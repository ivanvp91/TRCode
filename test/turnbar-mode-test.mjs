/**
 * Shift+Tab in the turn bar: all three terminal encodings must flip the
 * confirmation mode mid-turn, glued text must not break it, and a sequence the
 * terminal splits across reads must still land.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
process.stdout.write = () => true;

const { TurnBar } = await import("../dist/ui/turnbar.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + " :: " + detail); }
}

let toggles = 0, interrupted = 0;
const bar = new TurnBar({
  status: () => ({ left: "", hint: "", context: "" }),
  onInterrupt: () => interrupted++,
  onToggleMode: () => toggles++,
});
bar.start();
await sleep(30);
const key = async (s) => { stdin.emit("data", Buffer.from(s, "utf8")); await sleep(60); };

for (const [label, seq] of [
  ["ESC[Z (backtab)", ESC + "[Z"],
  ["ESC[27;2;9~ (modifyOtherKeys)", ESC + "[27;2;9~"],
  ["ESC[9;2u (kitty)", ESC + "[9;2u"],
]) {
  toggles = 0; interrupted = 0;
  await key(seq);
  check(`${label} переключает режим`, toggles === 1, `toggles=${toggles} interrupted=${interrupted}`);
  check(`${label} не отменяет ход`, interrupted === 0, `interrupted=${interrupted}`);
}

toggles = 0; interrupted = 0;
await key("привет" + ESC + "[Z");
check("Shift+Tab рядом с текстом переключает режим один раз", toggles === 1, `toggles=${toggles}`);
check("и не отменяет ход", interrupted === 0, `interrupted=${interrupted}`);
await key("\r");
await sleep(20);
const stopped = bar.stop();
check("текст перед Shift+Tab доезжает в очередь целым",
  stopped.queued.length === 1 && stopped.queued[0] === "привет", JSON.stringify(stopped.queued));
bar.start();
await sleep(20);

toggles = 0; interrupted = 0;
await key(ESC + "[Z" + ESC + "[Z");
check("два Shift+Tab в одном чанке дают два переключения", toggles === 2, `toggles=${toggles}`);
check("и не отменяют ход", interrupted === 0, `interrupted=${interrupted}`);

toggles = 0; interrupted = 0;
stdin.emit("data", Buffer.from((ESC + "[Z").slice(0, 2), "utf8"));
await sleep(5);
stdin.emit("data", Buffer.from((ESC + "[Z").slice(2), "utf8"));
await sleep(80);
check("разрезанный терминалом Shift+Tab доходит", toggles === 1, `toggles=${toggles}`);
check("и не отменяет ход", interrupted === 0, `interrupted=${interrupted}`);
bar.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
