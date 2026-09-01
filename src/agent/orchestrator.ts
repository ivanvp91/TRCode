/**
 * `/orchestrate` — decompose, run, synthesise.
 *
 * Different from `/swarm`: a swarm throws the SAME question at several models
 * and reconciles their answers; an orchestration splits ONE task into
 * dependent subtasks and runs each on its own agent, in dependency waves.
 *
 * Steps that only investigate run read-only, so several can run at once with
 * no chance of racing on the filesystem. Steps that change files run one at a
 * time and still go through the normal permission prompts.
 */
import { c } from "../ui/ansi.js";
import { MarkdownStream, Spinner, assistantPrefix, error, hint, info, line, padded, rule, truncate, warn } from "../ui/render.js";
import { buildSystemPrompt } from "./prompt.js";
import { runAgent, stepCeiling } from "./loop.js";
import { complete } from "../provider/client.js";
import { effortFor, servesModality, usableModels } from "../provider/models.js";
import { splitModelId, wireModelId } from "../provider/registry.js";
import { subagentMode } from "./subagent.js";
import { UsageTracker, fmtTokens } from "../usage.js";
import { loadConfig } from "../config.js";
import { fmtDuration } from "../ui/layout.js";
import type { ModelInfo, ToolDef } from "../types.js";
import type { App } from "../ui/repl.js";

interface Step {
  id: string;
  title: string;
  prompt: string;
  /** Ids this step needs finished first. */
  deps: string[];
  /** Investigation steps stay read-only so they can run in parallel. */
  writes: boolean;
  model?: string;
}

interface StepResult {
  step: Step;
  text: string;
  ok: boolean;
  ms: number;
}

const PLANNER_PROMPT = `You are the planner of an agent system. You are given a task and you split it into subtasks, each of which a separate agent will carry out with its own context.

Return STRICT JSON, with no commentary and no markdown fencing:

{
  "steps": [
    {
      "id": "s1",
      "title": "short name, 3-6 words",
      "prompt": "a self-contained assignment: what to do, where to look, what to return",
      "deps": [],
      "writes": false
    }
  ],
  "final": "what the end result should be — one sentence"
}

Rules:
- Two to six steps. Fewer if the task is simple; do not split for the sake of splitting.
- "deps" lists the ids whose results this step is pointless without. Steps with no shared dependencies run IN PARALLEL, so do not invent false dependencies.
- "writes": true only if the step actually changes files or runs commands. Investigation, reading and analysis are false.
- Steps with "writes": true run one at a time and last. Do not create two writing steps that touch the same thing.
- "prompt" is written for an agent that has NOT seen the original request and will not see other steps except those in deps. Spell it out fully.
- Do not invent files or commands you may not know: if a step needs reconnaissance, make that a separate step.`;

/**
 * The models a step may run on. Same rule as the task tool: a step agent is
 * paid for by the key the session is using, so it is this provider's models,
 * and the shortlist alone when /subagents has one switched on. Without that
 * list there is nothing to choose between — the session's model runs every
 * step, exactly as it did before.
 */
export function stepModels(app: App): ModelInfo[] {
  const home = splitModelId(app.session.model).providerId;
  const runnable = usableModels(app.catalog).filter(
    (m) => m.chatCapable !== false && servesModality(m, "text") && splitModelId(m.id).providerId === home,
  );
  const list = subagentMode(home) === "list" ? loadConfig().subagentModels?.[home] ?? [] : [];
  const shortlist = runnable.filter((m) => list.includes(m.id));
  if (!shortlist.length) return runnable.filter((m) => m.id === app.session.model);
  // The session's model leads and is always on the offer: it is the default
  // every step without a "model" falls back to.
  const withDefault = shortlist.some((m) => m.id === app.session.model)
    ? shortlist
    : [...runnable.filter((m) => m.id === app.session.model), ...shortlist];
  // The list rides in the planner's prompt, so it stays as short as the offer.
  return withDefault.slice(0, 12);
}

/**
 * A step's model, resolved against what the planner was offered. A name it
 * invented — or the bare spelling of one it was given — lands on the default
 * rather than on a 404.
 */
export function resolveStepModel(offered: ModelInfo[], want: string | undefined, dflt: string): string {
  if (!want) return dflt;
  const hit = offered.find((m) => m.id === want || wireModelId(m.id) === want);
  return hit ? hit.id : dflt;
}

/** What the planner is told about those models — ids, size, price. */
function modelBlock(models: ModelInfo[], dflt: string): string {
  const lines = models
    .map((m) => {
      const ctx = m.contextWindow ? ` · ctx ${fmtTokens(m.contextWindow)}` : "";
      const price = m.pricing ? ` · $${m.pricing.input}/$${m.pricing.output} per Mtok` : "";
      return `- ${m.id}${m.id === dflt ? " (the default)" : ""}${ctx}${price}`;
    })
    .join("\n");
  return `

A step may also carry "model": "<id>", choosing which model carries it out. Available:
${lines}

- Omit "model" and the step runs on ${dflt}.
- Match the model to the step: the largest one for reasoning, writing and anything with a judgement call in it; a cheaper one for mechanical work — listing files, grepping, collecting facts, reformatting.
- Ids exactly as written above. Anything else is ignored and that step runs on ${dflt}.`;
}

const SYNTH_PROMPT = `You are given the results of several agents that carried out subtasks of one task. Assemble the final answer to the user from them.

- Answer the task itself; do not recount who did what.
- What is done, state as done; what failed or went unverified, name outright.
- Do not smooth over contradictions between steps — resolve them.
- Refer to files as path:line.
- No preamble and no "hope this helps".`;

/** Pulls a JSON object out of a model reply that may be fenced or chatty. */
function extractJson(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in the reply");
  return JSON.parse(body.slice(start, end + 1));
}

function normalizePlan(raw: any): Step[] {
  const list: any[] = Array.isArray(raw?.steps) ? raw.steps : [];
  const steps: Step[] = list
    .map((s, i) => ({
      id: String(s?.id ?? `s${i + 1}`),
      title: String(s?.title ?? `step ${i + 1}`).trim(),
      prompt: String(s?.prompt ?? "").trim(),
      deps: Array.isArray(s?.deps) ? s.deps.map(String) : [],
      writes: Boolean(s?.writes),
      model: s?.model ? String(s.model) : undefined,
    }))
    .filter((s) => s.prompt);

  if (!steps.length) throw new Error("the plan is empty");

  // Drop references to steps that do not exist, else the DAG never drains.
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) s.deps = s.deps.filter((d) => ids.has(d) && d !== s.id);

  return steps;
}

/** Groups steps into dependency waves; throws on a cycle. */
function waves(steps: Step[]): Step[][] {
  const done = new Set<string>();
  const out: Step[][] = [];
  let remaining = [...steps];

  while (remaining.length) {
    const ready = remaining.filter((s) => s.deps.every((d) => done.has(d)));
    if (!ready.length) {
      // Cycle or unreachable dependency: run the rest sequentially instead.
      out.push(...remaining.map((s) => [s]));
      return out;
    }
    // Writers run alone and after readers of the same wave.
    const readers = ready.filter((s) => !s.writes);
    const writers = ready.filter((s) => s.writes);
    if (readers.length) out.push(readers);
    for (const w of writers) out.push([w]);
    for (const s of ready) done.add(s.id);
    remaining = remaining.filter((s) => !ready.includes(s));
  }
  return out;
}

function renderPlan(steps: Step[], statuses: Map<string, string>, dflt?: string): void {
  for (const s of steps) {
    const st = statuses.get(s.id) ?? "pending";
    const mark =
      st === "done" ? c.green("✔") : st === "running" ? c.brightYellow("▸") : st === "failed" ? c.red("✖") : c.gray("○");
    const deps = s.deps.length ? c.gray(` ← ${s.deps.join(", ")}`) : "";
    const kind = s.writes ? c.yellow(" [writes]") : "";
    // Only when it is not the model everything else runs on — a column of the
    // same name on every row says nothing.
    const on = s.model && s.model !== dflt ? c.gray(` · ${wireModelId(s.model)}`) : "";
    padded(`  ${mark} ${c.gray(s.id)} ${s.title}${kind}${on}${deps}`);
  }
}

export async function runOrchestration(app: App, task: string): Promise<void> {
  const cfg = loadConfig();
  const ctx = app.toolContext();
  const started = Date.now();

  line();
  rule(c.brightMagenta(" orchestration "));
  padded(c.bold("task") + "  " + truncate(task, 90));
  line();

  // ── plan ────────────────────────────────────────────────────────────────
  // Only worth offering when there is a choice: one model is what happens
  // anyway, and a list of one in the prompt is tokens spent on nothing.
  const offered = stepModels(app);
  const canChoose = offered.length > 1;
  const planner = canChoose ? PLANNER_PROMPT + modelBlock(offered, app.session.model) : PLANNER_PROMPT;
  const sp = new Spinner("planning the breakdown");
  sp.start();
  let steps: Step[];
  const planUsage = new UsageTracker();
  try {
    const res = await complete({
      model: app.session.model,
      messages: [
        { role: "system", content: planner },
        { role: "user", content: `Working directory: ${app.cwd}\n\nTask:\n${task}` },
      ],
      temperature: 0.2,
      effort: effortFor(app.session.model, app.effortOverride),
      signal: ctx.signal,
    });
    planUsage.record(app.session.model, res.usage, app.catalog);
    app.usage.absorb(planUsage);
    steps = normalizePlan(extractJson(res.content));
    // Resolved once, here: the plan on screen has to name the model that will
    // actually run, not the one the planner wished for.
    for (const s of steps) s.model = resolveStepModel(canChoose ? offered : [], s.model, app.session.model);
    sp.stop();
  } catch (err) {
    sp.stop();
    app.usage.absorb(planUsage);
    error(`Could not build a plan: ${(err as Error).message}`);
    hint("Try a more concrete task, or just run it as a normal request.");
    return;
  }

  const statuses = new Map<string, string>();
  padded(c.bold("plan"));
  renderPlan(steps, statuses, app.session.model);
  line();

  // ── execute ─────────────────────────────────────────────────────────────
  const results = new Map<string, StepResult>();
  const readTools: ToolDef[] = app.toolList().filter((t) => t.risk === "read");
  const allTools: ToolDef[] = app.toolList().filter((t) => t.name !== "task");

  for (const wave of waves(steps)) {
    if (ctx.signal.aborted) break;

    const runs = wave.map(async (step) => {
      const model = step.model ?? app.session.model;
      const usage = new UsageTracker();
      const tag = c.brightBlue(`  ├ ${step.id}`);
      statuses.set(step.id, "running");
      padded(`${tag} ${c.bold(step.title)} ${c.gray(`· ${model}${step.writes ? "" : " · read-only"}`)}`);

      // A dependency that failed is named, not dropped: silently handing on
      // an empty context lets the step build on work that never happened.
      const prior = step.deps.map((d) => results.get(d)).filter((r): r is StepResult => Boolean(r));
      const context = prior
        .map((r) =>
          r.ok
            ? `<step-result id="${r.step.id}" title="${r.step.title}">\n${r.text}\n</step-result>`
            : `<step-failed id="${r.step.id}" title="${r.step.title}">${
                r.text.trim() || "This step produced no result."
              }</step-failed>`,
        )
        .join("\n\n");
      const failedDep = prior.some((r) => !r.ok);

      const prompt = context
        ? `${step.prompt}\n\nWhat other agents already established — build on this, do not re-verify it.${
            failedDep
              ? " A step shown as step-failed produced nothing: whatever it was meant to establish is still open, so do not assume its work was done."
              : ""
          }\n\n${context}`
        : step.prompt;

      const t0 = Date.now();
      try {
        const res = await runAgent({
          model,
          systemPrompt: buildSystemPrompt({ cwd: app.cwd, model, skills: app.activeSkills, subagent: true }),
          messages: [{ role: "user", content: prompt }],
          tools: step.writes ? allTools : readTools,
          toolContext: { ...ctx, depth: 1 },
          catalog: app.catalog,
          usage,
          maxSteps: stepCeiling(cfg.maxSteps, 30),
          signal: ctx.signal,
          effort: effortFor(model, app.effortOverride),
          toolConcurrency: Math.min(3, loadConfig().toolConcurrency),
          events: {
            onToolStart: (tool, args) => {
              padded(`${tag} ${c.cyan(tool.name)} ${c.gray(truncate(tool.summarize?.(args) ?? "", 60))}`);
            },
          },
        });

        app.usage.absorb(usage);
        const t = usage.totals();
        const ms = Date.now() - t0;
        const ok = Boolean(res.finalText.trim()) && res.stoppedBecause !== "aborted";
        statuses.set(step.id, ok ? "done" : "failed");
        padded(
          `${tag} ${ok ? c.green("done") : c.red("no result")} ${c.gray(
            `${fmtDuration(ms)} · ${fmtTokens(t.input + t.output)} tokens`,
          )}`,
        );
        results.set(step.id, { step, text: res.finalText, ok, ms });
      } catch (err) {
        app.usage.absorb(usage);
        const msg = (err as Error)?.name === "AbortError" ? "interrupted" : (err as Error).message;
        statuses.set(step.id, "failed");
        padded(`${tag} ${c.red("failed")} ${c.dim(msg)}`);
        // The reason is kept: a step that depends on this one is told what
        // went wrong, and only `ok` results ever reach the synthesis.
        results.set(step.id, { step, text: `This step failed: ${msg}`, ok: false, ms: Date.now() - t0 });
      }
    });

    await Promise.all(runs);
  }

  const good = [...results.values()].filter((r) => r.ok);
  line();
  padded(c.bold("step results"));
  renderPlan(steps, statuses, app.session.model);
  line();

  if (!good.length) {
    warn("No step produced a result.");
    return;
  }

  // ── synthesise ──────────────────────────────────────────────────────────
  const bundle = good
    .map((r) => `<step id="${r.step.id}" title="${r.step.title}">\n${r.text}\n</step>`)
    .join("\n\n");

  const synthUsage = new UsageTracker();
  const stream: { md: MarkdownStream | null } = { md: null };
  const sp2 = new Spinner("merging the results");
  sp2.start();
  let answer = "";

  try {
    const res = await runAgent({
      model: app.session.model,
      systemPrompt: SYNTH_PROMPT,
      messages: [{ role: "user", content: `Task:\n${task}\n\nStep results:\n\n${bundle}` }],
      tools: [],
      toolContext: { ...ctx, depth: 1 },
      catalog: app.catalog,
      usage: synthUsage,
      maxSteps: 1,
      signal: ctx.signal,
      effort: effortFor(app.session.model, app.effortOverride),
      events: {
        onText: (delta) => {
          if (!stream.md) {
            sp2.stop();
            line();
            assistantPrefix(`${app.session.model} ${c.gray("· synthesis")}`);
            stream.md = new MarkdownStream();
          }
          stream.md.push(delta);
        },
      },
    });
    sp2.stop();
    stream.md?.end();
    answer = res.finalText;
  } catch (err) {
    sp2.stop();
    warn(`Synthesis failed: ${(err as Error).message}`);
  }

  app.usage.absorb(synthUsage);

  if (!answer.trim()) {
    warn("Synthesis was empty — raw step results below.");
    for (const r of good) {
      line();
      assistantPrefix(`${r.step.id} · ${r.step.title}`);
      const md = new MarkdownStream();
      md.push(r.text);
      md.end();
    }
    answer = good.map((r) => `## ${r.step.title}\n${r.text}`).join("\n\n");
  }

  app.session.add({ role: "user", content: `[orchestration: ${steps.length} steps] ${task}` });
  app.session.add({ role: "assistant", content: answer, meta: { model: app.session.model } });
  app.session.save();

  const totals = app.usage.totals();
  line();
  padded(
    [
      c.brightMagenta(`orchestration ${good.length}/${steps.length}`),
      c.gray(fmtDuration(Date.now() - started)),
      c.gray(fmtTokens(totals.input + totals.output) + " tokens this session"),
    ].join(c.gray(" · ")),
  );
  hint("The result is in the history — carry on with normal requests.");
  line();
}
