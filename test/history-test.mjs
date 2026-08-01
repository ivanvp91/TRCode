/**
 * Input history: arrows must recall previous prompts, exactly as the REPL
 * wires the editor (same suggestion provider, same shared array).
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const UP = ESC + "[A";
const DOWN = ESC + "[B";

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
process.stdout.write = () => true;

const { InputEditor } = await import("../dist/ui/editor.js");
const { commandSuggestions } = await import("../dist/ui/commands.js");

const history = [];
const ed = new InputEditor({
  status: () => ({ left: "L", hint: "H", context: "C" }),
  history,
  suggest: commandSuggestions,
  suggestRows: 5,
});

const send = (...chunks) => {
  for (const ch of chunks) stdin.emit("data", Buffer.from(ch, "utf8"));
};

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const BASE = ["первый запрос", "/model", "третий запрос"];

/** Each check starts from the same history, since submitting appends to it. */
async function recall(keys) {
  history.splice(0, history.length, ...BASE);
  const p = ed.read();
  send(...keys);
  return p;
}

// Recording is the REPL job now; the editor only reads the array.
history.length = 0;
const p0 = ed.read();
send("первый запрос", CR);
ok("редактор возвращает введённое", (await p0) === "первый запрос");

ok("↑ возвращает последний запрос", (await recall([UP, CR])) === "третий запрос");
ok("↑↑ возвращает предпоследний", (await recall([UP, UP, CR])) === "/model");
ok("↑↑↑ возвращает самый ранний", (await recall([UP, UP, UP, CR])) === "первый запрос");
ok("↓ идёт обратно вперёд", (await recall([UP, UP, DOWN, CR])) === "третий запрос");

// A recalled slash command must not hand the arrows to the dropdown.
ok(
  "список команд не перехватывает историю",
  (await recall([UP, UP, UP, CR])) === "первый запрос",
  "меню перехватило стрелки",
);

// Typing then Up must keep the draft recoverable.
const p2 = ed.read();
send("черновик");
send(UP);
send(DOWN);
send(CR);
ok("черновик возвращается по ↓", (await p2) === "черновик", "черновик потерян");

// Persistence across restarts.
const { loadInputHistory, saveInputHistory } = await import("../dist/session/history.js");
const os = await import("node:os");
const fsm = await import("node:fs");
const tmp = fsm.mkdtempSync(os.tmpdir() + "/trc-hist-");
process.env.TRCODE_HOME = tmp + "/home";
saveInputHistory(tmp, ["строка один", "строка два"]);
const reloaded = loadInputHistory(tmp);
ok("история переживает перезапуск", JSON.stringify(reloaded) === JSON.stringify(["строка один", "строка два"]), JSON.stringify(reloaded));
ok("история чужого проекта не подмешивается", loadInputHistory(tmp + "-other").length === 0);
fsm.rmSync(tmp, { recursive: true, force: true });

process.stdout.write = realWrite;

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
