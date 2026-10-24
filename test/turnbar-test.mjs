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
// The bar's input row: the band that replaced the old box, marked by the same
// arrow a sent message is echoed with.
const inputRows = (hay) => count(hay, "›");
const inputAt = (hay) => hay.lastIndexOf("›");

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
  check("the input line is on screen while the turn runs", inputRows(t) === 1, t);
  check("the spinner line is above the input", t.indexOf("thinking") < inputAt(t), t);
  check("the status rows are below the input", t.lastIndexOf("context:") > inputAt(t), t);
}

// Transcript output must scroll above the bar, not through it.
line("   ⏺ read(src/index.ts)");
line("   ⏺ grep(TurnBar)");
await sleep(20);
{
  const t = strip(screen.text());
  check("output lands above the bar", t.indexOf("read(src/index.ts)") < inputAt(t), t);
  check("only one input row is on screen", inputRows(t) === 1, t);
  check("earlier output is not overwritten", /read\(src\/index\.ts\)/.test(t) && /grep\(TurnBar\)/.test(t), t);
}

// Typing goes into the frame.
for (const ch of "and what about tests") await key(ch);
{
  const t = strip(screen.text());
  check("typed text shows in the band", /› and what about tests/.test(t), t);
  check("typing does not duplicate the band", inputRows(t) === 1, t);
}

await key("\x7f"); // backspace
check("backspace works", /› and what about test$/m.test(strip(screen.text())), strip(screen.text()));

await key("\r"); // queue it
{
  const t = strip(screen.text());
  check("a queued message is listed", /queued: and what about test/.test(t), t);
  check("the input band is empty again", /›$/m.test(t), t);
  // The queued row makes the bar one taller, and the row it takes must not be
  // the last line of the transcript.
  check("queueing does not eat the line above the bar", /grep\(TurnBar\)/.test(t), t);
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
  check("the bar is gone once the turn ends", !/›/.test(t), t);
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
    check("pause takes the bar down", !/›/.test(t), t);
    check("the prompt is not fighting the bar", /Allow write/.test(t), t);
  }
  second.resume();
  await sleep(20);
  {
    const t = strip(screen.text());
    check("resume brings it back once", inputRows(t) === 1, t);
    check("the prompt stays above it", t.indexOf("Allow write") < inputAt(t), t);
  }
  second.stop();
  second.resume(); // must not resurrect a stopped bar
  await sleep(20);
  check("a stopped bar stays down", !/›/.test(strip(screen.text())), strip(screen.text()));
}

// Enter steers the running turn; Tab is the other half of it and holds the
// line for after the turn. The steered rows stay in the bar until the turn
// picks them up — an input box that just empties reads as the line vanishing.
{
  const steered = [];
  const steers = new TurnBar({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 1%" }),
    onInterrupt: () => {},
    onSteer: (text) => steered.push(text),
  });
  screen.reset();
  steers.start();
  await sleep(20);
  for (const ch of "not that file") await key(ch);
  await key("\r");
  {
    const t = strip(screen.text());
    check("Enter hands the line to the running turn", steered.length === 1 && steered[0] === "not that file", JSON.stringify(steered));
    check("and shows it as steering, not as queued", /steering: not that file/.test(t) && !/queued: not that file/.test(t), t);
    check("the band is empty again", /›$/m.test(t), t);
  }
  // The turn takes it at its next step, and its row goes with it.
  steers.markSteered();
  await sleep(20);
  check("a delivered line leaves the bar", !/steering: not that file/.test(strip(screen.text())), strip(screen.text()));

  for (const ch of "after this") await key(ch);
  await key("\t");
  {
    const t = strip(screen.text());
    check("Tab queues instead of steering", steered.length === 1 && /queued: after this/.test(t), t);
  }
  for (const ch of "one more") await key(ch);
  await key("\r");
  const { queued } = steers.stop();
  check(
    "stop hands back both kinds in the order typed",
    JSON.stringify(queued) === JSON.stringify(["after this", "one more"]),
    JSON.stringify(queued),
  );
}

// The command dropdown is the same list under the band as under the idle
// composer: a `/model` reached for while the model is working is that command,
// not a line to be retyped afterwards.
{
  const { commandSuggestions } = await import("../dist/ui/commands.js");
  const bar = new TurnBar({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 1%" }),
    onInterrupt: () => {},
    onSteer: () => {},
    suggest: (buffer) => commandSuggestions(buffer),
    suggestRows: 4,
  });
  screen.reset();
  bar.start();
  await sleep(20);
  await key("/");
  {
    const t = strip(screen.text());
    check("a slash opens the command list mid-turn", /\(\d+\/\d+\)/.test(t) && /→ \/model/.test(t), t);
    check("the list sits above the band, not under it", t.indexOf("(1/") < t.indexOf("› /"), t);
  }
  for (const ch of "upd") await key(ch);
  {
    const t = strip(screen.text());
    check("typing narrows it to the matching command", /→ \/update/.test(t), t);
    check("and the rest are gone", !/\/model/.test(t), t);
  }
  await key("\r");
  {
    const t = strip(screen.text());
    check("enter puts the command in the line", /› \/update/.test(t), t);
    check("the list closes with it", !/\(\d+\/\d+\)/.test(t), t);
  }
  const { queued } = bar.stop();
  check("picking a command sends nothing", queued.length === 0, JSON.stringify(queued));

  // Arrows walk the list; enter takes the row they are on.
  const arrows = new TurnBar({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 1%" }),
    onInterrupt: () => {},
    onSteer: () => {},
    suggest: (buffer) => (buffer.startsWith("/") ? [{ value: "/one", hint: "first" }, { value: "/two", hint: "second" }] : []),
    suggestRows: 2,
  });
  screen.reset();
  arrows.start();
  await sleep(20);
  await key("/");
  await key(ESC + "[B");
  {
    const t = strip(screen.text());
    check("down moves the highlight", /→ \/two/.test(t) && !/→ \/one/.test(t), t);
  }
  await key("\r");
  check("enter takes the highlighted row", /› \/two/.test(strip(screen.text())), strip(screen.text()));
  arrows.stop();

  // Esc with the list open puts the list away and nothing else: it used to
  // cancel the whole turn, and the list stayed painted where the bar had been.
  let stops = 0;
  const esc = new TurnBar({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 1%" }),
    onInterrupt: () => stops++,
    onSteer: () => {},
    suggest: (buffer) => (buffer.startsWith("/") ? [{ value: "/one", hint: "first" }, { value: "/two", hint: "second" }] : []),
    suggestRows: 2,
  });
  screen.reset();
  esc.start();
  await sleep(20);
  await key("/");
  check("the list advertises esc as closing it", /esc to close the list/.test(strip(screen.text())), strip(screen.text()));
  await key(ESC);
  await sleep(80); // past the hold that tells a bare Esc from a cursor key
  {
    const t = strip(screen.text());
    check("esc with the list open does not stop the turn", stops === 0, String(stops));
    check("it closes the list", !/\(\d+\/\d+\)/.test(t), t);
    check("and keeps the draft", /› \//.test(t), t);
  }
  await key(ESC);
  await sleep(80);
  check("a second esc, with no list, stops the turn", stops === 1, String(stops));
  esc.stop();

  // Ctrl+C is never a menu key.
  stops = 0;
  esc.start();
  await sleep(20);
  await key("/x");
  await key("\x03");
  check("ctrl+c with the list open still stops the turn", stops === 1, String(stops));
  esc.stop();
  // Two Ctrl+C within 1.5s are the stdin safety net's hard exit; the next
  // block presses it again.
  await sleep(1600);
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

// A bar that grows — the reasoning preview arriving, a queued line appearing —
// needs rows it does not have. Taking them from the transcript above painted
// the bar over what was already written there: the echo of the message that
// started the turn is the last thing printed before the preview shows up, and
// it disappeared. The extra rows are opened underneath instead, so the bar
// keeps its place at the bottom and the transcript scrolls away intact.
{
  const { setFooter, refreshFooter } = await import("../dist/ui/render.js");
  const grow = new Screen(100);
  const outerWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { grow.write(String(chunk)); return true; };

  for (let i = 0; i < 8; i++) grow.write("transcript " + i + "\n");
  grow.write("   ✦ последнее сообщение пользователя\n");
  let rows = ["  ⠋ thinking", "  ╭────╮", "  │ ❯  │", "  ╰────╯"];
  setFooter(() => rows);
  rows = ["  reasoning one", "  reasoning two", "  ⠙ thinking", "  ╭────╮", "  │ ❯  │", "  ╰────╯"];
  refreshFooter();

  process.stdout.write = outerWrite;
  const shown = grow.lines().map(strip);
  const t = shown.join("\n");
  check("the echoed message survives the bar growing over it", /✦ последнее сообщение/.test(t), t);
  check("no transcript line is painted over", shown.filter((l) => /^transcript /.test(l)).length === 8, t);
  check("the bar still ends at the bottom of the screen", shown.slice(-6).join("\n") === rows.join("\n"), t);
  check("the input row is still on screen after reasoning arrives", /╭────╮/.test(t) && /│ ❯/.test(t), t);
  setFooter(null);
}

// A 10-line reasoning preview plus the frame must not exceed the terminal.
{
  const origRows = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: 16, configurable: true });
  const tight = new TurnBar({
    status: () => ({ left: "model", hint: "esc", context: "ctx" }),
    onInterrupt: () => {},
  });
  screen.reset();
  tight.start();
  tight.setThinking(Array.from({ length: 12 }, (_, i) => `reason line ${i}`));
  await sleep(20);
  const shown = strip(screen.text());
  const frameAt = shown.lastIndexOf("›");
  check("a long reasoning preview still shows the input", frameAt !== -1, shown);
  check(
    "the preview is clipped so the frame fits",
    (shown.match(/reason line/g) || []).length < 12 && /reason line 11/.test(shown),
    shown,
  );
  tight.stop();
  Object.defineProperty(process.stdout, "rows", { value: origRows, configurable: true });
}

// The helper list: one row per running subagent, above the spinner. It is its
// own block, so the reasoning preview closing does not take it away.
{
  const { subagentRow } = await import("../dist/ui/render.js");
  const { hasColor } = await import("../dist/ui/ansi.js");
  const busy = new TurnBar({
    status: () => ({ left: "model", hint: "esc", context: "ctx" }),
    onInterrupt: () => {},
  });
  screen.reset();
  busy.start();
  const first = subagentRow({ id: 1, label: "a", model: "deepseek-v4.1-flash", steps: 7, maxSteps: 10, tokens: 25000 });
  busy.setActivity([
    first,
    subagentRow({ id: 2, label: "b", model: "glm-5.3-flash", steps: 1, maxSteps: 40, tokens: 3200, line: "read src/a.ts" }),
  ]);
  busy.setThinking(["первая мысль"]);
  await sleep(20);
  {
    const t = strip(screen.text());
    check("each running helper gets a row", /1\. deepseek-v4\.1-flash 70% · 25k tok/.test(t), t);
    check("the second row carries its own numbers", /2\. glm-5\.3-flash 3% · 3\.2k tok · read src\/a\.ts/.test(t), t);
    check("the list sits above the input", t.indexOf("1. deepseek") < t.lastIndexOf("›"), t);
    check("and above the reasoning preview", t.indexOf("1. deepseek") < t.indexOf("первая мысль"), t);
    if (hasColor) {
      // Same palette as the turn's stats line: model orange, numbers gray.
      check(
        "the model is orange and the counts gray",
        /\x1b\[93mdeepseek-v4\.1-flash\x1b\[39m/.test(first) && /\x1b\[90m70% · 25k tok\x1b\[39m/.test(first),
        JSON.stringify(first),
      );
    }
  }
  busy.endReasoning();
  await sleep(20);
  {
    const t = strip(screen.text());
    check("the answer starting does not clear the list", /1\. deepseek-v4\.1-flash/.test(t), t);
    check("but the preview goes", !/первая мысль/.test(t), t);
  }
  busy.setActivity([]);
  await sleep(20);
  check("the last helper takes its rows with it", !/deepseek-v4\.1-flash/.test(strip(screen.text())), strip(screen.text()));
  busy.stop();
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
    check("the input band survives the expansion", inputRows(t) === 1, t);
    check("the block landed above the input", t.indexOf("длинный блок целиком") < inputAt(t), t);
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
    check("left moves the caret before inserting", /^ {5}вторXая$/m.test(t), t);
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
    check("up recalls history mid-turn", /› что было раньше$/m.test(t), t);
  }
  await key(ESC + "[B"); // down — back to newest, i.e. the held draft
  {
    const t = strip(screen.text());
    check("down returns to the draft", /› черновик$/m.test(t), t);
  }
  await key(ESC + "[A"); // up again…
  await key("!"); // …and an edit lands in the recalled line
  {
    const t = strip(screen.text());
    check("an edit lands in the recalled line", /› что было раньше!$/m.test(t), t);
  }
  third.stop();
}

// ── escWatch: Esc outside a turn ──────────────────────────────────────────
// The login wait printed "esc to interrupt" with nobody reading the keyboard:
// pressing it did nothing at all, and the spinner kept going. The watcher is
// what makes that hint true outside a turn.
{
  const { escWatch } = await import("../dist/ui/turnbar.js");

  let fired = 0;
  const release = escWatch(() => fired++);
  await key(ESC);
  await sleep(60); // the watcher holds a lone Esc for 40ms before deciding
  check("esc fires the watcher with no turn bar", fired === 1, String(fired));

  await key(ESC + "[A"); // a cursor key is not a cancel
  await sleep(60);
  check("arrow keys do not fire it", fired === 1, String(fired));

  await key(String.fromCharCode(3)); // Ctrl+C
  await sleep(60);
  check("ctrl+c fires it too", fired === 2, String(fired));

  release();
  await key(ESC);
  await sleep(60);
  check("after release esc is inert again", fired === 2, String(fired));
}

// ── the spinner only advertises esc where somebody listens ────────────────
{
  const { Spinner } = await import("../dist/ui/render.js");
  const read = async (spinner) => {
    screen.reset();
    spinner.start();
    await sleep(160);
    // Read before stop(): the spinner clears its own line on the way out.
    const shown = strip(screen.text());
    spinner.stop();
    return shown;
  };
  check("a bare spinner promises no key", !(await read(new Spinner("жду"))).includes("esc to interrupt"), "");
  check("a cancellable one does", (await read(new Spinner("жду", { escape: true }))).includes("esc to interrupt"), "");
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
