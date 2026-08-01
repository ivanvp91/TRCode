/**
 * Reproduces the ways the prompt could appear frozen after switching windows:
 * focus-report sequences, escape sequences split across chunks, and a
 * bracketed paste whose closing marker never arrives.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const CTRL_L = String.fromCharCode(12);
const FOCUS_IN = ESC + "[I";
const FOCUS_OUT = ESC + "[O";
const PASTE_START = ESC + "[200~";

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
Object.defineProperty(process.stdout, "columns", { value: 90, configurable: true });

let painted = 0;
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  if (String(chunk).includes("╭")) painted++;
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

// 1. Focus report around typing: text must survive, nothing stray inserted.
let p = ed.read();
send("при", FOCUS_OUT, FOCUS_IN, "вет", CR);
ok("фокус-события не ломают ввод", (await p) === "привет");

// 2. Escape sequence split between two chunks — must act as one key.
p = ed.read();
send("ab", ESC, "[D", "X", CR); // ESC + "[D" = стрелка влево
ok("разорванная последовательность = стрелка", (await p) === "aXb", "ждали aXb");

// 3. Same split, but the tail never arrives: the fragment must be dropped,
//    not typed as "[".
p = ed.read();
send("ok", ESC);
await wait(120);
send("!", CR);
ok("оборванный ESC не вставляет мусор", (await p) === "ok!", "ждали ok!");

// 4. Unterminated bracketed paste must not swallow everything after it.
p = ed.read();
send(PASTE_START + "хвост");
send("сразу"); // ещё внутри окна ожидания — попадает во вставку
const beforeTimeout = painted;
await wait(3200);
send("после", CR);
const got = await p;
ok("незакрытая вставка не вешает ввод", got.includes("после"), JSON.stringify(got));
ok("текст вставки не потерян", got.includes("хвост"), JSON.stringify(got));

// 5. Ctrl+L and Esc repaint the frame and typing continues.
p = ed.read();
send("до");
const beforeRepaint = painted;
send(CTRL_L);
const afterCtrlL = painted;
send(ESC);
// Esc repaints only after the disambiguation window closes — a tail arriving
// within it would have made this an arrow key instead.
await wait(80);
const afterEsc = painted;
send("после", CR);
ok("Ctrl+L перерисовывает", afterCtrlL > beforeRepaint);
ok("Esc перерисовывает после окна распознавания", afterEsc > afterCtrlL);
ok("после перерисовки ввод жив", (await p) === "допосле");

process.stdout.write = realWrite;

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok || !t.detail ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
