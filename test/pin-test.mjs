/**
 * The bottom block belongs on the last line of the screen.
 *
 * A terminal cannot hold a block at the bottom, so the block drops there once —
 * by the rows the banner left above it — and after that keeps its place by
 * scrolling. A taller window opens rows underneath, and the block follows them
 * down again. This suite models a real screen (absolute moves, scrolls, erases)
 * because a stream of text alone cannot show where a row ends up.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

process.env.TRCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-pin-"));
// The band is a background colour, so this suite has to run with colours on
// even when the developer's shell has NO_COLOR set.
delete process.env.NO_COLOR;
process.env.TERM = "xterm-256color";

const ESC = String.fromCharCode(27);
const COLS = 90;
const ROWS = 20;

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });

class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
    // The background each cell was painted with, so a band can be told from a
    // blank row — both are spaces.
    this.bgGrid = Array.from({ length: rows }, () => Array(cols).fill(""));
    this.bg = "";
    this.row = 0;
    this.col = 0;
  }
  blank() { return Array(this.cols).fill(" "); }
  blankBg() { return Array(this.cols).fill(""); }
  scroll() {
    this.grid.shift();
    this.grid.push(this.blank());
    this.bgGrid.shift();
    this.bgGrid.push(this.blankBg());
  }
  resized(rows) {
    while (this.grid.length < rows) { this.grid.push(this.blank()); this.bgGrid.push(this.blankBg()); }
    while (this.grid.length > rows) { this.grid.pop(); this.bgGrid.pop(); }
    this.rows = rows;
    this.row = Math.min(this.row, rows - 1);
  }
  /** True when the row carries a background colour — a band. */
  banded(y) { return this.bgGrid[y].some((b) => b); }
  write(text) {
    let i = 0;
    while (i < text.length) {
      if (text[i] === ESC && text[i + 1] === "[") {
        const priv = new RegExp("^" + ESC + "\\[\\?[0-9;]*[A-Za-z]").exec(text.slice(i));
        if (priv) { i += priv[0].length; continue; }
        const m = new RegExp("^" + ESC + "\\[([0-9;]*)([A-Za-z])").exec(text.slice(i));
        if (m) {
          const nums = m[1] === "" ? [] : m[1].split(";").map((n) => parseInt(n, 10));
          const n = nums[0] ?? 1;
          const cmd = m[2];
          if (cmd === "A") this.row = Math.max(0, this.row - n);
          else if (cmd === "B") this.row = Math.min(this.rows - 1, this.row + n);
          else if (cmd === "G") this.col = Math.max(0, n - 1);
          else if (cmd === "T") {
            for (let j = 0; j < Math.min(n, this.rows); j++) {
              this.grid.pop(); this.grid.unshift(this.blank());
              this.bgGrid.pop(); this.bgGrid.unshift(this.blankBg());
            }
          }
          else if (cmd === "H") {
            this.row = Math.min(this.rows - 1, Math.max(0, n - 1));
            this.col = Math.max(0, (nums[1] ?? 1) - 1);
          } else if (cmd === "J") {
            for (let x = this.col; x < this.cols; x++) { this.grid[this.row][x] = " "; this.bgGrid[this.row][x] = ""; }
            for (let y = this.row + 1; y < this.rows; y++) { this.grid[y] = this.blank(); this.bgGrid[y] = this.blankBg(); }
          } else if (cmd === "K") {
            for (let x = this.col; x < this.cols; x++) { this.grid[this.row][x] = " "; this.bgGrid[this.row][x] = ""; }
          } else if (cmd === "m") {
            if (m[1] === "49" || m[1] === "0") this.bg = "";
            else if (m[1].startsWith("48;")) this.bg = m[1];
          }
          i += m[0].length;
          continue;
        }
      }
      const ch = text[i];
      if (ch === "\n") {
        this.row++;
        if (this.row >= this.rows) {
          this.scroll();
          this.row = this.rows - 1;
        }
        this.col = 0;
      } else if (ch === "\r") {
        this.col = 0;
      } else {
        if (this.col < this.cols) {
          this.grid[this.row][this.col] = ch;
          this.bgGrid[this.row][this.col] = this.bg;
        }
        this.col++;
      }
      i++;
    }
  }
  lines() { return this.grid.map((r) => r.join("").replace(/\s+$/, "")); }
  nonEmpty() { return this.lines().filter((l) => l.trim()); }
}

const screen = new Screen(COLS, ROWS);
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { screen.write(String(chunk)); return true; };
const say = (s = "") => realWrite(s + "\n");

const render = await import("../dist/ui/render.js");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; say("  ok   " + name + (process.env.PREVIEW && detail ? "\n" + detail + "\n" : "")); }
  else { failed++; say("  FAIL " + name + (detail ? "\n" + detail : "")); }
}
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");

// ── a fresh session: the block drops to the bottom at once ─────────────────
{
  render.line("banner one");
  render.line("banner two");
  render.line("banner three");
  // The composer is glued to the last line from the first frame; the empty rows
  // above it are what the transcript grows into.
  render.setStartRow(4);
  render.setFooter(() => ["footer one", "footer two", "footer three"]);
  const lines = screen.lines();
  check("the block starts on the bottom edge", lines[ROWS - 1] === "footer three", lines.join("\n"));
  check("its first line is three rows up", lines[ROWS - 3] === "footer one", lines.join("\n"));
  check("the header stays at the top", lines[0] === "banner one", lines.join("\n"));
}
render.setFooter(null);

// ── a screen that is close to full: the block drops to the bottom ──────────
{
  for (let i = 0; i < 8; i++) render.line("transcript " + i);
  // The cursor now stands in the lower half of the screen. A three-row block
  // there would end above the bottom, so it is dropped to the last line.
  render.setStartRow(screen.row + 1);
  render.setFooter(() => ["footer one", "footer two", "footer three"]);
  const lines = screen.lines();
  check("the block ends on the last line of the screen", lines[ROWS - 1] === "footer three", lines.join("\n"));
  check("its first line is three rows up", lines[ROWS - 3] === "footer one", lines.join("\n"));
  const above = lines.slice(0, ROWS - 3);
  check("the transcript is what stands above the block", above.includes("transcript 0") && above.includes("transcript 7"), lines.join("\n"));
}

// ── a line of transcript arrives: the block keeps its place ─────────────────
{
  render.line("a line of transcript");
  const lines = screen.lines();
  check("the transcript sits above the block", lines[ROWS - 4] === "a line of transcript", lines.join("\n"));
  check("the block is still on the last line", lines[ROWS - 1] === "footer three", lines.join("\n"));
}

// ── the window grows: the block follows the new bottom edge ─────────────────
{
  Object.defineProperty(process.stdout, "rows", { value: 26, configurable: true });
  screen.resized(26);
  process.stdout.emit("resize");
  render.refreshFooter();
  const lines = screen.lines();
  check("the block comes down to the new last line", lines[25] === "footer three", lines.join("\n"));
  check("its first line is three rows up again", lines[23] === "footer one", lines.join("\n"));
  check("the transcript above is untouched", lines.indexOf("a line of transcript") === 16, lines.join("\n"));
}

// ── the window shrinks: it stays on the last line, no orphan rows ───────────
{
  Object.defineProperty(process.stdout, "rows", { value: 16, configurable: true });
  screen.resized(16);
  process.stdout.emit("resize");
  render.refreshFooter();
  const lines = screen.lines();
  check("the block is still the last three rows", lines[15] === "footer three" && lines[13] === "footer one", lines.join("\n"));
}
// ── text written above the block keeps it at the bottom ────────────────────
{
  const last = screen.rows - 1;
  render.setFooter(() => ["bar one", "bar two", "bar three"]);
  render.refreshFooter();
  check("the bar starts at the bottom", screen.lines()[last] === "bar three", screen.lines().join("\n"));

  render.line("a fresh transcript line");
  const lines = screen.lines();
  check("the bar is still at the bottom after a new line", lines[last] === "bar three", lines.join("\n"));
  check("the new line sits right above it", lines[last - 3] === "a fresh transcript line", lines.join("\n"));

  // A message the user sends is echoed above the bar the same way.
  render.userEcho("a question");
  const after = screen.lines();
  check("the echo does not push the bar up", after[last] === "bar three", after.join("\n"));
  check("the echo is on screen", after.some((l) => l.includes("a question")), after.join("\n"));
}

// ── the block shrinks: the bottom edge stays, the rows become air ──────────
{
  const last = screen.rows - 1;
  render.setFooter(() => ["one", "two", "three", "four", "five"]);
  render.refreshFooter();
  check("a taller block still ends on the last line", screen.lines()[last] === "five", screen.lines().join("\n"));
  // A taller block has to take its rows from somewhere, and at the bottom of the
  // screen that is the transcript, which scrolls up by the rows it gave away.
  // The top is captured here so the next check is about the shrink alone.
  const top = screen.lines()[0];

  render.setFooter(() => ["only one", "only two"]);
  render.refreshFooter();
  const lines = screen.lines();
  // A block that kept its top would lift its bottom off the last line and leave
  // the rows it gave up blank under the status. They are held above it instead,
  // where the next transcript line is written into them.
  check("a shorter block keeps its bottom", lines[last] === "only two" && lines[last - 1] === "only one", lines.join("\n"));
  check("the rows it gave up are wiped", !lines.join("\n").includes("three"), lines.join("\n"));
  check("a shorter block does not scroll the transcript", lines[0] === top, lines.join("\n"));

  render.line("a fresh line");
  const after = screen.lines();
  check("a new line eats the air above the block", after[last] === "only two" && after[last - 4] === "a fresh line", after.join("\n"));
}
render.setFooter(null);

// ── the composer is a bottom block too ──────────────────────────────────────
{
  const fresh = new Screen(COLS, ROWS);
  process.stdout.write = (chunk) => { fresh.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
  process.stdout.emit("resize");

  render.line("banner");
  for (let i = 0; i < 9; i++) render.line("a message " + i);
  render.setStartRow(fresh.row + 1);

  const { InputEditor } = await import("../dist/ui/editor.js");
  const ed = new InputEditor({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 3%" }),
    history: [],
  });
  const p = ed.read();
  await new Promise((r) => setTimeout(r, 40));
  const lines = fresh.lines();
  check("the composer sits on the last lines", /context: 3%/.test(lines[ROWS - 1]), lines.join("\n"));
  check("the status rows are under the input band", /esc to interrupt/.test(lines[ROWS - 2]), lines.join("\n"));
  check("a dark row sits between the band and the status", lines[ROWS - 3] === "" && !fresh.banded(ROWS - 3), lines.join("\n"));
  check("the input band is above them", lines[ROWS - 5].includes("›"), lines.join("\n"));
  // The band is a block, not a hairline: a row of its own colour above and
  // below the text, and one dark row between the band and what came before.
  check("the band has a row of its own under the text", fresh.banded(ROWS - 4), lines.join("\n"));
  check("the band has a row of its own over the text", fresh.banded(ROWS - 6), lines.join("\n"));
  check("a dark row separates the band from the transcript", !fresh.banded(ROWS - 7), lines.join("\n"));
  check("the transcript stays above the composer", lines[0] === "banner", lines.join("\n"));

  // The window grows under a live composer: it has to follow the new bottom.
  Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
  fresh.resized(24);
  process.stdout.emit("resize");
  await new Promise((r) => setTimeout(r, 60));
  const grown = fresh.lines();
  check("the composer follows a taller window down", /context: 3%/.test(grown[23]), grown.join("\n"));
  check("and the transcript is left where it was", grown[0] === "banner", grown.join("\n"));

  stdin.emit("data", Buffer.from("\r"));
  await p;
}

// ── the turn ends: the composer keeps the bottom edge ───────────────────────
{
  // A turn is closed by taking the bar down. That bar carried the spinner and
  // the reasoning preview, so it is taller than the idle composer; the turn's
  // stats are printed where it stood. A composer that simply started below them
  // lifts its status rows off the bottom and leaves the rows the bar gave up
  // blank under the status — the strip that shows up right after an answer.
  const after = new Screen(COLS, 30);
  process.stdout.write = (chunk) => { after.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
  process.stdout.emit("resize");

  render.line("banner");
  for (let i = 0; i < 17; i++) render.line("a message " + i);
  render.setStartRow(after.row + 1);
  render.setFooter(() => Array.from({ length: 12 }, (_, i) => "bar row " + i));
  check("the turn bar sits on the last lines", after.lines()[29] === "bar row 11", after.lines().join("\n"));

  render.setFooter(null);
  render.line();
  render.line("the turn's stats one");
  render.line("the turn's stats two");

  const { InputEditor } = await import("../dist/ui/editor.js");
  const ed = new InputEditor({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 3%" }),
    history: [],
  });
  const p = ed.read();
  await new Promise((r) => setTimeout(r, 40));
  const lines = after.lines();
  check("the composer still ends on the last line", /context: 3%/.test(lines[29]), lines.join("\n"));
  check("the status rows come with it", /esc to interrupt/.test(lines[28]), lines.join("\n"));
  check("the turn's stats stay above the composer", lines.join("\n").includes("stats two"), lines.join("\n"));
  // The transcript scrolls up by the rows the frame takes under the stats — a
  // block on the last line always costs that — but nothing between the last
  // message and the stats is lost.
  const lastMessage = lines.indexOf("a message 16");
  const stats = lines.findIndex((l) => l.includes("stats one"));
  check("and the transcript is still above them", lastMessage >= 0 && lastMessage === stats - 2, lines.join("\n"));
  // Between the stats and the text of the input: the frame's dark separator and
  // the band's own pad row, and nothing else. More than that is the strip of
  // empty rows that reads as a gap after an answer.
  const bandAt = lines.findIndex((l) => l.includes("›"));
  check("stats, then exactly the frame's two rows", bandAt === stats + 4, lines.join("\n"));

  stdin.emit("data", Buffer.from("\r"));
  await p;
}

// ── the turn ends: the bar gives way to the composer, bottom stays put ─────
{
  const fresh = new Screen(COLS, ROWS);
  process.stdout.write = (chunk) => { fresh.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
  process.stdout.emit("resize");

  render.line("the answer");
  for (let i = 0; i < 11; i++) render.line("more of the answer " + i);
  render.setStartRow(fresh.row + 1);

  // A bar of nine rows, as it stands during a turn.
  render.setFooter(() => ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]);
  check("the bar ends on the last line", fresh.lines()[fresh.rows - 1] === "nine", fresh.lines().join("\n"));

  // The turn is over: the bar goes away and the composer takes its place.
  render.setFooter(null);
  const { InputEditor } = await import("../dist/ui/editor.js");
  const ed = new InputEditor({
    status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 3%" }),
    history: [],
  });
  const p = ed.read();
  await new Promise((r) => setTimeout(r, 40));
  const lines = fresh.lines();
  const last = fresh.rows - 1;
  check("the composer takes the bar's place at the bottom", /context: 3%/.test(lines[last]), lines.join("\n"));
  check("no empty strip is left under the status", lines[last].trim() !== "", lines.join("\n"));

  stdin.emit("data", Buffer.from("\r"));
  await p;
}

// Stats are printed while the live bar is still installed, as in App.turn().
// Its extra rows must not become a permanent gap above the idle input.
for (const [height, probe] of [[9, false], [15, false], [9, true], [15, true]]) {
  const fresh = new Screen(COLS, 24);
  process.stdout.write = (chunk) => { fresh.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
  process.stdout.emit("resize");
  render.setStartRow(null);
  for (let i = 0; i < 18; i++) render.line("answer line " + i);
  render.setStartRow(fresh.row + 1);
  render.setFooter(() => Array.from({ length: height }, (_, i) => "live " + i));
  render.line();
  render.line("model stats");
  render.line("55 tok/s avg");
  render.setFooter(null);
  const transcript = fresh.nonEmpty();
  if (probe) render.setStartRow(fresh.row + 1, true);

  const { InputEditor } = await import("../dist/ui/editor.js");
  const ed = new InputEditor({
    status: () => ({ left: "model", hint: "keys", context: "context: 3%", session: "Current session" }),
    history: [],
  });
  ed.prefill("draft kept");
  const p = ed.read();
  const lines = fresh.lines();
  const stats = lines.indexOf("55 tok/s avg");
  const band = lines.findIndex((_, i) => fresh.banded(i));
  const label = `height ${height}, probe ${probe}`;
  check(`one separator above idle input (${label})`, stats >= 0 && band === stats + 2, lines.join("\n"));
  check(`context stays at the bottom (${label})`, lines[23].endsWith("context: 3%"), lines.join("\n"));
  check(`visible transcript is preserved (${label})`, transcript.every((l) => lines.includes(l)), lines.join("\n"));
  check(`session name precedes context (${label})`, /Current session +context: 3%/.test(lines[23]), lines.join("\n"));
  stdin.emit("data", Buffer.from("\r"));
  check(`draft survives the transition (${label})`, (await p) === "draft kept");
}

// ── while reasoning streams: the live bar keeps its breathing room ────────
{
  const fresh = new Screen(COLS, ROWS);
  process.stdout.write = (chunk) => { fresh.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
  process.stdout.emit("resize");

  for (let i = 0; i < 6; i++) render.line("answer " + i);
  render.setStartRow(fresh.row + 1);

  const { TurnBar } = await import("../dist/ui/turnbar.js");
  const bar = new TurnBar({
    status: () => ({ left: "model  thinking: high", hint: "esc to interrupt", context: "context: 3%" }),
  });
  bar.start();
  bar.setThinking(["first thought", "second thought"]);
  await new Promise((r) => setTimeout(r, 20));

  const lines = fresh.lines();
  const at = (needle) => lines.findIndex((l) => l.includes(needle));
  const spinner = at("esc to interrupt · type");
  const preview = at("second thought");
  check("the preview is on screen", preview !== -1, lines.join("\n"));
  check("a row separates the preview from the spinner", spinner === preview + 2 && lines[preview + 1] === "", lines.join("\n"));
  check("a row separates the spinner from the band", lines[spinner + 1] === "", lines.join("\n"));
  check("the band follows that row", fresh.banded(spinner + 2), lines.join("\n"));
  check("the status keeps a row of air above it", lines[spinner + 5] === "" && !fresh.banded(spinner + 5), lines.join("\n"));

  // Seven rows of reasoning, and no more: the rest of the bar has to stay on
  // screen, so the preview is the part that gives way.
  bar.setThinking(Array.from({ length: 10 }, (_, i) => "thought " + (i + 1)));
  await new Promise((r) => setTimeout(r, 20));
  const grown = fresh.lines();
  const shown = grown.filter((l) => /thought \d+/.test(l));
  check("the live preview keeps seven rows", shown.length === 7 && shown[6].includes("thought 10"), grown.join("\n"));
  check("and drops the oldest ones", !grown.join("\n").includes("thought 3"), grown.join("\n"));
  bar.stop();
}
// ── the command menu is an overlay: the composer never moves ──────────────
{
  const fresh = new Screen(COLS, ROWS);
  let raw = "";
  process.stdout.write = (chunk) => { raw += String(chunk); fresh.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
  process.stdout.emit("resize");
  render.setStartRow(1);

  for (let i = 0; i < 8; i++) render.line("transcript " + i);

  const { InputEditor } = await import("../dist/ui/editor.js");
  const { commandSuggestions } = await import("../dist/ui/commands.js");
  const ed = new InputEditor({
    status: () => ({ left: "model  thinking: high", hint: "/ - команды", context: "context: 3%" }),
    history: [],
    suggest: commandSuggestions,
    suggestRows: 5,
  });

  const p = ed.read();
  await new Promise((r) => setTimeout(r, 20));
  const idle = fresh.lines();
  const idleCol = fresh.col;
  stdin.emit("data", Buffer.from("/"));
  await new Promise((r) => setTimeout(r, 20));
  const withMenu = fresh.lines();
  const slashCol = fresh.col;
  const slashRow = fresh.row;
  const menuPaint = raw.slice(raw.lastIndexOf("╭"));
  // Narrowed to a single row, the list must keep the panel's width.
  stdin.emit("data", Buffer.from("yol"));
  await new Promise((r) => setTimeout(r, 20));
  const narrowed = fresh.lines();
  stdin.emit("data", Buffer.from("\x7f\x7f\x7f"));
  await new Promise((r) => setTimeout(r, 20));
  stdin.emit("data", Buffer.from(ESC));
  await new Promise((r) => setTimeout(r, 80));
  const afterEsc = fresh.lines();
  stdin.emit("data", Buffer.from("\r"));
  await p;

  const inputAt = (ls) => ls.findIndex((l) => /›/.test(l));
  const menuAt = (ls) => ls.findIndex((l) => /Enter to pick|Enter — выбрать/.test(l));
  check("the menu is drawn above the input", menuAt(withMenu) !== -1 && menuAt(withMenu) < inputAt(withMenu), withMenu.join("\n"));
  // Painting the overlay ends each row with a newline; the caret used to be
  // left in column 1, a block cursor in the margin left of the "›".
  check("the caret stays after the typed slash", slashRow === inputAt(withMenu) && slashCol === idleCol + 1, `row ${slashRow}, col ${slashCol} (idle col ${idleCol})`);
  const borderRight = (ls) => {
    const top = ls.find((l) => l.includes("╭"));
    return top ? top.lastIndexOf("╮") : -1;
  };
  check(
    "the panel keeps its width as the filter narrows",
    borderRight(withMenu) !== -1 && borderRight(withMenu) === borderRight(narrowed),
    `${borderRight(withMenu)} vs ${borderRight(narrowed)}\n${narrowed.join("\n")}`,
  );
  check("and its right edge meets the band's", borderRight(withMenu) === COLS - 2, String(borderRight(withMenu)));
  const borderLeft = withMenu.find((l) => l.includes("╭"))?.indexOf("╭");
  check("its left edge is the band's too, not the margin", borderLeft === 0, String(borderLeft));
  check("the composer does not move for it", inputAt(withMenu) === inputAt(idle), withMenu.join("\n"));
  check("the frame does not grow for it", afterEsc.filter((l) => /›|context:/.test(l)).length === 2, afterEsc.join("\n"));
  check("closing it takes the menu away", menuAt(afterEsc) === -1, afterEsc.join("\n"));
  const above = (ls) => JSON.stringify(ls.slice(0, inputAt(ls)));
  check("and puts back what it covered", above(afterEsc) === above(idle), afterEsc.join("\n") + "\n---\n" + idle.join("\n"));

  // The panel's background has to reach its own border: a row that ends with a
  // colour reset would otherwise lose the fill for the rest of the line.
  const { hasColor } = await import("../dist/ui/ansi.js");
  if (hasColor) {
    /** Which cells of a row were painted with the panel's background. */
    const filledCells = (line) => {
      let i = 0;
      let panel = false;
      const cells = [];
      while (i < line.length) {
        if (line[i] === ESC && line[i + 1] === "[") {
          const m = new RegExp("^" + ESC + "\\[([0-9;]*)([A-Za-z])").exec(line.slice(i));
          if (m) {
            if (m[2] === "m") {
              const code = m[1] || "0";
              if (code.startsWith("48;2;42;45;52")) panel = true;
              else if (code === "49" || code === "0") panel = false;
            }
            i += m[0].length;
            continue;
          }
        }
        cells.push(panel);
        i++;
      }
      return cells;
    };
    const body = menuPaint.split("\n").filter((l) => l.includes("│"));
    const filled = body.every((l) => {
      const cut = l.lastIndexOf("│");
      if (cut < 0) return false;
      const cells = filledCells(l);
      // The cell just inside the right border, and the border itself.
      return cells[cells.length - 2] === true;
    });
    check("the panel background reaches its border", body.length > 0 && filled, menuPaint.replace(/\x1b/g, "^["));
  }
}

// ── the answer starts: the preview's rows go back to the transcript ───────
{
  const live = new Screen(COLS, 30);
  process.stdout.write = (chunk) => { live.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
  process.stdout.emit("resize");

  render.line("banner");
  for (let i = 0; i < 14; i++) render.line("a message " + i);
  render.setStartRow(live.row + 1);

  const { TurnBar } = await import("../dist/ui/turnbar.js");
  const bar = new TurnBar({ status: () => ({ left: "model", hint: "esc to interrupt", context: "context: 3%" }) });
  bar.start();
  bar.setThinking(["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  await new Promise((r) => setTimeout(r, 30));
  const previewRows = live.lines().filter((l) => /^ *t[1-7]$/.test(l)).length;

  // The first text delta: the preview is over, and the rows it held go back
  // while the transcript is still writing into them.
  bar.endReasoning();
  await new Promise((r) => setTimeout(r, 30));
  const afterRows = live.lines().filter((l) => /^ *t[1-7]$/.test(l)).length;
  check("the preview is gone once the answer starts", previewRows > 0 && afterRows === 0, live.lines().join("\n"));
  check("and the bar still ends on the last line", /context: 3%/.test(live.lines()[29]), live.lines().join("\n"));
  bar.stop();
}

render.setFooter(null);

// ── the command list mid-turn borrows rows and hands them back ──────────────
// The list used to grow the bar: the transcript scrolled up to make room, and
// once the list closed the bar shrank and left those rows blank above itself —
// the reasoning and the spinner sank under a ten-row hole and the bar read as
// an idle prompt. And the composer's gap stayed at the tail of the row log for
// good, so anything restored from the log painted blanks over the answer.
{
  const fresh = new Screen(COLS, 30);
  process.stdout.write = (chunk) => { fresh.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
  process.stdout.emit("resize");
  render.setStartRow(1);

  const { InputEditor } = await import("../dist/ui/editor.js");
  const { TurnBar } = await import("../dist/ui/turnbar.js");
  const { commandSuggestions } = await import("../dist/ui/commands.js");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const status = () => ({ left: "model", hint: "h", context: "context: 1%" });

  // A fresh session: the composer drops to the bottom over a gap of blank rows.
  const ed = new InputEditor({ status, history: [], suggest: commandSuggestions, suggestRows: 6 });
  const p = ed.read();
  await sleep(20);
  stdin.emit("data", Buffer.from("hello"));
  stdin.emit("data", Buffer.from("\r"));
  await p;
  render.line("  » hello (echo)");

  let stops = 0;
  const bar = new TurnBar({ status, onInterrupt: () => stops++, onSteer: () => {}, suggest: commandSuggestions, suggestRows: 6 });
  bar.start();
  await sleep(20);
  render.line("  answer line A");
  render.line("  answer line B");
  await sleep(20);
  const spinnerAt = (ls) => ls.findIndex((l) => /thinking \(/.test(l));
  const before = fresh.lines();

  stdin.emit("data", Buffer.from("/"));
  await sleep(150);
  const open = fresh.lines();
  const bottom = open.findIndex((l) => l.includes("╰"));
  const gapUnder = bottom === -1 ? -1 : open.slice(bottom + 1).findIndex((_, i) => fresh.banded(bottom + 1 + i));
  check("one blank row between the list and the band, not two", gapUnder === 1, open.join("\n"));
  render.line("  answer line C");
  await sleep(20);
  stdin.emit("data", Buffer.from("\x7f"));
  await sleep(150);
  const closed = fresh.lines();
  bar.stop();

  check("the list covers the transcript, the bar keeps its height", open.findIndex((l) => /›/.test(l)) === before.findIndex((l) => /›/.test(l)), open.join("\n"));
  check("closing it leaves no hole: the spinner is back where it was", spinnerAt(closed) === spinnerAt(before), closed.join("\n"));
  const above = closed.slice(0, spinnerAt(closed)).filter((l) => l.trim());
  check(
    "and the rows it covered come back, with what streamed meanwhile",
    /hello \(echo\)/.test(above.join("\n")) && /answer line A/.test(above.join("\n")) && /answer line C/.test(above.at(-1) ?? ""),
    closed.join("\n"),
  );
  check("typing and deleting a slash never stops the turn", stops === 0, String(stops));
  process.stdout.write = (chunk) => { screen.write(String(chunk)); return true; };
}

// Changing the draft's height must move the transcript with the composer.
// Recalling the same long and short messages used to accumulate blank padding
// on every cycle until the frame itself was taller than the terminal.
for (const long of ["first\nsecond\nthird", "wrapped text ".repeat(24)]) {
  const fresh = new Screen(COLS, ROWS);
  process.stdout.write = (chunk) => { fresh.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
  process.stdout.emit("resize");
  render.setStartRow(null);
  for (let i = 0; i < 13; i++) render.line("transcript " + i);
  render.setStartRow(fresh.row + 1);
  const { InputEditor } = await import("../dist/ui/editor.js");
  const ed = new InputEditor({
    status: () => ({ left: "model", hint: "keys", context: "context: 3%" }),
    history: [long, "short"],
  });
  const reading = ed.read();
  const send = (s) => stdin.emit("data", Buffer.from(s));
  send(ESC + "[A");
  const baseline = fresh.lines();
  let stable = true;
  for (let i = 0; i < 12; i++) {
    send(ESC + "[A");
    const expanded = fresh.lines();
    const last = expanded.indexOf("transcript 12");
    const prompt = expanded.findIndex((l) => /›/.test(l));
    stable &&= last >= 0 && prompt === last + 3 && expanded.at(-1).endsWith("context: 3%");
    send(ESC + "[B");
    const compact = fresh.lines();
    stable &&= compact.indexOf("transcript 12") === baseline.indexOf("transcript 12")
      && compact.findIndex((l) => /›/.test(l)) === baseline.findIndex((l) => /›/.test(l))
      && compact.at(-1).endsWith("context: 3%");
  }
  check(`history height changes leave no growing gap (${long.includes("\n") ? "newlines" : "wrapping"})`, stable, fresh.lines().join("\n"));
  send("\r");
  check("history still submits the complete recalled message", (await reading) === "short");
  render.line("next turn");
  const lastTranscript = fresh.lines().indexOf("transcript 12");
  check("submitting after history leaves no gap in the transcript", lastTranscript >= 0 && fresh.lines().indexOf("next turn") === lastTranscript + 1, fresh.lines().join("\n"));

  render.setStartRow(fresh.row + 1);
  ed.prefill("draft");
  const editing = ed.read();
  const beforeEdit = fresh.lines();
  let editStable = true;
  for (let i = 0; i < 12; i++) {
    send("\n");
    send("\x7f");
    const afterEdit = fresh.lines();
    editStable &&= afterEdit.indexOf("next turn") === beforeEdit.indexOf("next turn")
      && afterEdit.findIndex((l) => /› draft/.test(l)) === beforeEdit.findIndex((l) => /› draft/.test(l))
      && afterEdit.at(-1).endsWith("context: 3%");
  }
  check("adding and deleting newlines keeps the composer next to the transcript", editStable, fresh.lines().join("\n"));
  send("\r");
  check("editing preserves the draft", (await editing) === "draft");
}

// ── a submitted line gives the hole back to the transcript ──────────────────
// The composer drops to the last line on a fresh session, which leaves a hole
// between the transcript and the input. Once the line is sent, that hole is the
// next paragraph's place: printing at the bottom instead put the echo and the
// whole answer under a wall of blank rows, and a panel opened there too.
{
  const fresh = new Screen(COLS, ROWS);
  process.stdout.write = (chunk) => { fresh.write(String(chunk)); return true; };
  Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
  process.stdout.emit("resize");
  render.setStartRow(null);
  render.line("banner");
  render.line("a previous line");
  render.setStartRow(fresh.row + 1);

  const { InputEditor } = await import("../dist/ui/editor.js");
  const status = () => ({ left: "model", hint: "keys", context: "context: 3%" });
  const ed = new InputEditor({ status, history: [] });
  const p = ed.read();
  await new Promise((r) => setTimeout(r, 20));
  check("a fresh composer drops to the last line", /context: 3%/.test(fresh.lines()[ROWS - 1]), fresh.lines().join("\n"));
  check("leaving a hole above it", fresh.lines().slice(2, 13).every((l) => l === ""), fresh.lines().join("\n"));

  stdin.emit("data", Buffer.from("hello"));
  stdin.emit("data", Buffer.from("\r"));
  await p;
  render.line("echo line one");
  render.line("answer line one");
  const lines = fresh.lines();
  check(
    "what is printed next starts at the transcript's end",
    lines[2] === "echo line one" && lines[3] === "answer line one",
    lines.join("\n"),
  );

  const again = ed.read();
  await new Promise((r) => setTimeout(r, 20));
  const back = fresh.lines();
  check("the next composer finds the bottom again", /context: 3%/.test(back[ROWS - 1]), back.join("\n"));
  check("and the echo stays where it landed", back[2] === "echo line one", back.join("\n"));
  stdin.emit("data", Buffer.from("\r"));
  await again;
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
