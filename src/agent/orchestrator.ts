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
import { MarkdownStream, assistantPrefix, hint, line, padded, rule, truncate, warn } from "../ui/render.js";
import { runWorker, runPool, workerModels, resolveWorkerModel } from "./worker.js";
import { attachHistory, attachReferenced } from "./brain.js";
import { markTurn } from "../session/checkpoint.js";
import type { OrchestrationStep as Step, OrchestrationState } from "../session/orchestration.js";
import { effortFor } from "../provider/models.js";
import { wireModelId } from "../provider/registry.js";
import { fmtTokens } from "../usage.js";
import { loadConfig } from "../config.js";
import { fmtDuration } from "../ui/layout.js";
import type { ModelInfo } from "../types.js";
import type { App, TaskProgress } from "../ui/repl.js";

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
  return workerModels(app.catalog, app.session.model).slice(0, 12);
}

/**
 * A step's model, resolved against what the planner was offered. A name it
 * invented — or the bare spelling of one it was given — lands on the default
 * rather than on a 404.
 */
export function resolveStepModel(offered: ModelInfo[], want: string | undefined, dflt: string): string {
  return resolveWorkerModel(offered, want, dflt);
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

export function normalizePlan(raw: any): Step[] {
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
  if (steps.length > 24) throw new Error("the plan has too many steps");
  if (steps.some((s) => !/^[a-zA-Z][\w-]{0,63}$/.test(s.id) || s.id in Object.prototype)) throw new Error("invalid step id");

  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) throw new Error("duplicate step ids in plan");
  for (const s of steps) for (const d of s.deps) if (!ids.has(d) || d === s.id) throw new Error(`invalid dependency ${d} of ${s.id}`);
  waves(steps); // validate the entire DAG before any side effects

  return steps;
}

/** Groups steps into dependency waves; throws on a cycle. */
export function waves(steps: Step[]): Step[][] {
  const done = new Set<string>();
  const out: Step[][] = [];
  let remaining = [...steps];

  while (remaining.length) {
    const ready = remaining.filter((s) => s.deps.every((d) => done.has(d)));
    if (!ready.length) {
      throw new Error("cyclic or unreachable dependencies in plan");
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
      st === "done" ? c.green("✔") : st === "running" ? c.brightYellow("▸") :
        st === "failed" || st === "skipped" ? c.red("✖") : st === "interrupted" ? c.yellow("‖") : c.gray("○");
    const deps = s.deps.length ? c.gray(` ← ${s.deps.join(", ")}`) : "";
    const kind = s.writes ? c.yellow(" [writes]") : "";
    // Only when it is not the model everything else runs on — a column of the
    // same name on every row says nothing.
    const on = s.model && s.model !== dflt ? c.gray(` · ${wireModelId(s.model)}`) : "";
    padded(`  ${mark} ${c.gray(s.id)} ${s.title}${kind}${on}${deps}`);
  }
}

/** Inspect saved work without starting requests. */
export function orchestrationStatus(app: App): void {
  const state = app.session.orchestration;
  if (!state) return void hint("No saved orchestration. /orchestrate <task> starts one.");
  padded(`${c.bold(state.status)} · ${state.phase} · ${state.task}`);
  renderPlan(state.steps, new Map(Object.entries(state.statuses)), app.session.model);
  if (state.status !== "complete") hint("/orchestrate resume · /orchestrate replan <instructions>");
}

export async function runOrchestration(app: App, task: string, mode: "new" | "resume" | "replan" = "new"): Promise<void> {
  const saved = app.session.orchestration;
  if (mode !== "new" && (!saved || saved.status === "complete")) {
    hint("No unfinished orchestration. /orchestrate <task> starts one.");
    return;
  }
  await app.runTask("orchestration", async (progress) => {
    if (!await app.authorizeSubagents(true)) return;
    const state: OrchestrationState = mode === "new" ? {
      task, model: app.session.model,
      context: attachHistory(app.session.messages) + attachReferenced(app.cwd, task),
      status: "running", phase: "planning", steps: [], statuses: {}, results: {}, messages: {},
      startedAt: Date.now(), updatedAt: Date.now(),
    } : saved!;
    app.session.orchestration = state;
    if (mode === "new") {
      markTurn(app.session, `[orchestration] ${task}`);
      app.session.add({ role: "user", content: `[orchestration] ${task}` });
    }
    if (mode === "replan") {
      state.phase = "planning";
      state.revision = task;
      state.messages.__planner = [];
      state.context = attachHistory(app.session.messages) + attachReferenced(app.cwd, state.task + " " + task);
    }
    state.status = "running";
    const save = () => { state.updatedAt = Date.now(); app.session.save(); };
    save();
    try {
      await execute(app, state, progress, save);
    } catch (err) {
      state.status = app.toolContext().signal.aborted ? "paused" : "failed";
      throw err;
    } finally {
      if (app.toolContext().signal.aborted) {
        state.status = "paused";
        for (const step of state.steps) {
          if (state.statuses[step.id] === "running") state.statuses[step.id] = "interrupted";
        }
        hint("Plan and results saved. /orchestrate resume continues; /orchestrate status shows progress.");
      }
      save();
    }
  });
}

async function execute(app: App, state: OrchestrationState, progress: TaskProgress, save: () => void): Promise<void> {
  const cfg = loadConfig();
  const ctx = app.toolContext();
  const offered = stepModels(app);
  line();
  rule(c.brightMagenta(" orchestration "));
  padded(c.bold("task") + "  " + truncate(state.task, 90));
  line();

  if (state.phase === "planning" || !state.steps.length) {
    progress.label("planning the breakdown");
    const completed = state.steps.filter((s) => state.results[s.id]?.ok);
    const prior = completed.map((s) => `${s.id}: ${s.title}\n${state.results[s.id].text}`).join("\n\n");
    const unfinished = state.steps.filter((s) => !state.results[s.id]?.ok)
      .map((s) => `${s.id}: ${state.results[s.id]?.text || "not finished"}${attachHistory(state.messages[s.id], 6000)}`).join("\n\n");
    const revision = state.steps.length ? `\n\nRevise the unfinished work. Keep completed steps intact; return ONLY remaining steps, which may depend on completed ids. Incomplete writing steps may already have changed files: inspect the current workspace before assigning another write.\nCompleted steps:\n${prior || "none"}\nIncomplete work:\n${unfinished || "none"}\nPrevious plan:\n${JSON.stringify(state.steps)}\nUser instructions:\n${state.revision || "Continue the remaining task."}` : "";
    const messages = state.messages.__planner ??= [];
    if (messages.length) messages.push({ role: "user", content: "Continue planning. Inspect files as needed, then return a complete valid JSON plan from the beginning; do not continue a partial JSON fragment." });
    const events = progress.events();
    const res = await runWorker({
      model: app.session.model,
      systemPrompt: PLANNER_PROMPT + (offered.length > 1 ? modelBlock(offered, app.session.model) : "") +
        "\nYou have read tools: inspect relevant project files before finalizing the plan. Your final answer must be the JSON object.",
      prompt: `Working directory: ${app.cwd}\n\nTask:\n${state.task}${state.context}${revision}`,
      messages,
      context: ctx, tools: app.toolList(), readOnly: true, skills: [], catalog: app.catalog,
      usage: app.usage, maxSteps: cfg.maxSteps, ceiling: 8, effort: effortFor(app.session.model, app.effortOverride),
      activity: (text) => progress.activity(`planner · ${text}`),
      events: { ...events, onStep: () => save() },
    });
    if (ctx.signal.aborted) return;
    if (res.stoppedBecause !== "stop") throw new Error(`Planner did not finish (${res.stoppedBecause}). /orchestrate resume retries it.`);
    const raw = extractJson(res.finalText);
    const doneIds = new Set(completed.map((s) => s.id));
    const remaining = (Array.isArray(raw.steps) ? raw.steps : []).filter((s: any) => !doneIds.has(String(s?.id)));
    const steps = normalizePlan({ steps: [...completed, ...remaining] });
    for (const step of steps) if (!doneIds.has(step.id)) step.model = resolveStepModel(offered, step.model, app.session.model);
    state.steps = steps;
    if (state.revision !== undefined) {
      for (const id of Object.keys(state.results)) if (!doneIds.has(id)) delete state.results[id];
      for (const id of Object.keys(state.messages)) if (id !== "__planner" && !doneIds.has(id)) delete state.messages[id];
      state.statuses = Object.fromEntries(completed.map((s) => [s.id, "done" as const]));
      delete state.revision;
    }
    state.phase = "execution";
    save();
  }

  padded(c.bold("plan"));
  renderPlan(state.steps, new Map(Object.entries(state.statuses)), app.session.model);
  line();
  for (const wave of waves(state.steps)) {
    if (ctx.signal.aborted) return;
    const pending = wave.filter((step) => !state.results[step.id]?.ok);
    await runPool(pending, cfg.toolConcurrency, ctx.signal, async (step) => {
      if (step.deps.some((id) => !state.results[id]?.ok)) {
        state.statuses[step.id] = "skipped";
        state.results[step.id] = { text: "Skipped because a required dependency failed.", ok: false, ms: 0 };
        save();
        return;
      }
      const model = resolveStepModel(workerModels(app.catalog, app.session.model), step.model, app.session.model);
      step.model = model;
      state.phase = "execution";
      state.statuses[step.id] = "running";
      const tag = c.brightBlue(`  ├ ${step.id}`);
      progress.label(`orchestration · ${Object.values(state.results).filter((r) => r.ok).length}/${state.steps.length} done`);
      padded(`${tag} ${c.bold(step.title)} ${c.gray(`· ${model}${step.writes ? "" : " · read-only"}`)}`);
      const prior = step.deps.map((id) => `<step-result id="${id}">\n${state.results[id].text}\n</step-result>`).join("\n\n");
      const prompt = `${step.prompt}\n\nOriginal task:\n${state.task}${state.context}${prior ? `\n\nCompleted dependencies:\n${prior}` : ""}`;
      const messages = state.messages[step.id] ??= [];
      if (messages.length) messages.push({ role: "user", content: "Continue this unfinished assignment. Preserve completed changes; verify the current files before repeating any write or command." });
      const events = progress.events();
      const t0 = Date.now();
      save();
      try {
        const res = await runWorker({
          model, prompt, messages, context: ctx, tools: app.toolList(), readOnly: !step.writes,
          skills: app.activeSkills, catalog: app.catalog, usage: app.usage,
          maxSteps: cfg.maxSteps, ceiling: 30, effort: effortFor(model, app.effortOverride),
          activity: (text) => progress.activity(`${step.id} · ${text}`),
          events: { ...events, onStep: () => save() },
        });
        const ok = !ctx.signal.aborted && res.stoppedBecause === "stop" && Boolean(res.finalText.trim());
        state.statuses[step.id] = ctx.signal.aborted ? "interrupted" : ok ? "done" : "failed";
        state.results[step.id] = {
          text: ok ? res.finalText : `${res.finalText}\n\nUnfinished: ${res.stoppedBecause}.`,
          ok, ms: Date.now() - t0,
        };
        padded(`${tag} ${ok ? c.green("done") : c.yellow(state.statuses[step.id])} ${c.gray(fmtDuration(Date.now() - t0))}`);
      } catch (err) {
        state.statuses[step.id] = ctx.signal.aborted ? "interrupted" : "failed";
        state.results[step.id] = { text: `This step failed: ${(err as Error).message}`, ok: false, ms: Date.now() - t0 };
        padded(`${tag} ${c.red(state.statuses[step.id])} ${c.dim((err as Error).message)}`);
      } finally { save(); }
    });
  }
  if (ctx.signal.aborted) return;
  const good = state.steps.filter((s) => state.results[s.id]?.ok);
  padded(c.bold("step results"));
  renderPlan(state.steps, new Map(Object.entries(state.statuses)), app.session.model);
  if (!good.length) {
    state.status = "failed";
    app.lastTurnFailed = true;
    warn("No step produced a result. /orchestrate resume retries; /orchestrate replan <instructions> revises the plan.");
    return;
  }

  state.phase = "synthesis";
  save();
  progress.label("merging the results");
  const bundle = good.map((s) => `<step id="${s.id}" title="${s.title}">\n${state.results[s.id].text}\n</step>`).join("\n\n");
  const failures = state.steps.filter((s) => !state.results[s.id]?.ok).map((s) => `${s.id}: ${state.results[s.id]?.text || "not run"}`).join("\n");
  const stream: { md: MarkdownStream | null } = { md: null };
  const events = progress.events();
  let answer = "";
  try {
    const res = await runWorker({
      model: app.session.model, systemPrompt: SYNTH_PROMPT,
      prompt: `Task:\n${state.task}${state.context}\n\nStep results:\n${bundle}\n\nFailed or skipped steps (report as incomplete):\n${failures || "none"}`,
      context: ctx, tools: [], readOnly: true, skills: [], catalog: app.catalog, usage: app.usage,
      maxSteps: 1, ceiling: 1, effort: effortFor(app.session.model, app.effortOverride),
      events: { ...events, onText: (delta) => {
        events.onText?.(delta);
        if (!stream.md) { line(); assistantPrefix(`${app.session.model} ${c.gray("· synthesis")}`); stream.md = new MarkdownStream(); }
        stream.md.push(delta);
      } },
    });
    answer = res.finalText;
    if (ctx.signal.aborted) { state.answer = answer; return; }
    if (res.stoppedBecause !== "stop") throw new Error(`Synthesis did not finish (${res.stoppedBecause}).`);
  } catch (err) {
    if (ctx.signal.aborted) return;
    warn(`Synthesis failed: ${(err as Error).message}. Completed step results are saved.`);
    state.status = "failed";
    app.lastTurnFailed = true;
    hint("/orchestrate resume retries synthesis without repeating completed steps.");
    return;
  } finally { stream.md?.end(); }
  if (!answer.trim()) {
    state.status = "failed";
    app.lastTurnFailed = true;
    warn("Synthesis was empty. /orchestrate resume retries it.");
    return;
  }
  state.answer = answer;
  state.status = failures ? "failed" : "complete";
  app.lastTurnFailed = Boolean(failures);
  app.session.add({ role: "assistant", content: answer, meta: { model: app.session.model } });
  save();
  line();
  padded([c.brightMagenta(`orchestration ${good.length}/${state.steps.length}`), c.gray(fmtDuration(Date.now() - state.startedAt)),
    c.gray(fmtTokens(app.usage.turnTotals().input + app.usage.turnTotals().output) + " tokens this turn")].join(c.gray(" · ")));
  if (failures) hint("Incomplete steps saved. /orchestrate resume · /orchestrate replan <instructions>");
}
