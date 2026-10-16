/**
 * Subagents: the `task` tool spawns an independent agent with its own
 * context and model. Several task calls emitted in one assistant turn run
 * concurrently, which is the whole point — parallel exploration without
 * polluting the lead agent's context.
 *
 * Subagents get every tool except `task` itself, so the tree is one level deep
 * and cannot fan out unboundedly.
 */
import { c } from "../ui/ansi.js";
import { padded, truncate } from "../ui/render.js";
import { runWorker, taskModels, resolveWorkerModel } from "./worker.js";
export { subagentMode } from "./worker.js";
import { ApiError } from "../provider/client.js";
import { UsageTracker, fmtTokens } from "../usage.js";
import type { Effort } from "../config.js";
import type { ModelInfo, ToolDef } from "../types.js";
import type { Skill } from "../skills/loader.js";

/**
 * Rolling progress sink for subagent actions. With one, per-step lines go to a
 * live preview (the turn bar) instead of piling up in the transcript — the
 * transcript keeps only each task's header and its done/failed line.
 */
export interface SubagentActivity {
  begin(): void;
  push(line: string): void;
  end(): void;
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
  /** Parent tracker; subagent usage is folded in when it finishes. */
  usage: UsageTracker;
  activity?: SubagentActivity;
  /** Serialized turn-level approval and model setup, supplied by the REPL. */
  authorize?: () => Promise<boolean>;
}

let counter = 0;

export function makeTaskTool(deps: SubagentDeps): ToolDef {
  const allowed = taskModels(deps.catalog, deps.defaultModel);
  const offered = allowed.slice(0, 24);
  const modelIds = offered.map((m) => m.id);

  return {
    name: "task",
    risk: "agent",
    description:
      "Launches a subagent on one subtask. It has its own context and the full tool set, " +
      "and returns only its final text — your context stays free of the intermediate steps.\n" +
      "Emit SEVERAL task calls in one turn to run them in parallel: different subsystems, different hypotheses, different models.\n" +
      "Write the assignment self-contained: the subagent cannot see this conversation. Say exactly what to return.\n" +
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
    summarize: (a) => String(a.description ?? "subagent"),

    async run(args, ctx) {
      if (deps.authorize && !await deps.authorize()) {
        return { output: "Subagents were not approved or models were not selected for this turn. Continue the work yourself; do not request another subagent in this turn.", isError: true };
      }
      if (ctx.signal.aborted) return { output: "Subagent launch interrupted.", isError: true };
      const id = ++counter;
      const label = String(args.description ?? `task ${id}`);
      const readOnly = Boolean(args.read_only);
      // Approval may have opened the model picker since this schema was built.
      const catalog = deps.catalogNow?.() ?? deps.catalog;
      const current = taskModels(catalog, deps.defaultModel);
      const dflt = current[0]?.id ?? deps.defaultModel;
      const asked = String(args.model || dflt);
      const model = resolveWorkerModel(current, asked, dflt);
      if (model !== asked) {
        padded(
          `  ${c.gray(
            `[${id}] ${asked} is not in the /subagents list — using ${model}`,
          )}`,
        );
      }

      const usage = new UsageTracker();
      const tag = `  ${c.brightBlue(`├ [${id}]`)}`;
      const act = deps.activity;
      const step = (text: string) => {
        if (act) act.push(`[${id}] ${text}`);
        else padded(`${tag} ${c.dim(text)}`);
      };
      padded(`${tag} ${c.bold(label)} ${c.gray(`· ${model}${readOnly ? " · read-only" : ""}`)}`);

      const started = Date.now();
      act?.begin();

      const brief = String(args.prompt ?? "");

      try {
        const result = await runWorker({
          model,
          prompt: brief,
          context: ctx,
          tools: deps.tools(),
          readOnly,
          skills: deps.skills,
          catalog,
          usage,
          maxSteps: deps.maxSteps,
          ceiling: 40,
          effort: deps.effortFor(model),
          activity: step,
        });

        deps.usage.absorb(usage);
        const t = usage.totals();
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        padded(
          `${tag} ${result.stoppedBecause === "stop" ? c.green("done") : c.yellow(result.stoppedBecause)} ${c.gray(
            `${secs}s · ${result.steps} steps · ${fmtTokens(t.input + t.output)} tokens`,
          )}`,
        );

        if (result.stoppedBecause === "aborted") {
          return { output: `Subagent "${label}" was interrupted by the user.`, isError: true };
        }
        if (!result.finalText.trim()) {
          return {
            output: `Subagent "${label}" finished with no text result (${result.steps} steps).`,
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
          output: result.finalText + capped,
          display: `[${id}] ${label}: ${truncate(result.finalText, 100)}`,
        };
      } catch (err) {
        deps.usage.absorb(usage);
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
        act?.end();
      }
    },
  };
}
