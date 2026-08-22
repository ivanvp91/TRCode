/**
 * The system prompt is re-sent on every step, so it is measured, not just
 * written: the tool-hygiene rules have to be there, the whole thing has to
 * stay small, and it must be byte-stable within a session or the provider
 * cache stops matching.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-prompt-"));
process.env.TRCODE_HOME = HOME;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-work-"));
fs.writeFileSync(path.join(WORK, "package.json"), "{}\n");

const { buildSystemPrompt, resetPromptSnapshots } = await import("../dist/agent/prompt.js");
const { estimateTokens } = await import("../dist/usage.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const opts = { cwd: WORK, model: "moonshotai/kimi-k3", skills: [] };
const prompt = buildSystemPrompt(opts);

// ── the rules that keep a session from getting expensive ────────────────────
check("delegating wide reading is quantified", /more than about three files/i.test(prompt), "");
check("it says to delegate read-only subagents", /task with read_only: true/i.test(prompt));
check("grep before read", /grep for the line/i.test(prompt));
check("offset/limit for large files", /offset\/limit/.test(prompt));
check("no cat through the shell", /never cat\/type one through shell/i.test(prompt));
check("no re-reading within a session", /already read in this session/i.test(prompt));
check("edit over write", /Prefer edit over rewriting/i.test(prompt));
check("subagents get the same discipline", /grep first, then read around the hit/i.test(buildSystemPrompt({ ...opts, subagent: true })));

// ── size: this rides along on every single request ──────────────────────────
{
  // Measured on a model with no note of its own, so this stays a guard on the
  // prompt itself rather than on the per-model addition below.
  const plain = estimateTokens(buildSystemPrompt({ ...opts, model: "anthropic/claude-opus-5" }));
  check(`the prompt stays small (${plain} tokens)`, plain < 900, String(plain));
  const withNote = estimateTokens(buildSystemPrompt({ ...opts, model: "qwen/qwen3.8-max" }));
  check(`a model note costs little (${withNote - plain} tokens)`, withNote - plain < 90, String(withNote - plain));
  const sub = estimateTokens(buildSystemPrompt({ ...opts, subagent: true }));
  check(`the subagent prompt stays smaller (${sub} tokens)`, sub < 500, String(sub));
}

// ── stability: a changed prefix is a cache miss for everything after it ─────
{
  const before = buildSystemPrompt(opts);
  fs.writeFileSync(path.join(WORK, "new-file.ts"), "export const x = 1;\n");
  const after = buildSystemPrompt(opts);
  check("a new file does not rewrite the prompt", before === after);

  resetPromptSnapshots();
  const refreshed = buildSystemPrompt(opts);
  check("resetting the snapshot picks the file up", refreshed.includes("new-file.ts"), refreshed.slice(0, 300));
  check("the refreshed prompt is stable too", refreshed === buildSystemPrompt(opts));
}

// ── the context nudge fires once per threshold, not every turn ──────────────
{
  const { App } = await import("../dist/ui/repl.js");
  const { Session } = await import("../dist/session/session.js");

  let out = "";
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out += String(chunk); return true; };
  const say = (s) => realWrite(s + "\n");
  const take = () => { const s = out; out = ""; return s; };

  const app = Object.create(App.prototype);
  const session = new Session({ cwd: WORK, model: "m", title: "t" });
  Object.assign(app, {
    cwd: WORK,
    cfg: { maxSteps: 60 },
    catalog: [{ id: "m", contextWindow: 100_000 }],
    session,
    usage: session.usage,
    nudgedAt: 0,
    nudgeKey: "",
    effortOverride: undefined,
  });

  const fill = (tokens) => {
    session.messages = [{ role: "user", content: "x".repeat(Math.round(tokens * 3.6)) }];
  };

  fill(20_000); // 20% of the window
  app.statusLine(1000, 1, "stop");
  check("quiet while there is room", !/History is/.test(take()));

  fill(60_000); // 60%
  app.statusLine(1000, 1, "stop");
  const first = take();
  check("speaks up past half the window", /History is ~/.test(first) && /\/compact/.test(first), first.slice(-200));

  app.statusLine(1000, 1, "stop");
  check("does not repeat itself at the same level", !/History is/.test(take()));

  fill(85_000); // 85% — a new threshold, worth saying again
  app.statusLine(1000, 1, "stop");
  check("speaks again at the next threshold", /History is/.test(take()));

  // Compacting makes the advice relevant again.
  session.compactions = 1;
  fill(60_000);
  app.statusLine(1000, 1, "stop");
  check("resets after a compaction", /History is/.test(take()));

  process.stdout.write = realWrite;
  void say;
}

// ── when auto-compaction fires ──────────────────────────────────────────────
// Compaction is lossy, so it has to wait for the window to actually fill. It
// used to also trigger at twice the on-the-wire trim budget, which on a 1M
// window meant compacting at 8% — a history the model could still hold whole.
{
  const { shouldAutoCompact, contextPressure } = await import("../dist/session/compact.js");
  const { Session } = await import("../dist/session/session.js");
  const { saveConfig } = await import("../dist/config.js");

  saveConfig({ maxRequestTokens: 40_000, autoCompactAt: 0.9 });
  const catalog = [{ id: "big", contextWindow: 1_000_000 }];
  const s = new Session({ cwd: WORK, model: "big", title: "t" });
  const fill = (tokens) => {
    s.messages = [{ role: "user", content: "x".repeat(Math.round(tokens * 3.6)) }];
  };

  fill(200_000); // 20% of the window, five times the request budget
  const low = contextPressure(s, catalog);
  check(
    "a fifth of the window does not compact",
    !shouldAutoCompact(s, catalog),
    `ratio ${low.ratio.toFixed(2)}`,
  );

  fill(880_000); // 88% — close, but the threshold is 90
  check("just under the threshold still holds", !shouldAutoCompact(s, catalog));

  fill(920_000);
  check("past 90% of the window it compacts", shouldAutoCompact(s, catalog));

  // The share is what decides, on any window size.
  const small = [{ id: "small", contextWindow: 100_000 }];
  s.model = "small";
  fill(95_000);
  check("the same share fires on a small window", shouldAutoCompact(s, small));
}

// "Check my servers" has an answer on this machine — but only if the agent
// knows where the list is.
{
  const os = await import("node:os");
  const fsx = await import("node:fs");
  const pathx = await import("node:path");
  const has = fsx.existsSync(pathx.join(os.homedir(), ".ssh", "config"));
  const env = prompt.slice(prompt.indexOf("<environment>"), prompt.indexOf("</environment>"));
  check(
    has ? "ssh-хосты названы в окружении" : "без ~/.ssh/config строки нет",
    has ? new RegExp("SSH hosts configured: [0-9]+").test(env) : !/SSH hosts/.test(env),
    env,
  );
}

// ── model-specific notes ────────────────────────────────────────────────────
{
  const { modelNote } = await import("../dist/agent/prompt.js");
  const { saveConfig } = await import("../dist/config.js");

  check("многословные семейства получают заметку", modelNote("qwen/qwen3.8-max").includes("Thinking budget"), modelNote("qwen/qwen3.8-max").slice(0, 40));
  check("префикс поставщика не мешает", modelNote("alibabacloud:qwen3.8-max").includes("Thinking budget"));
  check("kimi тоже", modelNote("moonshotai/kimi-k3").includes("Thinking budget"));
  // The subscription host names its own models: "k3" carries no family in it,
  // so the provider prefix has to count as part of the name.
  check("kimi:k3 с подписки — тоже", modelNote("kimi:k3").includes("Thinking budget"), modelNote("kimi:k3"));
  check("и kimi:kimi-for-coding", modelNote("kimi:kimi-for-coding").includes("Thinking budget"));
  check("а claude: с префиксом — нет", modelNote("claude:claude-opus-5") === "", modelNote("claude:claude-opus-5"));
  check("остальным ничего не добавляется", modelNote("anthropic/claude-opus-5") === "", modelNote("anthropic/claude-opus-5"));

  saveConfig({ modelPrompts: { "qwen/qwen3.8-max": "своя заметка" } });
  check("точный ключ заменяет встроенную", modelNote("qwen/qwen3.8-max") === "своя заметка", modelNote("qwen/qwen3.8-max"));
  check("а не просто дописывается", !modelNote("qwen/qwen3.8-max").includes("Thinking budget"));

  saveConfig({ modelPrompts: { "qwen/qwen3.8-max": "" } });
  check("пустая строка снимает заметку совсем", modelNote("qwen/qwen3.8-max") === "");

  saveConfig({ modelPrompts: { "kimi*": "для всей линейки" } }, { replace: ["modelPrompts"] });
  const both = modelNote("moonshotai/kimi-k3");
  check("ключ с * дописывается к встроенной", both.includes("Thinking budget") && both.includes("для всей линейки"), both);
  saveConfig({ modelPrompts: {} }, { replace: ["modelPrompts"] });
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`
${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
