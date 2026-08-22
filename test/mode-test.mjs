/**
 * Shift+Tab flips confirmations without leaving the input line. Three terminal
 * encodings have to work, the buffer must survive the toggle, and the status
 * row has to be re-read afterwards — that row is the only signal the mode
 * changed at all.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);

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
const { composeStatus } = await import("../dist/ui/inputbox.js");

let autoApprove = false;
let statusReads = 0;
const ed = new InputEditor({
  status: () => {
    statusReads++;
    return { left: autoApprove ? "yolo" : "", hint: "H", context: "C" };
  },
  history: [],
  onToggleMode: () => {
    autoApprove = !autoApprove;
  },
});

const send = (...chunks) => {
  for (const ch of chunks) stdin.emit("data", Buffer.from(ch, "utf8"));
};

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

/** Runs one read: sends keys, returns the submitted text. */
async function submit(...keys) {
  const p = ed.read();
  send(...keys, CR);
  return p;
}

// ── the three encodings ───────────────────────────────────────────────────
for (const [label, seq] of [
  ["ESC[Z (backtab)", ESC + "[Z"],
  ["ESC[27;2;9~ (modifyOtherKeys)", ESC + "[27;2;9~"],
  ["ESC[9;2u (kitty)", ESC + "[9;2u"],
]) {
  autoApprove = false;
  await submit(seq);
  ok(`Shift+Tab включает режим: ${label}`, autoApprove === true);
  await submit(seq);
  ok(`и выключает обратно: ${label}`, autoApprove === false);
}

// ── it is a mode key, not text ────────────────────────────────────────────
autoApprove = false;
const text = await submit("hello", ESC + "[Z", " world");
ok("текст не портится переключением", text === "hello world", JSON.stringify(text));
ok("режим при этом переключился", autoApprove === true);

// Plain Tab still completes rather than toggling.
autoApprove = false;
const plain = await submit("abc", TAB);
ok("обычный Tab не трогает режим", autoApprove === false, String(autoApprove));
ok("обычный Tab не съедает текст", plain.startsWith("abc"), JSON.stringify(plain));

// ── the status row is what shows the mode ─────────────────────────────────
{
  const before = statusReads;
  autoApprove = false;
  await submit(ESC + "[Z");
  ok("статус перечитан после переключения", statusReads > before, `${before} → ${statusReads}`);
}
{
  const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
  const off = strip(composeStatus({ model: "m", effort: "high", cwdLabel: "~", contextUsed: 1, contextWindow: 100, contextEstimated: false }).hint);
  ok("подсказка называет Shift+Tab", /Shift\+Tab/.test(off), off);
  const on = strip(composeStatus({ mode: "yolo", model: "m", effort: "high", cwdLabel: "~", contextUsed: 1, contextWindow: 100, contextEstimated: false }).left);
  ok("включённый режим виден в строке", on.startsWith("yolo"), on);
}

process.stdout.write = realWrite;
void frames;

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok || !t.detail ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
