/**
 * Context compaction. Summarises the conversation into a structured digest and
 * restarts the history from that digest, keeping the most recent exchanges
 * verbatim so the model does not lose the thread it is mid-way through.
 */
import { complete } from "../provider/client.js";
import { loadConfig } from "../config.js";
import { contextWindowFor } from "../provider/models.js";
import { historyTokens } from "../usage.js";
import type { Message, ModelInfo } from "../types.js";
import type { Session } from "./session.js";

const COMPACT_PROMPT = `You are compacting the history of an agentic coding session so the work can continue without losing context.

Produce a structured digest with exactly these sections:

## Task
What the user asked for — the original wording and every later refinement.

## Done
Concrete changes: files (full paths), functions, what exactly changed. Quote names and paths verbatim.

## Key facts about the code
Architectural details discovered while exploring: where things live, what conventions apply, how tests and builds are run.

## Decisions and why
The decisions taken and the reasoning, including options that were rejected.

## Current state
What works, what is broken, what was verified and what was not.

## Next steps
What remains, in priority order.

Rules: preserve identifiers, paths, commands, line numbers and error messages verbatim. Invent nothing that was not in the history. No preamble, no conclusion — sections only.`;

export interface CompactResult {
  summary: string;
  droppedMessages: number;
  keptMessages: number;
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
 * Keeps a tail of recent turns intact. The tail must start on a user message
 * and must not orphan a tool result from its assistant tool_call.
 */
function splitTail(messages: Message[], keepTurns: number): { head: Message[]; tail: Message[] } {
  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  if (userIdx.length <= keepTurns) return { head: messages, tail: [] };
  const cut = userIdx[userIdx.length - keepTurns];
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
}

export async function compactSession(
  session: Session,
  opts: { instructions?: string; signal?: AbortSignal; keepTurns?: number; catalog?: ModelInfo[] } = {},
): Promise<CompactResult> {
  const cfg = loadConfig();
  const keepTurns = opts.keepTurns ?? 2;
  // The configured small model may not exist on this provider — fall back
  // rather than failing the compaction with a 404.
  const summarizer =
    !opts.catalog || opts.catalog.some((m) => m.id === cfg.smallModel) ? cfg.smallModel || session.model : session.model;
  const { head, tail } = splitTail(session.messages, keepTurns);
  if (head.length < 2) {
    return { summary: "", droppedMessages: 0, keptMessages: session.messages.length };
  }

  const focus = opts.instructions
    ? `\n\nThe user asked the digest to focus on:\n${opts.instructions}`
    : "";

  const res = await complete({
    model: summarizer,
    messages: [
      { role: "system", content: COMPACT_PROMPT + focus },
      { role: "user", content: `Here is the session history:\n\n${transcribe(head)}` },
    ],
    temperature: 0.2,
    signal: opts.signal,
  });

  const summary = res.content.trim();
  if (!summary) throw new Error("The model returned an empty digest");

  const digest: Message = {
    role: "user",
    content: `<compacted-context>\nThe earlier part of this session has been compacted. Below is the digest. Treat these facts as established and carry on.\n\n${summary}\n</compacted-context>`,
    meta: { ts: Date.now() },
  };
  const ack: Message = {
    role: "assistant",
    content: "Context received. Continuing from the current state.",
    meta: { ts: Date.now() },
  };

  const dropped = head.length;
  session.messages = [digest, ack, ...tail];
  session.compactions++;
  session.usage.record(summarizer, res.usage, opts.catalog ?? []);
  session.save();

  return { summary, droppedMessages: dropped, keptMessages: session.messages.length };
}

/** Fraction of the context window the history currently occupies. */
export function contextPressure(session: Session, catalog: ModelInfo[]): { used: number; window: number; ratio: number } {
  const window = contextWindowFor(session.model, catalog);
  const used = historyTokens(session.messages);
  return { used, window, ratio: used / window };
}

/**
 * When to auto-compact. A fraction of the window alone is useless on a 1M-token
 * model — 82% of 1M means it never fires and the history grows all session. So
 * the request budget caps it too: past twice that, compaction is overdue.
 */
export function shouldAutoCompact(session: Session, catalog: ModelInfo[]): boolean {
  const cfg = loadConfig();
  const { used, window } = contextPressure(session, catalog);
  const byWindow = window * cfg.autoCompactAt;
  const byBudget = cfg.maxRequestTokens > 0 ? cfg.maxRequestTokens * 2 : Infinity;
  return used >= Math.min(byWindow, byBudget);
}
