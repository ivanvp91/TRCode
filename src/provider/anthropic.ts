/**
 * Anthropic Messages API adapter (/v1/messages).
 *
 * Differences that matter here: the system prompt is a separate field, tool
 * results travel as `tool_result` blocks inside a *user* message, and
 * max_tokens is mandatory.
 */
import { estimateTokens } from "../usage.js";
import { normalizeToolSchema } from "./schema.js";
import type { Message, StreamEvent, ToolCall, ToolDef, Usage } from "../types.js";
import type { Effort } from "../config.js";

export interface AnthropicRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  effort?: Effort;
  maxTokens?: number;
  temperature?: number;
  /**
   * How this model wants its thinking configured:
   *  "adaptive" — Claude 5: thinking.adaptive + output_config.effort
   *  "budget"   — Claude 4.x: thinking.enabled + budget_tokens
   *  "none"     — do not ask for thinking at all
   */
  thinkingForm?: "adaptive" | "budget" | "none";
  /**
   * Marks cache breakpoints so the provider can reuse the prefix. Unlike the
   * OpenAI path, where caching is automatic, Anthropic caches nothing unless
   * asked — every step of an agent loop pays full price for the same history.
   */
  cache?: boolean;
  /** Cache lifetime to ask for; dropped to "5m" for hosts that refuse it. */
  cacheTtl?: CacheTtl;
}

/**
 * How long a written cache entry lives. Five minutes is the default and it is
 * the wrong one for an agent: a turn is minutes of tool calls, and the pause
 * while the user reads a diff is enough to drop the whole prefix, so the next
 * request re-prefills a context that had not changed by one byte. An hour costs
 * more to write (2x base against 1.25x) and it is not close — a write is paid
 * once, the reads are paid on every step of every turn after it.
 *
 * Measured on Claude Code: 93% of its cache writes go to the hour, and it sits
 * at a 99.1% hit-rate. Hosts that proxy the Messages API without supporting the
 * field degrade to five minutes on their own; see the ladder in client.ts.
 */
export type CacheTtl = "1h" | "5m";

function cacheControl(ttl: CacheTtl | undefined): Record<string, string> {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}
/**
 * Anthropic ignores a breakpoint below ~1024 tokens (2048 on Haiku), and a
 * cache write costs 25% more than plain input. Below this there is nothing to
 * gain and something to lose, so we do not ask.
 */
const MIN_CACHEABLE_TOKENS = 2048;

export const DEFAULT_MAX_TOKENS = 8192;

/** Thinking budgets per effort level; "off"/"minimal" disable it. */
export const THINKING_BUDGET: Record<string, number> = { low: 2048, medium: 6144, high: 12288 };

/** Chat-shaped history → Anthropic `system` + `messages`. */
export function toAnthropicMessages(messages: Message[]): {
  system: string;
  messages: unknown[];
  /**
   * Where the current turn begins — the last thing the user actually typed.
   * Fixed for the whole turn however many tool rounds follow it, which makes
   * it the one place a breakpoint can be written once and read back on every
   * later step. The moving one at the tail covers what has happened since.
   */
  anchor: { msg: number; block: number } | null;
} {
  const system: string[] = [];
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  let anchor: { msg: number; block: number } | null = null;

  const push = (role: "user" | "assistant", block: any) => {
    const last = out[out.length - 1];
    // Anthropic rejects two messages with the same role in a row.
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };

  for (const m of messages) {
    if (m.meta?.hidden) continue;

    if (m.role === "system") {
      if (m.content) system.push(String(m.content));
      continue;
    }

    if (m.role === "tool") {
      push("user", {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: String(m.content ?? ""),
      });
      continue;
    }

    if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: String(m.content) });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        push("assistant", { type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      continue;
    }

    push("user", { type: "text", text: String(m.content ?? "") });
    anchor = { msg: out.length - 1, block: out[out.length - 1].content.length - 1 };
  }

  // The API requires the conversation to start with a user turn.
  if (out.length && out[0].role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(continued)" }] });
    if (anchor) anchor = { ...anchor, msg: anchor.msg + 1 };
  }

  return { system: system.join("\n\n"), messages: out, anchor };
}

export function buildAnthropicBody(req: AnthropicRequest, stream: boolean): Record<string, unknown> {
  const { system, messages, anchor } = toAnthropicMessages(req.messages);
  const CACHE_CONTROL = cacheControl(req.cacheTtl);
  const wantsThinking = Boolean(req.effort && req.effort !== "off" && req.thinkingForm !== "none");
  const form = req.thinkingForm ?? "adaptive";
  const budget = wantsThinking && form === "budget" ? THINKING_BUDGET[req.effort as string] : undefined;
  // With an explicit budget the answer needs room on top of it.
  const maxTokens = req.maxTokens ?? (budget ? budget + DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS);

  const cache = req.cache !== false && estimateTokens(system) + sizeOfMessages(req.messages) >= MIN_CACHEABLE_TOKENS;

  const body: Record<string, unknown> = {
    model: req.model,
    messages: cache ? withCacheBreakpoints(messages, anchor, CACHE_CONTROL) : messages,
    max_tokens: maxTokens,
    stream,
  };
  // The system prompt and the tool schemas are identical on every step of a
  // turn, so they are the cheapest thing to cache and the safest to mark.
  if (system) {
    body.system = cache ? [{ type: "text", text: system, cache_control: CACHE_CONTROL }] : system;
  }
  if (req.tools?.length) {
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: normalizeToolSchema(t.parameters) as unknown,
    }));
    // A breakpoint on the last tool covers the whole block above it.
    if (cache && tools.length) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: CACHE_CONTROL } as typeof tools[number];
    }
    body.tools = tools;
  }
  if (wantsThinking && form === "adaptive") {
    // Claude 5 rejects {type:"enabled"} and wants the effort level instead.
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: req.effort === "minimal" ? "low" : req.effort };
  } else if (budget) {
    body.thinking = { type: "enabled", budget_tokens: budget };
    // Extended thinking forbids a custom temperature.
  } else if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }
  return body;
}

/**
 * Two breakpoints in the history, doing different jobs.
 *
 * The one at the tail moves forward every request: this step writes the cache,
 * the next one hits it. On its own it is fragile — the entry it wrote is the
 * only thing standing between the next request and a full re-prefill, and one
 * expiry throws away the whole conversation.
 *
 * So the second one sits at the start of the current turn, where nothing moves
 * however many tool rounds follow. It is written once and read back on every
 * step of the turn, and when the tail entry does lapse, the request still
 * matches everything up to the user's message instead of nothing at all.
 *
 * Four is the ceiling Anthropic allows, and this uses all four: the system
 * prompt, the tool block, the anchor, the tail.
 */
function withCacheBreakpoints(
  messages: unknown[],
  anchor: { msg: number; block: number } | null,
  control: Record<string, string>,
): unknown[] {
  if (!messages.length) return messages;
  const out = messages.slice();

  const mark = (msg: number, block: number): void => {
    const m = out[msg] as { role: string; content: any[] } | undefined;
    if (!Array.isArray(m?.content) || !m.content[block]) return;
    const content = m.content.slice();
    content[block] = { ...content[block], cache_control: control };
    out[msg] = { ...m, content };
  };

  const lastMsg = out.length - 1;
  const lastBlock = ((out[lastMsg] as { content?: any[] })?.content?.length ?? 0) - 1;
  if (lastBlock < 0) return messages;

  // On the first step of a turn the two land on the same block; one is enough,
  // and a duplicate would spend a breakpoint for nothing.
  if (anchor && !(anchor.msg === lastMsg && anchor.block === lastBlock)) mark(anchor.msg, anchor.block);
  mark(lastMsg, lastBlock);
  return out;
}

function sizeOfMessages(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(String(m.content ?? ""));
    for (const tc of m.tool_calls ?? []) n += estimateTokens(tc.function.arguments) + 12;
  }
  return n;
}

interface Block {
  type: "text" | "tool_use" | "thinking";
  id?: string;
  name?: string;
  json: string;
}

/** Turns Anthropic SSE events into our internal stream events. */
export class AnthropicStreamParser {
  private blocks = new Map<number, Block>();
  private usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  private finish = "";

  handle(json: any): StreamEvent[] {
    const out: StreamEvent[] = [];
    const type = String(json?.type ?? "");

    if (type === "message_start") {
      const u = json.message?.usage ?? {};
      this.usage.prompt_tokens = promptTokens(u);
      this.usage.cached_tokens = Number(u.cache_read_input_tokens ?? 0) || undefined;
    } else if (type === "content_block_start") {
      const b = json.content_block ?? {};
      this.blocks.set(Number(json.index ?? 0), {
        type: b.type === "tool_use" ? "tool_use" : b.type === "thinking" ? "thinking" : "text",
        id: b.id,
        name: b.name,
        json: "",
      });
    } else if (type === "content_block_delta") {
      const idx = Number(json.index ?? 0);
      const block = this.blocks.get(idx);
      const d = json.delta ?? {};
      if (d.type === "text_delta" && d.text) out.push({ type: "text", text: String(d.text) });
      else if (d.type === "thinking_delta" && d.thinking) out.push({ type: "reasoning", text: String(d.thinking) });
      else if (d.type === "input_json_delta" && block) block.json += String(d.partial_json ?? "");
    } else if (type === "message_delta") {
      const u = json.usage ?? {};
      if (u.output_tokens) this.usage.completion_tokens = Number(u.output_tokens);
      const stop = json.delta?.stop_reason;
      if (stop) this.finish = stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : "stop";
    } else if (type === "error") {
      throw new Error(String(json.error?.message ?? "Anthropic stream error"));
    }

    return out;
  }

  result(): { toolCalls: ToolCall[]; usage: Usage; finishReason: string } {
    const toolCalls: ToolCall[] = [...this.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b)
      .filter((b) => b.type === "tool_use" && b.name)
      .map((b, i) => ({
        id: b.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`,
        type: "function" as const,
        function: { name: b.name!, arguments: b.json || "{}" },
      }));

    this.usage.total_tokens = this.usage.prompt_tokens + this.usage.completion_tokens;
    return {
      toolCalls,
      usage: this.usage,
      finishReason: toolCalls.length ? "tool_calls" : this.finish || "stop",
    };
  }
}

/**
 * Everything the prompt cost. Anthropic reports the cache beside the input
 * rather than inside it, so the bare `input_tokens` is only the part that was
 * neither read from the cache nor written to it — and a status line built on
 * it would say a turn sent a tenth of what it did, and that more of it was
 * cached than was sent.
 */
function promptTokens(u: any): number {
  return (
    Number(u?.input_tokens ?? 0) +
    Number(u?.cache_read_input_tokens ?? 0) +
    Number(u?.cache_creation_input_tokens ?? 0)
  );
}

/** Non-streaming reply → text + calls. */
export function parseAnthropicResult(json: any): {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason: string;
} {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of json?.content ?? []) {
    if (block?.type === "text") content += String(block.text ?? "");
    else if (block?.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        type: "function",
        function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const u = json?.usage ?? {};
  const input = promptTokens(u);
  const output = Number(u.output_tokens ?? 0);
  return {
    content,
    toolCalls,
    usage:
      u.input_tokens !== undefined
        ? {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: input + output,
            // Reported like the streaming path does, or a non-streamed call
            // (a compaction, a subagent) looks as if nothing was cached.
            cached_tokens: Number(u.cache_read_input_tokens ?? 0) || undefined,
          }
        : undefined,
    finishReason: json?.stop_reason === "tool_use" ? "tool_calls" : json?.stop_reason === "max_tokens" ? "length" : "stop",
  };
}
