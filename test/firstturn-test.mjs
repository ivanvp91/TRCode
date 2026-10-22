/**
 * The first answer of a session ends one blank row above the input, like every
 * later one.
 *
 * The first turn runs after the splash is dismissed, which unpins the prompt;
 * when it ended, the composer re-measured the screen as if the session had just
 * started, forgot the rows the turn bar had held, and dropped to the bottom by
 * the difference — two blank rows between the stats and the input, once per
 * session. This drives the real App against the mock host on a screen model
 * that answers the cursor probe the way a terminal does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.TRCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-firstturn-"));
delete process.env.NO_COLOR;
process.env.TERM = "xterm-256color";

const ESC = String.fromCharCode(27);
const COLS = 100;
const ROWS = 30;

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
stdin.setEncoding = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });

class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
    // The background each cell was painted with, so a band can be told from a
    // blank row — both are spaces.
    this.bgGrid = Array.from({ length: rows }, () => Array(cols).fill(""));
    this.bg = "";
    this.row = 0;
    this.col = 0;
  }
  blank() { return Array(this.cols).fill(" "); }
  blankBg() { return Array(this.cols).fill(""); }
  scroll() {
    this.grid.shift();
    this.grid.push(this.blank());
    this.bgGrid.shift();
    this.bgGrid.push(this.blankBg());
  }
  resized(rows) {
    while (this.grid.length < rows) { this.grid.push(this.blank()); this.bgGrid.push(this.blankBg()); }
    while (this.grid.length > rows) { this.grid.pop(); this.bgGrid.pop(); }
    this.rows = rows;
    this.row = Math.min(this.row, rows - 1);
  }
  /** True when the row carries a background colour — a band. */
  banded(y) { return this.bgGrid[y].some((b) => b); }
  write(text) {
    let i = 0;
    while (i < text.length) {
      if (text[i] === ESC && text[i + 1] === "[") {
        const priv = new RegExp("^" + ESC + "\\[\\?[0-9;]*[A-Za-z]").exec(text.slice(i));
        if (priv) { i += priv[0].length; continue; }
        const m = new RegExp("^" + ESC + "\\[([0-9;]*)([A-Za-z])").exec(text.slice(i));
        if (m) {
          const nums = m[1] === "" ? [] : m[1].split(";").map((n) => parseInt(n, 10));
          const n = nums[0] ?? 1;
          const cmd = m[2];
          if (cmd === "A") this.row = Math.max(0, this.row - n);
          else if (cmd === "B") this.row = Math.min(this.rows - 1, this.row + n);
          else if (cmd === "G") this.col = Math.max(0, n - 1);
          else if (cmd === "T") {
            for (let j = 0; j < Math.min(n, this.rows); j++) {
              this.grid.pop(); this.grid.unshift(this.blank());
              this.bgGrid.pop(); this.bgGrid.unshift(this.blankBg());
            }
          }
          else if (cmd === "H") {
            this.row = Math.min(this.rows - 1, Math.max(0, n - 1));
            this.col = Math.max(0, (nums[1] ?? 1) - 1);
          } else if (cmd === "J") {
            for (let x = this.col; x < this.cols; x++) { this.grid[this.row][x] = " "; this.bgGrid[this.row][x] = ""; }
            for (let y = this.row + 1; y < this.rows; y++) { this.grid[y] = this.blank(); this.bgGrid[y] = this.blankBg(); }
          } else if (cmd === "K") {
            for (let x = this.col; x < this.cols; x++) { this.grid[this.row][x] = " "; this.bgGrid[this.row][x] = ""; }
          } else if (cmd === "m") {
            if (m[1] === "49" || m[1] === "0") this.bg = "";
            else if (m[1].startsWith("48;")) this.bg = m[1];
          }
          i += m[0].length;
          continue;
        }
      }
      const ch = text[i];
      if (ch === "\n") {
        this.row++;
        if (this.row >= this.rows) {
          this.scroll();
          this.row = this.rows - 1;
        }
        this.col = 0;
      } else if (ch === "\r") {
        this.col = 0;
      } else {
        if (this.col < this.cols) {
          this.grid[this.row][this.col] = ch;
          this.bgGrid[this.row][this.col] = this.bg;
        }
        this.col++;
      }
      i++;
    }
  }
  lines() { return this.grid.map((r) => r.join("").replace(/\s+$/, "")); }
  nonEmpty() { return this.lines().filter((l) => l.trim()); }
}

const screen = new Screen(COLS, ROWS);
const realWrite = process.stdout.write.bind(process.stdout);
const say = (s = "") => realWrite(s + "\n");
process.stdout.write = (chunk) => {
  const s = String(chunk);
  screen.write(s);
  // A terminal answers the cursor probe with the row it stands on.
  if (s.includes(ESC + "[6n")) {
    setTimeout(() => stdin.emit("data", Buffer.from(`${ESC}[${screen.row + 1};${screen.col + 1}R`)), 5);
  }
  return true;
};

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; say("  ok   " + name); }
  else { failed++; say("  FAIL " + name + (detail ? "\n" + detail : "")); }
}

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
const port = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : await freePort();
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port) },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
const { saveConfig } = await import("../dist/config.js");
saveConfig({ tips: false, updateCheck: false });
await new Promise((r) => setTimeout(r, 1200));

const { App } = await import("../dist/ui/repl.js");
const app = new App({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "trc-firstturn-cwd-")), model: "mock-smart", autoApprove: true });
await app.init();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rows between the turn's stats line and the composer's band. */
function gapAboveInput() {
  const ls = screen.lines();
  const stats = ls.findLastIndex((l) => /\d+ steps? ·/.test(l));
  const prompt = ls.findLastIndex((l) => /^\s*›/.test(l));
  // The band has a row of its own colour above the text.
  let band = prompt;
  while (band > 0 && screen.banded(band - 1)) band--;
  return { gap: stats === -1 || prompt === -1 ? -1 : band - stats - 1, screen: ls.join("\n") };
}

void app.run();
await sleep(1500);
for (const [i, q] of ["first question", "second question", "reasoning followed by an answer"].entries()) {
  if (i === 2) {
    // Drive the real App callbacks, including an unfinished reasoning line
    // and leading blank answer chunks, while the actual turn bar is installed.
    app.runWithFailover = async ({ events }) => {
      const read = { name: "read" };
      events.onReasoning("preparing to read the file");
      events.onToolStart(read, { path: "test/turnbar-mode-test.mjs" });
      events.onToolEnd(read, true, "40 of 78 lines");
      events.onToolStart(read, { path: "test/turnbar-mode-test.mjs", offset: 40 });
      events.onToolEnd(read, true, "38 of 78 lines");
      events.onReasoning("reasoning one\nreasoning two\nunfinished final thought");
      events.onText("\n\n  \n");
      events.onText("\nFinal answer without a large gap.\n");
      events.onAssistantMessage();
      return { stoppedBecause: "stop", steps: 1, finalText: "Final answer without a large gap." };
    };
  }
  for (const ch of q) stdin.emit("data", Buffer.from(ch));
  stdin.emit("data", Buffer.from("\r"));
  // The mock answers in well under a second; the rest is the frame settling.
  for (let t = 0; t < 50 && !/context:/.test(screen.lines().at(-1)) ; t++) await sleep(100);
  await sleep(600);
  const { gap, screen: shown } = gapAboveInput();
  check(`${i === 0 ? "the first" : "a later"} answer ends one blank row above the input`, gap === 1, `gap ${gap}\n${shown}`);
  if (i === 2) {
    const lines = screen.lines();
    const thinking = lines.findLastIndex((l) => /hidden.*\/reasoning/.test(l));
    const divider = lines.findLastIndex((l) => /─+ Response ─+/.test(l));
    const answer = lines.findLastIndex((l) => l.includes("Final answer without a large gap."));
    check("the reasoning summary closes before the response divider", thinking >= 0 && divider === thinking + 2, shown);
    check("one blank row separates the divider from the answer", answer === divider + 2 && lines[divider + 1]?.trim() === "", shown);
  }
}

mock.kill();
say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
