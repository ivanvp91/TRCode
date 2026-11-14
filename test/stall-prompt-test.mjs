/**
 * The "Keep waiting" question asked when the host goes quiet mid-stream.
 *
 * It used to be an inline button row with the turn bar stepped aside: the bar
 * vanished, the buttons stood on their own row near the bottom, and the answer
 * that arrived while the question was up was written onto that row — the
 * widget's next repaint then cleared the answer below it. The question now
 * lives in the bar's frame (above the input band) and removes itself the
 * moment the stream moves again, which is what the watchdog's resolution
 * signal is for.
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ESC = String.fromCharCode(27);
const COLS = 100;
const ROWS = 34;

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-stall-"));
process.env.TRCODE_HOME = HOME;
delete process.env.TRCODE_MODEL;

/** One SSE response that stays silent, then answers. */
let silenceMs = 400;
const server = http.createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "stall-m", owned_by: "mock", context_window: 128000 }] }));
    return;
  }
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const sse = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
    const chunk = (delta, finish = null) => ({
      id: "x",
      object: "chat.completion.chunk",
      model: "stall-m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    sse(chunk({ role: "assistant", content: "" }));
    setTimeout(() => {
      sse(chunk({ content: "late answer" }));
      sse({ ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 2 } });
      res.write("data: [DONE]\n\n");
      res.end();
    }, silenceMs).unref?.();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ── fake terminal + virtual screen ─────────────────────────────────────────
const stdin = new EventEmitter();
Object.assign(stdin, { isTTY: true, isRaw: false, setRawMode: (v) => { stdin.isRaw = v; return stdin; }, resume: () => stdin, pause: () => stdin });
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
for (const [key, value] of Object.entries({ isTTY: true, columns: COLS, rows: ROWS })) {
  Object.defineProperty(process.stdout, key, { value, configurable: true });
}

class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
    this.row = 0;
    this.col = 0;
  }
  scrollUp() {
    this.grid.shift();
    this.grid.push(Array(this.cols).fill(" "));
  }
  write(text) {
    let i = 0;
    while (i < text.length) {
      if (text[i] === ESC && text[i + 1] === "[") {
        const priv = new RegExp("^" + ESC + "\\[[?=][0-9;]*[A-Za-z]").exec(text.slice(i));
        if (priv) { i += priv[0].length; continue; }
        const m = new RegExp("^" + ESC + "\\[([0-9;]*)([A-Za-z])").exec(text.slice(i));
        if (m) {
          const args = m[1] === "" ? [] : m[1].split(";").map((n) => parseInt(n, 10));
          const cmd = m[2];
          if (cmd === "H" || cmd === "f") {
            this.row = Math.max(0, Math.min(this.rows - 1, (args[0] ?? 1) - 1));
            this.col = Math.max(0, Math.min(this.cols - 1, (args[1] ?? 1) - 1));
          } else if (cmd === "A") this.row = Math.max(0, this.row - (args[0] || 1));
          else if (cmd === "B") this.row = Math.min(this.rows - 1, this.row + (args[0] || 1));
          else if (cmd === "C") this.col = Math.min(this.cols - 1, this.col + (args[0] || 1));
          else if (cmd === "D") this.col = Math.max(0, this.col - (args[0] || 1));
          else if (cmd === "G") this.col = Math.max(0, (args[0] || 1) - 1);
          else if (cmd === "J") {
            if (args[0] === 2) this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(" "));
            else if (args[0] === 0) {
              this.grid[this.row].fill(" ", this.col);
              for (let r = this.row + 1; r < this.rows; r++) this.grid[r].fill(" ");
            }
          } else if (cmd === "K") this.grid[this.row].fill(" ", this.col);
          i += m[0].length;
          continue;
        }
      }
      const ch = text[i];
      if (ch === "\r") this.col = 0;
      else if (ch === "\n") {
        this.col = 0;
        if (this.row === this.rows - 1) this.scrollUp();
        else this.row++;
      } else if (ch >= " ") {
        if (this.col < this.cols) this.grid[this.row][this.col] = ch;
        this.col++;
      }
      i++;
    }
  }
  lines() {
    return this.grid.map((r) => r.join("").replace(/\s+$/, ""));
  }
  text() {
    return this.lines().join("\n");
  }
}

let screen = new Screen(COLS, ROWS);
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  screen.write(String(chunk));
  return true;
};

process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
process.env.DEEPSEEK_API_KEY = "sk-test";

const { saveConfig } = await import("../dist/config.js");
const { setFooter, setStartRow, line, setIdleComposer } = await import("../dist/ui/render.js");
const { stallPrompt } = await import("../dist/ui/stall.js");
const { streamChat } = await import("../dist/provider/client.js");

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const key = (s) => stdin.emit("data", Buffer.from(s, "utf8"));
const rowOf = (needle) => screen.lines().findIndex((l) => l.includes(needle));
const rowsMatching = (needle) => screen.lines().filter((l) => l.includes(needle)).length;

/** A stand-in for the turn bar: reasoning row, band, status. */
const barRows = () => ["  BAR", "", "  \u203a typing", "  running \u00b7 3s"];

function freshScreen() {
  screen = new Screen(COLS, ROWS);
  setFooter(null);
  for (let i = 1; i <= 12; i++) line(`transcript row ${String(i).padStart(2, "0")}`);
  setStartRow(3);
  setFooter(barRows);
}

// ── 1. the question is drawn over the bar, not in its place ────────────────
freshScreen();
await wait();
let answer = stallPrompt({ signal: new AbortController().signal });
await wait();
let rows = screen.lines();
ok("the question is on screen", rowOf("Keep waiting") !== -1, rows);
ok("the turn bar is still there", rowOf("BAR") !== -1 && rowOf("running") !== -1, rows);
ok("the question sits above the bar", rowOf("Keep waiting") < rowOf("BAR"), { keep: rowOf("Keep waiting"), bar: rowOf("BAR") });
ok("the input band stays above the status", rowOf("\u203a typing") < rowOf("running"), rows);
ok("exactly one question row", rowsMatching("Keep waiting") === 1, rows);
ok("the bar no longer holds a hole under itself", rowOf("running") >= ROWS - 2, { running: rowOf("running"), ROWS });

// ── 2. arrows move the selection without leaving a copy behind ─────────────
key("\u001b[C");
await wait();
rows = screen.lines();
ok("the other button is now the highlighted one", rows.some((l) => l.includes(" Abort the request ")) && rows.some((l) => l.includes("[Keep waiting]")), rows);
ok("a repaint does not duplicate the question", rowsMatching("Keep waiting") === 1, rows);
key("\u001b[D");
await wait();
ok("walking back restores the first button", screen.lines().some((l) => l.includes(" Abort the request ")) === false, screen.lines());

// ── 3. "keep waiting" answers and leaves one line above the bar ────────────
key("w");
const kept = await answer;
await wait();
rows = screen.lines();
ok("keep waiting resolves true", kept === true, kept);
ok("the buttons are gone", !rows.some((l) => l.includes("[Abort the request]")) && rowsMatching("Keep waiting") === 1, rows);
ok("the answer is echoed once", rowsMatching("\u25b8 Keep waiting") === 1, rows);
ok("the echo is above the bar", rowOf("\u25b8 Keep waiting") < rowOf("BAR"), rows);
ok("the bar kept its place", rowOf("running") >= ROWS - 2, { running: rowOf("running") });

// ── 4. abort answers false ─────────────────────────────────────────────────
freshScreen();
answer = stallPrompt({ signal: new AbortController().signal });
await wait();
key("n");
ok("abort resolves false", (await answer) === false, "");
await wait();
ok("abort is echoed and the buttons go", rowOf("Abort the request") !== -1 && !screen.lines().some((l) => l.includes("[Keep waiting]")), screen.lines());

// ── 5. Enter takes whatever is highlighted ─────────────────────────────────
freshScreen();
answer = stallPrompt({ signal: new AbortController().signal });
await wait();
key("\t");
await wait();
key("\r");
ok("enter takes the highlighted button", (await answer) === false, "");

// ── 6. the stream moving takes the question away by itself ─────────────────
freshScreen();
const ctrl = new AbortController();
answer = stallPrompt({ signal: ctrl.signal });
await wait();
ok("the question is up before the abort", rowOf("Keep waiting") !== -1, screen.lines());
const before = screen.text();
ctrl.abort();
const dismissed = await answer;
await wait();
rows = screen.lines();
ok("a resolved stall drops the question", dismissed === true, dismissed);
ok("nothing is left of it on the bar", rowOf("Keep waiting") === -1 && rowOf("Abort the request") === -1, rows);
ok("the bar is back where it was", rowOf("running") >= ROWS - 2, { running: rowOf("running") });
ok("a question nobody answered prints no echo", rowsMatching("\u25b8") === 0, rows);
ok("the transcript below it is untouched", screen.text().includes("transcript row 12"), { before: before.length });

// ── 7. a second stall does not stack on the first ──────────────────────────
freshScreen();
const first = stallPrompt({ signal: new AbortController().signal });
await wait();
key("w");
await first;
const second = stallPrompt({ signal: new AbortController().signal });
await wait();
ok("the next question paints one row, not two", rowsMatching("Keep waiting") === 1, screen.lines());
second.then(() => {});
stdin.emit("data", Buffer.from("n", "utf8"));
await second;

// ── 8. the watchdog drives the question ────────────────────────────────────
saveConfig({ requestTimeoutMs: 300 });
silenceMs = 400;
let asked = 0;
let resolvedSignal = null;
const seen = [];
let keep = true;
for await (const ev of streamChat({
  model: "tokenrouter:stall-m",
  messages: [{ role: "user", content: "hi" }],
  onStall: (idleMs, signal) => {
    asked++;
    resolvedSignal = signal;
    // What the UI does: the question leaves the moment the stream moves.
    return new Promise((done) => {
      signal.addEventListener("abort", () => done(true), { once: true });
      setTimeout(() => done(keep), 5000).unref?.();
    });
  },
})) {
  if (ev.type === "text") seen.push(ev.text);
}
ok("the silence is asked about", asked === 1, String(asked));
ok("the question gets a resolution signal", resolvedSignal instanceof AbortSignal, String(resolvedSignal));
ok("the signal fires when data arrives", resolvedSignal.aborted === true, String(resolvedSignal.aborted));
ok("the late answer is not thrown away", seen.join("") === "late answer", seen.join(""));

// ── 9. an "abort" answer still ends the request ────────────────────────────
silenceMs = 4000;
asked = 0;
keep = false;
let failure = "";
const started = Date.now();
try {
  for await (const ev of streamChat({
    model: "tokenrouter:stall-m",
    messages: [{ role: "user", content: "hi" }],
    onStall: () => Promise.resolve(false),
  })) {
    if (ev.type === "text") { /* not reached */ }
  }
} catch (err) {
  failure = err.message;
}
ok("abort stops the request", failure.includes("Stream stalled"), failure);
ok("it stops without waiting the silence out", Date.now() - started < 3000, String(Date.now() - started));

// ── 10. a late answer after data arrived does not abort anything ───────────
silenceMs = 300;
asked = 0;
const late = [];
let releaseLate;
try {
  for await (const ev of streamChat({
    model: "tokenrouter:stall-m",
    messages: [{ role: "user", content: "hi" }],
    onStall: () =>
      new Promise((done) => {
        asked++;
        releaseLate = () => done(false);
      }),
  })) {
    if (ev.type === "text") late.push(ev.text);
  }
} catch (err) {
  late.push("ERROR " + err.message);
}
releaseLate?.();
await wait(100);
ok("an answer given after the stream moved is ignored", late.join("") === "late answer", late.join(""));

// ── 11. no terminal, no question ───────────────────────────────────────────
Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
ok("without a TTY the request is given up", (await stallPrompt({ signal: new AbortController().signal })) === false, "");
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
setFooter(null);
setIdleComposer(null);
server.close();

const failed = results.filter((r) => !r.ok);
const realWrite2 = realWrite;
for (const r of results) {
  realWrite2((r.ok ? "  ok   " : "  FAIL ") + r.name + (r.ok || !r.detail ? "" : `\n       ${typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)}\n`) + "\n");
}
realWrite2(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
