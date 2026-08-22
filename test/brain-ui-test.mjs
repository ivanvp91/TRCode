/**
 * What the panel puts on the screen.
 *
 * The rounds and the final answer are markdown, and both used to reach the
 * terminal as raw text: the rounds went through wrapText and arrived grey with
 * `##` and pipe-tables intact, and the final answer was rendered into lines
 * that nobody printed — the user watched three models discuss a question and
 * never saw the answer. Both are asserted here on the real repl method.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A terminal, as far as the bar and the renderer are concerned. This has to be
// in place before the UI modules are imported.
const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-brain-ui-"));
process.env.TRCODE_HOME = HOME;

const port = Number(process.env.MOCK_PORT || 8931);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { App } = await import("../dist/ui/repl.js");
const { Session } = await import("../dist/session/session.js");
const { UsageTracker } = await import("../dist/usage.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const ESC = String.fromCharCode(27);
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g"), "");

const app = Object.create(App.prototype);
const session = new Session({ cwd: process.cwd(), model: "mock-fast", title: "brain" });
Object.assign(app, {
  cwd: process.cwd(),
  catalog: [{ id: "mock-fast" }, { id: "mock-smart" }],
  session,
  usage: new UsageTracker(),
  pending: [],
  editor: null,
  effortOverride: undefined,
  status: () => ({ model: "mock-fast", cwdLabel: ".", contextUsed: 0, contextWindow: 128000 }),
  statusLine: () => {},
  toggleAutoApprove: () => {},
  suggestAnotherHost: () => {},
});

const real = process.stdout.write.bind(process.stdout);
let buf = "";
process.stdout.write = (chunk) => { buf += String(chunk); return true; };
const realErr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => { buf += String(chunk); return true; };
try {
  await App.prototype.runBrain.call(app, "как ускорить сборку", ["mock-fast", "mock-smart"]);
} finally {
  process.stdout.write = real;
  process.stderr.write = realErr;
}
const out = strip(buf);

check("the panel's final answer reaches the screen", out.includes("ИТОГ"), out.slice(-400));
check("the rounds reach the screen", out.includes("РАУНД"));
check("no raw heading markers survive", !out.includes("## "), (out.match(/^.*## .*$/m) ?? [""])[0]);
check("bullets are rendered", out.includes("•"));
check("bold markers are consumed", !out.includes("**вывод**"));
check("inline code markers are consumed", !/`build`/.test(out));
// A pipe table has to come out as a table, not as the source line.
check("the table is laid out", out.includes("ключ") && !out.includes("| --- |"), (out.match(/^.*ключ.*$/m) ?? [""])[0]);
check("the answer joins the history", session.messages.some((m) => m.role === "assistant" && m.content.includes("ИТОГ")));

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
