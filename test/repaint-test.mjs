/**
 * Repainting must replace the frame, never stack another copy under it.
 * A virtual screen replays the ANSI cursor moves so the result is counted the
 * way a terminal would show it, not the way the byte stream reads.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const CTRL_L = String.fromCharCode(12);
const LF = String.fromCharCode(10);

class Screen {
  constructor(cols = 100) {
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
  countTopBorders() {
    return this.lines().filter((l) => l.includes("╭")).length;
  }
  countPrompts() {
    return this.lines().filter((l) => l.includes("❯")).length;
  }
}

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

const screen = new Screen(100);
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  screen.write(String(chunk));
  return true;
};

const { InputEditor } = await import("../dist/ui/editor.js");
const ed = new InputEditor({ status: () => ({ left: "L", hint: "H", context: "C" }), history: [] });
const send = (...chunks) => {
  for (const ch of chunks) stdin.emit("data", Buffer.from(ch, "utf8"));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

// Esc repeatedly: the frame must stay single.
const p = ed.read();
send("текст");
const afterType = screen.countTopBorders();
for (let i = 0; i < 5; i++) {
  send(ESC);
  await wait(60); // Esc resolves only after the disambiguation window
}
const afterEsc = screen.countTopBorders();
ok("Esc не размножает рамку", afterEsc === afterType, `${afterType} → ${afterEsc}`);
ok("одна строка ввода на экране", screen.countPrompts() === 1, `строк с ❯: ${screen.countPrompts()}`);

for (let i = 0; i < 5; i++) send(CTRL_L);
ok("Ctrl+L не размножает рамку", screen.countTopBorders() === afterType, `${screen.countTopBorders()}`);

// Multi-line input grows the frame but still leaves exactly one.
send(LF, "вторая", LF, "третья");
ok("многострочный ввод — одна рамка", screen.countTopBorders() === 1, `${screen.countTopBorders()}`);

send(CR);
await p;
ok("после отправки рамка убрана", screen.countTopBorders() === 0, `${screen.countTopBorders()}`);

// Мерцание — это кадр, пойманный терминалом на полпути: рамка стёрта, новая ещё
// не написана. Значит нажатие клавиши обязано быть одной записью, и стирать
// рамку перед перерисовкой нельзя.
{
  const writes = [];
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    screen.write(String(chunk));
    return true;
  };

  const typing = ed.read();
  send("ф"); // первая отрисовка рамки
  writes.length = 0;
  send("ы"); // перерисовка поверх неё
  const frame = writes.join("");
  ok("нажатие клавиши — одна запись", writes.length === 1, `записей: ${writes.length}`);
  ok("рамка не стирается перед перерисовкой", !frame.includes(ESC + "[0J"), JSON.stringify(frame));
  ok(
    "кадр обёрнут в synchronized output",
    frame.startsWith(ESC + "[?2026h") && frame.endsWith(ESC + "[?2026l"),
    JSON.stringify(frame),
  );

  send(CR);
  await typing;
}

process.stdout.write = realWrite;

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
