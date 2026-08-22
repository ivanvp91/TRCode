/** Chat client with SSE streaming and retries, routed per provider. */
import { loadConfig, saveConfig, type Effort } from "../config.js";
import type { Message, StreamEvent, ToolCall, ToolDef, Usage } from "../types.js";
import { type Protocol } from "./protocol.js";
import {
  DEFAULT_PROVIDER,
  modeConfig,
  modeFor,
  protocolForModel,
  qualifyModelId,
  renewRejectedToken,
  resolveAuth,
  splitModelId,
  wireModelId,
  type ResolvedAuth,
} from "./registry.js";
import { buildResponsesBody, parseResponsesResult, ResponsesStreamParser } from "./responses.js";
import { AnthropicStreamParser, buildAnthropicBody, parseAnthropicResult } from "./anthropic.js";
import { DEFAULT_MAX_TOKENS, THINKING_BUDGET } from "./anthropic.js";
import { normalizeToolSchema } from "./schema.js";

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Reasoning budget; "off" or undefined omits the parameter. */
  effort?: Effort;
  /** Forces a non-streaming call; used for short utility completions. */
  stream?: boolean;
  /**
   * Asked when the stream has been silent for a while: true keeps waiting
   * (the connection stays open), false aborts. Without it the silence limit
   * is a hard cut — the right behaviour when there is nobody to ask.
   */
  onStall?: (idleMs: number) => Promise<boolean>;
  /**
   * Called when the send is held back by a learned rate limit, so the UI can
   * show that a minute is being waited out instead of looking like a hang.
   * The model is named because it is not always the session's own — a title
   * or a compaction runs on the small one, and a subagent on its own.
   */
  onRateWait?: (waitMs: number, model: string, said: string) => void;
}

/**
 * How a model wants the reasoning budget on the wire. Sending both shapes at
 * once made hosts that accept only one reject the whole request, so the forms
 * are tried in order and the working one is remembered per model.
 */
export type EffortForm = "reasoning_effort" | "reasoning" | "adaptive" | "budget" | "none";

/**
 * Shapes to try, per protocol, in order. Each dialect has its own spelling and
 * trying a foreign one only burns a round-trip, so the ladders stay separate.
 */
const EFFORT_LADDER: Record<string, EffortForm[]> = {
  openai: ["reasoning_effort", "reasoning"],
  responses: ["reasoning"],
  anthropic: ["adaptive", "budget"],
  unsupported: [],
};
const effortForm = new Map<string, EffortForm>(Object.entries(loadConfig().effortForm ?? {}) as [string, EffortForm][]);
for (const id of loadConfig().effortUnsupported ?? []) if (!effortForm.has(id)) effortForm.set(id, "none");

export function modelRejectsEffort(model: string): boolean {
  return effortForm.get(model) === "none";
}

/**
 * Hosts that answer 400 to `cache_control`. A proxy in front of Anthropic may
 * not pass the field through, and one rejected request is enough to learn it —
 * for the rest of the process we send the same body without breakpoints.
 */
const cacheRejected = new Set<string>();

/**
 * Hosts that take breakpoints but not an hour-long one. Proxies in front of the
 * Messages API lag the field, and losing the longer lifetime is a far smaller
 * loss than losing caching altogether — so the hour is given up first and the
 * breakpoints only if the complaint survives that.
 */
const longTtlRejected = new Set<string>();

export function modelRejectsCache(model: string): boolean {
  return cacheRejected.has(model);
}

/**
 * Models that refuse a temperature at all. A reasoning model is often fixed at
 * 1 and answers `400 invalid temperature: only 1 is allowed for this model` to
 * anything else — which dropped a model out of a /brain panel over a sampling
 * preference. The value is a preference, so it is given up and the request
 * goes through; learned once per model per run, like the cache fields.
 */
const temperatureRejected = new Set<string>();

export function modelRejectsTemperature(model: string): boolean {
  return temperatureRejected.has(model);
}

/** True when the failure is specifically about the sampling temperature. */
function isTemperatureComplaint(err: ApiError): boolean {
  return err.status === 400 && /temperature/i.test(err.body ?? err.message);
}

/** The temperature to send, or nothing for a model that has refused one. */
function temperatureFor(model: string, asked: number | undefined, fallback: number | undefined): number | undefined {
  return temperatureRejected.has(model) ? undefined : asked ?? fallback;
}

export function modelRejectsLongCacheTtl(model: string): boolean {
  return longTtlRejected.has(model);
}

/** True when the failure is specifically about the cache field. */
function isCacheComplaint(err: ApiError): boolean {
  return err.status === 400 && /cache_control|cache_creation|ephemeral|extended-cache-ttl/i.test(err.body ?? err.message);
}

/** Current form for a model, defaulting to the first one we try. */
function ladderFor(model: string): EffortForm[] {
  return EFFORT_LADDER[protocolForModel(model)] ?? EFFORT_LADDER.openai;
}

function formFor(model: string): EffortForm {
  const learned = effortForm.get(model);
  if (learned) return learned;
  const cfg = loadConfig();
  const ladder = ladderFor(model);
  // An explicit config choice only applies where that spelling makes sense.
  if (cfg.effortParam !== "both" && ladder.includes(cfg.effortParam as EffortForm)) {
    return cfg.effortParam as EffortForm;
  }
  return ladder[0] ?? "none";
}

/** The next shape to try after `current` failed, or "none" when out of ideas. */
function nextForm(model: string, current: EffortForm): EffortForm {
  const ladder = ladderFor(model);
  const i = ladder.indexOf(current);
  return i === -1 || i === ladder.length - 1 ? "none" : ladder[i + 1];
}

function rememberForm(model: string, form: EffortForm): void {
  if (effortForm.get(model) === form) return;
  effortForm.set(model, form);
  try {
    saveConfig({ effortForm: Object.fromEntries(effortForm) as Record<string, EffortForm> });
  } catch {
    /* config is best-effort here */
  }
}

/** Clears what we learned, so the next request probes again. */
export function resetEffortLearning(model?: string): void {
  if (model) effortForm.delete(model);
  else effortForm.clear();
  try {
    saveConfig(
      { effortForm: Object.fromEntries(effortForm) as Record<string, EffortForm>, effortUnsupported: [] },
      { replace: ["effortForm"] },
    );
  } catch {
    /* best effort */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Repairs the tool pairing a history may have lost.
 *
 * Every tool_call has to be answered by a tool message carrying its id, and
 * a tool message has to answer a call that is present — hosts refuse both
 * halves of that, and the ones that do not are worse: a call with no answer
 * reads to the model as a command it never ran, so it runs the ten-minute
 * build again. An interrupted turn and a trimmed history both produce this,
 * and a session saved that way carries it forever.
 */
export function repairToolPairs(messages: Message[]): Message[] {
  const called = new Set<string>();
  for (const m of messages) for (const call of m.tool_calls ?? []) called.add(call.id);
  const answered = new Set<string>();
  for (const m of messages) if (m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);

  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // A result whose call is gone answers nothing.
    if (m.role === "tool" && m.tool_call_id && !called.has(m.tool_call_id)) continue;
    out.push(m);
    if (!m.tool_calls?.length) continue;
    // Whatever results already follow stay where they are; the ones that are
    // missing are appended after them, so a round reads in the order it ran.
    while (i + 1 < messages.length && messages[i + 1].role === "tool") {
      const r = messages[++i];
      if (r.tool_call_id && !called.has(r.tool_call_id)) continue;
      out.push(r);
    }
    for (const call of m.tool_calls) {
      if (answered.has(call.id)) continue;
      answered.add(call.id);
      out.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function?.name,
        content: "No result: the turn ended before this finished. Do not assume it succeeded or failed.",
      });
    }
  }
  return out;
}

function wireMessages(messages: Message[]): unknown[] {
  return messages
    .filter((m) => !m.meta?.hidden)
    .map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content ?? "" };
      if (m.name) out.name = m.name;
      if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      // An assistant turn that only calls tools must send content:null, not "".
      if (m.role === "assistant" && m.tool_calls?.length && !m.content) out.content = null;
      return out;
    });
}

function wireTools(tools?: ToolDef[]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: normalizeToolSchema(t.parameters) },
  }));
}

function applyEffort(body: Record<string, unknown>, model: string, effort: Effort | undefined): void {
  if (!effort || effort === "off") return;
  const form = formFor(model);
  if (form === "none") return;
  if (form === "reasoning_effort") body.reasoning_effort = effort;
  else body.reasoning = { effort };
}

/**
 * True when a 400 is about the reasoning parameter rather than our payload.
 *
 * Hosts complain in their own vocabulary and rarely in ours: Model Studio's
 * Token Plan answers "adaptive thinking is not supported on this model" to a
 * `reasoning_effort` it does not take, naming neither. Matching only our own
 * spellings turned that into a failed turn — and a crashed subagent — where
 * dropping the parameter and asking again would have worked.
 */
function isEffortComplaint(body: string): boolean {
  return /reasoning|effort|thinking|adaptive|budget/i.test(body);
}

function buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const cfg = loadConfig();
  const body: Record<string, unknown> = {
    model: wireModelId(req.model),
    messages: wireMessages(req.messages),
    stream,
  };
  applyEffort(body, req.model, req.effort);
  const tools = wireTools(req.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const temp = temperatureFor(req.model, req.temperature, cfg.temperature);
  if (temp !== undefined) body.temperature = temp;
  // The same ceiling the Anthropic dialect has: without it a reasoning model
  // is free to spend its whole window on thinking and prose, all billed as
  // output.
  const budget = req.effort && req.effort !== "off" ? THINKING_BUDGET[req.effort] : undefined;
  const max = req.maxTokens ?? cfg.maxTokens ?? (budget ? budget + DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS);
  if (max !== undefined) body.max_tokens = max;
  if (stream) body.stream_options = { include_usage: true };
  // OpenRouter reports detailed usage — cached tokens above all, which is what
  // tells a warm cache from a full-price prefill — only when asked. Without
  // this the tracker books the whole prompt as fresh input, whether or not the
  // provider actually cached it.
  if (splitModelId(req.model).providerId === "openrouter") {
    body.usage = { include: true };
  }
  return body;
}

/**
 * Sends one request to whichever provider owns the model. Auth is resolved per
 * call rather than cached, because an OAuth provider may have to renew its
 * token first — `resolveAuth` handles that, and does it once for a burst.
 */
async function post(model: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const { providerId } = splitModelId(model);
  let auth;
  try {
    // Auth may renew an OAuth token over the network; racing it against the
    // signal keeps Esc working even when that renewal is what hangs.
    auth = await abortable(resolveAuth(providerId), signal);
  } catch (err) {
    if ((err as any)?.name === "AbortError") throw err;
    throw new ApiError((err as Error).message, 401);
  }
  return fetch(`${auth.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "trcode-cli",
      // Provider headers last: a host that gates on its own User-Agent must be
      // able to replace ours, not merely add to it.
      ...auth.headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Rate limits are handled where they happen and nowhere else: a request goes
 * out the moment it is ready, and only a 429 that actually came back buys a
 * wait. Nothing is held back in advance.
 *
 * The client used to keep the window a host named and pace later sends by it.
 * It is the textbook answer and it was wrong here: a limit is a property of an
 * account at a moment, the client cannot see when it lifts, and being wrong
 * costs the user a minute of dead time per step — every step, for the rest of
 * the process. Being wrong the other way costs one refused request, which the
 * retry below absorbs. An agent turn is dozens of steps, so the asymmetry is
 * not close.
 *
 * A 429 names its window ("Maximum 1 requests within 1 minutes"), and most
 * hosts count every attempt against it — refused ones included — so the retry
 * waits out a full window rather than probing sooner.
 */
const RATE_LIMIT_RETRIES = 8;
/**
 * How long a request may spend waiting out refusals before giving up.
 *
 * A count alone was wrong: three tries is plenty against a per-second limit
 * and hopeless against "one request per minute", where four subagents queue
 * behind each other and the last one needs four windows just to reach the
 * front. Time is the thing worth bounding — a turn that waits five minutes is
 * already a bad turn, whatever the host's window happens to be.
 */
const RATE_LIMIT_PATIENCE_MS = 5 * 60_000;
/**
 * Used when neither Retry-After nor the message names a window. Hosts that
 * say nothing are usually metering per second or per burst, not per minute,
 * so a blind minute mostly buys dead time — and when it really was a minute,
 * the next 429 says so and the window is relearned from the host's own words.
 */
const RATE_LIMIT_FALLBACK_MS = 20_000;
/** Window edges are fuzzy; land just past one rather than on it. */
const RATE_LIMIT_MARGIN_MS = 2_000;
const TRANSIENT_RETRIES = 3;

/** "Maximum 1 requests within 1 minutes" → 60 000, when the host spells it out. */
function windowFromMessage(body: string): number | undefined {
  const m = /within\s+(\d+)\s*(second|sec|minute|min)/i.exec(body);
  if (!m) return undefined;
  const ms = Number(m[1]) * (/min/i.test(m[2]) ? 60_000 : 1_000);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

async function postWithRetry(
  model: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
  onRateWait?: (waitMs: number, model: string, said: string) => void,
): Promise<Response> {
  let rateRetries = 0;
  let rateWaited = 0;
  let transientRetries = 0;
  let authRenewed = false;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let res: Response;
    try {
      res = await post(model, path, body, signal);
    } catch (err) {
      if ((err as any)?.name === "AbortError") throw err;
      if (transientRetries >= TRANSIENT_RETRIES) throw err;
      await sleep(2 ** transientRetries++ * 700, signal);
      continue;
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    // A host can revoke an OAuth access token before its stated expiry — a
    // login on another device, a session cut server-side — and `isStale`
    // cannot see that. The refresh token usually still stands, so renew once
    // and resend before reporting the key as bad.
    if (res.status === 401 && !authRenewed) {
      authRenewed = true;
      if (await abortable(renewRejectedToken(splitModelId(model).providerId), signal)) continue;
    }
    const err = new ApiError(describeStatus(res.status, text, model), res.status, text);
    if (!RETRYABLE.has(res.status)) throw err;
    const rateLimited = res.status === 429;
    if (rateLimited ? rateRetries >= RATE_LIMIT_RETRIES || rateWaited >= RATE_LIMIT_PATIENCE_MS : transientRetries >= TRANSIENT_RETRIES) throw err;
    if (rateLimited) {
      // The host's own idea of "when" wins: Retry-After first, then the
      // window spelled out in the message, then the fallback.
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        (Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : windowFromMessage(text) ?? RATE_LIMIT_FALLBACK_MS) + RATE_LIMIT_MARGIN_MS;
      rateRetries++;
      rateWaited += waitMs;
      // Only ever here: a wait the host asked for, after a refusal it sent.
      onRateWait?.(waitMs, model, extractError(text));
      await sleep(waitMs, signal);
      continue;
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** transientRetries * 700;
    transientRetries++;
    await sleep(waitMs, signal);
  }
}

function describeStatus(status: number, body: string, model?: string): string {
  const detail = extractError(body);
  // The fix for a bad key is provider-specific: `trc auth login` alone
  // re-auths TokenRouter, which is not the host that just refused.
  const provider = model ? splitModelId(model).providerId : undefined;
  const loginCmd = provider && provider !== DEFAULT_PROVIDER ? `trc auth login --provider ${provider}` : "trc auth login";
  // Model Studio's content filter, which reads source code as inappropriate
  // content. The message alone reads like the request was malformed.
  if (/DataInspection|inappropriate content|content.?(filter|policy|moderation)/i.test(detail)) {
    // Deterministic for this history: the same messages will be refused again,
    // so the useful thing to say is that retrying is not the way out.
    return `${status} — the host's content filter refused this conversation. Retrying sends the same history and fails the same way; continue it on another host, or start a new session. (${detail})`;
  }
  switch (status) {
    case 401:
      return `401 — key rejected. Check with: ${loginCmd}${detail ? ` (${detail})` : ""}`;
    case 403:
      return `403 — access to this model is denied${detail ? ` (${detail})` : ""}`;
    case 402:
      // Subscription hosts answer this when the plan lapsed; the credential is
      // fine, so pointing at auth would send the user in the wrong direction.
      return `402 — the plan does not cover this request${detail ? ` (${detail})` : ""}`;
    case 404:
      return `404 — model or endpoint not found${detail ? ` (${detail})` : ""}`;
    case 429:
      return `429 — rate limit exceeded${detail ? ` (${detail})` : ""}`;
    case 500: {
      // A router's mid-stream error is not a verdict on the request: its
      // upstream failed, and the same request can simply go out again.
      if (/upstream idle timeout/i.test(detail)) return "500 — the host's upstream sat silent until the router gave up on it; the request never reached an answer";
      return `HTTP 500${detail ? ` — ${detail}` : ""}`;
    }
    default:
      return `HTTP ${status}${detail ? ` — ${detail}` : ""}`;
  }
}

function extractError(body: string): string {
  try {
    const j = JSON.parse(body);
    // {"error": {"message": …}} is the common shape; the grok proxy sends
    // {"error": "…"} — a bare string, which used to read as no detail at all.
    const e = j?.error;
    return String((typeof e === "string" ? e : e?.message) ?? j?.message ?? "").slice(0, 300);
  } catch {
    return body.slice(0, 200).replace(/\s+/g, " ").trim();
  }
}

/**
 * Sends a chat request; if the host rejects the reasoning parameter, drops it
 * and retries once so an unsupported model degrades instead of failing.
 */
async function postChat(req: ChatRequest, stream: boolean): Promise<Response> {
  const path = pathFor(protocolForModel(req.model));
  for (;;) {
    try {
      return await postWithRetry(req.model, path, buildBodyFor(req, stream), req.signal, req.onRateWait);
    } catch (err) {
      // A host that does not understand cache breakpoints: drop them and go
      // on. Costs one round-trip once per model, never a failed turn.
      if (err instanceof ApiError && isCacheComplaint(err)) {
        // Two rungs, cheapest loss first: give up the hour, then the
        // breakpoints. Costs a round-trip once per model, never a failed turn.
        if (!longTtlRejected.has(req.model)) {
          longTtlRejected.add(req.model);
          continue;
        }
        if (!cacheRejected.has(req.model)) {
          cacheRejected.add(req.model);
          continue;
        }
      }
      // A model that will not be steered: drop the temperature and go on. It
      // is a preference, and losing it is nothing next to losing the answer.
      if (err instanceof ApiError && isTemperatureComplaint(err) && !temperatureRejected.has(req.model)) {
        temperatureRejected.add(req.model);
        continue;
      }
      const form = formFor(req.model);
      const worthRetrying =
        err instanceof ApiError &&
        err.status === 400 &&
        req.effort &&
        req.effort !== "off" &&
        form !== "none" &&
        isEffortComplaint(err.body ?? err.message);
      if (!worthRetrying) throw err;
      // The rejection names the reasoning parameter: try the other shape.
      rememberForm(req.model, nextForm(req.model, form));
    }
  }
}

function pathFor(p: Protocol): string {
  return p === "responses" ? "/responses" : p === "anthropic" ? "/messages" : "/chat/completions";
}

/** Builds the request body in whichever dialect the model speaks. */
function buildBodyFor(rawReq: ChatRequest, stream: boolean): Record<string, unknown> {
  // One place for every protocol: whatever is wrong with the pairing, it is
  // wrong for all three.
  const req: ChatRequest = { ...rawReq, messages: repairToolPairs(rawReq.messages) };
  const cfg = loadConfig();
  const protocol = protocolForModel(req.model);
  if (protocol === "responses") {
    const body = buildResponsesBody(
      {
        model: wireModelId(req.model),
        messages: req.messages,
        tools: req.tools,
        effort: formFor(req.model) === "none" ? "off" : req.effort,
        maxTokens: req.maxTokens ?? cfg.maxTokens,
      },
      stream,
    );
    return body;
  }
  if (protocol === "anthropic") {
    const form = formFor(req.model);
    return buildAnthropicBody(
      {
        model: wireModelId(req.model),
        messages: req.messages,
        tools: req.tools,
        effort: form === "none" ? "off" : req.effort,
        thinkingForm: form === "budget" ? "budget" : form === "none" ? "none" : "adaptive",
        maxTokens: req.maxTokens ?? cfg.maxTokens,
        temperature: temperatureFor(req.model, req.temperature, cfg.temperature),
        cache: cfg.promptCache !== false && !cacheRejected.has(req.model),
        cacheTtl: longTtlRejected.has(req.model) ? "5m" : "1h",
      },
      stream,
    );
  }
  return buildBody(req, stream);
}

/** Rejects with AbortError as soon as the signal fires, whatever `p` does. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Every message in an error's cause chain, outermost first.
 *
 * Node reports a broken connection as `TypeError: terminated` and puts what
 * actually happened one or two levels down in `cause` — which is why a turn
 * that died after ten minutes of work said nothing but "terminated".
 */
export function causeChain(err: unknown): string[] {
  const out: string[] = [];
  let cur: any = err;
  const seen = new Set<any>();
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const msg = [cur.code, cur.message].filter(Boolean).join(": ");
    if (msg) out.push(String(msg));
    cur = cur.cause;
  }
  return out;
}

/** A connection that died on its own, as opposed to a host that answered. */
export function isConnectionDrop(err: unknown): boolean {
  if ((err as any)?.name === "AbortError") return false;
  if (err instanceof ApiError) {
    // A router whose upstream sat silent answers mid-stream with words instead
    // of a hang-up. It never judged the request, so the same one is still
    // valid — this is a dropped connection wearing a status code.
    return err.status === 500 && /upstream idle timeout/i.test(err.message);
  }
  return /terminated|fetch failed|socket hang up|other side closed|premature close|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR|upstream idle timeout/i.test(
    causeChain(err).join(" | "),
  );
}

/**
 * What to tell the user about a dropped connection.
 *
 * The one that bites during long reasoning is undici's own body timeout: Node
 * closes a response that has sent nothing for five minutes, and a model that
 * thinks silently for longer than that trips it even though the request was
 * perfectly fine. Our watchdog is set to ten, so Node gets there first.
 */
export function describeConnectionDrop(err: unknown): string {
  const chain = causeChain(err).join(" | ");
  if (/upstream idle timeout/i.test(chain))
    return "the host's upstream sat silent until the router gave up on it — the request never reached an answer, so it can simply be resent";
  if (/UND_ERR_BODY_TIMEOUT|Body Timeout/i.test(chain))
    return "the connection was closed after 5 minutes with no data — a model that thinks silently for longer than that trips Node's own limit, whatever the host is doing";
  if (/UND_ERR_HEADERS_TIMEOUT|Headers Timeout/i.test(chain))
    return "the host accepted the request but sent no response headers in 5 minutes";
  if (/other side closed|ECONNRESET|socket hang up|premature close/i.test(chain))
    return "the host closed the connection mid-answer";
  if (/ENOTFOUND|EAI_AGAIN/i.test(chain)) return "the host name could not be resolved — check the network";
  if (/ECONNREFUSED|ENETUNREACH/i.test(chain)) return "the host refused the connection";
  return chain || "the connection dropped";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** Accumulates streamed tool_call deltas, which arrive fragmented by index. */
class ToolCallAccumulator {
  private slots = new Map<number, ToolCall>();

  push(deltas: any[]): void {
    for (const d of deltas ?? []) {
      const idx = d.index ?? 0;
      const slot = this.slots.get(idx) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (d.id) slot.id = d.id;
      if (d.function?.name) slot.function.name += d.function.name;
      if (d.function?.arguments) slot.function.arguments += d.function.arguments;
      this.slots.set(idx, slot);
    }
  }

  result(): ToolCall[] {
    return [...this.slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, tc]) => ({ ...tc, id: tc.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}` }))
      .filter((tc) => tc.function.name);
  }

  get size(): number {
    return this.slots.size;
  }
}

/**
 * Aborts when the stream goes quiet for too long. A slow model is fine; a
 * connection that stops producing bytes is not, and without this the CLI hangs
 * with no way out but Ctrl+C.
 */
function withIdleWatchdog(
  external: AbortSignal | undefined,
  idleMs: number,
  onStall?: (idleMs: number) => Promise<boolean>,
) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  /** Bumped on every byte; a stall answer from before the bump is stale. */
  let gen = 0;

  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  if (external?.aborted) controller.abort();

  const expire = async () => {
    if (onStall && !controller.signal.aborted) {
      const g = gen;
      let keep = false;
      try {
        keep = await onStall(idleMs);
      } catch {
        keep = false;
      }
      // Data arrived while the question was on screen: the stall resolved
      // itself, and an "abort" answer no longer refers to anything.
      if (gen !== g) return;
      if (keep && !controller.signal.aborted) {
        arm();
        return;
      }
    }
    timedOut = true;
    controller.abort();
  };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void expire(), idleMs);
  };

  const kick = () => {
    gen++;
    arm();
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    external?.removeEventListener("abort", onExternalAbort);
  };

  arm();
  return { signal: controller.signal, kick, stop, timedOut: () => timedOut };
}

/** Streams a chat completion, yielding text deltas then a final `done` event. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const idleMs = loadConfig().requestTimeoutMs ?? 600_000;
  // With someone to ask, ask sooner: five silent minutes is a fair question,
  // and "keep waiting" costs one keypress. The full limit stays for the hard
  // cut when there is nobody watching.
  // Four minutes, not five, because Node closes a response that has sent
  // nothing for five all by itself: asking at the same moment is a race with
  // the socket, and the socket wins.
  const checkMs = req.onStall ? Math.min(idleMs, 240_000) : idleMs;
  const dog = withIdleWatchdog(req.signal, checkMs, req.onStall);

  let res: Response;
  try {
    res = await postChat({ ...req, signal: dog.signal }, true);
  } catch (err) {
    dog.stop();
    if (dog.timedOut()) {
      throw new ApiError(
        `No response in ${Math.round(idleMs / 1000)}s. The model may still be working server-side — retry, or raise requestTimeoutMs in config.json.`,
        504,
      );
    }
    throw err;
  }
  if (!res.body) {
    dog.stop();
    throw new ApiError("Empty response from the server", 502);
  }

  const protocol = protocolForModel(req.model);
  const acc = new ToolCallAccumulator();
  const responsesParser = protocol === "responses" ? new ResponsesStreamParser() : null;
  const anthropicParser = protocol === "anthropic" ? new AnthropicStreamParser() : null;
  let finishReason = "";
  let usage: Usage | undefined;
  let buffer = "";
  const decoder = new TextDecoder();

  try {
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    dog.kick();
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    // SSE frames are separated by a blank line; tolerate CRLF.
    while ((sep = findFrameEnd(buffer)) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, "");
      const events = parseFrame(frame);
      for (const payload of events) {
        if (payload === "[DONE]") continue;
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }

        if (responsesParser) {
          for (const ev of responsesParser.handle(json)) yield ev;
          continue;
        }
        if (anthropicParser) {
          for (const ev of anthropicParser.handle(json)) yield ev;
          continue;
        }

        if (json.error) {
          const body = JSON.stringify(json);
          const detail = extractError(body);
          // A router whose upstream sat silent answers mid-stream with words
          // instead of a hang-up. The request never reached an answer, so the
          // step is resent rather than reported as a refusal.
          if (/upstream idle timeout/i.test(detail)) throw new ApiError(`HTTP 500 — ${detail}`, 500, body);
          throw new ApiError(describeStatus(500, body), 500, body);
        }
        if (json.usage) usage = normalizeUsage(json.usage);
        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", text: reasoning };
        if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
        if (delta.tool_calls) acc.push(delta.tool_calls);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  } catch (err) {
    if (dog.timedOut()) {
      throw new ApiError(
        `Stream stalled: ${Math.round(idleMs / 1000)}s with no data. A host that does not stream reasoning sits silent while the model thinks — retry, or raise requestTimeoutMs in config.json.`,
        504,
      );
    }
    throw err;
  } finally {
    dog.stop();
  }

  if (responsesParser) {
    const r = responsesParser.result();
    yield { type: "done", toolCalls: r.toolCalls, usage: r.usage, finishReason: r.finishReason };
    return;
  }
  if (anthropicParser) {
    const r = anthropicParser.result();
    yield { type: "done", toolCalls: r.toolCalls, usage: r.usage, finishReason: r.finishReason };
    return;
  }

  const toolCalls = acc.result();
  yield {
    type: "done",
    toolCalls,
    usage,
    finishReason: finishReason || (toolCalls.length ? "tool_calls" : "stop"),
  };
}

function findFrameEnd(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseFrame(frame: string): string[] {
  const payloads: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const l = rawLine.trimEnd();
    if (!l || l.startsWith(":")) continue;
    if (l.startsWith("data:")) payloads.push(l.slice(5).trim());
  }
  return payloads;
}

function normalizeUsage(u: any): Usage {
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0) || 0;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  return {
    // Hosts disagree on whether the prompt count includes what came from the
    // cache: OpenAI counts it in, Anthropic reports it beside. A cache read
    // larger than the whole prompt is the tell, and the two are added there —
    // otherwise "97% cached" turns into "793% cached" and the cost is wrong
    // in the same direction.
    prompt_tokens: cached > prompt ? prompt + cached : prompt,
    completion_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0),
    total_tokens: Number(u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
    cached_tokens: cached || undefined,
    reasoning_tokens:
      Number(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0) || undefined,
  };
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason: string;
}

/** Non-streaming completion, used for compaction, titles and quick utilities. */
export async function complete(req: ChatRequest): Promise<CompletionResult> {
  // The streaming path has an idle watchdog; this one has no bytes to watch,
  // so a flat deadline stands in — without it a dead connection on a
  // non-streamed call (compaction, titles) would hang forever.
  const idleMs = loadConfig().requestTimeoutMs ?? 600_000;
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  req.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (req.signal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, idleMs);
  timer.unref?.();

  let json: any;
  try {
    const res = await postChat({ ...req, signal: controller.signal }, false);
    json = await res.json();
  } catch (err) {
    if (timedOut) {
      throw new ApiError(
        `No response in ${Math.round(idleMs / 1000)}s — retry, or raise requestTimeoutMs in config.json.`,
        504,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onExternalAbort);
  }
  const protocol = protocolForModel(req.model);
  if (protocol === "responses") return parseResponsesResult(json);
  if (protocol === "anthropic") return parseAnthropicResult(json);
  const choice = json.choices?.[0] ?? {};
  return {
    content: choice.message?.content ?? "",
    toolCalls: choice.message?.tool_calls ?? [],
    usage: json.usage ? normalizeUsage(json.usage) : undefined,
    finishReason: choice.finish_reason ?? "stop",
  };
}

export interface ProviderCheck {
  ok: boolean;
  detail: string;
  /** HTTP status behind a failure, so callers can tell a dead token from a
   *  lapsed plan: the first is worth deleting, the second is not. */
  status?: number;
}

/**
 * Credential probe for any configured provider. A coding endpoint may have no
 * catalog at all, so a 404 from /models says nothing either way — only a
 * refusal to serve the account counts as a failure.
 */
export async function verifyProvider(providerId: string): Promise<ProviderCheck> {
  let auth;
  try {
    auth = await resolveAuth(providerId);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
  try {
    const mode = modeFor(providerId);
    const catalog = (mode ? modeConfig(providerId, mode) : null)?.catalogPath ?? "models";
    const res = await fetch(`${auth.baseUrl}/${catalog}`, { headers: auth.headers });
    if (res.ok) {
      const body: any = await res.json().catch(() => ({}));
      const list: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      const cfg = mode ? modeConfig(providerId, mode) : null;
      // A public listing answers the same to everyone: it has said nothing
      // about the credential, so the credential has to be asked elsewhere.
      if (cfg?.publicCatalog) return probeAuth(auth, providerId, list);
      return { ok: true, detail: list.length ? `${list.length} models available` : "credential accepted" };
    }
    // 401/403 — the token is bad. 402 — the token is fine but the plan will
    // not pay for anything, which is equally unusable and differently fixed.
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        detail: describeStatus(res.status, await res.text().catch(() => "")),
      };
    }
    return { ok: true, detail: `credential accepted (no model list: HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Asks the request endpoint what the listing could not: is this key any good?
 *
 * The question is put as a request the host will refuse whatever the answer —
 * an empty message list never reaches a model, so nothing is billed and no
 * output is waited for — and only the refusal is read. A bad credential is
 * turned away before the body is looked at; anything else means the key got
 * through and the complaint is about the empty request, which is the point.
 *
 * The bar for failing is deliberately high. Being wrong the safe way leaves a
 * bad key to fail on the first turn, which is what happened before this
 * existed; being wrong the other way deletes a good one at login.
 */
async function probeAuth(auth: ResolvedAuth, providerId: string, catalog: any[]): Promise<ProviderCheck> {
  const n = catalog.length;
  const accepted = { ok: true, detail: n ? `${n} models available` : "credential accepted" };
  // Whichever model the host lists first, in whichever dialect it speaks: the
  // request is never served, only authenticated.
  const first = String(catalog[0]?.id ?? catalog[0]?.model ?? "").trim();
  if (!first) return accepted;
  const protocol = protocolForModel(qualifyModelId(providerId, first));
  const body =
    protocol === "responses"
      ? { model: first, input: [] }
      : protocol === "anthropic"
        ? { model: first, messages: [], max_tokens: 1 }
        : { model: first, messages: [] };
  try {
    const res = await fetch(`${auth.baseUrl}${pathFor(protocol)}`, {
      method: "POST",
      headers: { ...auth.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Only 401, and only when the refusal is actually about the credential.
    // A plan that will not pay (402) or a model the account may not have (403)
    // both mean the key is real; and a host can answer 401 to a complaint
    // about the model — Zen does — which would otherwise get a good key
    // deleted over a request this probe chose itself.
    const refusal = res.status === 401 ? await res.text().catch(() => "") : "";
    if (res.status === 401 && /auth|api.?key|credential|unauthor|token/i.test(refusal)) {
      return { ok: false, status: 401, detail: describeStatus(401, refusal) };
    }
    return accepted;
  } catch {
    // The listing did come back, so the host is reachable and this is a
    // stumble on the way to a second opinion, not a verdict on the key.
    return accepted;
  }
}

/** Cheap credential probe used by `trc auth login`. */
export async function verifyKey(baseUrl: string, apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body: any = await res.json().catch(() => ({}));
      const n = Array.isArray(body?.data) ? body.data.length : 0;
      return { ok: true, detail: n ? `${n} models available` : "key accepted" };
    }
    return { ok: false, detail: describeStatus(res.status, await res.text().catch(() => "")) };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
