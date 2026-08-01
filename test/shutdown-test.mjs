/**
 * The REPL must let go of the terminal when it stops. A pending read that is
 * never resolved keeps stdin referenced and the process resident — that is how
 * two dozen orphaned `trc` processes piled up.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

// ── 1. InputEditor.cancel() unwinds a pending read and restores stdin ─────
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
const { hasConsumer, releaseStdin } = await import("../dist/ui/stdin.js");
const ed = new InputEditor({ status: () => ({ left: "L", hint: "H", context: "C" }), history: [] });

const pending = ed.read();
stdin.emit("data", Buffer.from("нед"));
// The hub owns stdin for the whole session — exactly one listener, always.
const listenersWhileReading = stdin.listenerCount("data");
const consumingWhileReading = hasConsumer();
ed.cancel();
const value = await pending;
const consumingAfter = hasConsumer();

ok("во время чтения слушатель stdin висит", listenersWhileReading === 1, String(listenersWhileReading));
ok("во время чтения есть потребитель", consumingWhileReading);
ok("cancel() резолвит чтение как null", value === null, JSON.stringify(value));
ok("cancel() снимает потребителя", consumingAfter === false, String(consumingAfter));
ed.cancel(); // повторный вызов не должен падать
ok("повторный cancel() безопасен", true);

// Shutdown is what hands the terminal back, not each individual read.
releaseStdin();
ok("releaseStdin() снимает слушатель", stdin.listenerCount("data") === 0, String(stdin.listenerCount("data")));
ok("releaseStdin() снимает raw-режим", stdin.isRaw === false, String(stdin.isRaw));

process.stdout.write = realWrite;

// ── 2. процесс действительно умирает при открытом stdin ──────────────────
const exitMs = await new Promise((resolve) => {
  const t0 = Date.now();
  const child = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["pipe", "ignore", "ignore"],
    env: {
      ...process.env,
      TRCODE_HOME: process.env.TRCODE_HOME ?? "./.t",
      TOKENROUTER_API_KEY: "sk-test",
      TOKENROUTER_BASE_URL: process.env.TOKENROUTER_BASE_URL ?? "http://127.0.0.1:8804/v1",
    },
  });
  let done = false;
  child.on("exit", () => {
    done = true;
    resolve(Date.now() - t0);
  });
  setTimeout(() => child.stdin.write("/exit\n"), 1200);
  setTimeout(() => {
    if (!done) {
      child.kill("SIGKILL");
      resolve(-1);
    }
  }, 9000);
});

ok("процесс завершается, не дожидаясь закрытия stdin", exitMs > 0 && exitMs < 5000, exitMs < 0 ? "завис" : `${exitMs} мс`);

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.detail ? `  (${t.detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
