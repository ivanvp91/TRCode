/**
 * The model's question dialog sits above the input, not under it.
 *
 * The dialog used to replace the bottom bar, so it opened below the line the
 * user types into and pushed the input out of the way. It is now drawn as part
 * of the bar's frame — dialog rows first, bar rows last — so the question
 * floats over the conversation with the input line still under it.
 *
 * The virtual screen replays cursor moves, so this checks where things end up
 * on screen rather than what the byte stream reads.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const COLS = 80;
const ROWS = 40;

class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
    this.row = 0;
    this.col = 0;
  }
  scrollUp() {
    this.grid.shift();
    this.grid.push(Array(this.cols).fill(" "));
  }
  write(text) {
    let i = 0;
    while (i < text.length) {
      if (text[i] === ESC && text[i + 1] === "[") {
        const priv = new RegExp("^" + ESC + "\\[[?=][0-9;]*[A-Za-z]").exec(text.slice(i));
        if (priv) {
          i += priv[0].length;
          continue;
        }
        const m = new RegExp("^" + ESC + "\\[([0-9;]*)([A-Za-z])").exec(text.slice(i));
        if (m) {
          const args = m[1] === "" ? [] : m[1].split(";").map((n) => parseInt(n, 10));
          const cmd = m[2];
          if (cmd === "H" || cmd === "f") {
            this.row = Math.max(0, Math.min(this.rows - 1, (args[0] ?? 1) - 1));
            this.col = Math.max(0, Math.min(this.cols - 1, (args[1] ?? 1) - 1));
          } else if (cmd === "A") this.row = Math.max(0, this.row - (args[0] || 1));
          else if (cmd === "B") this.row = Math.min(this.rows - 1, this.row + (args[0] || 1));
          else if (cmd === "C") this.col = Math.min(this.cols - 1, this.col + (args[0] || 1));
          else if (cmd === "D") this.col = Math.max(0, this.col - (args[0] || 1));
          else if (cmd === "G") this.col = Math.max(0, (args[0] || 1) - 1);
          else if (cmd === "J") {
            if (args[0] === 2) this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(" "));
            else if (args[0] === 0) {
              this.grid[this.row].fill(" ", this.col);
              for (let r = this.row + 1; r < this.rows; r++) this.grid[r].fill(" ");
            }
          } else if (cmd === "K") this.grid[this.row].fill(" ", this.col);
          i += m[0].length;
          continue;
        }
      }
      const ch = text[i];
      if (ch === "\r") this.col = 0;
      else if (ch === "\n") {
        // A terminal with ONLCR returns to column 1 and scrolls at the bottom.
        this.col = 0;
        if (this.row === this.rows - 1) this.scrollUp();
        else this.row++;
      } else if (ch >= " ") {
        if (this.col < this.cols) this.grid[this.row][this.col] = ch;
        this.col++;
      }
      i++;
    }
  }
  lines() {
    return this.grid.map((r) => r.join("").replace(/\s+$/, ""));
  }
  text() {
    return this.lines().join("\n");
  }
}

const stdin = new EventEmitter();
Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin });
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
for (const [key, value] of Object.entries({ isTTY: true, columns: COLS, rows: ROWS })) {
  Object.defineProperty(process.stdout, key, { value, configurable: true });
}

const screen = new Screen(COLS, ROWS);
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  screen.write(String(chunk));
  return true;
};

const { setFooter, line, setStartRow } = await import("../dist/ui/render.js");
const { questionModal } = await import("../dist/ui/questions.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    realWrite("  ok   " + name + "\n");
  } else {
    failed++;
    realWrite("  FAIL " + name + (detail ? "\n       " + JSON.stringify(detail) : "") + "\n");
  }
};
const key = (s) => stdin.emit("data", Buffer.from(s, "utf8"));
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the turn bar: the band the user types into. */
const barRows = () => ["", "\u001b[96m\u203a \u001b[97m", "  running \u00b7 3s"];
const indexOfRow = (needle) => screen.lines().findIndex((l) => l.includes(needle));

// The conversation the dialog will float over.
for (let i = 1; i <= 18; i++) line(`transcript row ${String(i).padStart(2, "0")}`);
setStartRow(2);
setFooter(barRows);
await wait();
check("the bar is on screen before the dialog", indexOfRow("\u203a") !== -1, screen.lines());

// ── the dialog opens above the input ────────────────────────────────────────
const controller = new AbortController();
const answer = questionModal(
  [{ question: "Where should settings live?", header: "Settings", options: [{ label: "Shared with the project" }, { label: "User only" }] }],
  { signal: controller.signal },
);
await wait();

const top = indexOfRow("\u256d\u2500");
const bottom = indexOfRow("\u2570\u2500");
const band = indexOfRow("\u203a");
check("the dialog is drawn", top !== -1, screen.lines());
check("the input line is still there", band !== -1, screen.lines());
check("the dialog sits above the input", top !== -1 && band !== -1 && bottom < band, { top, bottom, band, screen: screen.lines() });
check("the dialog is not squeezed out of the screen", top > 0, { top });
check("the status stays under the input line", indexOfRow("running") > band, { band, status: indexOfRow("running") });
check("the dialog asks the question", screen.text().includes("Where should settings live?"));

// ── transcript output while it is open ──────────────────────────────────────
line("background worker finished");
await wait();
const top2 = indexOfRow("\u256d\u2500");
const bottom2 = indexOfRow("\u2570\u2500");
const band2 = indexOfRow("\u203a");
check("background output does not push the input away", band2 !== -1, screen.lines());
check("nor does it lose the dialog", top2 !== -1 && bottom2 < band2, { top2, bottom2, band2, screen: screen.lines() });

// ── closing gives the rows back ─────────────────────────────────────────────
key(ESC);
await answer;
await wait();
check("the dialog is gone", indexOfRow("\u256d\u2500") === -1, screen.lines());
check("the input line stayed put", indexOfRow("\u203a") !== -1, screen.lines());
check("the bar keeps its bottom row", screen.lines().filter((l) => l.trim()).slice(-1)[0].includes("running"), screen.lines());
check("the transcript is still readable", indexOfRow("background worker finished") !== -1, screen.lines());

// ── a tall dialog leaves the screen as it found it ──────────────────────────
// The rows a question used were reserved as padding once it closed: a band of
// air as tall as the dialog stood between the conversation and the bar, eaten
// one row per printed line. Drawn over the transcript, the dialog costs nothing.
const blankRowsAboveBar = () => {
  const rows = screen.lines();
  const band = rows.findIndex((l) => l.includes("\u203a"));
  if (band === -1) return -1;
  let n = 0;
  for (let r = band - 1; r >= 0 && rows[r].trim() === ""; r--) n++;
  return Math.max(0, n - 1); // the bar's own frame opens with a blank row
};
for (let i = 1; i <= 40; i++) line(`conversation row ${String(i).padStart(2, "0")}`);
await wait();
const before = screen.text();
const beforeAir = blankRowsAboveBar();
check("the conversation reaches the bar", beforeAir === 0, { beforeAir, screen: screen.lines() });

const tall = new AbortController();
const tallAnswer = questionModal(
  [
    { question: "Where should settings live?", header: "Settings", options: [{ label: "Shared with the project" }, { label: "User only" }, { label: "Ask every time" }] },
    { question: "Which formats?", header: "Formats", options: [{ label: "JSON" }, { label: "YAML" }, { label: "TOML" }, { label: "INI" }] },
  ],
  { signal: tall.signal },
);
await wait(60);
check("the tall dialog is drawn", indexOfRow("\u256d\u2500") !== -1, screen.lines());

key(ESC);
await tallAnswer;
await wait(60);
check("closing a tall dialog leaves no blank band above the bar", blankRowsAboveBar() === 0, {
  air: blankRowsAboveBar(),
  screen: screen.lines(),
});
check("the screen it covered comes back exactly", screen.text() === before, {
  before: before.split("\n").slice(-12),
  after: screen.text().split("\n").slice(-12),
});

process.stdout.write = realWrite;
setFooter(null);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
