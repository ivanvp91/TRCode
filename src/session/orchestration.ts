import type { Message } from "../types.js";

export interface OrchestrationStep {
  id: string;
  title: string;
  prompt: string;
  deps: string[];
  writes: boolean;
  model?: string;
}

export interface OrchestrationResult {
  text: string;
  ok: boolean;
  ms: number;
}

export interface OrchestrationState {
  task: string;
  model: string;
  context: string;
  status: "running" | "paused" | "failed" | "complete";
  phase: "planning" | "execution" | "synthesis";
  steps: OrchestrationStep[];
  statuses: Record<string, "pending" | "running" | "done" | "failed" | "skipped" | "interrupted">;
  results: Record<string, OrchestrationResult>;
  /** Separate contexts let unfinished workers continue without replaying completed rounds. */
  messages: Record<string, Message[]>;
  answer?: string;
  revision?: string;
  startedAt: number;
  updatedAt: number;
}
