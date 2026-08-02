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
 *
 * Trimming is incremental: a stub made for step N is reused on step N+1, so
 * the old part of the history is byte-identical between steps — that is what
 * a provider-side prompt cache matches on.
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
  /**
   * Hard ceiling for a single old tool result, applied whether or not the
   * request is over budget. Without it one 400KB file read rides along on
   * every step until the *whole history* finally crosses the threshold.
   * 0 disables the cap.
   */
  maxResultBytes?: number;
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

/**
 * `headBytes` is how much of the result survives. The budget pass keeps a
 * token or two of context; the size cap keeps enough to still be useful,
 * since it fires on results the model may not have finished with.
 */
function stubFor(m: Message, headBytes = 200): Message {
  const body = String(m.content ?? "");
  const head = body.slice(0, headBytes).trimEnd();
  return {
    ...m,
    content:
      `${head}\n… [${body.length - head.length} more characters omitted — this result was already acted on in later steps. ` +
      `Call the tool again if you need it in full.]`,
  };
}

/**
 * Shortens tool output outside the recent tail once the request exceeds the
 * budget. Only the wire copy is shortened — the stored history keeps the full
 * output, so /resume, /compact and replayHistory see what actually happened.
 * The stub is deterministic (same input → same bytes), so the wire prefix
 * stays stable between steps and a provider-side cache can match on it.
 */
export function trimForRequest(messages: Message[], opts: TrimOptions): TrimResult {
  const before = sizeOf(messages);
  const keepRecent = opts.keepRecent ?? 8;
  const minBytes = opts.minTrimBytes ?? 400;
  const maxResult = opts.maxResultBytes ?? 0;
  // Everything before the recent tail is fair game.
  const cutoff = Math.max(0, messages.length - keepRecent);
  if (before <= opts.budget && !maxResult) return { messages, saved: 0, trimmed: 0 };

  const out = messages.slice();
  let current = before;
  let trimmed = 0;

  const shorten = (i: number, headBytes: number) => {
    const stub = stubFor(out[i], headBytes);
    current -= estimateTokens(String(out[i].content ?? "")) - estimateTokens(String(stub.content));
    out[i] = stub;
    trimmed++;
  };

  // Pass 1: the size cap. Independent of the budget, so a single huge dump
  // stops riding along from the step after the one that asked for it.
  if (maxResult > 0) {
    for (let i = 0; i < cutoff; i++) {
      const m = out[i];
      if (m.role !== "tool") continue;
      if (String(m.content ?? "").length <= maxResult) continue;
      shorten(i, Math.min(2000, Math.floor(maxResult / 4)));
    }
  }

  // Pass 2: the budget. Oldest first — the further back a tool result is, the
  // less it is needed.
  for (let i = 0; i < cutoff && current > opts.budget; i++) {
    const m = out[i];
    if (m.role !== "tool") continue;
    const body = String(m.content ?? "");
    if (body.length < minBytes) continue;
    if (/more characters omitted/.test(body)) continue; // already a stub
    shorten(i, 200);
  }

  return { messages: out, saved: Math.max(0, before - current), trimmed };
}

/** Size of a history, for callers that want to report it. */
export { sizeOf as historySize };
