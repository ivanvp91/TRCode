/** Shared execution policy for task helpers, orchestration steps and swarm workers. */
import { loadConfig, type Effort } from "../config.js";
import { servesModality, usableModels } from "../provider/models.js";
import { splitModelId, wireModelId } from "../provider/registry.js";
import { pickSkill, skillInjection, skillInterjector } from "../skills/match.js";
import type { Skill } from "../skills/loader.js";
import { forkSpillStore } from "../tools/spill.js";
import type { Message, ModelInfo, ToolContext, ToolDef } from "../types.js";
import type { UsageTracker } from "../usage.js";
import { runAgent, stepCeiling, type AgentEvents, type RunResult } from "./loop.js";
import { buildSystemPrompt } from "./prompt.js";

export function subagentMode(providerId: string): "session" | "list" {
  const cfg = loadConfig();
  const saved = cfg.subagentMode?.[providerId];
  if (saved === "session" || saved === "list") return saved;
  return (cfg.subagentModels?.[providerId] ?? []).length ? "list" : "session";
}

export function workerModels(catalog: ModelInfo[], dflt: string): ModelInfo[] {
  const home = splitModelId(dflt).providerId;
  const runnable = usableModels(catalog).filter(
    (m) => m.chatCapable !== false && servesModality(m, "text") && splitModelId(m.id).providerId === home,
  );
  const list = subagentMode(home) === "list" ? loadConfig().subagentModels?.[home] ?? [] : [];
  const shortlist = runnable.filter((m) => list.includes(m.id));
  return shortlist.length
    ? [...runnable.filter((m) => m.id === dflt), ...shortlist.filter((m) => m.id !== dflt)]
    : runnable.filter((m) => m.id === dflt);
}

/** Task helpers prefer the configured list; the lead remains the planner's fallback. */
export function taskModels(catalog: ModelInfo[], dflt: string): ModelInfo[] {
  const provider = splitModelId(dflt).providerId;
  const models = workerModels(catalog, dflt);
  const chosen = subagentMode(provider) === "list" ? loadConfig().subagentModels?.[provider] ?? [] : [];
  const configured = models.filter((m) => chosen.includes(m.id));
  return configured.length ? configured : models;
}

export function subagentModelsConfigured(catalog: ModelInfo[], dflt: string): boolean {
  const provider = splitModelId(dflt).providerId;
  const cfg = loadConfig();
  if (subagentMode(provider) === "session") return cfg.subagentMode?.[provider] === "session";
  const selected = cfg.subagentModels?.[provider] ?? [];
  return workerModels(catalog, dflt).some((m) => selected.includes(m.id));
}

export function resolveWorkerModel(offered: ModelInfo[], want: string | undefined, dflt: string): string {
  return offered.find((m) => m.id === want || wireModelId(m.id) === want)?.id ?? dflt;
}

export interface WorkerOptions {
  model: string;
  prompt: string;
  /** When resuming, continue the worker's own tool history. */
  messages?: Message[];
  context: ToolContext;
  tools: ToolDef[];
  readOnly: boolean;
  catalog: ModelInfo[];
  skills: Skill[];
  effort: Effort;
  maxSteps: number;
  ceiling: number;
  usage: UsageTracker;
  systemPrompt?: string;
  events?: AgentEvents;
  activity?: (text: string) => void;
}

export async function runWorker(opts: WorkerOptions): Promise<RunResult> {
  const cfg = loadConfig();
  const activity = (text: string) => {
    if (!opts.context.signal.aborted) (opts.activity ?? opts.context.emit)?.(text);
  };
  const messages = opts.messages ?? [];
  if (!messages.length) messages.push({ role: "user", content: opts.prompt });
  const loaded = new Set(messages.map((m) => m.meta?.skill).filter((s): s is string => Boolean(s)));
  const skills = cfg.skillsEnabled && cfg.skillAuto !== false ? opts.skills : [];
  if (messages.length === 1) {
    const opening = pickSkill(skills, opts.prompt);
    if (opening) {
      loaded.add(opening.skill.name);
      messages.push({ role: "user", content: skillInjection(opening.skill), meta: { skill: opening.skill.name } });
      activity(`skill ${opening.skill.name}`);
    }
  }
  return await runAgent({
    model: opts.model,
    systemPrompt: opts.systemPrompt ?? buildSystemPrompt({ cwd: opts.context.cwd, model: opts.model, skills: [], subagent: true }),
    messages,
    tools: opts.tools.filter((t) => t.name !== "task" && (!opts.readOnly || t.risk === "read")),
    toolContext: {
      ...opts.context,
      depth: (opts.context.depth ?? 0) + 1,
      spill: forkSpillStore(opts.context.spill),
      emit: activity,
    },
    catalog: opts.catalog,
    usage: opts.usage,
    maxSteps: stepCeiling(opts.maxSteps, opts.ceiling),
    signal: opts.context.signal,
    effort: opts.effort,
    toolConcurrency: Math.max(1, Math.min(3, cfg.toolConcurrency)),
    interject: skillInterjector(skills, { loaded, max: 1, onLoad: (skill) => activity(`skill ${skill.name}`) }),
    onRateWait: (ms, model) => activity(`${wireModelId(model)} rate limit: waiting ${Math.ceil(ms / 1000)}s`),
    events: {
      ...opts.events,
      onToolStart: (tool, args, call) => {
        activity(`${tool.name} ${tool.summarize?.(args) ?? ""}`);
        opts.events?.onToolStart?.(tool, args, call);
      },
    },
  });
}

/** Bounded fan-out; abort never starts another queued worker. */
export async function runPool<T>(items: T[], concurrency: number, signal: AbortSignal, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (!signal.aborted && !failure) {
      const index = next++;
      if (index >= items.length) return;
      try { await run(items[index], index); }
      catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}
