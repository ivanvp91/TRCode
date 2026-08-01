/**
 * Input-token control.
 *
 * An agent loop resends the whole history on every step, so a long session
 * costs O(steps²) in input tokens — that is where a 2M-input / 40k-output bill
 * comes from. The bulk of that history is tool output (file dumps, greps) that
 * the model has already read and acted on.
 *
 * So: keep every message, but shorten the *old* tool results. Nothing is
 * dropped, message pairing stays intact, and the recent turns — the ones the
 * model is actually still working from — are left untouched.
 */
import { estimateTokens } from "../usage.js";
import type { Message } from "../types.js";

export interface TrimOptions {
  /** Target size for the outgoing request, in tokens. */
  budget: number;
  /**
   * How many trailing messages stay verbatim. Counted in messages, not user
   * turns: the history balloons *inside* a single turn, as one tool round
   * follows another, and a turn-based rule would protect all of it.
   */
  keepRecent?: number;
  /** Tool results shorter than this are never touched. */
  minTrimBytes?: number;
}

export interface TrimResult {
  messages: Message[];
  /** Tokens saved versus sending the history as-is. */
  saved: number;
  /** How many tool results were shortened. */
  trimmed: number;
}

function sizeOf(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(String(m.content ?? ""));
    for (const tc of m.tool_calls ?? []) n += estimateTokens(tc.function.arguments) + 12;
  }
  return n;
}

export function trimForRequest(messages: Message[], opts: TrimOptions): TrimResult {
  const before = sizeOf(messages);
  if (before <= opts.budget) return { messages, saved: 0, trimmed: 0 };

  const keepRecent = opts.keepRecent ?? 8;
  const minBytes = opts.minTrimBytes ?? 400;
  // Everything before the recent tail is fair game.
  const cutoff = Math.max(0, messages.length - keepRecent);

  const out = messages.slice();
  let current = before;
  let trimmed = 0;

  // Oldest first: the further back a tool result is, the less it is needed.
  for (let i = 0; i < cutoff && current > opts.budget; i++) {
    const m = out[i];
    if (m.role !== "tool") continue;
    const body = String(m.content ?? "");
    if (body.length < minBytes) continue;

    const head = body.slice(0, 200).trimEnd();
    const stub =
      `${head}\n… [${body.length - head.length} more characters omitted — this result was already acted on in later steps. ` +
      `Call the tool again if you need it in full.]`;

    current -= estimateTokens(body) - estimateTokens(stub);
    out[i] = { ...m, content: stub };
    trimmed++;
  }

  return { messages: out, saved: Math.max(0, before - current), trimmed };
}

/** Size of a history, for callers that want to report it. */
export { sizeOf as historySize };
