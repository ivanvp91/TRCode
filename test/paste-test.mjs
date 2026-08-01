/**
 * Paste arrives in several shapes depending on the terminal:
 *  1. bracketed, one chunk        ESC[200~ text ESC[201~
 *  2. bracketed, split chunks     markers and text across several data events
 *  3. plain multi-character chunk (no bracketing)
 *  4. character-by-character      (very slow terminals / some emulators)
 * All four must land in the buffer intact.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const PASTE_START = ESC + "[200~";
const PASTE_END = ESC + "[201~";

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

const realWrite = process.stdout.write.bind(process.stdout);
let written = "";
process.stdout.write = (chunk) => {
  written += String(chunk);
  return true;
};

const { InputEditor } = await import("../dist/ui/editor.js");

const ed = new InputEditor({
  status: () => ({ left: "L", hint: "H", context: "C" }),
  history: [],
});

const send = (...chunks) => {
  for (const ch of chunks) stdin.emit("data", Buffer.from(ch, "utf8"));
};

async function run(name, chunks, expect) {
  const p = ed.read();
  send(...chunks, CR);
  const got = await p;
  return { name, ok: got === expect, got, expect };
}

const TEXT = "SELECT * FROM users WHERE id = 42;";
const MULTI = "первая строка\nвторая строка";

const results = [];
results.push(await run("1. bracketed одним куском", [PASTE_START + TEXT + PASTE_END], TEXT));
results.push(
  await run("2. bracketed по кускам", [PASTE_START + "SELECT * ", "FROM users ", "WHERE id = 42;" + PASTE_END], TEXT),
);
results.push(await run("3. обычный длинный кусок", [TEXT], TEXT));
results.push(await run("4. посимвольно", [...TEXT], TEXT));
results.push(await run("5. многострочная вставка", [PASTE_START + MULTI + PASTE_END], MULTI));
results.push(
  await run("6. вставка с завершающим переводом строки", [PASTE_START + TEXT + "\n" + PASTE_END], TEXT),
);
results.push(await run("7. CRLF внутри вставки", [PASTE_START + "a\r\nb" + PASTE_END], "a\nb"));
results.push(
  await run("8. вставка в середину набранного", ["ab", ESC + "[D", PASTE_START + "XY" + PASTE_END], "aXYb"),
);
results.push(await run("9. кириллица и эмодзи", [PASTE_START + "привет мир" + PASTE_END], "привет мир"));

process.stdout.write = realWrite;

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(
    `${r.ok ? "  OK  " : "ПРОВАЛ"}  ${r.name}` +
      (r.ok ? "" : `\n        ждали ${JSON.stringify(r.expect)}\n        получили ${JSON.stringify(r.got)}`),
  );
}

const enabled = written.includes(ESC + "[?2004h");
const disabled = written.includes(ESC + "[?2004l");
console.log(`\nрежим bracketed paste включается: ${enabled ? "да" : "НЕТ"}, выключается на выходе: ${disabled ? "да" : "НЕТ"}`);
console.log(`${results.length - failed}/${results.length} пройдено`);
process.exit(failed || !enabled || !disabled ? 1 : 0);
