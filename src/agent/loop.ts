/**
 * The agent loop: stream a completion, execute any tool calls, feed the
 * results back, repeat until the model stops calling tools.
 */
import { streamChat, ApiError } from "../provider/client.js";
import { loadConfig, type Effort } from "../config.js";
import { trimForRequest } from "../session/trim.js";
import type { Message, ModelInfo, ToolCall, ToolContext, ToolDef, Usage } from "../types.js";
import { UsageTracker } from "../usage.js";

export interface AgentEvents {
  /** Assistant text delta. */
  onText?(delta: string): void;
  /** Chain-of-thought style delta, when a model exposes it. */
  onReasoning?(delta: string): void;
  /** A completion request is about to go out (step index, 0-based). */
  onStep?(step: number): void;
  onToolStart?(tool: ToolDef, args: Record<string, any>, call: ToolCall): void;
  onToolEnd?(tool: ToolDef, ok: boolean, display: string, call: ToolCall): void;
  onUsage?(model: string, usage: Usage | undefined): void;
  /** Assistant finished a message (text turn boundary). */
  onAssistantMessage?(m: Message): void;
  /** Old tool output was shortened to keep the request within budget. */
  onTrim?(savedTokens: number, count: number): void;
}

export interface RunOptions {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDef[];
  toolContext: ToolContext;
  catalog: ModelInfo[];
  usage: UsageTracker;
  maxSteps: number;
  signal: AbortSignal;
  /** Reasoning budget for this run; resolved by the caller. */
  effort?: Effort;
  events?: AgentEvents;
  /** Tool calls in one assistant turn run concurrently up to this many. */
  toolConcurrency?: number;
}

export interface RunResult {
  /** Messages produced during this run, already appended to options.messages. */
  finalText: string;
  steps: number;
  stoppedBecause: "stop" | "max_steps" | "aborted" | "length";
}

function parseArgs(raw: string): { ok: true; args: Record<string, any> } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, args: parsed };
    return { ok: false, error: "arguments must be a JSON object" };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
}

/** Runs tool calls with bounded concurrency, preserving result order. */
async function runToolCalls(
  calls: ToolCall[],
  tools: ToolDef[],
  ctx: ToolContext,
  events: AgentEvents | undefined,
  concurrency: number,
): Promise<Message[]> {
  const results: Message[] = new Array(calls.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= calls.length) return;
      const call = calls[i];
      const tool = tools.find((t) => t.name === call.function.name);

      if (!tool) {
        results[i] = {
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: `No such tool: "${call.function.name}". Available: ${tools.map((t) => t.name).join(", ")}`,
        };
        continue;
      }

      const parsed = parseArgs(call.function.arguments);
      if (!parsed.ok) {
        results[i] = {
          role: "tool",
          tool_call_id: call.id,
          name: tool.name,
          content: `Could not parse the arguments: ${parsed.error}. Call again with valid JSON.`,
        };
        events?.onToolEnd?.(tool, false, parsed.error, call);
        continue;
      }

      events?.onToolStart?.(tool, parsed.args, call);
      try {
        const res = await tool.run(parsed.args, ctx);
        results[i] = {
          role: "tool",
          tool_call_id: call.id,
          name: tool.name,
          content: res.output,
        };
        events?.onToolEnd?.(tool, !res.isError, res.display ?? res.output, call);
      } catch (err) {
        const msg = (err as Error)?.name === "AbortError" ? "Interrupted by the user." : (err as Error).message;
        results[i] = {
          role: "tool",
          tool_call_id: call.id,
          name: tool.name,
          content: `Tool error: ${msg}`,
        };
        events?.onToolEnd?.(tool, false, msg, call);
      }
    }
  };

  const n = Math.max(1, Math.min(concurrency, calls.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { messages, tools, events } = opts;
  let finalText = "";
  let step = 0;

  for (; step < opts.maxSteps; step++) {
    if (opts.signal.aborted) return { finalText, steps: step, stoppedBecause: "aborted" };
    events?.onStep?.(step);

    // Shorten stale tool output instead of resending megabytes every step.
    const budget = loadConfig().maxRequestTokens;
    const trim = budget > 0 ? trimForRequest(messages, { budget }) : { messages, saved: 0, trimmed: 0 };
    if (trim.trimmed) events?.onTrim?.(trim.saved, trim.trimmed);
    const wire: Message[] = [{ role: "system", content: opts.systemPrompt }, ...trim.messages];

    let text = "";
    let toolCalls: ToolCall[] = [];
    let finishReason = "stop";
    let usage: Usage | undefined;

    try {
      for await (const ev of streamChat({
        model: opts.model,
        messages: wire,
        tools,
        effort: opts.effort,
        signal: opts.signal,
      })) {
        if (ev.type === "text" && ev.text) {
          text += ev.text;
          events?.onText?.(ev.text);
        } else if (ev.type === "reasoning" && ev.text) {
          events?.onReasoning?.(ev.text);
        } else if (ev.type === "done") {
          toolCalls = ev.toolCalls ?? [];
          finishReason = ev.finishReason ?? "stop";
          usage = ev.usage;
        }
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        if (text) messages.push({ role: "assistant", content: text });
        return { finalText: text || finalText, steps: step, stoppedBecause: "aborted" };
      }
      throw err instanceof ApiError ? err : new Error(`Request failed: ${(err as Error).message}`);
    }

    opts.usage.record(opts.model, usage, opts.catalog);
    events?.onUsage?.(opts.model, usage);

    const assistantMsg: Message = {
      role: "assistant",
      content: text || null,
      meta: { model: opts.model },
    };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);
    events?.onAssistantMessage?.(assistantMsg);

    if (text) finalText = text;

    if (!toolCalls.length) {
      return { finalText, steps: step + 1, stoppedBecause: finishReason === "length" ? "length" : "stop" };
    }

    const toolMessages = await runToolCalls(
      toolCalls,
      tools,
      opts.toolContext,
      events,
      opts.toolConcurrency ?? 4,
    );
    messages.push(...toolMessages);

    if (opts.signal.aborted) return { finalText, steps: step + 1, stoppedBecause: "aborted" };
  }

  return { finalText, steps: step, stoppedBecause: "max_steps" };
}
