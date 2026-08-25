/**
 * OpenAI Responses API adapter (/v1/responses).
 *
 * Our history is kept in chat-completions shape, so it is translated on the
 * way out: assistant tool calls become `function_call` items and tool results
 * become `function_call_output` items, which is how the Responses API carries
 * a tool round-trip.
 */
import type { Message, StreamEvent, ToolCall, ToolDef, Usage } from "../types.js";
import type { Effort } from "../config.js";
import { normalizeToolSchema } from "./schema.js";
import { DEFAULT_MAX_TOKENS, THINKING_BUDGET } from "./anthropic.js";

/** The same ceiling the Anthropic dialect has; see buildAnthropicBody. */
function defaultMaxTokens(effort?: Effort): number {
  const budget = effort && effort !== "off" ? THINKING_BUDGET[effort] : undefined;
  return budget ? budget + DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}

export interface ResponsesRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  effort?: Effort;
  maxTokens?: number;
  temperature?: number;
}

/** Chat-shaped history → Responses `input` array. */
export function toResponsesInput(messages: Message[]): { instructions: string; input: unknown[] } {
  const instructions: string[] = [];
  const input: unknown[] = [];

  for (const m of messages) {
    if (m.meta?.hidden) continue;

    if (m.role === "system") {
      if (m.content) instructions.push(String(m.content));
      continue;
    }

    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: String(m.content ?? ""),
      });
      continue;
    }

    if (m.role === "assistant") {
      if (m.content) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: String(m.content) }],
        });
      }
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || "{}",
        });
      }
      continue;
    }

    input.push({
      role: "user",
      content: [
        { type: "input_text", text: String(m.content ?? "") },
        ...(m.images ?? []).map((img) => ({
          type: "input_image" as const,
          image_url: `data:${img.mime};base64,${img.data}`,
        })),
      ],
    });
  }

  return { instructions: instructions.join("\n\n"), input };
}

export function buildResponsesBody(req: ResponsesRequest, stream: boolean): Record<string, unknown> {
  const { instructions, input } = toResponsesInput(req.messages);
  const body: Record<string, unknown> = { model: req.model, input, stream };
  if (instructions) body.instructions = instructions;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: normalizeToolSchema(t.parameters),
    }));
    body.tool_choice = "auto";
  }
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  else body.max_output_tokens = defaultMaxTokens(req.effort);
  if (req.effort && req.effort !== "off") {
    // Responses takes the nested form; "minimal" is not a documented level.
    body.reasoning = { effort: req.effort === "minimal" ? "low" : req.effort };
  }
  return body;
}

interface CallSlot {
  id: string;
  name: string;
  args: string;
}

/** Turns a Responses SSE event into our internal stream events. */
export class ResponsesStreamParser {
  private calls = new Map<string, CallSlot>();
  private finish = "";
  private usage: Usage | undefined;

  handle(json: any): StreamEvent[] {
    const out: StreamEvent[] = [];
    const type = String(json?.type ?? "");

    if (type === "response.output_text.delta" && json.delta) {
      out.push({ type: "text", text: String(json.delta) });
    } else if (type === "response.reasoning_summary_text.delta" && json.delta) {
      out.push({ type: "reasoning", text: String(json.delta) });
    } else if (type === "response.output_item.added" && json.item?.type === "function_call") {
      const key = String(json.item.id ?? json.item.call_id ?? this.calls.size);
      this.calls.set(key, {
        id: String(json.item.call_id ?? json.item.id ?? key),
        name: String(json.item.name ?? ""),
        args: String(json.item.arguments ?? ""),
      });
    } else if (type === "response.function_call_arguments.delta") {
      const key = String(json.item_id ?? json.id ?? "");
      const slot = this.calls.get(key) ?? { id: key, name: "", args: "" };
      slot.args += String(json.delta ?? "");
      this.calls.set(key, slot);
    } else if (type === "response.output_item.done" && json.item?.type === "function_call") {
      const key = String(json.item.id ?? json.item.call_id ?? "");
      const slot = this.calls.get(key) ?? { id: "", name: "", args: "" };
      slot.id = String(json.item.call_id ?? slot.id ?? key);
      slot.name = String(json.item.name ?? slot.name);
      if (json.item.arguments) slot.args = String(json.item.arguments);
      this.calls.set(key, slot);
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const r = json.response ?? {};
      if (r.usage) this.usage = normalizeUsage(r.usage);
      this.finish = r.status === "incomplete" ? "length" : type === "response.failed" ? "error" : "stop";
    }

    return out;
  }

  result(): { toolCalls: ToolCall[]; usage?: Usage; finishReason: string } {
    const toolCalls: ToolCall[] = [...this.calls.values()]
      .filter((s) => s.name)
      .map((s, i) => ({
        id: s.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`,
        type: "function" as const,
        function: { name: s.name, arguments: s.args || "{}" },
      }));
    return {
      toolCalls,
      usage: this.usage,
      finishReason: this.finish === "length" ? "length" : toolCalls.length ? "tool_calls" : this.finish || "stop",
    };
  }
}

function normalizeUsage(u: any): Usage {
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number(u.total_tokens ?? input + output),
    cached_tokens: Number(u.input_tokens_details?.cached_tokens ?? 0) || undefined,
    reasoning_tokens: Number(u.output_tokens_details?.reasoning_tokens ?? 0) || undefined,
  };
}

/** Non-streaming reply → text + calls, for utility completions. */
export function parseResponsesResult(json: any): {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason: string;
} {
  const items: any[] = Array.isArray(json?.output) ? json.output : [];
  let content = String(json?.output_text ?? "");
  const toolCalls: ToolCall[] = [];

  for (const item of items) {
    if (item?.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" && !json?.output_text) content += String(part.text ?? "");
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? ""),
        type: "function",
        function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "{}") },
      });
    }
  }

  return {
    content,
    toolCalls,
    usage: json?.usage ? normalizeUsage(json.usage) : undefined,
    finishReason: toolCalls.length ? "tool_calls" : json?.status === "incomplete" ? "length" : "stop",
  };
}
