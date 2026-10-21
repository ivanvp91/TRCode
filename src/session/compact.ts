/**
 * Context compaction: a handoff summary, not a transcript.
 *
 * A compaction is not a digest of everything: it throws away the part of a
 * history that grows without bound — assistant turns and tool traffic — keeps a
 * handoff summary, and carries the recent *user* messages over verbatim. Those
 * are the task and its refinements, the one thing a model cannot rediscover by
 * reading the workspace, and the reason a compacted session can still be told
 * "no, not like that".
 */
import { complete, repairToolPairs } from "../provider/client.js";
import { loadConfig } from "../config.js";
import { contextWindowFor } from "../provider/models.js";
import { estimateTokens, historyTokens } from "../usage.js";
import type { Message, ModelInfo } from "../types.js";
import type { Session } from "./session.js";

/**
 * The summarization prompt: a checkpoint for the
 * model that resumes, not a report for a human. The sections it asks for are
 * exactly the things a fresh context cannot infer from the code.
 */
const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
Preserve identifiers, paths, commands, line numbers and error messages verbatim. Invent nothing that was not in the history.`;

/** Said before the summary itself, so the next model knows what it is reading. */
const SUMMARY_INTRO =
  "Another language model started this task and produced a handoff summary. Use it to continue the work without duplicating what is already done.";

/**
 * How many tokens of recent user messages survive a compaction. 20k is large
 * enough for a long task statement plus its
 * corrections, and small enough that the summary stays the bulk of the new
 * context.
 */
const RETAINED_USER_TOKENS = 20_000;

/** How much of the history a compaction is allowed to throw away. */
export type CompactLevel = "light" | "medium" | "full";

const DIGEST_OPEN = "<compacted-context>";

/**
 * Messages at the tail a light pass never touches. The last few turns are what
 * the model is actively working on; trimming them saves little and costs the
 * exact context the next request needs.
 */
const LIGHT_KEEP_RECENT = 8;

/** Characters of an old tool result that survive a light pass. */
const LIGHT_TOOL_CHARS = 700;

/**
 * Marks a body a pass already shortened, so a second pass does not shorten the
 * note itself over and over (each run would add another one).
 */
const LIGHT_TRIM_MARK = "[old tool output trimmed to save context";
const MEDIUM_TRIM_MARK = "[trimmed while compacting";

/** Messages a medium compaction carries over untouched. */
const MEDIUM_KEEP_RECENT = 12;

/** Characters of a tool result inside a medium compaction's kept tail. */
const MEDIUM_TOOL_CHARS = 1500;

export interface LightResult {
  /** Messages whose body actually shrank. */
  trimmedMessages: number;
  /** Rough bytes removed: tool text and base64 pixels. */
  charsSaved: number;
}

export interface CompactResult {
  level: CompactLevel;
  summary: string;
  /** Messages folded into the digest. */
  droppedMessages: number;
  /** Messages in the history afterwards, digest included. */
  keptMessages: number;
  /** User messages carried over verbatim. */
  retainedUserMessages: number;
}

/** A message compaction wrote, as opposed to something the user typed. */
function isDigest(m: Message): boolean {
  return m.role === "user" && String(m.content ?? "").startsWith(DIGEST_OPEN);
}

function isRealUser(m: Message): boolean {
  // Injected context rides as a user message too — skill bodies, UI briefs —
  // and carrying one verbatim would spend the whole budget on something the
  // summary can describe in a line.
  return m.role === "user" && !isDigest(m) && !m.meta?.hidden && !m.meta?.skill;
}

/** Serialises history into a transcript the summariser model can read. */
function transcribe(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const body = String(m.content ?? "");
      parts.push(`[tool result ${m.name ?? ""}]\n${body.slice(0, 2500)}`);
      continue;
    }
    if (m.role === "assistant") {
      if (m.content) parts.push(`[assistant]\n${m.content}`);
      for (const tc of m.tool_calls ?? []) {
        parts.push(`[call ${tc.function.name}] ${tc.function.arguments.slice(0, 800)}`);
      }
      continue;
    }
    parts.push(`[user]\n${String(m.content ?? "")}`);
  }
  return parts.join("\n\n");
}

/**
 * Keeps a transcript inside what the summariser can actually read. A small
 * model pinned for compaction may hold far less than the session model, and a
 * request over its window would fail exactly when the session is full and
 * compaction matters most. The head (the task) and the tail (where the work is
 * now) are what a summary needs; the middle is elided.
 */
function fitTranscript(text: string, budgetTokens: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= budgetTokens) return text;
  const chars = Math.floor(budgetTokens * 3.6);
  const head = Math.floor(chars * 0.35);
  const tail = Math.max(0, chars - head);
  return `${text.slice(0, head)}\n\n… [${tokens - budgetTokens} tokens of the middle elided to fit the summariser's window] …\n\n${text.slice(-tail)}`;
}

interface Retained {
  /** The newest user messages that fit, oldest first. */
  kept: Message[];
}

/**
 * The newest user messages within a token budget. A message that fits is kept
 * whole; the one that overruns is truncated rather than dropped, because it is
 * usually the task statement itself, and losing it is the worst thing a
 * compaction can do.
 */
function retainUserMessages(messages: Message[], budget: number): Retained {
  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (isRealUser(m)) userIdx.push(i);
  });
  if (!userIdx.length) return { kept: [] };

  let remaining = budget;
  const picked: { index: number; message: Message }[] = [];
  for (let k = userIdx.length - 1; k >= 0 && remaining > 0; k--) {
    const index = userIdx[k];
    const original = messages[index];
    const text = String(original.content ?? "");
    const tokens = estimateTokens(text);
    if (tokens <= remaining) {
      picked.push({ index, message: { ...original } });
      remaining -= tokens;
      continue;
    }
    const chars = Math.max(200, Math.floor(remaining * 3.6) - 80);
    picked.push({
      index,
      message: {
        ...original,
        // A cut-off image is worse than no image: the text is what carries the
        // instruction, and the pixels would cost the budget they just ran out of.
        images: undefined,
        content: `${text.slice(0, chars)}\n… [truncated while compacting: originally ~${tokens} tokens]`,
      },
    });
    remaining = 0;
  }
  picked.reverse();
  return { kept: picked.map((p) => p.message) };
}

/**
 * Compacts the session in place: /compact, auto-compaction before a turn, and
 * mid-turn compaction after a tool round all land here.
 *
 * In place matters. The agent loop holds the history array across a turn, so
 * replacing `session.messages` with a new array would leave it writing to a
 * history nobody sends any more; splicing keeps every holder on the live one.
 */
export async function compactSession(
  session: Session,
  opts: { instructions?: string; signal?: AbortSignal; catalog?: ModelInfo[]; level?: CompactLevel } = {},
): Promise<CompactResult> {
  const cfg = loadConfig();
  const level = opts.level ?? "full";
  const all = session.messages;
  // Medium keeps the tail it is in the middle of working on; full keeps only
  // what is cheap to keep — the user's own words.
  const keepRecent = level === "medium" ? Math.max(0, Math.min(MEDIUM_KEEP_RECENT, all.length - 1)) : 0;
  const cut = all.length - keepRecent;
  const older = all.slice(0, cut);
  const tail = keepRecent ? repairToolPairs(shrinkTail(all.slice(cut))) : [];
  const { kept } = retainUserMessages(older, RETAINED_USER_TOKENS);

  // Everything the summary has to cover: the older history —
  // including earlier digests, or each compaction would forget the ones before
  // it. Only a history that is nothing but a digest is left alone.
  const meaningful = older.filter((m) => m.role !== "system" && !isDigest(m) && String(m.content ?? "").trim());
  if (!meaningful.length) {
    return {
      level,
      summary: "",
      droppedMessages: 0,
      keptMessages: all.length,
      retainedUserMessages: kept.length,
    };
  }

  const catalog = opts.catalog ?? [];
  // The configured small model may not exist on this provider — fall back
  // rather than failing the compaction with a 404.
  const summarizer =
    !opts.catalog || opts.catalog.some((m) => m.id === cfg.smallModel) ? cfg.smallModel || session.model : session.model;
  const summarizerWindow = contextWindowFor(summarizer, catalog);
  const transcript = fitTranscript(transcribe(older), Math.max(2000, Math.floor(summarizerWindow * 0.8)));

  const focus = opts.instructions
    ? `\n\nThe user asked the summary to focus on:\n${opts.instructions}`
    : "";

  const res = await complete({
    model: summarizer,
    messages: [
      { role: "system", content: COMPACT_PROMPT + focus },
      { role: "user", content: `Here is the session history:\n\n${transcript}` },
    ],
    temperature: 0.2,
    signal: opts.signal,
  });

  const summary = res.content.trim();
  if (!summary) throw new Error("The model returned an empty summary");

  const digest: Message = {
    role: "user",
    content: `${DIGEST_OPEN}\n${SUMMARY_INTRO}\n\n${summary}\n</compacted-context>`,
    meta: { ts: Date.now() },
  };

  const next = [digest, ...kept, ...tail];
  const dropped = all.length - kept.length - tail.length;
  all.splice(0, all.length, ...next);
  session.compactions++;
  // The cycle's beacons: a full pass rewrote the history, so the next cycle
  // starts from scratch; a medium pass counts against its own budget.
  if (level === "full") session.autoCompacts = { light: 0, medium: 0 };
  else session.autoCompacts.medium++;
  session.usage.record(summarizer, res.usage, catalog);
  session.save();

  return {
    level,
    summary,
    droppedMessages: dropped,
    keptMessages: next.length,
    retainedUserMessages: kept.length,
  };
}

/**
 * The messages a medium compaction keeps: the working tail, with the oldest
 * tool bodies shortened to what still identifies them. Pixels on a tool result
 * go — the summary carries what the tool found, and a kept tail is not worth
 * megabytes of base64.
 */
function shrinkTail(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const body = String(m.content ?? "");
    const cut = body.length > MEDIUM_TOOL_CHARS && !body.includes(MEDIUM_TRIM_MARK);
    if (!cut && !m.images?.length) return m;
    return {
      ...m,
      images: undefined,
      content: cut
        ? `${body.slice(0, MEDIUM_TOOL_CHARS)}\n… ${MEDIUM_TRIM_MARK}: ${body.length - MEDIUM_TOOL_CHARS} characters dropped]`
        : body,
    };
  });
}

/**
 * The lightest pass: no model call, no digest, nothing thrown away but what has
 * already been read.
 *
 * It runs at a quarter of the window, long before a compaction would be
 * defensible — so it may not rewrite the conversation. Old tool results shrink
 * to a stub (their contents are still in the workspace and the model can read
 * them again), old pixels come off, and the thinking that produced turns
 * already in the transcript is dropped. The tail is left alone: that is the
 * part the next request is actually about.
 */
export function lightCompact(session: Session): LightResult {
  const all = session.messages;
  const cut = Math.max(0, all.length - LIGHT_KEEP_RECENT);
  let trimmedMessages = 0;
  let charsSaved = 0;
  for (let i = 0; i < cut; i++) {
    const m = all[i];
    if (m.role === "tool") {
      const body = String(m.content ?? "");
      const pixels = (m.images ?? []).reduce((n, img) => n + img.data.length, 0);
      const cutBody = body.length > LIGHT_TOOL_CHARS && !body.includes(LIGHT_TRIM_MARK);
      if (!cutBody && !pixels) continue;
      const next = cutBody
        ? `${body.slice(0, LIGHT_TOOL_CHARS)}\n… ${LIGHT_TRIM_MARK}: ${body.length - LIGHT_TOOL_CHARS} characters dropped]`
        : body;
      charsSaved += body.length - next.length + pixels;
      all[i] = { ...m, content: next, images: undefined };
      trimmedMessages++;
      continue;
    }
    if (m.role === "assistant" && m.reasoning) {
      charsSaved += m.reasoning.length;
      all[i] = { ...m, reasoning: undefined };
      trimmedMessages++;
    }
  }
  if (trimmedMessages) {
    session.autoCompacts.light++;
    session.save();
  }
  return { trimmedMessages, charsSaved };
}

/** Fraction of the context window the history currently occupies. */
export function contextPressure(session: Session, catalog: ModelInfo[]): { used: number; window: number; ratio: number } {
  const window = contextWindowFor(session.model, catalog);
  const used = historyTokens(session.messages);
  return { used, window, ratio: used / window };
}

/**
 * How many times a rung may run before the ladder waits for the next one.
 *
 * A history that sits just above a threshold would otherwise be trimmed on
 * every turn forever: each pass buys back a little, the ratio returns to the
 * threshold, and the next rung is never reached. The caps make the ladder a
 * one-way trip — light can carry the history at most three times, medium twice,
 * and after that the history is simply allowed to grow to the full pass.
 *
 * Three lights is not a guess. A light pass can only reclaim the tool traffic
 * that has aged out of the kept tail; with φ the share of growth that is tool
 * output, the number of passes needed to climb from 25% to 50% is 1/(1−φ).
 * Coding turns run around φ ≈ 2/3 (tool output twice the prose), which gives
 * three. A fourth would only matter at φ ≥ 3/4 — a turn that is almost all file
 * dumps, where a digest is overdue anyway.
 *
 * Two mediums is one effective pass plus a retry: at the 50% threshold a medium
 * compaction removes roughly a third of the window, so a third pass would need
 * that much fresh growth again — by which point the full pass at 90% is due.
 */
export const LIGHT_BUDGET = 3;
export const MEDIUM_BUDGET = 2;

/**
 * How hard to compact right now, or null to leave the history alone.
 *
 * Compaction is lossy, so the ladder spends the cheap losses first: a light
 * trim at a quarter of the window (no model call, nothing thrown away but tool
 * output already read), a medium pass at half (a digest of the older history,
 * the working tail kept verbatim), and the full handoff at ninety
 * percent, when the window is about to run out. `autoCompact: false` turns the
 * whole ladder off; `/compact auto on|off` flips it.
 */
export type AutoCompactLevel = CompactLevel | null;

export function autoCompactLevel(session: Session, catalog: ModelInfo[]): AutoCompactLevel {
  const cfg = loadConfig();
  if (cfg.autoCompact === false) return null;
  const { ratio } = contextPressure(session, catalog);
  if (ratio >= cfg.autoCompactAt) return "full";
  // Past a threshold only that rung — or a higher one — is considered: once the
  // light pass has had its three tries, trimming again at 60% would be busywork
  // on the way to the digest. The counters reset when a full pass rewrites the
  // history (see compactSession).
  if (ratio >= cfg.autoCompactMediumAt) return session.autoCompacts.medium < MEDIUM_BUDGET ? "medium" : null;
  if (ratio >= cfg.autoCompactLightAt) return session.autoCompacts.light < LIGHT_BUDGET ? "light" : null;
  return null;
}

/**
 * True when the history needs any compaction at all.
 *
 * This used to also fire at twice `maxRequestTokens`, on the reasoning that a
 * fraction of a 1M-token window would never be reached. But that budget is the
 * on-the-wire trim, not the window: with the default 40k it compacted at 80k —
 * 8% of a 1M window — throwing away a history the model could still hold in
 * full.
 */
export function shouldAutoCompact(session: Session, catalog: ModelInfo[]): boolean {
  return autoCompactLevel(session, catalog) !== null;
}
