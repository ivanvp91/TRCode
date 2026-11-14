/**
 * Hooks inside a real turn: a PreToolUse hook stops the tool from running at
 * all, and a PostToolUse hook speaks to the model where it reads the result.
 * The mock host answers every step with the same tool call, which is enough to
 * see what the loop does with it.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-hooklive-"));
process.env.TRCODE_HOME = HOME;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "trc-hooklive-proj-"));
fs.mkdirSync(path.join(ROOT, ".git"));
fs.mkdirSync(path.join(ROOT, ".trcode"));

const port = Number(process.env.MOCK_PORT || 8957);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { runAgent } = await import("../dist/agent/loop.js");
const { UsageTracker } = await import("../dist/usage.js");
const { resetHookSettings, trustProjectHooks } = await import("../dist/hooks.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const hookScript = path.join(HOME, "decide.mjs");
fs.writeFileSync(
  hookScript,
  `process.stderr.write("this project forbids that\\n");
process.stdout.write("read the rule in CONTRIBUTING.md\\n");
process.exit(2);
`,
);
const command = `node "${hookScript.replace(/\\/g, "/")}"`;

const settings = (hooks) => {
  fs.writeFileSync(path.join(ROOT, ".trcode", "settings.json"), JSON.stringify({ hooks }));
  resetHookSettings();
  // A repository's hooks run only after the file it was asked about is
  // approved; the turn loop sees exactly what an approved file does.
  trustProjectHooks(ROOT);
};

const ctx = () => ({
  cwd: ROOT,
  depth: 0,
  signal: new AbortController().signal,
  readFiles: new Set(),
  emit() {},
  async confirm() { return true; },
});

const run = async (maxSteps) => {
  const messages = [{ role: "user", content: "посмотри файл" }];
  let runs = 0;
  const read = {
    name: "read",
    description: "d",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    risk: "read",
    async run() {
      runs++;
      return { output: "file contents" };
    },
  };
  await runAgent({
    model: "mock-loop",
    systemPrompt: "ты агент",
    messages,
    tools: [read],
    toolContext: ctx(),
    catalog: [{ id: "mock-loop" }],
    usage: new UsageTracker(),
    maxSteps,
    signal: new AbortController().signal,
    effort: "off",
    toolConcurrency: 1,
  });
  return { messages, runs };
};

// ── PreToolUse refuses the call ─────────────────────────────────────────────
settings({ PreToolUse: [{ matcher: "read", command }] });
{
  const { messages, runs } = await run(1);
  check("the tool is never run", runs === 0, `ran ${runs} times`);
  const result = messages.find((m) => m.role === "tool");
  check("the model is told it was stopped", /^Blocked by a hook: this project forbids that/.test(String(result?.content ?? "")), String(result?.content));
}

// ── PostToolUse reacts to what the tool produced ────────────────────────────
settings({ PostToolUse: [{ matcher: "read", command }] });
{
  const { messages, runs } = await run(1);
  check("the tool does run", runs === 1, `ran ${runs} times`);
  const result = messages.find((m) => m.role === "tool");
  check("the tool's own output survives", String(result?.content).startsWith("file contents"), String(result?.content));
  check("the hook's words ride along as feedback", /\[hook feedback\] this project forbids that/.test(String(result?.content ?? "")), String(result?.content));
}

// ── a matcher that does not match leaves the call alone ─────────────────────
settings({ PreToolUse: [{ matcher: "shell", command }] });
{
  const { messages, runs } = await run(1);
  check("another tool's hook does not fire", runs === 1, `ran ${runs} times`);
  const result = messages.find((m) => m.role === "tool");
  check("and the result has no hook line", !String(result?.content ?? "").includes("hook"), String(result?.content));
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
for (const dir of [HOME, ROOT]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a hook child may still hold the directory */
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
