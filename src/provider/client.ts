/** OpenAI-compatible client for TokenRouter, with SSE streaming and retries. */
import { loadConfig, saveConfig, type Effort } from "../config.js";
import type { Message, StreamEvent, ToolCall, ToolDef, Usage } from "../types.js";
import { protocolFor, type Protocol } from "./protocol.js";
import { buildResponsesBody, parseResponsesResult, ResponsesStreamParser } from "./responses.js";
import { AnthropicStreamParser, buildAnthropicBody, parseAnthropicResult } from "./anthropic.js";

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

/** Current form for a model, defaulting to the first one we try. */
function ladderFor(model: string): EffortForm[] {
  return EFFORT_LADDER[protocolFor(model)] ?? EFFORT_LADDER.openai;
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
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function applyEffort(body: Record<string, unknown>, model: string, effort: Effort | undefined): void {
  if (!effort || effort === "off") return;
  const form = formFor(model);
  if (form === "none") return;
  if (form === "reasoning_effort") body.reasoning_effort = effort;
  else body.reasoning = { effort };
}

/** True when a 400 is about the reasoning parameter rather than our payload. */
function isEffortComplaint(body: string): boolean {
  return /reasoning|effort/i.test(body);
}

function buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const cfg = loadConfig();
  const body: Record<string, unknown> = {
    model: req.model,
    messages: wireMessages(req.messages),
    stream,
  };
  applyEffort(body, req.model, req.effort);
  const tools = wireTools(req.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const temp = req.temperature ?? cfg.temperature;
  if (temp !== undefined) body.temperature = temp;
  const max = req.maxTokens ?? cfg.maxTokens;
  if (max !== undefined) body.max_tokens = max;
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    throw new ApiError("No API key. Run: trc auth login", 401);
  }
  return fetch(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      "User-Agent": "trcode-cli",
    },
    body: JSON.stringify(body),
    signal,
  });
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function postWithRetry(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const res = await post(path, body, signal);
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      if (!RETRYABLE.has(res.status) || attempt === 3) {
        throw new ApiError(describeStatus(res.status, text), res.status, text);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 700;
      await sleep(waitMs, signal);
      lastErr = new ApiError(describeStatus(res.status, text), res.status, text);
    } catch (err) {
      if (err instanceof ApiError && !RETRYABLE.has(err.status)) throw err;
      if ((err as any)?.name === "AbortError") throw err;
      if (attempt === 3) throw err;
      lastErr = err;
      await sleep(2 ** attempt * 700, signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function describeStatus(status: number, body: string): string {
  const detail = extractError(body);
  switch (status) {
    case 401:
      return `401 — key rejected. Check with: trc auth login${detail ? ` (${detail})` : ""}`;
    case 403:
      return `403 — access to this model is denied${detail ? ` (${detail})` : ""}`;
    case 404:
      return `404 — model or endpoint not found${detail ? ` (${detail})` : ""}`;
    case 429:
      return `429 — rate limit exceeded${detail ? ` (${detail})` : ""}`;
    default:
      return `HTTP ${status}${detail ? ` — ${detail}` : ""}`;
  }
}

function extractError(body: string): string {
  try {
    const j = JSON.parse(body);
    return String(j?.error?.message ?? j?.message ?? "").slice(0, 300);
  } catch {
    return body.slice(0, 200).replace(/\s+/g, " ").trim();
  }
}

/**
 * Sends a chat request; if the host rejects the reasoning parameter, drops it
 * and retries once so an unsupported model degrades instead of failing.
 */
async function postChat(req: ChatRequest, stream: boolean): Promise<Response> {
  const path = pathFor(protocolFor(req.model));
  for (;;) {
    try {
      return await postWithRetry(path, buildBodyFor(req, stream), req.signal);
    } catch (err) {
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
function buildBodyFor(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const cfg = loadConfig();
  const protocol = protocolFor(req.model);
  if (protocol === "responses") {
    const body = buildResponsesBody(
      {
        model: req.model,
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
        model: req.model,
        messages: req.messages,
        tools: req.tools,
        effort: form === "none" ? "off" : req.effort,
        thinkingForm: form === "budget" ? "budget" : form === "none" ? "none" : "adaptive",
        maxTokens: req.maxTokens ?? cfg.maxTokens,
        temperature: req.temperature ?? cfg.temperature,
      },
      stream,
    );
  }
  return buildBody(req, stream);
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
function withIdleWatchdog(external: AbortSignal | undefined, idleMs: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  if (external?.aborted) controller.abort();

  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleMs);
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    external?.removeEventListener("abort", onExternalAbort);
  };

  kick();
  return { signal: controller.signal, kick, stop, timedOut: () => timedOut };
}

/** Streams a chat completion, yielding text deltas then a final `done` event. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const idleMs = loadConfig().requestTimeoutMs ?? 300_000;
  const dog = withIdleWatchdog(req.signal, idleMs);

  let res: Response;
  try {
    res = await postChat({ ...req, signal: dog.signal }, true);
  } catch (err) {
    dog.stop();
    if (dog.timedOut()) {
      throw new ApiError(`No response in ${Math.round(idleMs / 1000)}s. Try another model or retry.`, 504);
    }
    throw err;
  }
  if (!res.body) {
    dog.stop();
    throw new ApiError("Empty response from the server", 502);
  }

  const protocol = protocolFor(req.model);
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

        if (json.error) throw new ApiError(extractError(JSON.stringify(json)), 500, JSON.stringify(json));
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
      throw new ApiError(`Stream stalled: ${Math.round(idleMs / 1000)}s with no data.`, 504);
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
  return {
    prompt_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
    completion_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0),
    total_tokens: Number(u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
    cached_tokens: Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0) || undefined,
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
  const res = await postChat(req, false);
  const json: any = await res.json();
  const protocol = protocolFor(req.model);
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
