/**
 * The panel: several models answer the same question, read each other, and one
 * writes the result. What matters here is the shape of the run — three rounds,
 * a model that fails does not take the panel with it, and one survivor is not
 * a panel at all.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-brain-"));
process.env.TRCODE_HOME = HOME;

const port = Number(process.env.MOCK_PORT || 8925);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { runBrain } = await import("../dist/agent/brain.js");
const { UsageTracker } = await import("../dist/usage.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const catalog = [{ id: "mock-fast" }, { id: "mock-smart" }, { id: "mock-noeffort" }, { id: "mock-fixedtemp" }];
const base = {
  task: "как ускорить сборку",
  finalModel: "mock-fast",
  cwd: process.cwd(),
  catalog,
  effortFor: () => "off",
};

// ── the shape of a run ──────────────────────────────────────────────────────
{
  const rounds = [];
  const usage = new UsageTracker();
  const res = await runBrain({
    ...base,
    models: ["mock-fast", "mock-smart"],
    usage,
    events: { onAnswer: (m, r) => rounds.push(`${m}:${r}`) },
  });
  check("everyone answers alone first", rounds.filter((r) => r.endsWith(":answer")).length === 2, rounds.join(" "));
  check("then everyone reads the others", rounds.filter((r) => r.endsWith(":critique")).length === 2, rounds.join(" "));
  check("and one writes the result", rounds.filter((r) => r.endsWith(":final")).length === 1, rounds.join(" "));
  check("which is what comes back", res.final.length > 0, res.final.slice(0, 60));
  check("the panel is reported", res.panel.length === 2, res.panel.join(", "));
  check("every call is billed to the session", usage.totals().requests === 5, JSON.stringify(usage.totals()));
}

// ── a model that dies does not take the panel with it ───────────────────────
{
  const dropped = [];
  const res = await runBrain({
    ...base,
    models: ["mock-fast", "mock-broken"],
    usage: new UsageTracker(),
    events: { onFailed: (m) => dropped.push(m) },
  });
  check("a failing model drops out", dropped.length === 1, dropped.join(", "));
  check("and the answer still arrives", res.final.length > 0, res.final.slice(0, 60));
  check("the panel names only who finished", res.panel.length === 1, res.panel.join(", "));
}

// ── one voice is not a panel ────────────────────────────────────────────────
{
  const rounds = [];
  const res = await runBrain({
    ...base,
    models: ["mock-fast"],
    usage: new UsageTracker(),
    events: { onAnswer: (m, r) => rounds.push(r) },
  });
  check("a single model is not asked to critique itself", !rounds.includes("critique"), rounds.join(" "));
  check("nor to summarise itself", !rounds.includes("final"), rounds.join(" "));
  check("its answer is the answer", res.final.length > 0, res.final.slice(0, 40));
}

// The panel has no tools, so a question that names a file has to arrive with
// the file in it — otherwise every model answers that it cannot read it.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trc-brain-files-"));
  fs.writeFileSync(path.join(dir, "idea.md"), "СОДЕРЖИМОЕ ФАЙЛА ПРО РОУТЕР");
  const sent = [];
  const seen = { ...base, cwd: dir };
  // The mock echoes nothing back, so the question is read from what the client
  // sent: the log the mock writes has the model, not the body — hence a stub.
  const { runBrain: run } = await import("../dist/agent/brain.js");
  await run({
    ...seen,
    models: ["mock-fast", "mock-smart"],
    usage: new UsageTracker(),
    task: "обсудите idea.md",
    events: { onStart: () => sent.push(1) },
  });
  const body = fs.readFileSync(path.join(HOME, "mock.log"), "utf8");
  check("the panel was actually run", sent.length >= 2, String(sent.length));
  // What the file contained cannot be read back from the mock log, so the
  // attachment is asserted on the builder instead.
  const { attachReferenced } = await import("../dist/agent/brain.js");
  if (attachReferenced) {
    check("a named file is attached", attachReferenced(dir, "обсудите idea.md").includes("СОДЕРЖИМОЕ"), "");
    check("a path that does not exist is left alone", attachReferenced(dir, "обсудите нет-такого.md") === "", "");
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── a model that will not be steered stays in the panel ─────────────────────
{
  // The panel asks for temperature 0.4. A model fixed at 1 answers 400 to that
  // and used to leave the panel over it — an opinion lost to a preference.
  const failures = [];
  const rounds = [];
  await runBrain({
    ...base,
    models: ["mock-fast", "mock-fixedtemp"],
    usage: new UsageTracker(),
    events: {
      onFailed: (m, why) => failures.push(`${m}: ${why}`),
      onAnswer: (m, r) => rounds.push(`${m}:${r}`),
    },
  });
  const out = fs.readFileSync(path.join(HOME, "mock.log"), "utf8");
  check("nobody drops out over a temperature", failures.length === 0, failures.join("; "));
  check("the fixed model answers", rounds.includes("mock-fixedtemp:answer"), rounds.join(" "));
  check("the retry dropped the parameter", /model=mock-fixedtemp temperature=-/.test(out), "");
  // Learned once per model: the second and third rounds do not pay for it again.
  check("and it was probed only once", (out.match(/rejected=temperature/g) ?? []).length === 1, String((out.match(/rejected=temperature/g) ?? []).length));
}

// ── the conversation the question was asked in ──────────────────────────────
{
  const { attachHistory } = await import("../dist/agent/brain.js");
  const history = [
    { role: "system", content: "СИСТЕМА, которую совет видеть не должен" },
    { role: "user", content: "идея: роутер, который выбирает модель по цене" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"ideas/001.md"}' } }] },
    { role: "tool", tool_call_id: "c1", name: "read", content: "СОДЕРЖИМОЕ ИЗ ИСТОРИИ" },
    { role: "assistant", content: "понял, это про маршрутизацию" },
    { role: "user", content: "скрытое", meta: { hidden: true } },
  ];
  const block = attachHistory(history);
  // "обсудите идею" — три слова и местоимение; то, на что оно указывает, лежит
  // в истории, а не в вопросе.
  check("the idea itself reaches the panel", block.includes("роутер, который выбирает модель по цене"), block.slice(0, 200));
  check("what the session read comes with it", block.includes("СОДЕРЖИМОЕ ИЗ ИСТОРИИ"), "");
  check("which file was opened is context", block.includes("[call read]"), "");
  check("the system prompt is not the panel's business", !block.includes("СИСТЕМА, которую"), "");
  check("hidden messages stay hidden", !block.includes("скрытое"), "");
  check("oldest first, as it was said", block.indexOf("идея: роутер") < block.indexOf("понял, это про"), "");
  check("no history, no block", attachHistory([]) === "" && attachHistory(undefined) === "", "");

  // The budget is spent on the end of the conversation: that is what the
  // question was asked about.
  const long = [
    { role: "user", content: "старое " + "x".repeat(5000) },
    { role: "user", content: "новое и важное" },
  ];
  const tight = attachHistory(long, 400);
  check("the tail survives the budget", tight.includes("новое и важное"), tight.slice(-200));
  check("and the head is what gets cut", (tight.match(/x{500,}/g) ?? []).length === 0, "");
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
