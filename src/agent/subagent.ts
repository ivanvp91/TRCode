/**
 * Subagents: the `task` tool spawns an independent agent with its own
 * context and model. Several task calls emitted in one assistant turn run
 * concurrently, which is the whole point — parallel exploration without
 * polluting the lead agent's context.
 *
 * Subagents get every tool except `task` itself, so the tree is one level deep
 * and cannot fan out unboundedly.
 *
 * A finished subagent is parked with its own history under an agent_id, so
 * the lead can send it a follow-up — "now fix what you found" — without
 * re-briefing a fresh one that has to rediscover everything.
 */
import { c } from "../ui/ansi.js";
import { padded, truncate } from "../ui/render.js";
import { runWorker, taskModels, resolveWorkerModel } from "./worker.js";
export { subagentMode } from "./worker.js";
import { wireModelId } from "../provider/registry.js";
import { roleSteps, subagentRoles, type SubagentRole } from "./roles.js";
import { buildSystemPrompt } from "./prompt.js";
import { stepCeiling } from "./loop.js";
import { ApiError } from "../provider/client.js";
import { UsageTracker, fmtTokens } from "../usage.js";
import type { Effort } from "../config.js";
import type { Message, ModelInfo, ToolDef } from "../types.js";
import type { Skill } from "../skills/loader.js";

/**
 * One running helper as the turn bar lists it: the model it runs on, how much
 * of its step budget it has spent, and what it has cost so far.
 */
export interface SubagentProgress {
  id: number;
  label: string;
  /** Display name, provider prefix stripped — that is what the bar shows. */
  model: string;
  /** Steps taken so far, against the budget the helper was given. */
  steps: number;
  maxSteps: number;
  /** Input + output tokens this helper has spent. */
  tokens: number;
  /** Its latest action, shown after the counters. */
  line?: string;
}

/**
 * Rolling progress sink for subagent actions. With one, the running helpers are
 * listed in the turn bar — model, share of the step budget, tokens — instead of
 * piling lines up in the transcript, which keeps only each task's header and
 * its done/failed line.
 */
export interface SubagentActivity {
  begin(info: SubagentProgress): void;
  update(info: SubagentProgress): void;
  end(id: number): void;
}

/** A subagent that finished and can take a follow-up. */
interface ParkedAgent {
  id: number;
  label: string;
  model: string;
  readOnly: boolean;
  role?: string;
  messages: Message[];
  at: number;
  busy: boolean;
}

/**
 * Parked subagents of one session. Held in memory only: a follow-up continues
 * a helper from this run, and /new or /resume starts the registry over.
 */
export class SubagentRegistry {
  /** Oldest parked agents go first past this; each holds a whole history. */
  static readonly MAX = 8;
  private agents = new Map<number, ParkedAgent>();
  private owner = "";

  /** Empties the registry when the session it belongs to changes. */
  bind(session: string): void {
    if (session === this.owner) return;
    this.owner = session;
    this.agents.clear();
  }

  get(id: number): ParkedAgent | undefined {
    return this.agents.get(id);
  }

  park(agent: ParkedAgent): void {
    this.agents.set(agent.id, agent);
    const idle = [...this.agents.values()].filter((a) => !a.busy).sort((a, b) => a.at - b.at);
    while (this.agents.size > SubagentRegistry.MAX && idle.length) this.agents.delete(idle.shift()!.id);
  }

  drop(id: number): void {
    this.agents.delete(id);
  }

  ids(): number[] {
    return [...this.agents.keys()];
  }
}

export interface SubagentDeps {
  cwd: string;
  catalog: ModelInfo[];
  catalogNow?: () => ModelInfo[];
  skills: Skill[];
  /** Tools available to subagents (task is filtered out internally). */
  tools: () => ToolDef[];
  defaultModel: string;
  /** Reasoning budget resolver for whichever model the subagent runs on. */
  effortFor: (model: string) => Effort;
  maxSteps: number;
  /** Parent tracker; subagent requests land in it as they happen, marked as delegated. */
  usage: UsageTracker;
  activity?: SubagentActivity;
  /** Serialized turn-level approval and model setup, supplied by the REPL. */
  authorize?: () => Promise<boolean>;
  /** Where finished subagents wait for a follow-up; one per tool if omitted. */
  registry?: SubagentRegistry;
}

let counter = 0;

export function makeTaskTool(deps: SubagentDeps): ToolDef {
  const allowed = taskModels(deps.catalog, deps.defaultModel);
  const offered = allowed.slice(0, 24);
  const modelIds = offered.map((m) => m.id);
  const roles = subagentRoles();
  const roleNames = Object.keys(roles);
  const registry = deps.registry ?? new SubagentRegistry();

  return {
    name: "task",
    risk: "agent",
    description:
      "Launches a subagent on one subtask. It has its own context and the full tool set, " +
      "and returns only its final text — your context stays free of the intermediate steps.\n" +
      "Emit SEVERAL task calls in one turn to run them in parallel: different subsystems, different hypotheses, different models.\n" +
      "A request that splits into independent parts — ten languages, ten modules, the same edit in many files — is a fan-out: launch one subagent per part in that turn, without being asked, then join the results.\n" +
      "Write the assignment self-contained: the subagent cannot see this conversation. Say exactly what to return.\n" +
      "A follow-up to a finished subagent: pass its agent_id and only the new instruction — it keeps its history.\n" +
      "Subagents share your working directory; parallel writers must touch different files.\n" +
      "Do not use it for something a single read/grep would do — that is slower and more expensive.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short task name, 3-5 words" },
        prompt: {
          type: "string",
          description:
            "The full self-contained assignment: what to investigate or do, where to look, and in what form to return the result",
        },
        role: {
          type: "string",
          description: Object.entries(roles).map(([name, r]) => `${name}: ${r.description}`).join("; "),
          enum: roleNames.length ? roleNames : undefined,
        },
        agent_id: { type: "integer", description: "From an earlier result: continue that subagent" },
        model: {
          type: "string",
          description:
            "Model for the subagent, from this provider only. Defaults to the configured helper model, or the session's model in session mode. Omit unless told otherwise.",
          enum: modelIds.length ? modelIds : undefined,
        },
        read_only: {
          type: "boolean",
          description: "true — the subagent gets read and search only (no write/edit/shell). Safe for reconnaissance.",
        },
      },
      required: ["description", "prompt"],
    },
    summarize: (a) => String(a.description ?? "subagent") + (a.agent_id ? ` · #${a.agent_id}` : a.role ? ` · ${a.role}` : ""),

    async run(args, ctx) {
      const brief = String(args.prompt ?? "");
      const resumeId = args.agent_id === undefined || args.agent_id === null || args.agent_id === "" ? 0 : Number(args.agent_id);
      const parked = resumeId ? registry.get(resumeId) : undefined;
      if (resumeId && !parked) {
        const known = registry.ids();
        return {
          output:
            `There is no subagent with agent_id ${args.agent_id}` +
            (known.length ? ` — the ones that can take a follow-up are ${known.join(", ")}.` : " — none can take a follow-up in this session.") +
            " Launch a new one with a self-contained assignment instead.",
          isError: true,
        };
      }
      if (parked?.busy) {
        return { output: `Subagent ${parked.id} is still working on its previous assignment. Wait for that result before sending it another.`, isError: true };
      }
      const roleName = parked ? parked.role : typeof args.role === "string" && args.role.trim() ? args.role.trim().toLowerCase() : undefined;
      const role: SubagentRole | undefined = roleName ? roles[roleName] ?? subagentRoles()[roleName] : undefined;
      if (roleName && !role) {
        return { output: `Unknown role "${args.role}". Roles: ${roleNames.join(", ") || "none"}. Omit role or pick one of these.`, isError: true };
      }

      if (deps.authorize && !await deps.authorize()) {
        return { output: "Subagents were not approved or models were not selected for this turn. Continue the work yourself; do not request another subagent in this turn.", isError: true };
      }
      if (ctx.signal.aborted) return { output: "Subagent launch interrupted.", isError: true };
      const id = parked?.id ?? ++counter;
      const label = parked?.label ?? String(args.description ?? `task ${id}`);
      // A role takes tools away; nothing here gives them back.
      const readOnly = parked ? parked.readOnly : Boolean(args.read_only) || role?.readOnly === true;
      // Approval may have opened the model picker since this schema was built.
      const catalog = deps.catalogNow?.() ?? deps.catalog;
      const current = taskModels(catalog, deps.defaultModel);
      const dflt = current[0]?.id ?? deps.defaultModel;
      let model: string;
      if (parked) {
        // The history was written for this model; switching mid-conversation
        // hands one model's reasoning to another that never saw it.
        model = parked.model;
      } else {
        const asked = String(args.model || role?.model || dflt);
        model = resolveWorkerModel(current, asked, dflt);
        if (model !== asked) {
          padded(
            `  ${c.gray(
              `[${id}] ${asked} is not in the /subagents list — using ${model}`,
            )}`,
          );
        }
      }

      const usage = deps.usage.child("task");
      const tag = `  ${c.brightBlue(`├ [${id}]`)}`;
      const act = deps.activity;
      // The bar measures progress against the same ceiling the run gets, so a
      // helper that is about to be stopped reads ~100% rather than 40%.
      const budget = stepCeiling(roleSteps(deps.maxSteps, role), 40);
      const info: SubagentProgress = { id, label, model: wireModelId(model), steps: 0, maxSteps: budget, tokens: 0 };
      const spent = () => {
        const t = usage.totals();
        return t.input + t.output;
      };
      const step = (text: string) => {
        if (!act) return void padded(`${tag} ${c.dim(text)}`);
        info.line = text;
        act.update({ ...info, tokens: spent() });
      };
      const badges = [model, roleName, readOnly ? "read-only" : "", parked ? "follow-up" : ""].filter(Boolean).join(" · ");
      padded(`${tag} ${c.bold(label)} ${c.gray(`· ${badges}`)}`);

      const started = Date.now();
      act?.begin({ ...info, tokens: spent() });

      const messages: Message[] = parked?.messages ?? [];
      if (parked) {
        messages.push({ role: "user", content: brief });
        parked.busy = true;
      }
      const systemPrompt = role?.prompt
        ? `${buildSystemPrompt({ cwd: ctx.cwd, model, skills: [], subagent: true })}\n\n${role.prompt}`
        : undefined;

      try {
        const result = await runWorker({
          model,
          prompt: brief,
          messages,
          context: ctx,
          tools: deps.tools(),
          readOnly,
          skills: deps.skills,
          catalog,
          usage,
          maxSteps: roleSteps(deps.maxSteps, role),
          ceiling: 40,
          effort: role?.effort ?? deps.effortFor(model),
          systemPrompt,
          activity: step,
          events: {
            // The request about to go out is step n, so n steps are behind it.
            onStep: (n) => {
              info.steps = n;
              act?.update({ ...info, tokens: spent() });
            },
          },
        });

        registry.park({ id, label, model, readOnly, role: roleName, messages, at: Date.now(), busy: false });
        const t = usage.totals();
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        padded(
          `${tag} ${result.stoppedBecause === "stop" ? c.green("done") : c.yellow(result.stoppedBecause)} ${c.gray(
            `${secs}s · ${result.steps} steps · ${fmtTokens(t.input + t.output)} tokens`,
          )}`,
        );

        const handle = `\n\n[agent_id: ${id}]`;
        if (result.stoppedBecause === "aborted") {
          return { output: `Subagent "${label}" was interrupted by the user.`, isError: true };
        }
        if (!result.finalText.trim()) {
          return {
            output: `Subagent "${label}" finished with no text result (${result.steps} steps).${handle}`,
            isError: true,
          };
        }
        const capped =
          result.stoppedBecause === "max_steps"
            ? `\n\n[the subagent hit its step limit — this result may be incomplete]`
            : result.stoppedBecause === "looping"
              ? `\n\n[the subagent was stopped: it kept repeating one tool call and made no progress — this result may be incomplete]`
            : "";
        return {
          output: result.finalText + capped + handle,
          display: `[${id}] ${label}: ${truncate(result.finalText, 100)}`,
        };
      } catch (err) {
        // A history cut off mid-request may end on an unanswered tool call;
        // continuing it would be refused by the host. Nothing to resume.
        registry.drop(id);
        const msg = (err as Error)?.name === "AbortError" ? "interrupted" : (err as Error).message;
        padded(`${tag} ${c.red("failed")} ${c.dim(msg)}`);
        // What the model does next is decided by what this string says. After a
        // rate limit it used to read "crashed", and the model duly launched the
        // same fan-out again — four more refusals on a host that had just said
        // it serves one request at a time. So the message carries the remedy.
        const metered = err instanceof ApiError && err.status === 429;
        if (metered) {
          return {
            output:
              `Subagent "${label}" could not start: the host is rate-limiting this account (${msg}).
` +
              "Do not launch several subagents on this host again — they queue behind each other and " +
              "most will be refused. Either run one subtask at a time, or do the work in this turn yourself.",
            isError: true,
          };
        }
        return { output: `Subagent "${label}" crashed: ${msg}`, isError: true };
      } finally {
        act?.end(id);
      }
    },
  };
}
