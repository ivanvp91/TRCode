/**
 * Every tool call has to end up with an answer.
 *
 * Esc during a ten-minute build left the assistant's tool_call hanging: no
 * result, ever. That is a history hosts are entitled to refuse, and the ones
 * that accept it are worse — the model reads a call it has no outcome for and
 * runs the same build again, which is exactly what happened. Two layers are
 * asserted here: the loop, which answers what it interrupted, and the wire,
 * which repairs whatever still arrives unpaired.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-pairs-"));
process.env.TRCODE_HOME = HOME;

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
const { repairToolPairs } = await import("../dist/provider/client.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// ── the wire repairs what reaches it ────────────────────────────────────────
{
  const call = (id, name) => ({ id, type: "function", function: { name, arguments: "{}" } });

  const dangling = [
    { role: "user", content: "собери релиз" },
    { role: "assistant", content: null, tool_calls: [call("c1", "shell")] },
    { role: "user", content: "продолжи" },
  ];
  const fixed = repairToolPairs(dangling);
  const answer = fixed.find((m) => m.role === "tool" && m.tool_call_id === "c1");
  check("an unanswered call gets an answer", Boolean(answer), JSON.stringify(fixed));
  check("the answer follows its call", fixed.indexOf(answer) === 2, String(fixed.indexOf(answer)));
  check("it names the tool", answer?.name === "shell", answer?.name);
  check("and says nothing is known about the outcome", /do not assume/i.test(answer?.content ?? ""), answer?.content);
  check("the rest of the history is untouched", fixed.length === 4 && fixed[3].content === "продолжи");

  const paired = [
    { role: "assistant", content: null, tool_calls: [call("c1", "read"), call("c2", "grep")] },
    { role: "tool", tool_call_id: "c1", name: "read", content: "ok" },
    { role: "tool", tool_call_id: "c2", name: "grep", content: "ok" },
  ];
  check("a paired history is left alone", JSON.stringify(repairToolPairs(paired)) === JSON.stringify(paired));

  const halfPaired = [
    { role: "assistant", content: null, tool_calls: [call("c1", "read"), call("c2", "shell")] },
    { role: "tool", tool_call_id: "c1", name: "read", content: "ok" },
  ];
  const half = repairToolPairs(halfPaired);
  check("only the missing half is filled in", half.length === 3 && half[2].tool_call_id === "c2", JSON.stringify(half));

  const orphan = [
    { role: "user", content: "привет" },
    { role: "tool", tool_call_id: "gone", name: "read", content: "результат без вызова" },
  ];
  check("a result whose call is gone is dropped", repairToolPairs(orphan).length === 1);
}

// ── the loop answers what it interrupted ────────────────────────────────────
{
  const ac = new AbortController();
  let started = 0;
  // A tool that behaves like a build: it runs until something stops it.
  const sleeper = {
    name: "read",
    risk: "read",
    description: "hangs until aborted",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    run: (_args, ctx) =>
      new Promise((resolve) => {
        started++;
        ctx.signal.addEventListener("abort", () => resolve({ output: "killed" }), { once: true });
      }),
  };

  const messages = [{ role: "user", content: "прочитай package.json" }];
  setTimeout(() => ac.abort(), 600);
  const res = await runAgent({
    model: "mock-smart",
    systemPrompt: "ты агент",
    messages,
    tools: [sleeper],
    toolContext: { cwd: process.cwd(), depth: 0, signal: ac.signal },
    catalog: [{ id: "mock-smart" }],
    usage: new UsageTracker(),
    maxSteps: 3,
    signal: ac.signal,
    effort: "off",
    toolConcurrency: 1,
  });

  check("the turn reports the interrupt", res.stoppedBecause === "aborted", res.stoppedBecause);
  check("the tool did start", started === 1, String(started));
  const asked = messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
  const ids = (asked?.tool_calls ?? []).map((t) => t.id);
  check("the call is in the history", ids.length === 1, JSON.stringify(ids));
  const answers = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  check("and it was answered despite the interrupt", ids.every((id) => answers.includes(id)), JSON.stringify(answers));
  const said = messages.find((m) => m.role === "tool")?.content ?? "";
  check("the answer says it was interrupted", /interrupted|killed/i.test(said), said);
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
