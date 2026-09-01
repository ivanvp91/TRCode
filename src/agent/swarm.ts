/**
 * `/swarm` — the same task attacked in parallel by several models, then a
 * synthesis pass. Workers run read-only so N agents can never race on the
 * filesystem; the synthesised answer goes back into the session so normal
 * (write-capable) turns can act on it afterwards.
 */
import { c } from "../ui/ansi.js";
import { MarkdownStream, Spinner, assistantPrefix, info, line, padded, rule, truncate, warn } from "../ui/render.js";
import { buildSystemPrompt } from "./prompt.js";
import { runAgent, stepCeiling } from "./loop.js";
import { UsageTracker, fmtTokens } from "../usage.js";
import { loadConfig } from "../config.js";
import { effortFor, servesModality, usableModels } from "../provider/models.js";
import type { ModelInfo, ToolDef } from "../types.js";
import type { App } from "../ui/repl.js";

/**
 * The roster chosen by hand: what /swarm models saved, minus anything this
 * client can no longer reach. Empty — nothing chosen, or nothing left of it —
 * hands the pick back to defaultRoster.
 */
export function configuredRoster(catalog: ModelInfo[]): string[] {
  return loadConfig().swarmModels.filter((id) => catalog.some((m) => m.id === id));
}

/**
 * What a /swarm would run right now: the chosen roster when there is one, else
 * the automatic pick. One place, so the panel shows exactly what will run.
 */
export function swarmRoster(catalog: ModelInfo[], current: string, size = 3): string[] {
  const chosen = configuredRoster(catalog);
  return chosen.length ? chosen : defaultRoster(catalog, current, size);
}

/**
 * Who merges the answers: the roster member pinned for it, else the session's
 * model. A pin dropped from the roster is ignored rather than obeyed — the
 * synthesis reads every answer, so it has to be a model that ran.
 */
export function swarmMain(sessionModel: string, roster: string[]): string {
  const pinned = loadConfig().swarmMainModel;
  return pinned && roster.includes(pinned) ? pinned : sessionModel;
}

/** Picks a diverse roster: the current model plus different-owner alternatives. */
export function defaultRoster(catalog: ModelInfo[], current: string, size = 3): string[] {
  // Only what can actually answer: an embedding or image-only model taken for
  // its vendor would fail on the first turn and quietly shrink the swarm.
  const pool = usableModels(catalog).filter((m) => m.chatCapable !== false && servesModality(m, "text"));
  const ids = pool.map((m) => m.id);
  if (!ids.length) return [current];
  const roster = [current];
  const ownerOf = (id: string) => pool.find((m) => m.id === id)?.owner ?? id.split("-")[0];
  const usedOwners = new Set([ownerOf(current)]);

  // Prefer a different vendor each time — diversity is the point of a swarm.
  for (const m of pool) {
    if (roster.length >= size) break;
    if (roster.includes(m.id)) continue;
    const owner = ownerOf(m.id);
    if (usedOwners.has(owner)) continue;
    if (/fast|flash|mini/.test(m.id)) continue;
    roster.push(m.id);
    usedOwners.add(owner);
  }
  for (const id of ids) {
    if (roster.length >= size) break;
    if (!roster.includes(id)) roster.push(id);
  }
  return roster.slice(0, size);
}

const WORKER_SUFFIX = `

Work independently and to the end: read whatever you need from the real project files. You have read and search access only — change nothing, propose changes as text (exact code fragments are fine).

Return:
1. The answer itself.
2. What backs it — the specific files and lines you checked.
3. What you are unsure about.`;

const SYNTH_PROMPT = `You are given independent answers from several models to the same task. Each worked its own way and did not see the others.

Merge them into one answer:
- Where they agree, treat it as reliable and state it confidently.
- Where they disagree, name the disagreement outright, say which side is more convincing and why — argue from specifics (files checked, lines, evidence), not from which one "sounds better".
- Keep what only one model found if it is backed by facts.
- Discard bare assertions with no support.

Write the final answer as if you were answering the user yourself: no "model A said…" in every paragraph. Put the disagreement analysis at the end as a short separate block, and only if the disagreements matter.`;

export async function runSwarm(app: App, task: string, given?: string[]): Promise<void> {
  const cfg = loadConfig();
  // The panel hands its own roster in so what it showed is what runs; a bare
  // /swarm <task> resolves the same list here.
  const roster = given?.length ? given : swarmRoster(app.catalog, app.session.model, 3);
  const synthModel = swarmMain(app.session.model, roster);

  if (roster.length < 2) {
    warn("Fewer than two models in the catalog — the swarm degenerates into a plain request.");
  }

  line();
  rule(c.brightMagenta(` swarm · ${roster.length} ${roster.length === 1 ? "model" : "models"} `));
  padded(`${c.bold("task")} ${truncate(task, 90)}`);
  for (const m of roster) padded(`${c.brightBlue("├")} ${m}${m === synthModel ? c.gray(" · synthesis") : ""}`);
  line();

  const readOnlyTools: ToolDef[] = app.toolList().filter((t) => t.risk === "read");
  const started = Date.now();
  const ctx = app.toolContext();

  const runs = roster.map(async (model, i) => {
    const usage = new UsageTracker();
    const tag = `  ${c.brightBlue(`├ [${i + 1}] ${model}`)}`;
    const t0 = Date.now();
    try {
      const res = await runAgent({
        model,
        systemPrompt: buildSystemPrompt({ cwd: app.cwd, model, skills: app.activeSkills, subagent: true }),
        messages: [{ role: "user", content: task + WORKER_SUFFIX }],
        tools: readOnlyTools,
        toolContext: { ...ctx, depth: 1 },
        catalog: app.catalog,
        usage,
        maxSteps: stepCeiling(cfg.maxSteps, 25),
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
      padded(
        `${tag} ${c.green("done")} ${c.gray(
          `${((Date.now() - t0) / 1000).toFixed(0)}s · ${fmtTokens(t.input + t.output)} tokens`,
        )}`,
      );
      return { model, text: res.finalText, ok: Boolean(res.finalText.trim()) };
    } catch (err) {
      app.usage.absorb(usage);
      const msg = (err as Error)?.name === "AbortError" ? "interrupted" : (err as Error).message;
      padded(`${tag} ${c.red("failed")} ${c.dim(msg)}`);
      return { model, text: "", ok: false };
    }
  });

  const results = await Promise.all(runs);
  const good = results.filter((r) => r.ok);

  if (!good.length) {
    warn("No model returned a result.");
    return;
  }
  if (good.length === 1) {
    info(`Only one model finished (${good[0].model}) — no synthesis needed.`);
    printAnswer(good[0].model, good[0].text);
    commit(app, task, good[0].text, roster, good[0].model);
    return;
  }

  line();
  const sp = new Spinner(`merging ${good.length} answers into one`);
  sp.start();

  const bundle = good
    .map((r, i) => `<answer model="${r.model}" index="${i + 1}">\n${r.text}\n</answer>`)
    .join("\n\n");

  const synthUsage = new UsageTracker();
  let synth = "";
  // Held in an object so the callback assignment stays visible to the caller.
  const stream: { md: MarkdownStream | null } = { md: null };

  try {
    const res = await runAgent({
      model: synthModel,
      systemPrompt: SYNTH_PROMPT,
      messages: [{ role: "user", content: `Task:\n${task}\n\nModel answers:\n\n${bundle}` }],
      tools: [],
      toolContext: { ...ctx, depth: 1 },
      catalog: app.catalog,
      usage: synthUsage,
      maxSteps: 1,
      signal: ctx.signal,
      effort: effortFor(synthModel, app.effortOverride),
      events: {
        onText: (delta) => {
          if (!stream.md) {
            sp.stop();
            line();
            assistantPrefix(`${synthModel} ${c.gray("· synthesis")}`);
            stream.md = new MarkdownStream();
          }
          stream.md.push(delta);
        },
      },
    });
    sp.stop();
    stream.md?.end();
    synth = res.finalText;
    if (!synth.trim()) {
      warn("Synthesis came back empty — showing the raw answers.");
      for (const r of good) printAnswer(r.model, r.text);
      synth = good.map((r) => `## ${r.model}\n${r.text}`).join("\n\n");
    }
  } catch (err) {
    sp.stop();
    warn(`Synthesis failed: ${(err as Error).message}. Raw answers below.`);
    for (const r of good) printAnswer(r.model, r.text);
    synth = good.map((r) => `## ${r.model}\n${r.text}`).join("\n\n");
  }

  app.usage.absorb(synthUsage);
  commit(app, task, synth, roster, synthModel);

  line();
  padded(
    [
      c.brightMagenta(`swarm ${roster.length}×`),
      c.gray(`${((Date.now() - started) / 1000).toFixed(0)}s`),
      c.gray(fmtTokens(app.usage.totals().input + app.usage.totals().output) + " tokens this session"),
    ].join(c.gray(" · ")),
  );
  padded(c.gray("The result is in the history — carry on with normal requests."));
  line();
}

function printAnswer(model: string, text: string): void {
  line();
  assistantPrefix(model);
  const md = new MarkdownStream();
  md.push(text);
  md.end();
}

/** Folds the swarm result into the session so the dialogue stays coherent. */
function commit(app: App, task: string, answer: string, roster: string[], model?: string): void {
  app.session.add({ role: "user", content: `[swarm: ${roster.join(", ")}] ${task}` });
  app.session.add({ role: "assistant", content: answer, meta: { model: model ?? app.session.model } });
  app.session.save();
}
