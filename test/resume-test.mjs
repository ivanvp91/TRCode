/**
 * Drives the real /resume flow on a virtual screen: session list with sizes,
 * the detail card, the three-way prompt, and the replayed transcript.
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ESC = String.fromCharCode(27);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-resume-"));
process.env.TRCODE_HOME = HOME;
process.env.NO_COLOR = "";
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = "1";

// Point at the mock before anything can call loadConfig() — it caches on first
// call, and a stale default base URL would send the compaction to the real API.
let mock = null;
if (!process.env.TOKENROUTER_BASE_URL) {
  const port = Number(process.env.MOCK_PORT || 8899);
  mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
    stdio: "ignore",
    env: { ...process.env, MOCK_PORT: String(port) },
  });
  process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
  await new Promise((r) => setTimeout(r, 1200));
}
process.env.TOKENROUTER_API_KEY = "sk-test";

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
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
        const priv = new RegExp("^" + ESC + "\\[\\?[0-9;]*[A-Za-z]").exec(text.slice(i));
        if (priv) { i += priv[0].length; continue; }
        const m = new RegExp("^" + ESC + "\\[([0-9;]*)([A-Za-z])").exec(text.slice(i));
        if (m) {
          const n = m[1] === "" ? 1 : parseInt(m[1].split(";")[0], 10);
          const cmd = m[2];
          if (cmd === "A") this.row = Math.max(0, this.row - n);
          else if (cmd === "B") this.row += n;
          else if (cmd === "G") this.col = Math.max(0, n - 1);
          else if (cmd === "J") {
            const r = this.row_(this.row);
            for (let x = this.col; x < this.cols; x++) r[x] = " ";
            for (let y = this.row + 1; y <= this.maxRow; y++) this.row_(y).fill(" ");
          } else if (cmd === "K") this.row_(this.row).fill(" ");
          i += m[0].length;
          continue;
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
  lines() { return this.grid.slice(0, this.maxRow + 1).map((r) => r.join("").replace(/\s+$/, "")); }
  reset() { this.grid = []; this.row = 0; this.col = 0; this.maxRow = 0; }
}

const screen = new Screen(100);
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { screen.write(String(chunk)); return true; };
/** Test output must bypass the virtual screen. */
const say = (s = "") => realWrite(s + "\n");

const { Session } = await import("../dist/session/session.js");
const { App } = await import("../dist/ui/repl.js");
const { runCommand } = await import("../dist/ui/commands.js");
const { renderMarkdownBlock } = await import("../dist/ui/render.js");
const { width } = await import("../dist/ui/ansi.js");
const { sessionsDir } = await import("../dist/config.js");

const CWD = process.cwd();

const TABLE_ANSWER = `# Pricing review

| Plan | $/mo | Accounts | Sync |
|---|---|---|---|
| Free | 0 | 3 | 5 min |
| Starter | 9.99 | 10 | 30 sec |
| Trader ⭐ | 19.99 | 25 | 15 sec |

- The gap between Starter and Trader is too small.
- **Prop vertical** is the only real differentiator.
`;

/** Two saved sessions: a big one with a table, and a tiny one. */
function seed() {
  const big = new Session({ cwd: CWD, model: "moonshotai/kimi-k3", title: "pricing analysis" });
  big.add({ role: "user", content: "analyse the fx monitor pricing" });
  big.add({ role: "assistant", content: TABLE_ANSWER, meta: { model: "moonshotai/kimi-k3" } });
  big.add({ role: "assistant", content: null, tool_calls: [
    { id: "1", type: "function", function: { name: "read", arguments: '{"path":"pricing.php"}' } },
  ] });
  big.add({ role: "tool", content: "…file…", tool_call_id: "1", name: "read" });
  // Bulk so the size is visibly non-trivial.
  big.add({ role: "user", content: "x".repeat(40_000) });
  big.save();

  const small = new Session({ cwd: CWD, model: "moonshotai/kimi-k3", title: "quick question" });
  small.add({ role: "user", content: "hi" });
  small.save();
  return { big, small };
}

const { big, small } = seed();

/** An App with just the fields /resume touches — no network, no tools. */
function makeApp() {
  const app = Object.create(App.prototype);
  Object.assign(app, {
    cwd: CWD,
    cfg: { model: "moonshotai/kimi-k3" },
    catalog: [{ id: "moonshotai/kimi-k3", contextWindow: 1_000_000 }],
    session: new Session({ cwd: CWD, model: "moonshotai/kimi-k3", title: "current" }),
    usage: null,
    readFiles: new Set(),
    turnKeys: null,
    abort: null,
    skills: [],
  });
  app.usage = app.session.usage;
  app.rebuildTools = () => {};
  return app;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (s) => { stdin.emit("data", Buffer.from(s, "utf8")); await sleep(30); };
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");

let passed = 0;
let failed = 0;
/** PREVIEW=1 prints the captured screen for every check, to eyeball layout. */
function check(name, cond, detail = "") {
  if (cond) { passed++; say("  ok   " + name + (process.env.PREVIEW && detail ? "\n" + detail + "\n" : "")); }
  else { failed++; say("  FAIL " + name + (detail ? "\n       " + detail : "")); }
}

// ── 1. list → card → continue as is ─────────────────────────────────────────
{
  const app = makeApp();
  screen.reset();
  const done = runCommand(app, "/resume");
  await sleep(60);
  const list = screen.lines().map(strip).join("\n");

  check("list shows a token size", /~\d[\d.]*k?\/1M/.test(list), list);
  check("list shows a fill percentage", /\d+%/.test(list), list);
  check("list shows both sessions", /pricing analysis/.test(list) && /quick question/.test(list), list);

  // Filter down to the big session so the assertions below are deterministic
  // regardless of which one was saved last.
  for (const ch of "pricing") await key(ch);
  await key("\r");
  const card = screen.lines().map(strip).join("\n");
  check("card shows the token budget", /of 1M tokens \(\d+%\)/.test(card), card);
  check("card shows a fill bar", /[█░]{10,}/.test(card), card);
  check(
    "card offers all three actions",
    /Continue as is/.test(card) && /Compact and continue/.test(card) && /Back to the list/.test(card),
    card,
  );

  screen.reset();
  await key("\r"); // Continue as is
  await done;
  const replay = screen.lines().map(strip);
  const text = replay.join("\n");

  check("adopted the chosen session", app.session.id === big.id, app.session.id);
  check("replay header carries size", /messages · ~[\d.]+k of 1M tokens/.test(text), text);
  check("replay keeps the table aligned", replay.some((l) => /Free\s+│/.test(l)), text);
}

// ── 2. "back to the list" really goes back ──────────────────────────────────
{
  const app = makeApp();
  const before = app.session.id;
  screen.reset();
  const done = runCommand(app, "/resume");
  await sleep(60);
  await key("\r"); // open the first session
  await key(ESC + "[C"); // → Compact and continue
  await key(ESC + "[C"); // → Back to the list
  screen.reset();
  await key("\r"); // confirm: back
  await sleep(40);
  const back = screen.lines().map(strip).join("\n");
  check("returns to the picker", /Pick a session/.test(back), back);

  await key(ESC); // cancel the picker
  await done;
  check("cancelling leaves the session untouched", app.session.id === before);
}

// ── 3. the replayed answer keeps its table ──────────────────────────────────
{
  const app = makeApp();
  app.session = Session.load(CWD, big.id);
  app.usage = app.session.usage;
  screen.reset();
  app.replayHistory();
  const lines = screen.lines().map(strip);
  const text = lines.join("\n");

  check("table is aligned, not flattened", lines.some((l) => /Free\s+│\s+0\s+│/.test(l)), text);
  check("separator row is dropped", !/\|---\|/.test(text) && !/\| Plan \|/.test(text), text);
  check("heading survives", /Pricing review/.test(text), text);
  check("bullets are rendered", /• The gap between Starter/.test(text), text);
  check("tool call is listed", /read\(/.test(text), text);
  check("long turn is capped", /more lines/.test(text), text);
}

// ── 4. a compacted digest replays as a labelled block ───────────────────────
{
  const app = makeApp();
  const s = new Session({ cwd: CWD, model: "moonshotai/kimi-k3", title: "compacted" });
  s.add({
    role: "user",
    content:
      "<compacted-context>\nThe earlier part of this session has been compacted. Below is the digest.\n\n## Task\nShip the pricing page.\n\n## Done\nEdited `pricing.php`.\n</compacted-context>",
  });
  s.add({ role: "assistant", content: "Context received." });
  s.compactions = 1;
  app.session = s;
  screen.reset();
  app.replayHistory();
  const text = screen.lines().map(strip).join("\n");

  check("digest gets a label", /compacted context/.test(text), text);
  check("digest keeps no xml tags", !/<compacted-context>/.test(text), text);
  check("digest sections survive", /Task/.test(text) && /Ship the pricing page/.test(text), text);
  check("header notes the compaction", /compacted 1×/.test(text), text);
}

// ── 5. "compact and continue" really compacts ───────────────────────────────
{
  const app = makeApp();
  screen.reset();
  const done = runCommand(app, `/resume ${big.id}`);
  await sleep(60);
  await key(ESC + "[C"); // → Compact and continue
  await key("\r");
  await sleep(2500);
  await done;
  const text = screen.lines().map(strip).join("\n");

  check("compaction reports the saving", /Compacted \d+ messages into a digest/.test(text), text);
  check("compaction reports tokens", /~[\d.]+k? → ~[\d.]+k? tokens/.test(text), text);
  check("history actually shrank", app.session.messages.length < 5, String(app.session.messages.length));
  check("session is marked compacted", app.session.compactions === 1, String(app.session.compactions));
  check("digest replaces the head", /compacted context/.test(text), text);
}

// ── 6. dead sessions never reach the list ───────────────────────────────────
{
  const dir = sessionsDir(CWD);
  const ghost = new Session({ cwd: CWD, model: "moonshotai/kimi-k3", title: "ghost" });
  ghost.save();
  check("an empty session writes no file", !fs.existsSync(path.join(dir, `${ghost.id}.json`)));

  // What older builds left behind: a file with a meta block and no messages.
  const stale = path.join(dir, "20260101-dead01.json");
  fs.writeFileSync(
    stale,
    JSON.stringify({
      meta: { id: "20260101-dead01", title: "", cwd: CWD, model: "moonshotai/kimi-k3", createdAt: 1, updatedAt: 2, messageCount: 0 },
      messages: [],
      usage: [],
    }),
  );
  check("list hides an empty session", !Session.list(CWD).some((m) => m.id === "20260101-dead01"));
  const removed = Session.pruneEmpty(CWD);
  check("pruneEmpty deletes it", removed >= 1 && !fs.existsSync(stale), String(removed));
  check("pruneEmpty spares real sessions", fs.existsSync(path.join(dir, `${big.id}.json`)));
}

// ── 7. /sessions renames and deletes ────────────────────────────────────────
{
  const app = makeApp();
  screen.reset();
  const done = runCommand(app, "/sessions");
  await sleep(60);
  const list = screen.lines().map(strip).join("\n");
  check("manage mode has its own title", /Sessions/.test(list), list);

  for (const ch of "quick") await key(ch);
  await key("\r");
  const card = screen.lines().map(strip).join("\n");
  check(
    "four actions are offered",
    /Continue/.test(card) && /Rename/.test(card) && /Delete/.test(card) && /Compact/.test(card),
    card,
  );

  await key(ESC + "[C"); // → Rename
  await key("\r");
  await key(String.fromCharCode(21)); // Ctrl+U clears the prefilled title
  for (const ch of "renamed session") await key(ch);
  await key("\r");
  await sleep(60);
  check("rename lands on disk", Session.load(CWD, small.id)?.title === "renamed session", Session.load(CWD, small.id)?.title);

  // Back on the list: pick it again and delete it.
  for (const ch of "renamed") await key(ch);
  await key("\r");
  await key(ESC + "[C");
  await key(ESC + "[C"); // → Delete
  await key("\r");
  const confirm = screen.lines().map(strip).join("\n");
  check("delete asks first", /Keep/.test(confirm) && /Delete \d+ messages?/.test(confirm), confirm);
  await key(ESC + "[C"); // → Delete N messages (Keep is preselected)
  await key("\r");
  await sleep(60);
  check("delete removes the file", !fs.existsSync(path.join(sessionsDir(CWD), `${small.id}.json`)));

  await key(ESC); // leave the list
  await done;
}

// ── 8. wide characters do not shift columns ─────────────────────────────────
{
  check("an emoji counts as two cells", width("⭐") === 2, String(width("⭐")));
  check("CJK counts as two cells", width("日本") === 4, String(width("日本")));
  check("a variation selector counts as none", width("★️") === 1, String(width("★️")));

  const rows = renderMarkdownBlock(
    "| Plan | Note |\n|---|---|\n| Free | plain |\n| Trader ⭐ | starred |\n",
    { width: 60 },
  ).map(strip);
  const bars = rows.filter((r) => r.includes("│")).map((r) => width(r.slice(0, r.indexOf("│"))));
  check("every table row puts its bar in the same column", new Set(bars).size === 1, JSON.stringify(rows));
}

mock?.kill("SIGKILL");
fs.rmSync(HOME, { recursive: true, force: true });
say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
