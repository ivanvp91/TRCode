/**
 * Request projection log: what the model actually saw on every step.
 *
 * The session history is not what goes out. `trimForRequest` shortens old tool
 * results, skills and design references are spliced in by `interject`, and the
 * system prompt plus tool schemas ride along on top — none of that survives a
 * resume, because only `messages` are stored. So each request appends one line
 * to `<session-id>.proj.jsonl` beside the session file: the sizes of every
 * component, what was injected, what trim saved. Append-only and written
 * defensively, like Session.save — a disk hiccup must never kill a turn.
 */
import fs from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config.js";
import { estimateTokens } from "../usage.js";
import type { Message, ToolDef } from "../types.js";

export interface InjectedContext {
  /** Who put it there: "skill:<name>", "design-reference", … */
  source: string;
  tokens: number;
}

export interface RequestProjection {
  step: number;
  ts: number;
  model: string;
  /** System prompt + env + workspace listing. */
  systemTokens: number;
  /** Tool schemas as they go out on the wire. */
  schemaTokens: number;
  /** History after trim — what actually travelled. */
  historyTokens: number;
  injected: InjectedContext[];
  /** How many old results trim shortened for this request. */
  trimmed: number;
  /** Tokens trim saved versus sending the stored history as-is. */
  trimSaved: number;
  /** From the response's usage field, when the provider reports it. */
  promptTokens?: number;
  cachedTokens?: number;
}

export function projectionFile(cwd: string, sessionId: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.proj.jsonl`);
}

/** Appends one projection record. Never throws. */
export function appendProjection(cwd: string, sessionId: string, p: RequestProjection): void {
  try {
    fs.appendFileSync(projectionFile(cwd, sessionId), JSON.stringify(p) + "\n");
  } catch {
    /* never let logging kill the turn */
  }
}

/** All records for a session, oldest first; missing file means none yet. */
export function loadProjections(cwd: string, sessionId: string): RequestProjection[] {
  let raw: string;
  try {
    raw = fs.readFileSync(projectionFile(cwd, sessionId), "utf8");
  } catch {
    return [];
  }
  const out: RequestProjection[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as RequestProjection;
      if (typeof p?.step === "number") out.push(p);
    } catch {
      /* a torn or foreign line is skipped, not fatal */
    }
  }
  return out;
}

/** Removes the log alongside its session (Session.remove calls this). */
export function removeProjection(cwd: string, sessionId: string): void {
  try {
    fs.unlinkSync(projectionFile(cwd, sessionId));
  } catch {
    /* nothing to remove */
  }
}

export function systemPromptSize(systemPrompt: string): number {
  return estimateTokens(systemPrompt);
}

/** Tool schemas cost roughly what their JSON costs, plus call overhead per tool. */
export function toolSchemaSize(tools: ToolDef[]): number {
  let n = 0;
  for (const t of tools) n += estimateTokens(JSON.stringify(t.parameters ?? {})) + 12;
  return n;
}

/** Wire history size after trim, images included at their base64 weight. */
export function historyWireSize(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(String(m.content ?? ""));
    for (const img of m.images ?? []) n += Math.ceil(img.data.length / 4);
    for (const tc of m.tool_calls ?? []) n += estimateTokens(tc.function.arguments) + 12;
  }
  return n;
}
