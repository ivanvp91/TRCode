/** Checks the slash dropdown and that every frame row is exactly as wide. */
import { EventEmitter } from "node:events";
const ESC = String.fromCharCode(27);
const stdin = new EventEmitter();
stdin.isTTY = true; stdin.isRaw = false;
stdin.setRawMode = v => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin; stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

class Screen {
  constructor(cols) { this.cols = cols; this.grid = []; this.row = 0; this.col = 0; this.maxRow = 0; }
  row_(r) { while (this.grid.length <= r) this.grid.push(Array(this.cols).fill(" ")); return this.grid[r]; }
  write(text) {
    let i = 0;
    while (i < text.length) {
      if (text[i] === ESC && text[i + 1] === "[") {
        const priv = new RegExp("^" + ESC + "\[\?[0-9;]*[A-Za-z]").exec(text.slice(i));
        if (priv) { i += priv[0].length; continue; }
        const m = new RegExp("^" + ESC + "\[([0-9;]*)([A-Za-z])").exec(text.slice(i));
        if (m) {
          const n = m[1] === "" ? 1 : parseInt(m[1].split(";")[0], 10);
          const cmd = m[2];
          if (cmd === "A") this.row = Math.max(0, this.row - n);
          else if (cmd === "B") this.row += n;
          else if (cmd === "G") this.col = Math.max(0, n - 1);
          else if (cmd === "J") { const r = this.row_(this.row); for (let x = this.col; x < this.cols; x++) r[x] = " ";
            for (let y = this.row + 1; y <= this.maxRow; y++) this.row_(y).fill(" "); }
          else if (cmd === "K") this.row_(this.row).fill(" ");
          i += m[0].length; continue;
        }
      }
      const ch = text[i];
      if (ch === "\n") { this.row++; this.col = 0; }
      else if (ch === "\r") this.col = 0;
      else { this.row_(this.row)[this.col] = ch; this.col++; }
      this.maxRow = Math.max(this.maxRow, this.row);
      i++;
    }
  }
  lines() { return this.grid.slice(0, this.maxRow + 1).map(r => r.join("").replace(/\s+$/, "")); }
}

const screen = new Screen(100);
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = c => { screen.write(String(c)); return true; };

const { InputEditor } = await import("../dist/ui/editor.js");
const { commandSuggestions } = await import("../dist/ui/commands.js");
const strip = s => s.replace(new RegExp(ESC + "\[[0-9;]*[A-Za-z]", "g"), "");

const ed = new InputEditor({
  status: () => ({ left: "yolo  moonshotai/kimi-k3  thinking: high  ~/proj", hint: "/ - команды", context: "context: 3% (23k/1M)" }),
  history: [],
  suggest: commandSuggestions,
  suggestRows: 5,
});

const p = ed.read();
stdin.emit("data", Buffer.from("/"));
const snapSlash = screen.lines().map(strip);
stdin.emit("data", Buffer.from(ESC + "[B"));
stdin.emit("data", Buffer.from("\r"));
stdin.emit("data", Buffer.from(String.fromCharCode(13))); // второй Enter отправляет выбранное
const picked = await p;

// Закрытое меню делает рамку ниже. Перерисовка идёт поверх прежних строк, так
// что лишние обязана убрать за собой — иначе от списка остаются призраки.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const p2 = ed.read();
stdin.emit("data", Buffer.from("/"));
const withMenu = screen.lines().map(strip);
stdin.emit("data", Buffer.from(ESC)); // закрыть меню
await sleep(60); // Esc разрешается только после окна на распознавание
const afterEsc = screen.lines().map(strip);
stdin.emit("data", Buffer.from("\r"));
await p2;

process.stdout.write = realWrite;

// Экран здесь накапливает все кадры подряд — очистка в этом эмуляторе не
// двигает maxRow. Значит смотреть надо на последний кадр: от верхней границы
// последней рамки и ниже.
const lastFrame = ls => ls.slice(ls.map(l => /╭/.test(l)).lastIndexOf(true)).filter(l => l.trim());
const menuRow = l => /Enter to pick|Enter — выбрать/.test(l);
const menuGone = lastFrame(withMenu).some(menuRow) && !lastFrame(afterEsc).some(menuRow);
// Что осталось: три строки рамки и две статусные, ничего от списка.
const noGhosts = lastFrame(afterEsc).length === 5;

console.log("--- экран при вводе «/» ---");
for (const l of snapSlash) console.log(l);

const frame = snapSlash.filter(l => /^\s*[╭│╰]/.test(l));
console.log("\n--- ширины строк рамки ---");
const widths = frame.map(l => [...l].length);
frame.forEach((l, i) => console.log(String(widths[i]).padStart(4), l.slice(0, 12) + "…" + l.slice(-3)));
const same = new Set(widths).size === 1;
console.log("\nвсе строки рамки одинаковой ширины:", same ? "ДА" : "НЕТ -> " + [...new Set(widths)].join(", "));
// Ожидание берётся из самого списка: проверяется навигация, а не то, какая
// команда сегодня стоит второй — иначе тест ломает любое пополнение меню.
const expected = commandSuggestions("/")[1].value + " ";
console.log("Enter на втором пункте выбрал:", JSON.stringify(picked), picked === expected ? "OK" : `ПРОВАЛ, ждали ${JSON.stringify(expected)}`);
console.log("после Esc список меню убран:", menuGone ? "ДА" : "НЕТ");
console.log("после Esc рамка стала ниже, призраков нет:", noGhosts ? "ДА" : "НЕТ -> " + JSON.stringify(afterEsc.filter(l => l.trim())));
process.exit(same && picked === expected && menuGone && noGhosts ? 0 : 1);
