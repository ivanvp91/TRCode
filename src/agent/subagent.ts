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
import { line, truncate } from "../ui/render.js";
import { buildSystemPrompt } from "./prompt.js";
import { runAgent } from "./loop.js";
import { UsageTracker, fmtTokens } from "../usage.js";
import type { Effort } from "../config.js";
import type { ModelInfo, ToolDef } from "../types.js";
import type { Skill } from "../skills/loader.js";

export interface SubagentDeps {
  cwd: string;
  catalog: ModelInfo[];
  skills: Skill[];
  /** Tools available to subagents (task is filtered out internally). */
  tools: () => ToolDef[];
  defaultModel: string;
  /** Reasoning budget resolver for whichever model the subagent runs on. */
  effortFor: (model: string) => Effort;
  maxSteps: number;
  /** Parent tracker; subagent usage is folded in when it finishes. */
  usage: UsageTracker;
}

let counter = 0;

export function makeTaskTool(deps: SubagentDeps): ToolDef {
  const modelIds = deps.catalog.map((m) => m.id);

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
          description: "Model for the subagent. Defaults to the current one. Use a cheap one for mechanical work.",
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
      const id = ++counter;
      const label = String(args.description ?? `task ${id}`);
      const model = String(args.model || deps.defaultModel);
      const readOnly = Boolean(args.read_only);

      const available = deps
        .tools()
        .filter((t) => t.name !== "task")
        .filter((t) => (readOnly ? t.risk === "read" : true));

      const usage = new UsageTracker();
      const tag = c.brightBlue(`  ├ [${id}]`);
      line(`${tag} ${c.bold(label)} ${c.gray(`· ${model}${readOnly ? " · read-only" : ""}`)}`);

      const started = Date.now();
      try {
        const result = await runAgent({
          model,
          systemPrompt: buildSystemPrompt({
            cwd: deps.cwd,
            model,
            skills: deps.skills,
            subagent: true,
          }),
          messages: [{ role: "user", content: String(args.prompt ?? "") }],
          tools: available,
          toolContext: {
            ...ctx,
            depth: ctx.depth + 1,
            // Subagents share the read-guard set so edits stay coherent.
            emit: (l: string) => line(`${tag} ${c.dim(truncate(l, 90))}`),
          },
          catalog: deps.catalog,
          usage,
          maxSteps: Math.min(deps.maxSteps, 40),
          signal: ctx.signal,
          effort: deps.effortFor(model),
          toolConcurrency: 3,
          events: {
            onToolStart: (tool, targs) => {
              line(`${tag} ${c.cyan(tool.name)} ${c.gray(truncate(tool.summarize?.(targs) ?? "", 70))}`);
            },
          },
        });

        deps.usage.absorb(usage);
        const t = usage.totals();
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        line(
          `${tag} ${c.green("done")} ${c.gray(
            `${secs}s · ${fmtTokens(t.input + t.output)} tokens`,
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
            : "";
        return {
          output: result.finalText + capped,
          display: `[${id}] ${label}: ${truncate(result.finalText, 100)}`,
        };
      } catch (err) {
        deps.usage.absorb(usage);
        const msg = (err as Error)?.name === "AbortError" ? "interrupted" : (err as Error).message;
        line(`${tag} ${c.red("failed")} ${c.dim(msg)}`);
        return { output: `Subagent "${label}" crashed: ${msg}`, isError: true };
      }
    },
  };
}
