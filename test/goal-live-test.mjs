/**
 * The goal loop end-to-end, against the real REPL wiring: /goal typed through
 * a fake stdin fires continuation turns on its own, the <goal-complete> tag
 * ends the loop, the turn budget pauses it, /goal resume refills the budget,
 * Esc pauses a running goal, and a failed step pauses it instead of retrying
 * forever. Assertions go through the session state, not the transcript: the
 * loop spends a 2-turn budget in milliseconds, faster than any screen poll.
 */
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESC = String.fromCharCode(27);

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-goal-live-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-goal-live-cwd-"));
process.env.TRCODE_HOME = HOME;

// ── a scenario server: the answer depends on the script the test sets ──────
let script = [];           // answers in order; the last one repeats forever
const calls = [];          // the user text of every request the server saw
const server = http.createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "goal-m", owned_by: "mock", context_window: 128000 }] }));
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const payload = JSON.parse(body);
    const msgs = payload.messages ?? [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    calls.push({ text: typeof lastUser?.content === "string" ? lastUser.content.slice(0, 120) : "" });
    const answer = script.length > 1 ? script.shift() : script[0] ?? "ok";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const sse = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
    const chunk = (delta) => ({
      id: "x", object: "chat.completion.chunk", model: "goal-m",
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    sse(chunk({ role: "assistant", content: "" }));
    // A "<HANG>" answer never ends: reasoning drips until the client aborts.
    if (answer.startsWith("<HANG>")) {
      const tick = setInterval(() => sse(chunk({ reasoning_content: "…" })), 200);
      req.on("close", () => clearInterval(tick));
      return;
    }
    for (const piece of answer.match(/.{1,6}/gs) ?? []) sse(chunk({ content: piece }));
    res.write(
      "data: " +
        JSON.stringify({
          id: "x", object: "chat.completion.chunk", model: "goal-m",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
        }) +
        "\n\n",
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ── fake terminal ──────────────────────────────────────────────────────────
const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });

let painted = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { painted += String(chunk); return true; };
const say = (s = "") => realWrite(s + "\n");
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");

process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";

const { App } = await import("../dist/ui/repl.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; say("  ok   " + name); }
  else { failed++; say("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const type = (text) => {
  stdin.emit("data", Buffer.from(text, "utf8"));
  stdin.emit("data", Buffer.from("\r", "utf8"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeout = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred()) return true;
    await sleep(40);
  }
  return pred();
}

const app = new App({ cwd: WORK, model: "goal-m", autoApprove: true });
await app.init();
// init() reconciles the model against the SEED catalog (a fresh home has no
// cache), which can swap goal-m away — the scenario server serves any model,
// so pin it back and keep every request on the local server.
app.session.model = "goal-m";
// Probe: one ordinary turn must land on the scenario server. If it does not,
// the whole suite would fail in a cascade of timeouts instead of saying so.
script = ["probe answer"];
await app.turn("probe");
check("requests land on the scenario server", calls.length > 0, `calls=${calls.length} model=${app.session.model}`);

// ── Scenario A: a goal that completes itself ───────────────────────────────
script = ["step one done", "all finished <goal-complete>"];
const runP = app.run();
await sleep(400);
type("/goal make the tests green");
check(
  "the session holds an active goal after /goal",
  await waitFor(() => app.session.goal?.status === "active" && app.session.goal?.objective === "make the tests green"),
  JSON.stringify(app.session.goal),
);
check(
  "continuation turns run without any user input",
  await waitFor(() => (app.session.goal?.turnsUsed ?? 0) >= 2),
  `turnsUsed=${app.session.goal?.turnsUsed}`,
);
check(
  "the completion tag ends the loop",
  await waitFor(() => app.session.goal?.status === "complete"),
  `status=${app.session.goal?.status}`,
);
await sleep(300);
check("no goal turn fires after completion", app.session.goal?.turnsUsed === 2, `turnsUsed=${app.session.goal?.turnsUsed}`);

// ── Scenario B: budget pause, /goal status, /goal resume ───────────────────
script = ["still working"];
const beforeB = calls.length;
type("/goal endless grind --turns 2");
check(
  "the new goal replaces the old one and spends its budget",
  await waitFor(() => app.session.goal?.objective === "endless grind" && app.session.goal?.status === "paused" && app.session.goal?.turnsUsed === 2),
  JSON.stringify(app.session.goal),
);
check(
  "its continuation prompts really carried the objective",
  calls.slice(beforeB).some((c) => c.text.includes("endless grind")),
  `calls=${JSON.stringify(calls.slice(beforeB).map((c) => c.text.slice(0, 40)))}`,
);
type("/goal status");
check(
  "/goal status marks the paused goal",
  await waitFor(() => /◎/.test(strip(painted).slice(-800))),
  strip(painted).slice(-300),
);
painted = "";
const grindCallsAtResume = calls.filter((c) => c.text.includes("endless grind")).length;
type("/goal resume");
check(
  "resume grants a fresh budget: two more turns go out, then the cap pauses it again",
  await waitFor(() => {
    const n = calls.filter((c) => c.text.includes("endless grind")).length;
    return n >= grindCallsAtResume + 2 && app.session.goal?.status === "paused" && app.session.goal?.turnsUsed === 2;
  }, 15000),
  `turnsUsed=${app.session.goal?.turnsUsed} status=${app.session.goal?.status} newCalls=${calls.filter((c) => c.text.includes("endless grind")).length - grindCallsAtResume}`,
);

// ── no --turns: the built-in cap lands on the first continuation turn ──────
script = ["still going"];
type("/goal uncapped work");
check(
  "an uncapped goal gets the built-in 25-turn limit on its first turn",
  await waitFor(() => app.session.goal?.objective === "uncapped work" && (app.session.goal?.turnsUsed ?? 0) >= 1 && app.session.goal?.maxTurns === 25),
  JSON.stringify(app.session.goal),
);
type("/goal pause");
check(
  "/goal pause stops the uncapped goal",
  await waitFor(() => app.session.goal?.status === "paused"),
  JSON.stringify(app.session.goal),
);

// ── Esc during a running goal turn pauses it, not skips it ─────────────────
script = ["<HANG>"];
type("/goal hang forever --turns 10");
check(
  "the hanging goal turn is in flight",
  await waitFor(() => calls.some((c) => c.text.includes("hang forever")), 15000),
);
await sleep(300);
stdin.emit("data", Buffer.from(ESC, "utf8"));
check(
  "Esc during a goal turn pauses the goal",
  await waitFor(() => app.session.goal?.status === "paused", 12000),
  `status=${app.session.goal?.status}`,
);
await sleep(300);
check("no further turn was fired after Esc", app.session.goal?.turnsUsed === 1, `turnsUsed=${app.session.goal?.turnsUsed}`);

// ── Scenario C: a failed step pauses the goal instead of retrying forever ──
// A hard 400 (no content-filter wording) is thrown straight out of runAgent —
// a dropped connection would only be retried, which is exactly what the pause
// exists to avoid burning through.
script = ["<FAIL>"];
type("/goal fragile task --turns 5");
check(
  "the new goal starts active",
  await waitFor(() => app.session.goal?.objective === "fragile task", 15000),
  JSON.stringify(app.session.goal),
);
check(
  "a failed step pauses the goal",
  await waitFor(() => app.session.goal?.status === "paused", 30000),
  `status=${app.session.goal?.status} turnsUsed=${app.session.goal?.turnsUsed}`,
);

type("/quit");
await Promise.race([runP, sleep(4000)]);

// ── persistence: the goal is in the session file on disk ──────────────────
const { Session } = await import("../dist/session/session.js");
const reloaded = Session.load(WORK, app.session.id);
check(
  "the goal survives a reload of the session",
  Boolean(reloaded?.goal) && reloaded.goal.objective === "fragile task" && reloaded.goal.status === "paused",
  JSON.stringify(reloaded?.goal),
);

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
