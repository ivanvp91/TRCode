/**
 * The agent loop: stream a completion, execute any tool calls, feed the
 * results back, repeat until the model stops calling tools.
 */
import { streamChat, ApiError, describeConnectionDrop, isConnectionDrop } from "../provider/client.js";
import { loadConfig, type Effort } from "../config.js";
import { trimForRequest } from "../session/trim.js";
import { boundToolOutput } from "../tools/spill.js";
import { contextWindowFor } from "../provider/models.js";
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
  onToolEnd?(tool: ToolDef, ok: boolean, display: string, call: ToolCall, kind?: "text" | "diff"): void;
  onUsage?(model: string, usage: Usage | undefined): void;
  /** Assistant finished a message (text turn boundary). */
  onAssistantMessage?(m: Message): void;
  /** Old tool output was shortened to keep the request within budget. */
  onTrim?(savedTokens: number, count: number): void;
  /** The connection died before the model said anything; the step is being resent. */
  onReconnect?(reason: string, attempt: number, of: number): void;
}

export interface RunOptions {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDef[];
  toolContext: ToolContext;
  catalog: ModelInfo[];
  usage: UsageTracker;
  /** Ceiling on tool-call rounds; 0 or less means none. */
  maxSteps: number;
  signal: AbortSignal;
  /** Reasoning budget for this run; resolved by the caller. */
  effort?: Effort;
  /** Interactive stall handler; see ChatRequest.onStall. */
  onStall?: (idleMs: number) => Promise<boolean>;
  /** A send is held back by a learned rate limit; see ChatRequest.onRateWait. */
  onRateWait?: (waitMs: number, model: string, said: string) => void;
  events?: AgentEvents;
  /** Tool calls in one assistant turn run concurrently up to this many. */
  toolConcurrency?: number;
  /**
   * Called at every step boundary with what the model just said and called.
   * Anything returned is spliced into the history before the next request.
   *
   * This is where a skill reaches a turn that had no way of asking for it: the
   * catalogue is read once, at the start, when the model still describes the
   * task in the user's words. Six steps in it knows what the work actually is,
   * and by then nothing is looking. See skills/match.ts.
   */
  interject?: (assistant: Message, calls: ToolCall[]) => Message | null;
}

export interface RunResult {
  /** Messages produced during this run, already appended to options.messages. */
  finalText: string;
  steps: number;
  stoppedBecause: "stop" | "max_steps" | "aborted" | "length";
}

/**
 * Far past any sane tool call (~500k tokens of output): a generation that
 * produced this much has looped, and downstream consumers (diff preview,
 * history) would choke on it. Refused before parsing, so the model gets told
 * and the turn goes on.
 */
const MAX_ARGS_CHARS = 2_000_000;

export function parseArgs(raw: string): { ok: true; args: Record<string, any> } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, args: {} };
  if (trimmed.length > MAX_ARGS_CHARS) {
    const mb = (trimmed.length / 1_000_000).toFixed(1);
    return {
      ok: false,
      error: `arguments are ${mb} MB — far past any sane tool call; the generation likely looped. Retry with less content, or split the work.`,
    };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, args: parsed };
    return { ok: false, error: "arguments must be a JSON object" };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
}

/** Resolves when the signal fires, and never otherwise. */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Runs tool calls with bounded concurrency, preserving result order. */
async function runToolCalls(
  calls: ToolCall[],
  tools: ToolDef[],
  ctx: ToolContext,
  events: AgentEvents | undefined,
  concurrency: number,
  /** Filled as each call finishes, so an interrupt can keep what did. */
  results: Message[] = new Array(calls.length),
): Promise<Message[]> {
  let next = 0;
  // Bounding happens here, once, on the way into the history — and nothing
  // afterwards rewrites the message. That is the whole trick: a history only
  // ever appended to is a history a provider-side cache keeps matching.
  const cfg = loadConfig();

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
        const bound = boundToolOutput(ctx.spill, res.output, {
          tool: tool.name,
          bias: tool.spillBias,
          limit: cfg.toolResultMaxBytes,
          dedupeMin: cfg.trimMinBytes,
        });
        results[i] = {
          role: "tool",
          tool_call_id: call.id,
          name: tool.name,
          content: bound.content,
        };
        // The user sees what the tool actually produced; only what travels
        // with every later request is bounded.
        events?.onToolEnd?.(tool, !res.isError, res.display ?? res.output, call, res.displayKind);
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
  // Dropped connections, counted for the whole turn rather than per step: a
  // host that keeps hanging up should surface, not be retried forever.
  let netRetries = 0;
  const NET_RETRIES = 3;

  // 0 means no ceiling: the turn runs until the model stops calling tools,
  // the user interrupts it, or the host refuses.
  const cap = opts.maxSteps > 0 ? opts.maxSteps : Infinity;

  for (; step < cap; step++) {
    if (opts.signal.aborted) return { finalText, steps: step, stoppedBecause: "aborted" };
    events?.onStep?.(step);

    // Shorten stale tool output instead of resending megabytes every step.
    const cfg = loadConfig();
    // Half the window, unless a number was pinned. Trimming exists to keep a
    // request inside the model's context, so the window is what it should be
    // measured against; a constant makes a 1M model behave like a 128k one.
    const budget =
      cfg.maxRequestTokens > 0
        ? cfg.maxRequestTokens
        : Math.max(40_000, Math.floor(contextWindowFor(opts.model, opts.catalog) / 2));
    const trim =
      budget > 0 || cfg.maxToolResultBytes > 0
        ? trimForRequest(messages, {
            budget: budget > 0 ? budget : Infinity,
            keepRecent: cfg.trimKeepRecent,
            minTrimBytes: cfg.trimMinBytes,
            maxResultBytes: cfg.maxToolResultBytes,
          })
        : { messages, saved: 0, trimmed: 0 };
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
        onStall: opts.onStall,
        onRateWait: opts.onRateWait,
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
      // A connection that died on its own is not an answer: the host never
      // refused anything, so the same request is still valid. Resent while the
      // model has said nothing yet — once text is on the screen, a silent
      // resend would print the answer twice.
      if (isConnectionDrop(err) && !text.trim() && netRetries < NET_RETRIES) {
        netRetries++;
        events?.onReconnect?.(describeConnectionDrop(err), netRetries, NET_RETRIES);
        await new Promise((r) => setTimeout(r, netRetries * 1500));
        if (opts.signal.aborted) return { finalText, steps: step, stoppedBecause: "aborted" };
        step--; // the same step, sent again
        continue;
      }
      if (isConnectionDrop(err)) {
        const kept = text.trim() ? " The part that had already arrived is kept." : "";
        if (text.trim()) messages.push({ role: "assistant", content: text });
        throw new ApiError(`Connection lost: ${describeConnectionDrop(err)}.${kept} Nothing was sent twice — retry the turn.`, 0);
      }
      throw err instanceof ApiError ? err : new Error(`Request failed: ${(err as Error).message}`);
    }

    opts.usage.record(opts.model, usage, opts.catalog, Date.now());
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

    // Aborting must not wait for the tools to notice. Most honour the signal,
    // but one that does not — an MCP server that stopped answering, a child
    // that ignores its kill — would hold the turn open with nothing on screen
    // moving, which is exactly what "Esc does nothing" looks like. The results
    // of an interrupted round are discarded either way.
    const partial: Message[] = new Array(toolCalls.length);
    const toolMessages = await Promise.race([
      runToolCalls(toolCalls, tools, opts.toolContext, events, opts.toolConcurrency ?? 4, partial),
      whenAborted(opts.signal).then(() => [] as Message[]),
    ]);
    if (opts.signal.aborted) {
      // Every tool call needs its answer, interrupted or not: an assistant
      // message whose tool_calls lead nowhere is a history most hosts refuse,
      // and the model that reads it has no way to know the ten-minute build it
      // launched was stopped rather than never started — so it runs it again.
      messages.push(...interruptedResults(toolCalls, partial));
      return { finalText, steps: step + 1, stoppedBecause: "aborted" };
    }
    messages.push(...toolMessages);

    if (opts.signal.aborted) return { finalText, steps: step + 1, stoppedBecause: "aborted" };

    // After the results, not before: the message lands where the next request
    // will read it last, which is where an instruction is actually followed.
    const spliced = opts.interject?.(assistantMsg, toolCalls);
    if (spliced) messages.push(spliced);
  }

  return { finalText, steps: step, stoppedBecause: "max_steps" };
}

/**
 * What an interrupted round leaves in the history: whatever finished, and a
 * plain sentence for whatever did not. Said in the tool's own voice, because
 * that is where the model looks for the outcome of a call it made.
 */
function interruptedResults(calls: ToolCall[], done: Message[]): Message[] {
  return calls.map(
    (call, i) =>
      done[i] ?? {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content:
          "Interrupted by the user before it finished. Whatever it started may have run partway — " +
          "check the state before repeating it, and do not assume it succeeded or failed.",
      },
  );
}

/**
 * The ceiling a delegated run gets: its own, unless the user asked for a
 * tighter one. Subagents, plans and swarm steps keep a bound even when the
 * main loop has none — nobody is watching them, they cannot be told to
 * continue, and the agent that launched them can always launch another.
 */
export function stepCeiling(configured: number, own: number): number {
  return configured > 0 ? Math.min(configured, own) : own;
}
