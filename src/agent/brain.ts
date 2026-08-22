/**
 * A panel of models on one question.
 *
 * One model answering is one model's blind spots. Several answering the same
 * question independently, then reading each other and revising, is the cheapest
 * way to find out which parts of an answer survive being looked at by someone
 * who did not write it — and where the real disagreement is, which is usually
 * the part worth the user's attention.
 *
 * Three rounds, and no more: answer, критика of the others, then one model
 * merges what survived. A fourth round of models agreeing with each other is
 * paid for and adds nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { complete } from "../provider/client.js";
import { wireModelId } from "../provider/registry.js";
import type { Effort } from "../config.js";
import type { Message, ModelInfo } from "../types.js";
import { UsageTracker } from "../usage.js";

export interface BrainEvents {
  /** A model started its part; the label is what the user sees. */
  onStart?(model: string, round: "answer" | "critique" | "final"): void;
  /** A model finished; text is what it produced. */
  onAnswer?(model: string, round: "answer" | "critique" | "final", text: string): void;
  /** A model dropped out — the panel goes on without it. */
  onFailed?(model: string, reason: string): void;
}

export interface BrainOptions {
  task: string;
  /** The panel. Two is a pair of opinions; beyond four it is mostly repetition. */
  models: string[];
  /** The model that writes the final answer — the session's, unless told otherwise. */
  finalModel: string;
  cwd: string;
  /**
   * The conversation the question was asked inside. A question asked mid-session
   * is usually about what is already on screen — "обсудите идею" is three words
   * and a pronoun — and the panel has no session of its own to look it up in.
   */
  history?: Message[];
  catalog: ModelInfo[];
  effortFor: (model: string) => Effort;
  usage: UsageTracker;
  signal?: AbortSignal;
  events?: BrainEvents;
}

const ANSWER_PROMPT = `You are one of several models answering the same question, independently and at the same time. You cannot see the others yet.

- Answer the question itself. No preamble, no restatement of what was asked.
- Be specific: name the file, the number, the tradeoff. A general answer is worth nothing here, because every other model can produce one too.
- Where you are guessing, say so in the same sentence. Where the question is underspecified, state the assumption you are answering under.
- A conversation and files may be attached below the question. The question is usually about them — "discuss the idea" means the one in the conversation — so read them before deciding the question is empty.
- Length: what the answer needs and no more. Twenty lines is a lot.`;

const CRITIQUE_PROMPT = `You answered a question. Below are the other answers to the same question, written independently.

Your job is not to be agreeable and not to defend what you wrote.
- Say where the others are wrong or thin, concretely. "Missed X", "wrong about Y because Z".
- Say where they are right and you were not. Changing your mind here is the point of the exercise.
- Then give your revised answer. If nothing changed it, say so in one line and repeat the part that matters.
- Do not summarise the discussion. Do not thank anyone.`;

const FINAL_PROMPT = `Several models answered the same question and then read each other. Below is everything they said.

Write the final answer for the user:
- Take what survived scrutiny. Drop what was refuted, silently — the user does not need the history.
- Where the panel genuinely disagreed and the disagreement matters, say so in one or two lines: what the split is and what it depends on. Do not manufacture a consensus that was not there.
- Answer in the user's language, in the shape the question asked for.
- No mention of "models", "panel" or "rounds": the user asked a question, not for a report on how it was answered.`;

/** One model's turn. A failure drops it from the panel rather than the run. */
async function ask(
  model: string,
  system: string,
  user: string,
  opts: BrainOptions,
  round: "answer" | "critique" | "final",
): Promise<string | null> {
  opts.events?.onStart?.(model, round);
  try {
    const res = await complete({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      effort: opts.effortFor(model),
      signal: opts.signal,
    });
    opts.usage.record(model, res.usage, opts.catalog);
    const text = res.content.trim();
    if (!text) {
      opts.events?.onFailed?.(model, "returned nothing");
      return null;
    }
    opts.events?.onAnswer?.(model, round, text);
    return text;
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    opts.events?.onFailed?.(model, (err as Error).message);
    return null;
  }
}

/** The other answers, written out for one model to read. */
function othersFor(model: string, answers: Map<string, string>): string {
  return [...answers]
    .filter(([m]) => m !== model)
    .map(([m, text]) => `--- ${wireModelId(m)} ---\n${text}`)
    .join("\n\n");
}

export interface BrainResult {
  final: string;
  /** Who took part to the end — a model that failed is not in here. */
  panel: string[];
}

/** Paths the question points at, as they would be typed in a terminal. */
const PATHISH = /[\w./\\-]*[/\\][\w./\\-]+|\b[\w.-]+\.(md|txt|ts|tsx|js|jsx|json|ya?ml|toml|py|go|rs|java|kt|sql|sh|ps1)\b/g;

/**
 * The files the question names, read and attached.
 *
 * The panel has no tools — it is models talking, not agents working — so
 * "обсудите ideas/001-cli-router.md" reached them as a file name and nothing
 * else, and every one of them answered that it could not read it. The question
 * names the file; the file is right here; nobody needs a round of the user
 * pasting it in.
 */
export function attachReferenced(cwd: string, question: string, budget = 40_000): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  let left = budget;
  for (const raw of question.match(PATHISH) ?? []) {
    const rel = raw.replace(/^[`'"(]+|[`'".,)]+$/g, "");
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const full = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    let body: string;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      body = fs.readFileSync(full, "utf8");
    } catch {
      continue; // a path that does not exist here is just a word in a sentence
    }
    // Binary content helps nobody read a question: a NUL byte says it is not text.
    if (body.includes(String.fromCharCode(0))) continue;
    // The budget is what runs out, not the file: a two-line note is exactly
    // the kind of file a question names.
    if (left < 200) break;
    const room = Math.min(body.length, left);
    left -= room;
    parts.push(
      `--- ${rel} ---\n${body.slice(0, room)}${body.length > room ? `\n… [${body.length - room} characters omitted]` : ""}`,
    );
    if (parts.length >= 3 || left <= 0) break;
  }
  return parts.length ? `\n\nThe files the question names, read from the working directory:\n\n${parts.join("\n\n")}` : "";
}

/**
 * The conversation the question was asked inside, written out for the panel.
 *
 * "обсудите идею" reached three models as three words, and all three answered —
 * correctly — that there was no idea in the question. What "the idea" refers to
 * was on the user's screen, in the history the panel was not given. So it goes
 * with the question.
 *
 * Walked newest first, because that is what the budget should be spent on: the
 * question was asked about the end of a conversation, not its beginning. Tool
 * results are kept but cut short — they can carry the substance (a file the
 * session already read) and they can also be a megabyte of build log.
 */
export function attachHistory(history: Message[] | undefined, budget = 24_000): string {
  if (!history?.length) return "";
  const parts: string[] = [];
  let left = budget;
  for (let i = history.length - 1; i >= 0 && left > 200; i--) {
    const m = history[i];
    if (m.role === "system" || m.meta?.hidden) continue;
    let text: string;
    if (m.role === "tool") {
      text = `[tool result ${m.name ?? ""}]\n${cut(String(m.content ?? ""), 800)}`;
    } else if (m.role === "assistant") {
      // The calls stay as one-liners: which file was opened is context, its
      // contents are the tool result's job and are budgeted there.
      const calls = (m.tool_calls ?? []).map((tc) => `[call ${tc.function.name}] ${cut(tc.function.arguments, 200)}`);
      text = [m.content ? `[assistant]\n${m.content}` : "", ...calls].filter(Boolean).join("\n");
    } else {
      text = `[user]\n${String(m.content ?? "")}`;
    }
    if (!text.trim()) continue;
    const room = Math.min(text.length, left);
    left -= room;
    parts.push(cut(text, room));
  }
  if (!parts.length) return "";
  parts.reverse();
  return `\n\nThe conversation this question was asked in — its most recent part, oldest first:\n\n${parts.join("\n\n")}`;
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [${s.length - max} characters omitted]`;
}

export async function runBrain(opts: BrainOptions): Promise<BrainResult> {
  const task = `Question:\n${opts.task}\n\nWorking directory: ${opts.cwd}${attachHistory(opts.history)}${attachReferenced(opts.cwd, opts.task)}`;

  // Round 1 — independent answers. In parallel: they must not see each other,
  // and a metered host slows only its own model down.
  const first = new Map<string, string>();
  const answers = await Promise.all(
    opts.models.map((m) => ask(m, ANSWER_PROMPT, task, opts, "answer").then((t) => [m, t] as const)),
  );
  for (const [m, t] of answers) if (t) first.set(m, t);

  if (first.size === 0) return { final: "", panel: [] };
  // One survivor is not a panel: its answer is the answer, and a critique round
  // against nobody is a round of the model agreeing with itself.
  if (first.size === 1) {
    const [[model, only]] = [...first];
    return { final: only, panel: [model] };
  }

  // Round 2 — each reads the others and revises.
  const second = new Map<string, string>();
  const revised = await Promise.all(
    [...first.keys()].map((m) =>
      ask(
        m,
        CRITIQUE_PROMPT,
        `${task}\n\nYour answer:\n${first.get(m)}\n\nThe other answers:\n${othersFor(m, first)}`,
        opts,
        "critique",
      ).then((t) => [m, t] as const),
    ),
  );
  for (const [m, t] of revised) if (t) second.set(m, t);

  // Round 3 — one model writes the answer the user actually gets.
  const transcript = [...first.keys()]
    .map((m) => {
      const label = wireModelId(m);
      const rev = second.get(m);
      return `=== ${label} ===\nFirst answer:\n${first.get(m)}${rev ? `\n\nAfter reading the others:\n${rev}` : ""}`;
    })
    .join("\n\n");

  const final = await ask(opts.finalModel, FINAL_PROMPT, `${task}\n\n${transcript}`, opts, "final");
  return {
    final: final ?? [...second.values(), ...first.values()][0] ?? "",
    panel: [...first.keys()],
  };
}
