/**
 * Drives InputEditor against a fake TTY so the frame, wrapping, cursor
 * placement and key handling can be checked without a real terminal.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const KEYS = {
  left: ESC + "[D",
  right: ESC + "[C",
  up: ESC + "[A",
  down: ESC + "[B",
  home: ESC + "[H",
  end: ESC + "[F",
  bs: String.fromCharCode(127),
  tab: String.fromCharCode(9),
  ctrlU: String.fromCharCode(21),
  ctrlW: String.fromCharCode(23),
  ctrlC: String.fromCharCode(3),
  enter: "\r",
};

function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = (v) => {
    s.isRaw = v;
    return s;
  };
  s.resume = () => s;
  s.pause = () => s;
  s.setEncoding = () => s;
  return s;
}

/** Replays ANSI cursor moves onto a virtual screen to see the final picture. */
class Screen {
  constructor(cols = 100, rows = 40) {
    this.cols = cols;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
    this.row = 0;
    this.col = 0;
    this.maxRow = 0;
  }
  write(text) {
    let i = 0;
    while (i < text.length) {
      if (text[i] === ESC && text[i + 1] === "[") {
        // Private sequences (cursor show/hide) must be consumed, not printed.
        const priv = new RegExp("^" + ESC + "\[\?[0-9;]*[A-Za-z]").exec(text.slice(i));
        if (priv) {
          i += priv[0].length;
          continue;
        }
        const m = new RegExp("^" + ESC + "\[([0-9;]*)([A-Za-z])").exec(text.slice(i));
        if (m) {
          const n = m[1] === "" ? 1 : parseInt(m[1].split(";")[0], 10);
          const cmd = m[2];
          if (cmd === "A") this.row = Math.max(0, this.row - n);
          else if (cmd === "B") this.row += n;
          else if (cmd === "G") this.col = Math.max(0, n - 1);
          else if (cmd === "J" && (m[1] === "0" || m[1] === "")) {
            for (let c = this.col; c < this.cols; c++) this.grid[this.row][c] = " ";
            for (let r = this.row + 1; r <= this.maxRow; r++) this.grid[r].fill(" ");
          } else if (cmd === "K") {
            for (let c = 0; c < this.cols; c++) this.grid[this.row][c] = " ";
          }
          i += m[0].length;
          continue;
        }
      }
      const ch = text[i];
      if (ch === "\n") {
        this.row++;
        this.col = 0;
      } else if (ch === "\r") {
        this.col = 0;
      } else {
        if (!this.grid[this.row]) this.grid[this.row] = Array(this.cols).fill(" ");
        this.grid[this.row][this.col] = ch;
        this.col++;
      }
      this.maxRow = Math.max(this.maxRow, this.row);
      i++;
    }
  }
  render() {
    return this.grid
      .slice(0, this.maxRow + 1)
      .map((r) => r.join("").replace(/\s+$/, ""))
      .join("\n");
  }
}

const screen = new Screen(100, 40);
const stdin = fakeStdin();

Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  screen.write(String(chunk));
  return true;
};

const { InputEditor } = await import("../dist/ui/editor.js");

const status = () => ({
  left: "yolo  moonshotai/kimi-k3  thinking: high  C:/proj",
  hint: "/ — команды · Esc — прервать ход",
  context: "context: 3% (23k/1M)",
});

const history = [];
const editor = new InputEditor({
  status,
  history,
  complete: (p) => ["/model", "/models"].filter((n) => n.startsWith(p)),
});

function send(...keys) {
  for (const k of keys) stdin.emit("data", Buffer.from(k, "utf8"));
}

const cases = [];

async function run(name, keys, expect) {
  const p = editor.read();
  send(...keys);
  const got = await p;
  // Recording submitted lines is the REPL job; mimic it so ↑ has something.
  if (got && got.trim() && history[history.length - 1] !== got) history.push(got);
  const ok = got === expect;
  cases.push({ name, ok, got, expect });
}

await run("простой ввод", ["п", "р", "и", "в", "е", "т", KEYS.enter], "привет");
await run("backspace", ["a", "b", "c", KEYS.bs, KEYS.enter], "ab");
await run("стрелки + вставка в середину", ["a", "c", KEYS.left, "b", KEYS.enter], "abc");
await run("home/end", ["b", "c", KEYS.home, "a", KEYS.end, "d", KEYS.enter], "abcd");
await run("ctrl+u", ["x", "y", "z", KEYS.ctrlU, "q", KEYS.enter], "q");
await run("ctrl+w", ["one two", KEYS.ctrlW, "three", KEYS.enter], "one three");
await run("история ↑", [KEYS.up, KEYS.enter], "one three");
await run("tab-дополнение", ["/mod", KEYS.tab, KEYS.enter], "/model");
await run("вставка многострочного", ["строка1\nстрока2\n", KEYS.enter], "строка1\nстрока2");
await run("продолжение через \\", ["ab\\", KEYS.enter, "cd", KEYS.enter], "ab\ncd");
await run("ctrl+c очищает буфер", ["мусор", KEYS.ctrlC, "чисто", KEYS.enter], "чисто");


// Final visual: a long line that has to wrap inside the frame.
const p = editor.read();
send("Очень длинная строка ввода, которая обязана перенестись внутри рамки и не сломать её границы");
const visual = screen.render();
send(KEYS.enter);
await p;

process.stdout.write = realWrite;

let failed = 0;
for (const t of cases) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK " : "ПРОВАЛ"}  ${t.name}${t.ok ? "" : `\n        ждали ${JSON.stringify(t.expect)}, получили ${JSON.stringify(t.got)}`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} пройдено\n`);
console.log("--- как выглядит рамка с переносом ---");
console.log(visual);
process.exit(failed ? 1 : 0);
