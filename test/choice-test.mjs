/**
 * The button row when it does not fit on one row.
 *
 * A row wide enough for the terminal to wrap it puts the cursor on the last
 * physical row only. Clearing "the line" then clears that row and leaves every
 * row above it — so each arrow key left one more copy of the buttons on
 * screen. The virtual screen below replays the cursor moves, so what is
 * counted is what a terminal would show, not what the byte stream reads.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

class Screen {
  constructor(cols) {
    this.cols = cols;
    this.grid = [];
    this.row = 0;
    this.col = 0;
    this.maxRow = 0;
  }
  at(r) {
    while (this.grid.length <= r) this.grid.push(Array(this.cols).fill(" "));
    return this.grid[r];
  }
  write(text) {
    let i = 0;
    while (i < text.length) {
      if (text[i] === ESC && text[i + 1] === "[") {
        const priv = new RegExp("^" + ESC + "\\[\\?[0-9;]*[A-Za-z]").exec(text.slice(i));
        if (priv) {
          i += priv[0].length;
          continue;
        }
        const m = new RegExp("^" + ESC + "\\[([0-9;]*)([A-Za-z])").exec(text.slice(i));
        if (m) {
          const n = m[1] === "" ? 1 : parseInt(m[1].split(";")[0], 10);
          const cmd = m[2];
          if (cmd === "A") this.row = Math.max(0, this.row - n);
          else if (cmd === "B") this.row += n;
          else if (cmd === "G") this.col = Math.max(0, n - 1);
          else if (cmd === "J") {
            const r = this.at(this.row);
            for (let x = this.col; x < this.cols; x++) r[x] = " ";
            for (let y = this.row + 1; y <= this.maxRow; y++) this.at(y).fill(" ");
          } else if (cmd === "K") this.at(this.row).fill(" ");
          i += m[0].length;
          continue;
        }
      }
      const ch = text[i];
      if (ch === "\n") {
        this.row++;
        this.col = 0;
      } else if (ch === "\r") this.col = 0;
      else {
        // A real terminal wraps at the right edge; without that here an
        // over-wide row costs nothing and the stacking it causes never shows.
        if (this.col >= this.cols) {
          this.row++;
          this.col = 0;
        }
        this.at(this.row)[this.col] = ch;
        this.col++;
      }
      this.maxRow = Math.max(this.maxRow, this.row);
      i++;
    }
  }
  lines() {
    return this.grid.slice(0, this.maxRow + 1).map((r) => r.join("").replace(/\s+$/, ""));
  }
}

const COLS = 64;
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
Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });

let screen = new Screen(COLS);
const realWrite = process.stdout.write.bind(process.stdout);
const say = (s) => realWrite(s + "\n");
process.stdout.write = (chunk) => {
  screen.write(String(chunk));
  return true;
};

const { choose } = await import("../dist/ui/choice.js");

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

const type = (s) => stdin.emit("data", Buffer.from(s, "utf8"));
const RIGHT = ESC + "[C";
const LEFT = ESC + "[D";
/** Rows with something on them — the widget's own footprint. */
const rows = () => screen.lines().filter((l) => l.trim());
const times = (needle) => rows().filter((l) => l.includes(needle)).length;

// ── a row too wide for the terminal ─────────────────────────────────────────
const many = [
  { value: "a", label: "openrouter.ai — dark dev-tool marketplace" },
  { value: "b", label: "kilo.com — gym SaaS marketing site" },
  { value: "c", label: "digitalocean.com — friendly cloud platform" },
  { value: "d", label: "Zomro.com — тёмный фиолетовый хостинг" },
  { value: "e", label: "Авто-подбор" },
  { value: "f", label: "С нуля" },
];

let answer = choose(many, { initial: "a", fallback: "a" });
const first = rows().length;
check("the buttons need more than one row here", first > 1, `rows: ${first}`);
check("every row fits the terminal", rows().every((l) => l.length <= COLS), rows().map((l) => l.length).join(","));
for (const label of many.map((ch) => ch.label)) {
  check(`"${label.slice(0, 22)}…" is drawn once`, times(label) === 1, rows().join(" | "));
}

// Six moves right and back: the row count must not grow by a single line.
for (let i = 0; i < 6; i++) type(RIGHT);
for (let i = 0; i < 3; i++) type(LEFT);
check("arrows repaint in place, they do not stack", rows().length === first, `${first} → ${rows().length}`);
check("no label is duplicated after moving", many.every((ch) => times(ch.label) === 1), rows().join(" | "));

// The selection actually moved: right six, left three, from index 0 → 3.
type(CR);
const picked = await answer;
check("the cursor moved with the arrows", picked === "d", picked);
check("only the answer is left on screen", times("▸") === 1 && rows().length === 1, rows().join(" | "));
check("the buttons are gone", !rows().some((l) => l.includes("openrouter.ai")), rows().join(" | "));

// ── the ordinary one-row case is untouched ──────────────────────────────────
screen = new Screen(COLS);
answer = choose(
  [
    { value: "yes", label: "Confirm", key: "y" },
    { value: "no", label: "Cancel", key: "n", tone: "danger" },
  ],
  { initial: "yes", fallback: "no" },
);
check("a short row stays one row", rows().length === 1, rows().join(" | "));
check("the hint rides along", rows()[0].includes("Enter"), rows()[0]);
type(RIGHT);
check("still one row after moving", rows().length === 1, rows().join(" | "));
type(CR);
check("the second button is what was picked", (await answer) === "no");
check("and it is reported once", times("▸ Cancel") === 1, rows().join(" | "));

process.stdout.write = realWrite;
say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
