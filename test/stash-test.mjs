/**
 * A big paste is a token, not two hundred lines.
 *
 * What arrives in the input frame is a handle — `[Pasted text #1 · 40 lines]`,
 * `[Image #1]` — and what reaches the model is the paste itself. The echo and
 * the replayed history cut anything long down to five lines with a way to ask
 * for the rest, so a session that starts with a pasted log does not open with
 * the log.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const PASTE_START = ESC + "[200~";
const PASTE_END = ESC + "[201~";

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-stash-"));
process.env.TRCODE_HOME = HOME;

const { InputEditor } = await import("../dist/ui/editor.js");
const paste = await import("../dist/ui/paste.js");
const render = await import("../dist/ui/render.js");

let passed = 0;
let failed = 0;
const realWrite = process.stdout.write.bind(process.stdout);
const check = (name, cond, detail = "") => {
  if (cond) { passed++; realWrite("  ok   " + name + "\n"); }
  else { failed++; realWrite("  FAIL " + name + (detail ? "\n       " + detail : "") + "\n"); }
};

const quietly = async (fn) => {
  let out = "";
  process.stdout.write = (chunk) => { out += String(chunk); return true; };
  try { await fn(); } finally { process.stdout.write = realWrite; }
  return out;
};

const BIG = Array.from({ length: 40 }, (_, i) => `строка ${i + 1} длинного вставленного лога`).join("\n");
const SMALL = "две строки\nвсего";

// ── the stash itself ────────────────────────────────────────────────────────
{
  paste.resetStash();
  check("a short paste is left alone", paste.stashPaste(SMALL) === SMALL);

  const token = paste.stashPaste(BIG);
  check("a long one becomes a token", /^\[Pasted text #1 · 40 lines\]$/.test(token), token);
  check("the token is recognised", paste.hasPasteToken("вот лог: " + token));
  check("and expands back to every line", paste.expandPastes("вот лог: " + token) === "вот лог: " + BIG);
  check("expanding leaves ordinary text alone", paste.expandPastes("просто текст") === "просто текст");
  check("an id nobody stashed stays as it is", paste.expandPastes("[Pasted text #99 · 3 lines]") === "[Pasted text #99 · 3 lines]");

  const shot = paste.stashPaste("C:\\Users\\И\\AppData\\Local\\Temp\\orca-paste-1787097735566.png");
  check("a pasted screenshot shows as an image", shot === "[Image #2]", shot);
  check("and travels as its path", paste.expandPastes(`посмотри ${shot}`).endsWith("orca-paste-1787097735566.png"));
  check("a second paste gets its own number", paste.stashPaste(BIG) === "[Pasted text #3 · 40 lines]");
}

// ── through the editor ──────────────────────────────────────────────────────
{
  paste.resetStash();
  let painted = "";
  process.stdout.write = (chunk) => { painted += String(chunk); return true; };
  const ed = new InputEditor({ status: () => ({ left: "L", hint: "H", context: "C" }), history: [] });
  const p = ed.read();
  for (const ch of ["посмотри: ", PASTE_START + BIG + PASTE_END, CR]) stdin.emit("data", Buffer.from(ch, "utf8"));
  const got = await p;
  process.stdout.write = realWrite;

  check("the frame keeps the token", got === "посмотри: [Pasted text #1 · 40 lines]", JSON.stringify(got));
  check("the frame never showed the paste", !painted.includes("строка 39"), "the whole log was drawn");
  check("the model gets the whole thing", paste.expandPastes(got) === "посмотри: " + BIG);
}

// ── what the screen shows ───────────────────────────────────────────────────
{
  paste.resetStash();
  let painted = "";
  process.stdout.write = (chunk) => { painted += String(chunk); return true; };
  render.userEcho(BIG);
  process.stdout.write = realWrite;

  const lines = painted.split("\n").filter((l) => l.trim());
  check("the echo is five lines and a handle", lines.length === 6, String(lines.length));
  check("it says how much is left", /… ещё строк: 35|… 35 more lines/.test(painted), lines[lines.length - 1]);
  check("and which key opens it", /ctrl\+o/.test(painted), lines[lines.length - 1]);
  check("the full text is kept for that", paste.collapsedText(1) === BIG);
  check("the last one is the default", paste.collapsedText() === BIG);

  painted = "";
  process.stdout.write = (chunk) => { painted += String(chunk); return true; };
  render.userEcho("короткий вопрос");
  process.stdout.write = realWrite;
  check("a short message is not touched", !/\/expand/.test(painted) && painted.includes("короткий вопрос"));
  check("and does not take a handle", paste.collapsedCount() === 1, String(paste.collapsedCount()));
}

// ── ctrl+o opens what was shortened ─────────────────────────────────────────
{
  paste.resetStash();
  await quietly(() => render.userEcho(BIG));
  await quietly(() => render.userEcho("другое длинное сообщение\n".repeat(20)));

  const CTRL_O = String.fromCharCode(15);
  const ed = new InputEditor({ status: () => ({ left: "L", hint: "H", context: "C" }), history: [] });
  let painted = "";
  process.stdout.write = (chunk) => { painted += String(chunk); return true; };
  const p = ed.read();
  stdin.emit("data", Buffer.from(CTRL_O, "utf8"));
  const afterFirst = painted;
  stdin.emit("data", Buffer.from(CTRL_O, "utf8"));
  const afterSecond = painted;
  stdin.emit("data", Buffer.from(CR, "utf8"));
  const got = await p;
  process.stdout.write = realWrite;

  check("ctrl+o prints the newest block", afterFirst.includes("другое длинное сообщение"), afterFirst.slice(-120));
  check("the second press walks one further back", afterSecond.includes("строка 40"), "the older block never appeared");
  check("and the input line is untouched by it", got === "", JSON.stringify(got));
}

// ── a tool call reads as one block ──────────────────────────────────────────
{
  paste.resetStash();
  const CMD = 'cd "C:/Users/Иван/OneDrive/AI Agents/Different/tokenrouter-cli" && npm test 2>&1 | grep -E "^(PASS|FAIL)" | tail -20';
  const OUT = Array.from({ length: 9 }, (_, i) => `PASS  suite-${i + 1}.mjs        ${i} passed, 0 failed`).join("\n");

  const head = await quietly(() => render.toolStart("shell", CMD));
  const headRows = head.split("\n").filter((l) => l.trim());
  check("the header carries the whole command", head.includes("tail -20"), head.trim());
  check("a command too long for one line wraps", headRows.length === 2, String(headRows.length));
  check("and hangs under the first line", headRows[1].startsWith("     "), JSON.stringify(headRows[1].slice(0, 8)));

  const body = await quietly(() => render.toolDone(true, OUT));
  const rows = body.split("\n").filter((l) => l.trim());
  check("five lines of output and a handle", rows.length === 6, String(rows.length));
  check("the corner marks the block, not every line", rows.filter((l) => l.includes("└")).length === 1, JSON.stringify(rows.map((l) => l.includes("└"))));
  check("the rest is counted", /\+4 lines|ещё 4 строки/.test(rows[5]), rows[5]);
  check("and reachable with the same key", /ctrl\+o/.test(rows[5]), rows[5]);
  check("the whole output is kept for it", paste.collapsedText() === OUT);

  paste.resetStash();
  const short = await quietly(() => render.toolDone(true, "готово"));
  check("short output takes no handle", !/ctrl\+o/.test(short) && paste.collapsedCount() === 0);
}

fs.rmSync(HOME, { recursive: true, force: true });
realWrite(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
