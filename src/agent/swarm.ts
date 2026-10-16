/**
 * `/swarm` — the same task attacked in parallel by several models, then a
 * synthesis pass. Workers run read-only so N agents can never race on the
 * filesystem; the synthesised answer goes back into the session so normal
 * (write-capable) turns can act on it afterwards.
 */
import { c } from "../ui/ansi.js";
import { MarkdownStream, assistantPrefix, info, line, padded, rule, truncate, warn } from "../ui/render.js";
import { runWorker, runPool } from "./worker.js";
import { attachHistory } from "./brain.js";
import { markTurn } from "../session/checkpoint.js";
import { UsageTracker, fmtTokens } from "../usage.js";
import { loadConfig } from "../config.js";
import { effortFor, servesModality, usableModels } from "../provider/models.js";
import type { ModelInfo } from "../types.js";
import type { App } from "../ui/repl.js";

/**
 * The roster chosen by hand: what /swarm models saved, minus anything this
 * client can no longer reach. Empty — nothing chosen, or nothing left of it —
 * hands the pick back to defaultRoster.
 */
export function configuredRoster(catalog: ModelInfo[]): string[] {
  const runnable = usableModels(catalog).filter((m) => m.chatCapable !== false && servesModality(m, "text"));
  return loadConfig().swarmModels.filter((id) => runnable.some((m) => m.id === id));
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
  await app.runTask("swarm", async (progress) => {
    const cfg = loadConfig();
    const roster = [...new Set(given?.length ? given : swarmRoster(app.catalog, app.session.model, 3))];
    const synthModel = swarmMain(app.session.model, roster);
    const context = attachHistory(app.session.messages);
    const ctx = app.toolContext();
    const started = Date.now();
    markTurn(app.session, `[swarm] ${task}`);
    app.session.add({ role: "user", content: `[swarm: ${roster.join(", ")}] ${task}` });
    app.session.save();
    if (roster.length < 2) warn("Fewer than two models — running one independent worker.");
    line();
    rule(c.brightMagenta(` swarm · ${roster.length} models `));
    padded(`${c.bold("task")} ${truncate(task, 90)}`);
    for (const model of roster) padded(`${c.brightBlue("├")} ${model}${model === synthModel ? c.gray(" · synthesis") : ""}`);
    line();

    const results: { model: string; text: string; ok: boolean; reason: string }[] = new Array(roster.length);
    let finished = 0;
    const savePartial = () => {
      const partial = results.filter((r) => r?.text.trim());
      if (partial.length) app.session.add({ role: "assistant", content:
        "Swarm interrupted; these worker results are incomplete and have not been synthesized.\n\n" +
        partial.map((r) => `## ${r.model}${r.ok ? "" : " (unfinished)"}\n${r.text}`).join("\n\n"),
        meta: { model: app.session.model } });
      app.session.save();
    };
    await runPool(roster, cfg.toolConcurrency, ctx.signal, async (model, index) => {
      const tag = `  ${c.brightBlue(`├ [${index + 1}] ${model}`)}`;
      const t0 = Date.now();
      progress.label(`swarm · ${finished}/${roster.length} done`);
      try {
        const res = await runWorker({
          model, prompt: task + context + WORKER_SUFFIX, context: ctx,
          tools: app.toolList(), readOnly: true, skills: app.activeSkills, catalog: app.catalog,
          usage: app.usage, maxSteps: cfg.maxSteps, ceiling: 25, effort: effortFor(model, app.effortOverride),
          activity: (text) => progress.activity(`[${index + 1}] ${model} · ${text}`), events: progress.events(),
        });
        const ok = !ctx.signal.aborted && res.stoppedBecause === "stop" && Boolean(res.finalText.trim());
        results[index] = { model, text: res.finalText, ok, reason: ok ? "" : res.stoppedBecause };
        padded(`${tag} ${ok ? c.green("done") : c.yellow(res.stoppedBecause)} ${c.gray(`${Math.round((Date.now() - t0) / 1000)}s`)}`);
      } catch (err) {
        const reason = ctx.signal.aborted ? "interrupted" : (err as Error).message;
        results[index] = { model, text: "", ok: false, reason };
        padded(`${tag} ${c.red("failed")} ${c.dim(reason)}`);
      } finally {
        finished++;
        progress.label(`swarm · ${finished}/${roster.length} done`);
        app.session.save();
      }
    });
    if (ctx.signal.aborted) { savePartial(); return; }
    const good = results.filter((r) => r?.ok);
    if (!good.length) {
      app.lastTurnFailed = true;
      warn("No model completed the task.");
      return;
    }
    const failures = results.filter((r) => r && !r.ok).map((r) => `${r.model}: ${r.reason}`).join("\n");
    let answer = "";
    let answerModel = synthModel;
    if (good.length === 1) {
      info(`Only one model finished (${good[0].model}) — no synthesis needed.`);
      answer = good[0].text;
      answerModel = good[0].model;
      printAnswer(answerModel, answer);
    } else {
      progress.label(`merging ${good.length} answers into one`);
      const bundle = good.map((r, i) => `<answer model="${r.model}" index="${i + 1}">\n${r.text}\n</answer>`).join("\n\n");
      const stream: { md: MarkdownStream | null } = { md: null };
      const events = progress.events();
      try {
        const res = await runWorker({
          model: synthModel, systemPrompt: SYNTH_PROMPT,
          prompt: `Task:\n${task}${context}\n\nModel answers:\n${bundle}\n\nIncomplete workers (report these):\n${failures || "none"}`,
          context: ctx, tools: [], readOnly: true, skills: [], catalog: app.catalog, usage: app.usage,
          maxSteps: 1, ceiling: 1, effort: effortFor(synthModel, app.effortOverride),
          events: { ...events, onText: (delta) => {
            events.onText?.(delta);
            if (!stream.md) { line(); assistantPrefix(`${synthModel} ${c.gray("· synthesis")}`); stream.md = new MarkdownStream(); }
            stream.md.push(delta);
          } },
        });
        if (ctx.signal.aborted) { savePartial(); return; }
        if (res.stoppedBecause !== "stop" || !res.finalText.trim()) throw new Error(`Synthesis did not finish (${res.stoppedBecause}).`);
        answer = res.finalText;
      } catch (err) {
        if (ctx.signal.aborted) { savePartial(); return; }
        app.lastTurnFailed = true;
        warn(`Synthesis failed: ${(err as Error).message}. Raw answers below.`);
        for (const result of good) printAnswer(result.model, result.text);
        answer = "Synthesis failed; independent worker answers:\n\n" + good.map((r) => `## ${r.model}\n${r.text}`).join("\n\n");
      } finally { stream.md?.end(); }
    }
    if (failures) answer += `\n\nIncomplete workers:\n${failures}`;
    app.session.add({ role: "assistant", content: answer, meta: { model: answerModel } });
    app.session.save();
    const totals = app.usage.turnTotals();
    line();
    padded([c.brightMagenta(`swarm ${good.length}/${roster.length}`), c.gray(`${Math.round((Date.now() - started) / 1000)}s`),
      c.gray(fmtTokens(totals.input + totals.output) + " tokens this turn")].join(c.gray(" · ")));
  });
}

function printAnswer(model: string, text: string): void {
  line();
  assistantPrefix(model);
  const md = new MarkdownStream();
  md.push(text);
  md.end();
}
