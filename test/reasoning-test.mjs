/**
 * Thinking mode has to survive the round trip.
 *
 * DeepSeek in thinking mode streams `reasoning_content` beside the answer and
 * then refuses the *next* request unless every assistant turn that carried tool
 * calls hands that thinking back: "The `reasoning_content` in the thinking mode
 * must be passed back to the API." The client streamed the thinking into the
 * transcript and never stored it, so the second step of any tool-using turn got
 * a 400 — and the session stayed stuck on every later step, because the stored
 * history never grows that field either.
 *
 * The mock model here enforces exactly that rule, so these checks fail if the
 * field is dropped again anywhere between the stream parser and the wire.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-think-"));
process.env.TRCODE_HOME = HOME;

const LOG = path.join(HOME, "mock.log");
const port = Number(process.env.MOCK_PORT || 8951);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: LOG },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { runAgent } = await import("../dist/agent/loop.js");
const { UsageTracker } = await import("../dist/usage.js");
const { streamChat } = await import("../dist/provider/client.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};
const mockLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "");

const calc = {
  name: "calc",
  risk: "read",
  description: "compute an expression",
  parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] },
  run: async (args) => ({ output: String(args.expr) === "17*23" ? "391" : "NaN" }),
};

// ── a tool-using turn in thinking mode goes through ────────────────────────
{
  const messages = [{ role: "user", content: "Use calc for 17*23." }];
  const res = await runAgent({
    model: "mock-thinking",
    systemPrompt: "you are an agent",
    messages,
    tools: [calc],
    toolContext: { cwd: process.cwd(), depth: 0, signal: new AbortController().signal },
    catalog: [{ id: "mock-thinking" }],
    usage: new UsageTracker(),
    maxSteps: 3,
    signal: new AbortController().signal,
    effort: "medium",
    toolConcurrency: 1,
  });

  check("the second step is not refused", res.stoppedBecause === "stop", res.stoppedBecause);
  check("and the answer is the real one", /391/.test(res.finalText), res.finalText);
  check("the mock never saw a missing passback", !/missing-reasoning/.test(mockLog()), mockLog().slice(-300));

  const assistant = messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
  check("the thinking is kept on the turn that asked for tools", typeof assistant?.reasoning === "string" && assistant.reasoning.length > 0, JSON.stringify(assistant?.reasoning));
  check("it is the thinking the host streamed", /calc|17/.test(assistant?.reasoning ?? ""), assistant?.reasoning);
  check("and the answer's own thinking is kept too", messages.some((m) => m.role === "assistant" && !m.tool_calls?.length && m.reasoning), JSON.stringify(messages.filter((m) => m.reasoning).map((m) => m.reasoning.slice(0, 30))));

  // The transcript reads the same as before: the field is wire material, not
  // something a resumed session should start showing.
  check("the visible answer is unaffected", !/Confirmed with the tool result/.test(res.finalText), res.finalText);
}

// ── what actually went out on the wire ─────────────────────────────────────
{
  const call = { id: "call_x", type: "function", function: { name: "calc", arguments: '{"expr":"17*23"}' } };
  const history = [
    { role: "user", content: "Use calc for 17*23." },
    { role: "assistant", content: null, tool_calls: [call], reasoning: "I should call calc." },
    { role: "tool", tool_call_id: "call_x", content: "391" },
  ];
  let n = 0;
  for await (const _ of streamChat({ model: "mock-thinking", messages: history, effort: "medium" })) n++;
  check("a stored turn replays its thinking", /passback=1/.test(mockLog()), mockLog().slice(-200));
  check("and the step completes", n > 0, String(n));

  // An assistant turn the host never gave thinking for must not claim any.
  const quiet = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const before = (mockLog().match(/passback=\d+/g) ?? []).pop();
  for await (const _ of streamChat({ model: "mock-fast", messages: quiet, effort: "off" })) break;
  check("a turn without thinking sends no field", (mockLog().match(/passback=\d+/g) ?? []).pop() === before, before);
}

// ── a history from before the field existed ────────────────────────────────
// A resumed session, a model switched mid-turn, a pair synthesized by repair:
// the assistant turn that called tools carries no thinking. The host still
// demands the field, and an empty string is what the real endpoint accepts
// (checked against OpenCode Go's DeepSeek), so the client learns the complaint
// once and fills it — instead of making the user retype the prompt.
{
  const call = { id: "call_old", type: "function", function: { name: "calc", arguments: '{"expr":"17*23"}' } };
  const history = [
    { role: "user", content: "Use calc for 17*23." },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call_old", name: "calc", content: "391" },
  ];
  const before = (mockLog().match(/missing-reasoning/g) ?? []).length;
  let events = 0;
  try {
    for await (const _ of streamChat({ model: "mock-thinking", messages: history, effort: "medium" })) events++;
  } catch (err) {
    check("the step did not fail", false, err.message);
  }
  check("a turn with no stored thinking still goes through", events > 0, String(events));
  check(
    "the host refused it exactly once",
    (mockLog().match(/missing-reasoning/g) ?? []).length === before + 1,
    mockLog().slice(-300),
  );
  check("and the resend carried the empty field", /passback=1/.test(mockLog().slice(-400)), mockLog().slice(-200));

  // Learned means the next step does not pay the same round-trip again.
  const again = (mockLog().match(/missing-reasoning/g) ?? []).length;
  for await (const _ of streamChat({ model: "mock-thinking", messages: history, effort: "medium" })) break;
  check("later steps do not repeat the refusal", (mockLog().match(/missing-reasoning/g) ?? []).length === again);
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
