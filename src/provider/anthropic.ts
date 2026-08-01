/**
 * Anthropic Messages API adapter (/v1/messages).
 *
 * Differences that matter here: the system prompt is a separate field, tool
 * results travel as `tool_result` blocks inside a *user* message, and
 * max_tokens is mandatory.
 */
import { estimateTokens } from "../usage.js";
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
}

const CACHE_CONTROL = { type: "ephemeral" as const };
/**
 * Anthropic ignores a breakpoint below ~1024 tokens (2048 on Haiku), and a
 * cache write costs 25% more than plain input. Below this there is nothing to
 * gain and something to lose, so we do not ask.
 */
const MIN_CACHEABLE_TOKENS = 2048;

const DEFAULT_MAX_TOKENS = 8192;

/** Thinking budgets per effort level; "off"/"minimal" disable it. */
const THINKING_BUDGET: Record<string, number> = { low: 2048, medium: 6144, high: 12288 };

/** Chat-shaped history → Anthropic `system` + `messages`. */
export function toAnthropicMessages(messages: Message[]): { system: string; messages: unknown[] } {
  const system: string[] = [];
  const out: { role: "user" | "assistant"; content: any[] }[] = [];

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
  }

  // The API requires the conversation to start with a user turn.
  if (out.length && out[0].role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(continued)" }] });
  }

  return { system: system.join("\n\n"), messages: out };
}

export function buildAnthropicBody(req: AnthropicRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(req.messages);
  const wantsThinking = Boolean(req.effort && req.effort !== "off" && req.thinkingForm !== "none");
  const form = req.thinkingForm ?? "adaptive";
  const budget = wantsThinking && form === "budget" ? THINKING_BUDGET[req.effort as string] : undefined;
  // With an explicit budget the answer needs room on top of it.
  const maxTokens = req.maxTokens ?? (budget ? budget + DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS);

  const cache = req.cache !== false && estimateTokens(system) + sizeOfMessages(req.messages) >= MIN_CACHEABLE_TOKENS;

  const body: Record<string, unknown> = {
    model: req.model,
    messages: cache ? withCacheBreakpoint(messages) : messages,
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
      input_schema: t.parameters as unknown,
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
 * Marks the end of the history so the next step reads it back instead of
 * re-sending it at full price. The breakpoint moves forward every request:
 * this one writes the cache, the next one hits it.
 */
function withCacheBreakpoint(messages: unknown[]): unknown[] {
  if (!messages.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1] as { role: string; content: any[] };
  if (!Array.isArray(last?.content) || !last.content.length) return messages;
  const content = last.content.slice();
  content[content.length - 1] = { ...content[content.length - 1], cache_control: CACHE_CONTROL };
  out[out.length - 1] = { ...last, content };
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
      this.usage.prompt_tokens = Number(u.input_tokens ?? 0);
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
  const input = Number(u.input_tokens ?? 0);
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
