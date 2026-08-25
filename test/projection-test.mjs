/**
 * Request projection log: what the model was actually sent on every step.
 *
 * The stored history alone cannot answer that after a resume — trim rewrites
 * old results and injections sit inside the messages — so each request appends
 * one record to <session-id>.proj.jsonl. These tests cover the file side
 * (append, load, missing file, corrupt lines) and the loop side (records land
 * per step, carry the provider usage, survive a disk error).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-proj-"));
process.env.TRCODE_HOME = HOME;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// The module needs a config home; sessionsDir lives under it.
const { appendProjection, loadProjections, removeProjection, projectionFile } = await import("../dist/session/projection.js");

const cwd = process.cwd();
const sid = "test-session";

// ── missing file means no records ──
check("no file → empty list", loadProjections(cwd, sid).length === 0);

// ── append + load roundtrip ──
appendProjection(cwd, sid, {
  step: 0, ts: 1000, model: "mock:m",
  systemTokens: 500, schemaTokens: 900, historyTokens: 1200,
  injected: [{ source: "skill:test", tokens: 300 }],
  trimmed: 2, trimSaved: 4000, promptTokens: 2900, cachedTokens: 800,
});
appendProjection(cwd, sid, {
  step: 1, ts: 2000, model: "mock:m",
  systemTokens: 500, schemaTokens: 900, historyTokens: 2500,
  injected: [], trimmed: 3, trimSaved: 9000,
});
{
  const rows = loadProjections(cwd, sid);
  check("both records load in order", rows.length === 2 && rows[0].step === 0 && rows[1].step === 1, JSON.stringify(rows.length));
  check("fields survive the roundtrip", rows[0].injected[0]?.source === "skill:test" && rows[0].trimSaved === 4000 && rows[1].cachedTokens === undefined);
}

// ── corrupt trailing line does not take the rest down ──
fs.appendFileSync(projectionFile(cwd, sid), "{broken json\n");
{
  const rows = loadProjections(cwd, sid);
  check("a broken line is skipped", rows.length === 2, String(rows.length));
}

// ── removeProjection cleans up alongside the session ──
removeProjection(cwd, sid);
check("removeProjection deletes the file", !fs.existsSync(projectionFile(cwd, sid)));
removeProjection(cwd, sid); // twice must be safe

// ── the loop writes one record per step, with usage ──────────────────────────
{
  const port = Number(process.env.MOCK_PORT || 8941);
  const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
    stdio: "ignore",
    env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
  });
  process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.TOKENROUTER_API_KEY = "sk-test";
  await new Promise((r) => setTimeout(r, 1200));

  const { runAgent } = await import("../dist/agent/loop.js");
  const { UsageTracker } = await import("../dist/usage.js");
  const sid2 = "loop-session";
  const usage = new UsageTracker();
  // A tool call on step 0 forces a second step; the mock's tool result comes
  // back as plain text, so the turn ends after two requests.
  const res = await runAgent({
    model: "mock-smart",
    systemPrompt: "ты агент",
    messages: [
      { role: "user", content: "call the echo tool, then answer." },
      {
        role: "assistant", content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } }],
      },
      { role: "tool", tool_call_id: "c1", name: "echo", content: "echoed: hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "thanks — now just say ok" },
    ],
    tools: [{
      name: "echo", description: "echo", parameters: { type: "object", properties: {} }, risk: "read",
      run: async () => ({ output: "echoed" }),
    }],
    toolContext: { cwd: process.cwd(), depth: 0, signal: new AbortController().signal },
    catalog: [],
    usage,
    maxSteps: 5,
    signal: new AbortController().signal,
    projection: { cwd, sessionId: sid2 },
  }).catch((err) => ({ error: err }));

  check("the turn finished", !res.error && res.steps >= 1, res.error?.message ?? "");
  if (!res.error) {
    const rows = loadProjections(cwd, sid2);
    check("one record per request", rows.length === res.steps, `rows=${rows.length} steps=${res.steps}`);
    check("components are non-zero", rows.every((p) => p.systemTokens > 0 && p.schemaTokens > 0 && p.historyTokens >= 0));
    check("provider usage lands in the record", rows.every((p) => typeof p.promptTokens === "number" && p.promptTokens > 0));
    check("steps are numbered in order", rows.map((p) => p.step).every((s, i, a) => i === 0 || s === a[i - 1] + 1));
    check("model is named", rows.every((p) => p.model === "mock-smart"));
  }
  mock.kill("SIGKILL");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
