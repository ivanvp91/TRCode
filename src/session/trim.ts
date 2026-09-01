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

/**
 * How far under the budget a trimming pass cuts once it has decided to cut.
 *
 * This is the last place that still rewrites an already-sent history, so what
 * it costs is not the tokens it saves but the re-prefill of everything behind
 * the oldest message it touches. That price is paid the moment the pass starts
 * — after which shortening the next message in the same pass is free. Cutting
 * exactly to the budget therefore bought two or three steps and then paid the
 * whole price again; cutting well under it pays once and buys dozens.
 */
const BUDGET_TARGET = 0.55;

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
    // Base64 is charged at roughly its byte count: ~4 chars per token group.
    for (const img of m.images ?? []) n += Math.ceil(img.data.length / 4);
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
/**
 * A repeat of a result already in the history, as one line.
 *
 * Agents re-read the same file and re-run the same grep constantly — and every
 * copy is paid for again on every later step, because the whole history goes
 * out each time. In one real session 55 tool results were byte-for-byte
 * repeats worth 74k tokens, a quarter of the entire history.
 *
 * The first copy stays verbatim, so nothing is lost and the prefix a cache
 * matches on does not move; the later ones say what they are. "Unchanged" is
 * also the answer the model was looking for when it re-read the file.
 */
function repeatStub(m: Message): Message {
  return {
    ...m,
    content: `[identical to the earlier ${m.name ?? "tool"} result above — unchanged since then]`,
    images: undefined,
  };
}

/**
 * An image read stays readable only while it is fresh: the base64 rides along
 * on every later step at full width, and a 2 MB screenshot is tens of
 * thousands of tokens the model has already described in text. Old results
 * keep the caption, lose the pixels.
 */
function imageStub(m: Message): Message {
  const n = m.images?.length ?? 0;
  return { ...m, images: undefined, content: `${String(m.content ?? "")}\n… [${n} image(s) attached earlier were dropped to save context. Use what you already noted about them; read the file again only if you must see it once more.]` };
}

function hasImages(m: Message): boolean {
  return Boolean(m.images?.length);
}

export function trimForRequest(messages: Message[], opts: TrimOptions): TrimResult {
  const before = sizeOf(messages);
  const keepRecent = opts.keepRecent ?? 8;
  const minBytes = opts.minTrimBytes ?? 400;
  const maxResult = opts.maxResultBytes ?? 0;
  // Everything before the recent tail is fair game.
  const cutoff = Math.max(0, messages.length - keepRecent);
  // No early return on budget alone: repeats are worth collapsing even in a
  // history that would have fitted, because every later step pays for them again.

  const out = messages.slice();
  let current = before;
  let trimmed = 0;

  // Pass 0: exact repeats. Cheapest saving there is — the content is already
  // in the context above, word for word.
  const seen = new Map<string, number>();
  for (let i = 0; i < cutoff; i++) {
    const m = out[i];
    if (m.role !== "tool") continue;
    const body = String(m.content ?? "");
    if (body.length < minBytes) continue;
    // Length-prefix style key: unambiguous, and no NUL byte — the one control
    // character the binary sniff refuses, which used to make this very file
    // unreadable to the read tool.
    const key = (m.name ?? "") + "::" + body.length + ":" + body;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, i);
      continue;
    }
    const stub = repeatStub(m);
    current -= estimateTokens(body) - estimateTokens(String(stub.content));
    out[i] = stub;
    trimmed++;
  }

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
      const body = String(m.content ?? "");
      if (body.length <= maxResult) continue;
      // A stub can still be longer than a very small cap; re-cutting it every
      // turn gains nothing and fires onTrim on a history that never changes.
      if (/more characters omitted/.test(body)) continue;
      shorten(i, Math.min(2000, Math.floor(maxResult / 4)));
    }
  }

  // Pass 1.5: images outside the recent tail, regardless of size. The pixels
  // are the single most expensive thing in an old result and the least needed.
  for (let i = 0; i < cutoff; i++) {
    const m = out[i];
    if (m.role !== "tool" || !hasImages(m)) continue;
    const stub = imageStub(m);
    out[i] = stub;
    trimmed++;
  }

  // Pass 2: the budget. Entered only when the request is genuinely over, and
  // then it cuts down to BUDGET_TARGET rather than to the line — see the note
  // there. Oldest first: the further back a tool result is, the less it is
  // needed, and the suffix behind it is already being re-prefilled anyway.
  if (current > opts.budget) {
    const floor = opts.budget * BUDGET_TARGET;
    for (let i = 0; i < cutoff && current > floor; i++) {
      const m = out[i];
      if (m.role !== "tool") continue;
      const body = String(m.content ?? "");
      if (body.length < minBytes) continue;
      if (/more characters omitted/.test(body)) continue; // already a stub
      shorten(i, 200);
    }
  }

  return { messages: out, saved: Math.max(0, before - current), trimmed };
}

/** Size of a history, for callers that want to report it. */
export { sizeOf as historySize };
