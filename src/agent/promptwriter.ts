/**
 * The prompt writer: a small model turns a one-line ask into the brief a coding
 * agent can act on without a round of questions.
 *
 * The gap it closes is not politeness. "нарисуй интерфейс" costs the main model
 * a step of guessing what to look at, another of asking, and often a wrong
 * first attempt — all of it at the big model's price. A cheap model that knows
 * the working directory and which skills exist can state the target, the
 * constraints and what "done" looks like for a fraction of that, and the
 * expensive model starts from the brief instead of from the fog.
 */
import { complete } from "../provider/client.js";
import { loadConfig, type Effort } from "../config.js";
import { splitModelId } from "../provider/registry.js";
import type { ModelInfo } from "../types.js";
import type { Skill } from "../skills/loader.js";
import { UsageTracker } from "../usage.js";

const WRITER_PROMPT = `You turn a short request into a precise brief for a coding agent that works in a terminal, in the user's repository.

Rules:
- Answer with the brief itself. No preamble, no explanation, no quotes around it.
- Keep the user's intent exactly. Never add features, targets or opinions they did not express. When something is genuinely ambiguous, say so inside the brief as an assumption, in one clause.
- Write in the user's language.
- Be concrete about scope: what to change or produce, where to look first, what must not change.
- State what a finished result looks like, in one line.
- Do not invent file names, APIs or numbers. Refer to what the listing below actually shows.
- If one of the listed skills fits the task, name it in one line: "use the <name> skill".
- Length: as short as the task allows. A one-line ask rarely needs more than five lines.`;

export interface WriteOptions {
  task: string;
  model: string;
  cwd: string;
  skills: Skill[];
  catalog: ModelInfo[];
  /** Directory listing and git state, as the main model would see them. */
  context?: string;
  effort?: Effort;
  signal?: AbortSignal;
  /** Folded into the session's totals: this call is not free either. */
  usage?: UsageTracker;
}

/**
 * The model that writes prompts for this provider: the one pinned for it, else
 * the configured small model, else whatever the session runs on. A pin that
 * points at a model this provider does not serve is ignored rather than
 * obeyed into a 404.
 */
/** Stored when the user chose the default on purpose. */
export const AUTO = "auto";

export function promptModelFor(sessionModel: string, catalog: ModelInfo[]): string {
  const cfg = loadConfig();
  const { providerId } = splitModelId(sessionModel);
  const known = (id: string | undefined) =>
    Boolean(id) && (!catalog.length || catalog.some((m) => m.id === id && m.chatCapable !== false));
  const pinned = cfg.promptModels?.[providerId];
  // "auto" is a remembered answer — "use whatever the default is, and stop
  // asking me" — not a model. An absent entry is the question never asked.
  if (pinned && pinned !== AUTO && known(pinned)) return pinned;
  // The small model is only a candidate when it belongs to this provider —
  // borrowing another host's model would spend the wrong plan.
  if (known(cfg.smallModel) && splitModelId(cfg.smallModel).providerId === providerId) return cfg.smallModel;
  return sessionModel;
}

/** Skills the writer may point at, as one line each. */
function skillLines(skills: Skill[]): string {
  return skills
    .slice(0, 40)
    .map((s) => `- ${s.name}: ${(s.description ?? "").slice(0, 120)}`)
    .join("\n");
}

export async function composePrompt(opts: WriteOptions): Promise<string> {
  const parts = [`Working directory: ${opts.cwd}`];
  if (opts.context) parts.push(opts.context);
  if (opts.skills.length) parts.push(`Skills available to the agent:\n${skillLines(opts.skills)}`);
  parts.push(`The user's request:\n${opts.task}`);

  const usage = opts.usage ?? new UsageTracker();
  const res = await complete({
    model: opts.model,
    messages: [
      { role: "system", content: WRITER_PROMPT },
      { role: "user", content: parts.join("\n\n") },
    ],
    temperature: 0.3,
    effort: opts.effort,
    signal: opts.signal,
  });
  usage.record(opts.model, res.usage, opts.catalog);

  const text = res.content.trim();
  // A writer that returns nothing must not replace the user's own words.
  return text || opts.task;
}
