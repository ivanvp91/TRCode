/**
 * A thinking turn that never reaches an answer.
 *
 * A reasoning model can spend its whole output budget thinking — the host then
 * ends the reply with `finish_reason: "length"` and no text — and a router that
 * gave up on its upstream just stops the stream. Both used to look like a
 * finished turn: the reasoning streamed, the statistics line appeared over an
 * empty answer, and nothing said the model had not answered. The step is sent
 * again instead, with what happened said out loud, and nothing empty reaches
 * the history.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-noanswer-"));
process.env.TRCODE_HOME = HOME;

const port = Number(process.env.MOCK_PORT || 8944);
const LOG = path.join(HOME, "mock.log");
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: LOG },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { runAgent } = await import("../dist/agent/loop.js");
const { UsageTracker } = await import("../dist/usage.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const mockLog = () => {
  try {
    return fs.readFileSync(LOG, "utf8");
  } catch {
    return "";
  }
};

const run = (model, messages, events) =>
  runAgent({
    model,
    systemPrompt: "ты агент",
    messages,
    tools: [],
    toolContext: { cwd: process.cwd(), depth: 0, signal: new AbortController().signal },
    catalog: [{ id: model }],
    usage: new UsageTracker(),
    maxSteps: 4,
    signal: new AbortController().signal,
    effort: "off",
    toolConcurrency: 1,
    events,
  });

const emptyAssistant = (messages) =>
  messages.some((m) => m.role === "assistant" && !(m.content ?? "").trim() && !(m.tool_calls?.length));

// ── a stream that stops without saying anything ─────────────────────────────
{
  const messages = [{ role: "user", content: "привет" }];
  const announced = [];
  const res = await run("mock-thinking-only", messages, {
    onNoAnswer: (why, attempt, of) => announced.push({ why, attempt, of }),
  });

  check("the turn gets its answer after a resend", res.finalText.includes("ОТВЕТ ПОСЛЕ РАЗМЫШЛЕНИЯ"), JSON.stringify(res.finalText));
  check("the step was not skipped", res.steps === 1, String(res.steps));
  check("the resend was announced", announced.length === 1, JSON.stringify(announced));
  check("it is counted against a budget", announced[0]?.attempt === 1 && announced[0]?.of === 5, JSON.stringify(announced[0]));
  check("the announcement says the stream ended", /ended before any answer/.test(announced[0]?.why ?? ""), announced[0]?.why);
  check("the reasoning-only reply never reaches the history", !emptyAssistant(messages), JSON.stringify(messages.map((m) => m.role)));
  check("nothing the user did not say was written down", !messages.some((m) => (m.content ?? "").includes("previous reply ended")), JSON.stringify(messages));
  check("the answer is in the history", messages.some((m) => (m.content ?? "").includes("ОТВЕТ ПОСЛЕ РАЗМЫШЛЕНИЯ")));
  check("and the turn reports a normal stop", res.stoppedBecause === "stop", res.stoppedBecause);
  const seen = mockLog().split("\n").filter((l) => l.startsWith("SILENT model=mock-thinking-only"));
  check("a stream that merely broke is resent exactly as it was", seen.length === 2 && seen.every((l) => l.includes("nudge=false")), seen.join(" | "));
}

// ── a host that never answers at all ────────────────────────────────────────
{
  const messages = [{ role: "user", content: "привет" }];
  const announced = [];
  let thrown;
  try {
    await run("mock-never-answers", messages, {
      onNoAnswer: (why, attempt, of) => announced.push({ why, attempt, of }),
    });
  } catch (err) {
    thrown = err;
  }

  check("a turn that never answers ends in words", Boolean(thrown), "the turn returned as if it had finished");
  check("the words say what happened", /without answering/.test(thrown?.message ?? ""), thrown?.message);
  check("the retries were announced", announced.length === 5, JSON.stringify(announced.length));
  check(
    "a spent output budget is named as such",
    announced.every((a) => /output limit/.test(a.why)),
    JSON.stringify(announced),
  );
  check("the empty replies stay out of the history", !emptyAssistant(messages), JSON.stringify(messages.map((m) => m.role)));
  check("no nudge is left behind either", messages.length === 1, JSON.stringify(messages));
  const seen = mockLog().split("\n").filter((l) => l.startsWith("SILENT model=mock-never-answers"));
  check(
    "a spent output budget is asked to answer straight away",
    seen.length === 6 && !seen[0].includes("nudge=true") && seen.slice(1).every((l) => l.includes("nudge=true")),
    seen.join(" | "),
  );
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
