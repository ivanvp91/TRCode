/**
 * Speed in the turn bar. Dividing the output of a turn by its wall clock was
 * wrong twice over: most of a turn is tool calls and waits, and the step's own
 * exact count replaced the running total, so the figure fell with every new
 * step. These cases pin the meter to generation time.
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

const { OutputRate } = await import("../dist/ui/rate.js");
const { TurnBar } = await import("../dist/ui/turnbar.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; say("  ok   " + name); }
  else { failed++; say("  FAIL " + name + (detail ? "\n" + detail : "")); }
}

// ── the meter counts generation, not the turn ──────────────────────────────
{
  let now = 1_000_000;
  const rate = new OutputRate(() => now);
  /** Deltas every 50 ms, so a burst spans the time it was streaming. */
  const stream = (tokens, ms) => {
    const steps = Math.round(ms / 50);
    for (let i = 0; i < steps; i++) {
      rate.note(tokens / steps);
      now += 50;
    }
  };

  check("nothing streamed, no speed", rate.perSecond() === null, String(rate.perSecond()));

  stream(500, 1000); // one second of streaming, 500 tokens
  const live = rate.perSecond();
  check("live speed is tokens over streamed seconds", Math.abs(live - 500) < 60, String(live));

  rate.close();
  const burst = rate.generationMs();
  check("a usage line ends the burst at the last delta", burst === 950, String(burst));

  now += 60_000; // a minute in a tool call
  check("a tool call is not generation", rate.generationMs() === burst, String(rate.generationMs()));
  check("and the speed stands still through it", Math.abs(rate.perSecond() - 526) < 60, String(rate.perSecond()));

  stream(500, 1000);
  rate.close();
  check("the next burst adds only its own time", rate.generationMs() === 1900, String(rate.generationMs()));
  const afterTool = rate.perSecond();
  check("1000 tokens over 1.9 s of streaming is ~526", Math.abs(afterTool - 526) < 60, String(afterTool));
  check("the waiting never reaches the rate", afterTool > 400, "a clock-based figure would be ~1");
}

// ── a mid-step stall ends the burst by itself ──────────────────────────────
{
  let now = 0;
  const rate = new OutputRate(() => now);
  rate.note(600);
  now += 200;
  rate.note(600);
  // The host goes quiet for five seconds inside the same step: no usage line
  // arrives, so nothing calls close().
  now += 5_000;
  rate.note(600);
  now += 200;
  rate.note(600);
  now += 200;
  const ms = rate.generationMs();
  check("a silent gap is not billed as generation", ms === 600, String(ms));
  check("the speed ignores it too", rate.perSecond() > 1000, String(rate.perSecond()));
}

// ── short streams get no number rather than a wild one ─────────────────────
{
  let now = 0;
  const rate = new OutputRate(() => now);
  rate.note(100);
  now += 100;
  check("under half a second there is nothing to divide", rate.perSecond() === null, String(rate.perSecond()));
  rate.close();
  rate.close();
  check("closing twice does not double the time", rate.generationMs() < 200, String(rate.generationMs()));
  check("zero-token notes are ignored", (() => {
    const idle = new OutputRate(() => 0);
    idle.note(0);
    return idle.perSecond() === null;
  })(), "");
}

// ── the bar shows it in the spinner line, not the turn's clock ─────────────
{
  const bar = new TurnBar({
    status: () => ({ left: "moonshotai/kimi-k3  thinking: high", hint: "esc to interrupt", context: "context: 3% (23k/1M)" }),
    onInterrupt: () => {},
  });

  // A step that streams for a moment and reports its usage, then a long tool
  // call, then a second step: the bar's own clock covers the whole turn.
  screen.reset();
  bar.start();
  const t0 = Date.now();
  bar.noteOutput(1200);
  await sleep(250);
  bar.noteOutput(1200);
  bar.endOutput();
  const firstStep = bar.generationMs();
  await sleep(900); // the tool call
  bar.noteOutput(1200);
  await sleep(250);
  bar.noteOutput(1200);
  const shown = strip(screen.text());
  const genMs = bar.generationMs();
  const wallMs = Date.now() - t0;
  bar.stop();

  const m = /([\d.]+)(k?) tok\/s/.exec(shown);
  const shownRate = m ? Number(m[1]) * (m[2] ? 1000 : 1) : 0;
  const clockRate = Math.round(4_800_000 / wallMs);
  check("the bar times generation, not the turn", genMs > 300 && genMs < wallMs - 700, `${genMs} ms of ${wallMs} ms`);
  check("a speed is printed", Boolean(m), shown);
  check(
    "and it is the generation figure, not the clock's",
    shownRate > clockRate * 1.6,
    `${m?.[0]}; the turn's clock would say ${clockRate} tok/s`,
  );
  check("a usage line ends the burst", firstStep > 150 && firstStep < 1200, String(firstStep));

  const closed = bar.generationMs();
  await sleep(300);
  check("a stopped bar stops counting", bar.generationMs() === closed, `${closed} -> ${bar.generationMs()}`);
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
