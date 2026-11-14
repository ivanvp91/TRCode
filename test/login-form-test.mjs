/**
 * The login form: a key and its name asked inside the modal frame, not with a
 * raw one-line prompt.
 *
 * What matters is what a terminal would show: the panel has a border and a
 * title, the typed key never appears on screen, Tab reaches the name field,
 * and Enter answers with both values. Esc leaves nothing behind.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const RIGHT = ESC + "[C";

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

const COLS = 72;
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

const { askForm } = await import("../dist/ui/form.js");

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
const rows = () => screen.lines().filter((l) => l.trim());
const allText = () => rows().join("\n");

// ── the frame ─────────────────────────────────────────────────────────────
let answer = askForm({
  title: "OpenCode Go — API key",
  subtitle: "Paste the key; Tab moves to its name, Enter connects.",
  fields: [
    { label: "API key", secret: true, placeholder: "sk-…" },
    { label: "Name", value: "Key 2" },
  ],
  submit: "Connect",
});

check("a bordered panel is drawn", rows().some((l) => l.includes("╭─")) && rows().some((l) => l.includes("╰")), allText());
check("the title sits in the border", rows().some((l) => l.includes("OpenCode Go — API key")), allText());
check("both fields are labelled", allText().includes("API key") && allText().includes("Name"), allText());
check("the suggested name is prefilled", allText().includes("Key 2"), allText());
check("the buttons are there", allText().includes("Connect") && allText().includes("Cancel"), allText());
check("the keys are explained", allText().includes("Esc"), allText());
check("every row fits the terminal", rows().every((l) => l.length <= COLS), rows().map((l) => l.length).join(","));

const framed = rows().length;

// ── the secret is never echoed ────────────────────────────────────────────
type("sk-very-secret-key-1234");
check("the key does not appear on screen", !allText().includes("sk-very-secret"), allText());
check("it is drawn as asterisks", /[*]{5,}/.test(allText()), allText());
check("typing does not grow the panel", rows().length === framed, `${framed} → ${rows().length}`);

// Tab reaches the name field, which is editable.
type(TAB);
type("-work");
check("the name field took the text", allText().includes("Key 2-work"), allText());
check("the panel still has its shape", rows().length === framed, `${framed} → ${rows().length}`);

type(CR);
const values = await answer;
check("Enter answers with both fields", values?.[0] === "sk-very-secret-key-1234" && values?.[1] === "Key 2-work", JSON.stringify(values));
check("the panel is gone afterwards", rows().length === 0, allText());

// ── the buttons are reachable ─────────────────────────────────────────────
{
  screen = new Screen(COLS);
  answer = askForm({
    title: "Key",
    fields: [
      { label: "API key", secret: true, placeholder: "sk-…" },
      { label: "Name", value: "Key 4" },
    ],
    submit: "Connect",
  });
  type("sk-button-test-1234");
  // Tab twice: key → name → buttons.
  type(TAB);
  type(TAB);
  const onButtons = allText();
  check("Tab reaches the buttons", onButtons.includes("←→ button"), onButtons);
  check("the buttons are still drawn", onButtons.includes("Connect") && onButtons.includes("Cancel"), onButtons);
  // Right moves to Cancel, Enter runs it.
  type(RIGHT);
  type(CR);
  const cancelledByButton = await answer;
  check("→ and Enter run the second button", cancelledByButton === null, JSON.stringify(cancelledByButton));
  check("and the panel is gone", rows().length === 0, allText());
}

// Enter on the focused Connect button submits.
{
  screen = new Screen(COLS);
  answer = askForm({ title: "Key", fields: [{ label: "API key", secret: true }, { label: "Name", value: "Key 5" }] });
  type("sk-submit-by-button\r");
  const viaButton = await answer;
  check("Enter on a field still submits", viaButton?.[0] === "sk-submit-by-button", JSON.stringify(viaButton));

  screen = new Screen(COLS);
  answer = askForm({ title: "Key", fields: [{ label: "API key", secret: true }, { label: "Name", value: "Key 6" }] });
  type("sk-enter-button");
  type(TAB);
  type(TAB);
  type(CR);
  const entered = await answer;
  check("Enter on Connect submits the form", entered?.[0] === "sk-enter-button" && entered?.[1] === "Key 6", JSON.stringify(entered));
}

// ── a paste submits by itself ─────────────────────────────────────────────
screen = new Screen(COLS);
answer = askForm({
  title: "Key",
  fields: [
    { label: "API key", secret: true },
    { label: "Name", value: "Key 3" },
  ],
});
type("sk-pasted-key-9999\r");
const pasted = await answer;
check("a pasted key with its newline submits", pasted?.[0] === "sk-pasted-key-9999" && pasted?.[1] === "Key 3", JSON.stringify(pasted));
check("and the next form starts on a clean screen", rows().length === 0, allText());

// ── Esc cancels, and nothing is left behind ───────────────────────────────
screen = new Screen(COLS);
answer = askForm({ title: "Key", fields: [{ label: "API key", secret: true }] });
type("typing");
type(ESC);
const cancelled = await answer;
check("Esc answers null", cancelled === null, JSON.stringify(cancelled));
check("and clears the panel", rows().length === 0, allText());

process.stdout.write = realWrite;
say(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
