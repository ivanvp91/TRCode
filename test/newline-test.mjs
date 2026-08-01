/**
 * Multi-line input. In raw mode plain Enter is CR, so LF is free to mean
 * "newline, don't send" — that is what Windows Terminal emits for Ctrl+Enter.
 * Other terminals report the modifier via CSI sequences instead.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

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

const realWrite = process.stdout.write.bind(process.stdout);
let frames = "";
process.stdout.write = (chunk) => {
  frames += String(chunk);
  return true;
};

const { InputEditor } = await import("../dist/ui/editor.js");
const ed = new InputEditor({ status: () => ({ left: "L", hint: "H", context: "C" }), history: [] });

const send = (...chunks) => {
  for (const ch of chunks) stdin.emit("data", Buffer.from(ch, "utf8"));
};

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

async function run(name, keys, expect) {
  const p = ed.read();
  send(...keys);
  const got = await p;
  ok(name, got === expect, `получили ${JSON.stringify(got)}, ждали ${JSON.stringify(expect)}`);
  return got;
}

await run("Ctrl+Enter (LF) переносит строку", ["первая", LF, "вторая", CR], "первая\nвторая");
await run("Alt+Enter переносит строку", ["a", ESC + CR, "b", CR], "a\nb");
await run("kitty Ctrl+Enter переносит", ["a", ESC + "[13;5u", "b", CR], "a\nb");
await run("kitty Shift+Enter переносит", ["a", ESC + "[13;2u", "b", CR], "a\nb");
await run("modifyOtherKeys Ctrl+Enter", ["a", ESC + "[27;5;13~", "b", CR], "a\nb");
// Modifier numbers differ per combination; the rule matches the whole family.
await run("kitty Ctrl+Shift+Enter", ["a", ESC + "[13;6u", "b", CR], "a\nb");
await run("modifyOtherKeys Ctrl+Shift+Enter", ["a", ESC + "[27;6;13~", "b", CR], "a\nb");
await run("Enter с любым модификатором", ["a", ESC + "[13;8u", "b", CR], "a\nb");
await run("Enter по-прежнему отправляет", ["готово", CR], "готово");
await run("обратный слеш всё ещё работает", ["ab\\", CR, "cd", CR], "ab\ncd");
await run("три строки подряд", ["1", LF, "2", LF, "3", CR], "1\n2\n3");

// The frame has to grow with the text instead of overwriting its own border.
frames = "";
const p = ed.read();
send("одна", LF, "две", LF, "три");
const rows = frames.split("\n").filter((l) => l.includes("│")).length;
send(CR);
await p;
ok("рамка растёт под несколько строк", rows >= 3, `строк ввода в рамке: ${rows}`);

// A sequence pinned via /keys must work too.
const { setExtraNewlineKeys } = await import("../dist/ui/editor.js");
setExtraNewlineKeys([ESC + "[99~"]);
await run("закреплённая через /keys", ["a", ESC + "[99~", "b", CR], "a\nb");
setExtraNewlineKeys([]);

process.stdout.write = realWrite;

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
