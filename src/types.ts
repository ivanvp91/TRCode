/** Shared types for the TokenRouter agentic CLI. */
import type { SpillStore } from "./tools/spill.js";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** An image attached to a message: what a vision model reads on the wire. */
export interface ImageAttachment {
  /** Image bytes, base64. Kept encoded so no step ever re-reads the file. */
  data: string;
  mime: string;
}

export interface Message {
  role: Role;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Screenshots and other images the model should see with this message. */
  images?: ImageAttachment[];
  /**
   * Local bookkeeping. `hidden` is stripped before hitting the wire; `skill`
   * marks an auto-loaded procedure, which the model must see but which would
   * bury the transcript if it were replayed.
   */
  meta?: { hidden?: boolean; ts?: number; model?: string; skill?: string };
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
  /**
   * Everything the model can produce, not just the one it is filed under. A
   * model that answers in text and can also return an image belongs in both
   * lists — it is a chat model, and it is also how you make a picture here.
   */
  modalities?: ("text" | "image" | "video" | "audio")[];
  /** Provider-reported creation timestamp (seconds), used for ordering. */
  created?: number;
  /**
   * True when the model is reachable through /v1/chat/completions with text.
   * Everything else (native Anthropic/Gemini, Responses-only, image, video,
   * audio) is listed but cannot be driven by this client.
   */
  chatCapable?: boolean;
}

/** One MCP server: how to launch it and, optionally, which tools to expose. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Expose only these tools (names as the server reports them). Every schema
   * rides along in every request, so a fat server is worth filtering.
   */
  tools?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Risk class drives the permission prompt. */
  risk: "read" | "write" | "shell" | "network" | "agent";
  /** Short one-line summary shown in the transcript while running. */
  summarize?(args: Record<string, any>): string;
  /**
   * Which end of an oversized result carries the answer. Logs and test runs
   * end with what the command was run for, so they keep their tail; a file
   * read or a listing keeps its head. See tools/spill.ts.
   */
  spillBias?: "head" | "tail";
  run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  output: string;
  /** Marks a failure so the loop can surface it distinctly. */
  isError?: boolean;
  /** Optional rich detail rendered to the user but not sent to the model. */
  display?: string;
  /** "diff" means `display` is already laid out and must be printed verbatim. */
  displayKind?: "text" | "diff";
  /**
   * Images for a vision model, sent as part of this tool result. The text
   * output still describes what happened; these ride along as what it saw.
   */
  images?: ImageAttachment[];
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** Depth in the agent tree: 0 = main agent, 1+ = spawned subagents. */
  depth: number;
  /** Returns true when the user (or policy) approves the action. */
  confirm(tool: ToolDef, args: Record<string, any>, preview?: string): Promise<boolean>;
  /**
   * True when the confirm() just answered had put `preview` on screen, so the
   * result can leave it out instead of printing the same diff a second time.
   * Consumed by the call: asking twice for the same preview answers false.
   */
  previewShown?(preview: string): boolean;
  /**
   * Stores what a file held before a write, so the turn can be undone. Absent
   * outside the REPL (a one-shot run has no session to keep it in).
   */
  snapshot?(opts: { path: string; tool: string; before: string | null; after: string }): void;
  /** Emits a line into the live transcript. */
  emit(line: string): void;
  /** Files already read this session, used to guard blind overwrites. */
  readFiles: Set<string>;
  /**
   * Where oversized tool output is parked so the history stays append-only.
   * Absent outside the REPL, where there is no session to park it beside.
   */
  spill?: SpillStore;
}

export interface StreamEvent {
  type: "text" | "tool_call_delta" | "usage" | "done" | "reasoning";
  text?: string;
  usage?: Usage;
  finishReason?: string;
  toolCalls?: ToolCall[];
}
