/**
 * The bottom bar during a turn: the frame must stay on screen while output
 * scrolls above it, exactly once, and take typed input without disturbing it.
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
            this.maxRow = this.row;
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
  text() { return this.lines().join("\n"); }
  reset() { this.grid = []; this.row = 0; this.col = 0; this.maxRow = 0; }
}

const screen = new Screen(100);
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { screen.write(String(chunk)); return true; };
const say = (s = "") => realWrite(s + "\n");

const { TurnBar } = await import("../dist/ui/turnbar.js");
const { line } = await import("../dist/ui/render.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (s) => { stdin.emit("data", Buffer.from(s, "utf8")); await sleep(20); };
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");
const count = (hay, needle) => hay.split(needle).length - 1;

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; say("  ok   " + name + (process.env.PREVIEW && detail ? "\n" + detail + "\n" : "")); }
  else { failed++; say("  FAIL " + name + (detail ? "\n" + detail : "")); }
}

let interrupted = 0;
const bar = new TurnBar({
  status: () => ({ left: "moonshotai/kimi-k3  thinking: high", hint: "esc to interrupt", context: "context: 3% (23k/1M)" }),
  onInterrupt: () => interrupted++,
});

screen.reset();
bar.start();
await sleep(30);
{
  const t = strip(screen.text());
  check("the frame is on screen while the turn runs", /╭─+╮/.test(t) && /│ ❯/.test(t), t);
  check("the spinner line is above the frame", t.indexOf("thinking") < t.indexOf("╭"), t);
  check("the status rows are below the frame", t.lastIndexOf("context:") > t.lastIndexOf("╯"), t);
}

// Transcript output must scroll above the bar, not through it.
line("   ⏺ read(src/index.ts)");
line("   ⏺ grep(TurnBar)");
await sleep(20);
{
  const t = strip(screen.text());
  check("output lands above the bar", t.indexOf("read(src/index.ts)") < t.indexOf("╭"), t);
  check("only one frame is on screen", count(t, "╭") === 1, t);
  check("earlier output is not overwritten", /read\(src\/index\.ts\)/.test(t) && /grep\(TurnBar\)/.test(t), t);
}

// Typing goes into the frame.
for (const ch of "and what about tests") await key(ch);
{
  const t = strip(screen.text());
  check("typed text shows in the frame", /│ ❯ and what about tests/.test(t), t);
  check("typing does not duplicate the frame", count(t, "╭") === 1, t);
}

await key("\x7f"); // backspace
check("backspace works", /│ ❯ and what about test\s+│/.test(strip(screen.text())), strip(screen.text()));

await key("\r"); // queue it
{
  const t = strip(screen.text());
  check("a queued message is listed", /queued: and what about test/.test(t), t);
  check("the frame is empty again", /│ ❯\s+│/.test(t), t);
}

await key(ESC);
// A lone Esc is held for a few milliseconds first: it may be the head of a
// cursor-key sequence the terminal split across two reads.
await new Promise((r) => setTimeout(r, 80));
check("esc interrupts the turn", interrupted === 1, String(interrupted));

for (const ch of "half typed") await key(ch);
const { queued, draft } = bar.stop();
check("stop hands back the queue", queued.length === 1 && queued[0] === "and what about test", JSON.stringify(queued));
check("stop hands back the unsent draft", draft === "half typed", draft);

line("   after the turn");
{
  const t = strip(screen.text());
  check("the bar is gone once the turn ends", !/╭─+╮/.test(t), t);
  check("output continues normally", /after the turn/.test(t), t);
}

// A permission prompt asks the bar to step aside, then puts it back.
{
  const second = new TurnBar({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 1%" }),
    onInterrupt: () => {},
  });
  screen.reset();
  second.start();
  await sleep(20);
  second.pause();
  line("   Allow write to src/index.ts?");
  {
    const t = strip(screen.text());
    check("pause takes the bar down", !/╭─+╮/.test(t), t);
    check("the prompt is not fighting the bar", /Allow write/.test(t), t);
  }
  second.resume();
  await sleep(20);
  {
    const t = strip(screen.text());
    check("resume brings it back once", count(t, "╭") === 1, t);
    check("the prompt stays above it", t.indexOf("Allow write") < t.indexOf("╭"), t);
  }
  second.stop();
  second.resume(); // must not resurrect a stopped bar
  await sleep(20);
  check("a stopped bar stays down", !/╭─+╮/.test(strip(screen.text())), strip(screen.text()));
}

// ── the caret stays out of the way for the whole turn ───────────────────────
// Every write erases and redraws the bar, which walks the cursor between the
// transcript and the bar. Visible, that reads as the caret flying around the
// screen while the model works.
{
  const { setFooter, Spinner, padded } = await import("../dist/ui/render.js");
  const HIDE = ESC + "[?25l";
  const SHOW = ESC + "[?25h";
  let raw = "";
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    raw += String(chunk);
    return true;
  };

  const spinner = new Spinner("thinking");
  setFooter(() => ["  bar"]);
  spinner.start();
  // What onText does on the first token of the answer: the spinner goes, the
  // bar stays, and the answer streams in under it.
  spinner.stop();
  padded("first line of the answer");
  padded("second line of the answer");
  const duringTurn = raw;
  setFooter(null);
  const afterTurn = raw;
  process.stdout.write = realWrite;

  const steps = [...afterTurn.matchAll(new RegExp("\\" + ESC + "\\[\\?25[lh]", "g"))].map((m) =>
    m[0] === HIDE ? "hide" : "show",
  );
  check("the caret is hidden while the bar is up", duringTurn.includes(HIDE), JSON.stringify(steps));
  check("stopping the spinner does not reveal it", !duringTurn.includes(SHOW), JSON.stringify(steps));
  check("removing the bar gives it back", afterTurn.endsWith(SHOW) || steps.at(-1) === "show", JSON.stringify(steps));
}

// ── a shrinking bar leaves nothing of the taller one behind ─────────────────
// Drawing over the old rows is what removes the flicker, so the case the old
// erase-everything-first code handled for free has to be checked: fewer rows
// than last time must clear what is left below them.
{
  const { setFooter, refreshFooter } = await import("../dist/ui/render.js");
  const shrink = new Screen(100);
  const outerWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { shrink.write(String(chunk)); return true; };

  let rows = ["  reasoning one", "  reasoning two", "  ⠋ thinking", "  ╰────╯"];
  setFooter(() => rows);
  rows = ["  ⠙ thinking", "  ╰────╯"];
  refreshFooter();
  const left = shrink.lines().map(strip).filter((l) => l.trim());

  process.stdout.write = outerWrite;
  check("the dropped rows are gone", !left.some((l) => /reasoning/.test(l)), JSON.stringify(left));
  check("what remains is the shorter bar", left.length === 2 && /thinking/.test(left[0]), JSON.stringify(left));
  setFooter(null);
}

// ── a frame reaches the terminal whole ──────────────────────────────────────
// Flicker is a frame the terminal caught half-drawn: the bar erased, its
// replacement not yet written. So each frame must be one write, must not blank
// the bar on the way, and must not be drawn at all when nothing changed.
{
  const { setFooter, refreshFooter } = await import("../dist/ui/render.js");
  const writes = [];
  const outerWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };

  let tickNo = 0;
  setFooter(() => [`  ⠋ thinking ${tickNo}`, "  ╭────╮", "  ╰────╯"]);

  writes.length = 0;
  tickNo++;
  refreshFooter();
  const tick = writes.join("");
  check("a spinner tick is a single write", writes.length === 1, JSON.stringify(writes));
  check("the tick never blanks the bar first", !tick.includes(ESC + "[0J"), JSON.stringify(tick));
  check(
    "the tick is wrapped in synchronized output",
    tick.startsWith(ESC + "[?2026h") && tick.endsWith(ESC + "[?2026l"),
    JSON.stringify(tick),
  );

  writes.length = 0;
  refreshFooter();
  check("an unchanged frame is not redrawn at all", writes.length === 0, JSON.stringify(writes));

  writes.length = 0;
  tickNo++;
  line("   ⏺ a line of transcript");
  check("a transcript line and the redrawn bar go out together", writes.length === 1, JSON.stringify(writes));

  setFooter(null);
  process.stdout.write = outerWrite;
}

// ── the bar answers ctrl+o and steers like the idle editor ──────────────────
{
  const paste = await import("../dist/ui/paste.js");
  const CTRL_O = String.fromCharCode(15);
  const LF = String.fromCharCode(10);
  const withHistory = new TurnBar({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 2%" }),
    onInterrupt: () => {},
    history: ["ранее отправленное сообщение"],
  });
  screen.reset();
  withHistory.start();
  await sleep(20);

  // A shortened block, as the transcript leaves one behind.
  const outerWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  paste.rememberCollapsed("длинный блок целиком\n" + "ещё строка\n".repeat(12));
  process.stdout.write = outerWrite;
  await key(CTRL_O);
  {
    const t = strip(screen.text());
    check("ctrl+o prints the shortened block mid-turn", t.includes("длинный блок целиком"), t.slice(-400));
    check("the frame survives the expansion", count(t, "╭") === 1, t);
    check("the block landed above the frame", t.indexOf("длинный блок целиком") < t.indexOf("╭"), t);
  }

  // Caret steering inside a wrapped, multi-line draft.
  for (const ch of "первая") await key(ch);
  await key(LF); // Ctrl+Enter — newline, not submit
  for (const ch of "вторая") await key(ch);
  await key(ESC + "[D"); // left
  await key(ESC + "[D");
  await key("X");
  {
    const t = strip(screen.text());
    check("left moves the caret before inserting", /│   вторXая\s+│/.test(t), t);
  }
  withHistory.stop();

  // ↑ recalls a submitted line while the model is still working.
  const third = new TurnBar({
    status: () => ({ left: "model", hint: "", context: "" }),
    onInterrupt: () => {},
    history: ["что было раньше"],
  });
  screen.reset();
  third.start();
  await sleep(20);
  await key("черновик");
  await key(ESC + "[A"); // up — out of the draft into the history
  {
    const t = strip(screen.text());
    check("up recalls history mid-turn", /│ ❯ что было раньше\s+│/.test(t), t);
  }
  await key(ESC + "[B"); // down — back to newest, i.e. the held draft
  {
    const t = strip(screen.text());
    check("down returns to the draft", /│ ❯ черновик\s+│/.test(t), t);
  }
  await key(ESC + "[A"); // up again…
  await key("!"); // …and an edit lands in the recalled line
  {
    const t = strip(screen.text());
    check("an edit lands in the recalled line", /│ ❯ что было раньше!\s+│/.test(t), t);
  }
  third.stop();
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
