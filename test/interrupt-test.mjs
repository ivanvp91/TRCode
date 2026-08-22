/**
 * Esc has to end a turn that is not going to end on its own: a model that
 * thinks forever, and a host that is holding the send back after a 429. Both
 * are exactly when a user reaches for it, and both were reported as deaf.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESC = String.fromCharCode(27);

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-esc-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-esc-cwd-"));
process.env.TRCODE_HOME = HOME;

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => {
  stdin.isRaw = v;
  return stdin;
};
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });

const realWrite = process.stdout.write.bind(process.stdout);
const say = (line) => realWrite(line + "\n");
let painted = "";
process.stdout.write = (chunk) => {
  painted += String(chunk);
  return true;
};
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");

const port = Number(process.env.MOCK_PORT || 8915);
const LOG = path.join(HOME, "mock.log");
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: LOG },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { App } = await import("../dist/ui/repl.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    say("  ok   " + name);
  } else {
    failed++;
    say("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
};

const app = new App({ cwd: WORK, model: "mock-slow", autoApprove: true });
await app.init();

/** Runs a turn, sends `keys` after `afterMs`, and reports how long it took. */
async function escDuring(model, afterMs, keys = ESC) {
  app.session.model = model;
  painted = "";
  const at = Date.now();
  const turn = app.turn("сделай что-нибудь долгое");
  const pressed = new Promise((r) =>
    setTimeout(() => {
      stdin.emit("data", Buffer.from(keys, "utf8"));
      r();
    }, afterMs),
  );
  const timeout = new Promise((r) => setTimeout(() => r("timeout"), afterMs + 8000));
  const outcome = await Promise.race([turn.then(() => "done"), timeout]);
  await pressed;
  return { outcome, ms: Date.now() - at, screen: strip(painted) };
}

// A model that streams reasoning and never stops. Without an abort the turn
// runs until the stall guard fires, minutes later.
{
  const { outcome, ms, screen } = await escDuring("mock-slow", 1200);
  check("Esc ends a turn that is still streaming", outcome === "done", `${outcome} after ${ms}ms`);
  check("and it ends promptly", ms < 4000, `${ms}ms`);
  check("the transcript says it was interrupted", /Прервано|Interrupted/i.test(screen), screen.slice(-400));
}

// A terminal hands over whatever has accumulated since the last read, so the
// Esc that matters — pressed while text is being typed, or hit twice out of
// impatience — arrives glued to other bytes. Matching the whole chunk missed
// exactly those.
{
  const { outcome, ms } = await escDuring("mock-slow", 900, ESC + ESC);
  check("a doubled Esc still interrupts", outcome === "done", `${outcome} after ${ms}ms`);
}
{
  const { outcome, ms } = await escDuring("mock-slow", 900, "прод" + ESC);
  check("Esc glued to typed text still interrupts", outcome === "done", `${outcome} after ${ms}ms`);
}
{
  // An arrow key is also an Esc byte, and must go on meaning "arrow".
  const { isInterrupt, readInterrupt, InterruptWatcher } = await import("../dist/ui/turnbar.js");
  check("cursor keys are not interrupts", !isInterrupt(ESC + "[A") && !isInterrupt(ESC + "OB"));
  check("a doubled Esc is", isInterrupt(ESC + ESC));
  check("and so is Esc before another key", isInterrupt(ESC + "x"));
  check("Ctrl+C is never in doubt", readInterrupt(String.fromCharCode(3)) === "yes");
  // Alt+Enter — a newline in the message being composed while the model works.
  // Read as Esc, it ended the turn the moment a queued note went to a second
  // line: the interrupt nobody asked for.
  check("Alt+Enter is a newline, not a cancel", readInterrupt(ESC + String.fromCharCode(13)) === "no");
  check("and so is Alt+Ctrl+Enter", readInterrupt(ESC + String.fromCharCode(10)) === "no");
  check("even glued to what was typed before it", readInterrupt("вторая строка" + ESC + String.fromCharCode(13)) === "no");
  check("modified Enter reported as a sequence too", readInterrupt(ESC + "[13;2u") === "no");
  // A chunk that ends on Esc is ambiguous: a real press, or the head of a
  // sequence the terminal split across two reads. What arrives next decides.
  check("a trailing Esc is undecided", readInterrupt(ESC) === "pending" && readInterrupt("x" + ESC) === "pending");

  // The turn nobody cancelled: a pasted log carries escape bytes of its own,
  // and every one of them used to read as somebody reaching for Esc.
  const LOG = ESC + "]0;title" + String.fromCharCode(7) + " [build] " + ESC + " 42%";
  const pasted = ESC + "[200~" + LOG + ESC + "[201~";
  check("escape bytes inside a paste are data", readInterrupt(pasted) === "no", readInterrupt(pasted));
  check("including when the paste is still open", readInterrupt(LOG, true) === "no", readInterrupt(LOG, true));
  check("a real Esc after the paste closes still counts", readInterrupt(pasted + ESC + "x") === "yes");

  // And across chunk boundaries.
  const fired = [];
  const w = new InterruptWatcher(() => fired.push(1), 30);
  w.feed(ESC);
  w.feed("[A");
  await new Promise((r) => setTimeout(r, 90));
  check("a cursor key split across two reads never cancels", fired.length === 0, String(fired.length));
  w.feed(ESC);
  await new Promise((r) => setTimeout(r, 90));
  check("a lone Esc cancels once nothing follows it", fired.length === 1, String(fired.length));
  w.feed(ESC);
  w.feed("x");
  check("Esc followed by a keystroke cancels at once", fired.length === 2, String(fired.length));
  w.stop();
}

// Anything typed while waiting is handed back, not sent: firing the queue
// right after an interrupt starts a new turn in the same breath, which is
// indistinguishable from Esc having done nothing.
{
  app.session.model = "mock-slow";
  const turn = app.turn("сделай что-нибудь долгое");
  await new Promise((r) => setTimeout(r, 700));
  stdin.emit("data", Buffer.from("продолжи", "utf8"));
  stdin.emit("data", Buffer.from("\r", "utf8"));
  stdin.emit("data", Buffer.from(ESC, "utf8"));
  await turn;
  check("a queued message is not sent after Esc", app.pendingCount === 0, `pending: ${app.pendingCount}`);
}

// A host that refused with 429 and named a window: the client is asleep until
// it passes, and that sleep has to be interruptible too.
{
  const { complete } = await import("../dist/provider/client.js");
  await complete({ model: "mock-limited", messages: [{ role: "user", content: "hi" }], stream: false });
  const { outcome, ms } = await escDuring("mock-limited", 800);
  check("Esc ends a turn held back by a rate limit", outcome === "done", `${outcome} after ${ms}ms`);
  check("without waiting the window out", ms < 3000, `${ms}ms`);
}


// A tool that never returns — an MCP server gone quiet, a child that ignores
// its kill. The turn must not wait for it once the user has said stop.
{
  const { runAgent } = await import("../dist/agent/loop.js");
  const ac = new AbortController();
  const hung = {
    name: "read",   // the name the mock calls, so the hung tool is the one that runs
    risk: "read",
    description: "never returns",
    parameters: { type: "object", properties: {} },
    run: () => new Promise(() => {}),
  };
  const at = Date.now();
  setTimeout(() => ac.abort(), 700);
  const res = await runAgent({
    model: "mock-fast",
    systemPrompt: "s",
    messages: [{ role: "user", content: "позови инструмент" }],
    tools: [hung],
    toolContext: { cwd: process.cwd(), signal: ac.signal, depth: 0 },
    catalog: [{ id: "mock-fast", modality: "text", chatCapable: true }],
    usage: new (await import("../dist/usage.js")).UsageTracker(),
    maxSteps: 0,
    signal: ac.signal,
  });
  const ms = Date.now() - at;
  check("a hung tool does not hold the turn", res.stoppedBecause === "aborted", res.stoppedBecause);
  check("and it lets go at once", ms < 2500, ms + "ms");
}


// Esc at a permission prompt. Answering "reject" only denies that one tool —
// the model goes on and the next tool asks again, which from the outside is a
// session that ignores Esc.
{
  const { PermissionBroker } = await import("../dist/ui/permissions.js");
  let cancelled = 0;
  const broker = new PermissionBroker({ interactive: true, exclusive: (fn) => fn() });
  broker.onCancel = () => cancelled++;
  const tool = { name: "shell", risk: "shell", description: "", parameters: {}, run: async () => ({ output: "" }) };
  const asked = broker.confirm(tool, { command: "rm -rf /" });
  await new Promise((r) => setTimeout(r, 300));
  stdin.emit("data", Buffer.from(ESC, "utf8"));
  const allowed = await asked;
  check("Esc at a permission prompt denies the tool", allowed === false, String(allowed));
  check("and stops the turn with it", cancelled === 1, String(cancelled));
}


// The rate-limit label counts down and then goes: it used to sit there
// claiming a wait that had ended, while the model was already answering.
{
  app.session.model = "mock-limited";
  const { complete } = await import("../dist/provider/client.js");
  await complete({ model: "mock-limited", messages: [{ role: "user", content: "hi" }], stream: false });
  painted = "";
  await app.turn("скажи что-нибудь");
  const tail = strip(painted).slice(-1500);
  check("the wait was announced", /rate limit/.test(strip(painted)));
  check("and is gone by the end of the turn", !/rate limit/.test(tail), tail.slice(-300));
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
