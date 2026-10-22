/**
 * Steering: a message typed while the model works joins the running turn at
 * its next step — a word across the desk, not a new turn after the answer.
 * Tab is the other half of Enter and holds the line for after the turn.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESC = String.fromCharCode(27);

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-steer-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-steer-cwd-"));
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

const port = Number(process.env.MOCK_PORT || 8955);
const LOG = path.join(HOME, "mock.log");
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: LOG },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

fs.writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "steer-fixture", version: "1.0.0" }, null, 2) + "\n");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockLog = () => {
  try {
    return fs.readFileSync(LOG, "utf8");
  } catch {
    return "";
  }
};

const app = new App({ cwd: WORK, model: "mock-steer", autoApprove: true });
await app.init();
app.session.model = "mock-steer";

// The mock holds its first answer back for 700ms and then asks for a tool, so
// typing at 300ms lands while the turn is genuinely running.
const STEER = "STEERCORRECTION не открывай этот файл";
let turn = app.turn("прочитай package.json");
await sleep(300);
stdin.emit("data", Buffer.from(STEER, "utf8"));
stdin.emit("data", Buffer.from("\r", "utf8"));
await turn;

{
  const messages = app.session.messages;
  const at = messages.findIndex((m) => m.role === "user" && String(m.content).includes("STEERCORRECTION"));
  check("the typed line joined the turn's history", at > 0, JSON.stringify(messages.map((m) => m.role)));
  check("it landed after the tool result", at > 0 && messages[at - 1].role === "tool", at > 0 ? messages[at - 1].role : "-");
  check("and the model answered after it", at > 0 && messages.slice(at + 1).some((m) => m.role === "assistant"));
  check("the next request carried it", /delivered=1/.test(mockLog()), mockLog().slice(-300));
  check("nothing was queued for a turn of its own", app.pendingCount === 0, String(app.pendingCount));
  check("the bar showed it as steering, not as queued", /steering: STEERCORRECTION/.test(strip(painted)));
  check("the bar was in steering mode all along", /enter to steer/.test(strip(painted)));
  check("it is kept for ↑ recall", app.history.includes(STEER), JSON.stringify(app.history.slice(-3)));
}

// The command dropdown is the same list under the band as under the idle
// composer: typing "/" while the model works is how a command is reached for.
painted = "";
turn = app.turn("прочитай package.json");
await sleep(300);
stdin.emit("data", Buffer.from("/upd", "utf8"));
await sleep(200);
{
  const screen = strip(painted);
  check("a slash mid-turn opens the command list", /→ \/update/.test(screen), screen.slice(-700));
  check("and the row it sits on says so", /\(\d+\/\d+\)/.test(screen), screen.slice(-400));
}
stdin.emit("data", Buffer.from(String.fromCharCode(21), "utf8")); // ctrl+u: clear the line
await turn;
check("the cleared line steers nothing", app.pendingCount === 0, String(app.pendingCount));

// Tab is the other half of Enter: the line waits for the turn to end.
painted = "";
turn = app.turn("прочитай ещё раз");
await sleep(300);
stdin.emit("data", Buffer.from("после хода", "utf8"));
stdin.emit("data", Buffer.from("\t", "utf8"));
await turn;
{
  const delivered = mockLog().match(/delivered=(\d)/g) ?? [];
  check("a Tab line does not join the running turn", delivered.at(-1) === "delivered=0", JSON.stringify(delivered));
  check("it is queued for the next turn instead", app.pendingCount === 1, String(app.pendingCount));
}

// A command typed mid-turn is the REPL's, not the model's: Enter queues it for
// after the turn instead of steering "/model" into the conversation as prose.
painted = "";
turn = app.turn("прочитай package.json");
await sleep(300);
stdin.emit("data", Buffer.from("/model mock-fast", "utf8"));
stdin.emit("data", Buffer.from("\r", "utf8"));
await turn;
{
  const before = 1;
  check("a command typed mid-turn is queued, not steered", app.pendingCount === before + 1, String(app.pendingCount));
  check(
    "and the model never saw it",
    !app.session.messages.some((m) => m.role === "user" && String(m.content).startsWith("/model")),
    JSON.stringify(app.session.messages.filter((m) => m.role === "user").map((m) => String(m.content).slice(0, 40))),
  );
}

mock.kill();
await sleep(200);
try {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
} catch {
  /* Windows may hold the directory briefly; the temp dir is disposable */
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
