/**
 * Shell lines: a draft that starts with "!" runs in the shell instead of going
 * to the model, and the command plus its output are kept as a hidden user
 * message so the next turn already knows what the user found out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-shell-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-shell-work-"));
process.env.TRCODE_HOME = HOME;
delete process.env.NO_COLOR;

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

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; say("  ok   " + name); }
  else { failed++; say("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const { isShellLine, isCommand } = await import("../dist/ui/commands.js");
const { App } = await import("../dist/ui/repl.js");

// ── when a line counts as a shell command ──────────────────────────────────
{
  check("a bang and a command is a shell line", isShellLine("!ls -la"));
  check("a bang with spaces after it too", isShellLine("!   git status"));
  check("a lone bang is not", !isShellLine("!") && !isShellLine("!   "));
  check("plain text is not", !isShellLine("hello"));
  check("a slash command keeps its own path", isCommand("/stat") && !isShellLine("/stat"));
}

// ── the turn itself ────────────────────────────────────────────────────────
const app = new App({ cwd: WORK, model: "mock-smart", autoApprove: true });
await app.init();

const before = app.session.messages.length;
painted = "";
await app.runUserShell("echo hello-from-shell");
const screen = strip(painted);
check("the command is echoed as typed", /!\s*echo hello-from-shell/.test(screen), screen.slice(-500));
check("the output is printed", /hello-from-shell/.test(screen), screen.slice(-500));
check("the call is drawn like a tool call", /Ran|echo hello-from-shell/.test(screen), screen.slice(-500));

const added = app.session.messages.slice(before);
check("one message joins the history", added.length === 1, JSON.stringify(added.map((m) => m.role)));
const message = added[0];
check("it is a user message", message?.role === "user", message?.role);
check("it carries the command", /<user-shell-command>[\s\S]*echo hello-from-shell/.test(message?.content ?? ""));
check("and what the command printed", /<output>[\s\S]*hello-from-shell/.test(message?.content ?? ""));
check("it is hidden from the transcript on replay", message?.meta?.hidden === true, JSON.stringify(message?.meta));

// A failing command is kept too: the exit code is the point of running it.
painted = "";
await app.runUserShell("exit 3");
const failing = app.session.messages.at(-1);
check("a failing command still lands in the history", /<user-shell-command>/.test(failing?.content ?? ""), failing?.content);

// ── the composer hint ─────────────────────────────────────────────────────
{
  const { InputEditor } = await import("../dist/ui/editor.js");
  const { composeStatus } = await import("../dist/ui/inputbox.js");
  const status = () => composeStatus({ mode: "yolo", provider: "Mock", model: "mock-smart", contextUsed: 10, contextWindow: 1000, contextEstimated: false, cwdLabel: "tmp" });
  // A wide window is where the full line fits: the hint drops the shell prefix
  // before it drops Shift+Tab, so this is the width that proves it is there.
  Object.defineProperty(process.stdout, "columns", { value: 190, configurable: true });
  const idle = status();
  check("the idle hint advertises the shell prefix", /!/.test(idle.hint), idle.hint);
  Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

  const editor = new InputEditor({ status, history: [], complete: () => [], suggest: () => [] });
  const drawn = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk) => { drawn.push(String(chunk)); return true; };
  try {
    editor.read();
    for (const ch of "!ls") stdin.emit("data", Buffer.from(ch, "utf8"));
    await new Promise((r) => setTimeout(r, 60));
    stdin.emit("data", Buffer.from(ESC, "utf8"));
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    process.stdout.write = real;
  }
  const frame = strip(drawn.join(""));
  check("typing a bang changes the status hint", /оболочк|shell/i.test(frame) && /модели|model/i.test(frame), frame.slice(-400));
  check("the draft itself is still plain text", /!ls/.test(frame), frame.slice(-300));
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
