/** Shared types for the TokenRouter agentic CLI. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Local-only bookkeeping, stripped before hitting the wire. */
  meta?: { hidden?: boolean; ts?: number; model?: string };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Populated when the provider reports cached prompt tokens. */
  cached_tokens?: number;
  /**
   * Thinking tokens, billed as output. A short visible answer can still cost
   * tens of thousands of them at a high reasoning budget, so they are tracked
   * separately — otherwise the bill looks inexplicable.
   */
  reasoning_tokens?: number;
}

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached input tokens, when the provider bills them separately. */
  cachedInput?: number;
}

export interface ModelInfo {
  id: string;
  /** Human label; falls back to the id. */
  label?: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: ModelPricing;
  /** Provider-reported owner, e.g. "moonshot". */
  owner?: string;
  supportsTools?: boolean;
  /** Endpoints the provider says this model speaks, e.g. ["openai"]. */
  endpoints?: string[];
  /** Provider tag string: "Text", "Image", "Text,Audio"… */
  tags?: string;
  /** What the model produces; drives the type selector in the picker. */
  modality?: "text" | "image" | "video" | "audio";
  /** Provider-reported creation timestamp (seconds), used for ordering. */
  created?: number;
  /**
   * True when the model is reachable through /v1/chat/completions with text.
   * Everything else (native Anthropic/Gemini, Responses-only, image, video,
   * audio) is listed but cannot be driven by this client.
   */
  chatCapable?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Risk class drives the permission prompt. */
  risk: "read" | "write" | "shell" | "network" | "agent";
  /** Short one-line summary shown in the transcript while running. */
  summarize?(args: Record<string, any>): string;
  run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  output: string;
  /** Marks a failure so the loop can surface it distinctly. */
  isError?: boolean;
  /** Optional rich detail rendered to the user but not sent to the model. */
  display?: string;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** Depth in the agent tree: 0 = main agent, 1+ = spawned subagents. */
  depth: number;
  /** Returns true when the user (or policy) approves the action. */
  confirm(tool: ToolDef, args: Record<string, any>, preview?: string): Promise<boolean>;
  /** Emits a line into the live transcript. */
  emit(line: string): void;
  /** Files already read this session, used to guard blind overwrites. */
  readFiles: Set<string>;
}

export interface StreamEvent {
  type: "text" | "tool_call_delta" | "usage" | "done" | "reasoning";
  text?: string;
  usage?: Usage;
  finishReason?: string;
  toolCalls?: ToolCall[];
}
