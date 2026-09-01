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
import { buildSystemPrompt } from "./prompt.js";
import { forkSpillStore } from "../tools/spill.js";
import { runAgent, stepCeiling } from "./loop.js";
import { ApiError } from "../provider/client.js";
import { UsageTracker, fmtTokens } from "../usage.js";
import { loadConfig, type Effort } from "../config.js";
import { splitModelId } from "../provider/registry.js";
import { pickSkill, skillInjection, skillInterjector } from "../skills/match.js";
import type { Message, ModelInfo, ToolDef } from "../types.js";
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
}

let counter = 0;

/**
 * Which models subagents may run on for this provider. The saved list is kept
 * either way: switching back to it costs a keystroke rather than re-picking
 * every model. An unset mode is read from the list, so configs written before
 * the choice existed behave exactly as they did.
 */
export function subagentMode(providerId: string): "session" | "list" {
  const cfg = loadConfig();
  const saved = cfg.subagentMode?.[providerId];
  if (saved === "session" || saved === "list") return saved;
  return (cfg.subagentModels?.[providerId] ?? []).length ? "list" : "session";
}

export function makeTaskTool(deps: SubagentDeps): ToolDef {
  const home = splitModelId(deps.defaultModel).providerId;
  // What cannot serve a chat turn has no business in the offer, and a subagent
  // is paid for by the key the session is using — so its own provider only.
  const runnable = deps.catalog.filter(
    (m) =>
      m.chatCapable !== false &&
      (m.modality ?? "text") === "text" &&
      splitModelId(m.id).providerId === home,
  );
  // A shortlist, when one was chosen and switched on: /subagents narrows the
  // offer to the models you are willing to run several of at once. Anything on
  // the list that this provider no longer serves is dropped rather than
  // offered, and in "session" mode the list is kept but not used.
  const pool = subagentMode(home) === "list" ? loadConfig().subagentModels?.[home] ?? [] : [];
  const shortlist = pool.length ? runnable.filter((m) => pool.includes(m.id)) : [];
  // The allowlist: a chosen shortlist, else only the session's own model. Left
  // open, the offer's "use a cheap one for mechanical work" sent real
  // reconnaissance to the cheapest id in a reseller's catalogue — hundreds of
  // requests and megabytes of input on a model nobody chose for this.
  const allowed = shortlist.length ? new Set(shortlist.map((m) => m.id)) : new Set([deps.defaultModel]);
  // The enum rides in the tool schema of every request, so it stays as small as
  // the allowlist; anything else this provider serves is still accepted by name
  // below, because the check reads the full runnable list.
  const MAX_OFFERED = 24;
  const offered = (shortlist.length ? shortlist : runnable.filter((m) => m.id === deps.defaultModel)).slice(
    0,
    MAX_OFFERED,
  );
  const modelIds = offered.map((m) => m.id);
  const runnableIds = new Set(runnable.map((m) => m.id));

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
            "Model for the subagent, from this provider only. Defaults to the current one; other models are available only when the user allows them via /subagents. Omit unless told otherwise.",
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
      const readOnly = Boolean(args.read_only);
      // An enum is a suggestion to a model, not a constraint: asked for a
      // model that cannot serve a chat turn, run the parent's rather than
      // failing the subtask on the first request. The same gate enforces the
      // /subagents allowlist: outside it, the session's own model is what runs,
      // whatever the caller asked for.
      const asked = String(args.model || deps.defaultModel);
      const model = !args.model || (runnableIds.has(asked) && allowed.has(asked)) ? asked : deps.defaultModel;
      if (model !== asked) {
        padded(
          `  ${c.gray(
            runnableIds.has(asked)
              ? `[${id}] ${asked} is not in the /subagents list — using ${model}`
              : `[${id}] ${asked} cannot run a subagent — using ${model}`,
          )}`,
        );
      }

      const available = deps
        .tools()
        .filter((t) => t.name !== "task")
        .filter((t) => (readOnly ? t.risk === "read" : true));

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

      // A subagent is given no catalogue, so the `skill` tool is the only way
      // it could ask for a procedure — and it has no idea one exists. Matching
      // its brief the way a request is matched costs nothing when nothing
      // fits, and is the only path a procedure has into delegated work.
      const cfg = loadConfig();
      const autoSkills = cfg.skillsEnabled && cfg.skillAuto !== false ? deps.skills : [];
      const loadedHere = new Set<string>();
      const brief = String(args.prompt ?? "");
      const messages: Message[] = [{ role: "user", content: brief }];
      const opening = pickSkill(autoSkills, brief);
      if (opening) {
        loadedHere.add(opening.skill.name);
        messages.push({ role: "user", content: skillInjection(opening.skill) });
        step(`skill ${opening.skill.name}`);
      }

      try {
        const result = await runAgent({
          model,
          systemPrompt: buildSystemPrompt({
            cwd: deps.cwd,
            model,
            // The skill catalogue is a lead-agent concern; a subagent pays its
            // own per-request price and gets nothing out of the list.
            skills: [],
            subagent: true,
          }),
          messages,
          tools: available,
          toolContext: {
            ...ctx,
            depth: ctx.depth + 1,
            // Same artifact directory, its own record of repeats: this agent
            // cannot scroll up to the lead's transcript.
            spill: forkSpillStore(ctx.spill),
            // Subagents share the read-guard set so edits stay coherent.
            emit: (l: string) => step(truncate(l, 90)),
          },
          catalog: deps.catalog,
          usage,
          maxSteps: stepCeiling(deps.maxSteps, 40),
          signal: ctx.signal,
          effort: deps.effortFor(model),
          toolConcurrency: Math.min(3, cfg.toolConcurrency),
          // One mid-turn load per subagent: it works on one assignment, so a
          // second change of subject is the lead agent's problem, not its own.
          interject: skillInterjector(autoSkills, {
            loaded: loadedHere,
            max: 1,
            onLoad: (skill) => step(`skill ${skill.name}`),
          }),
          events: {
            onToolStart: (tool, targs) => {
              step(`${tool.name} ${truncate(tool.summarize?.(targs) ?? "", 70)}`);
            },
          },
        });

        deps.usage.absorb(usage);
        const t = usage.totals();
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        padded(
          `${tag} ${c.green("done")} ${c.gray(
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
