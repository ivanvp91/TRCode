/** The welcome animation must never move the caret or overwrite the composer. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

delete process.env.NO_COLOR;
delete process.env.TRCODE_NO_SPLASH;
process.env.TERM = "xterm-256color";
const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
for (const [key, value] of Object.entries({ isTTY: true, columns: 120, rows: 50 })) {
  Object.defineProperty(process.stdout, key, { value, configurable: true });
}

const { logoFrame, animateLogo, LOGO_PERIOD } = await import("../dist/ui/logo.js");
const { banner, logoIntro, setStartRow, setFooter, userEcho, line } = await import("../dist/ui/render.js");
const { App } = await import("../dist/ui/repl.js");
const { InputEditor } = await import("../dist/ui/editor.js");
const { composeStatus } = await import("../dist/ui/inputbox.js");
const { stripAnsi, width } = await import("../dist/ui/ansi.js");
const { releaseStdin } = await import("../dist/ui/stdin.js");

for (const [cols, rows] of [[74, 13], [96, 20], [120, 22]]) {
  const frames = new Set();
  const silhouette = logoFrame(cols, rows).map(stripAnsi);
  for (let time = 0; time < 12; time += 0.4) {
    const frame = logoFrame(cols, rows, time);
    assert.equal(frame.length, rows);
    assert(frame.every(line => width(line) === cols));
    assert(frame.every(line => !/NaN|Infinity|undefined/.test(line)));
    const colours = frame.join("").match(/\x1b\[38;2;\d+;\d+;\d+m/g);
    assert(colours && new Set(colours).size === 1, "the entire logo uses one colour");
    const channels = colours[0].slice(7, -1).split(";");
    assert(channels.every(channel => channel === channels[0]), "the colour is neutral grey");
    assert(!/\x1b\[48;/.test(frame.join("")), "the dots preserve the terminal background");
    const plain = frame.map(stripAnsi);
    assert(plain.every(line => line[0] === " " && line.at(-1) === " "), "geometry fits fixed bounds");
    assert(plain[0].trim() === "" && plain.at(-1).trim() === "", "vertical bounds leave clearance");
    assert.deepEqual(plain, silhouette, "the original lettering never jumps between cells");
    frames.add(frame.join("\n"));
  }
  assert(frames.size > 10, "lighting keeps moving over stable geometry");
  for (const time of [0, 1.25, 2.5, 9.75]) {
    assert.deepEqual(logoFrame(cols, rows, time), logoFrame(cols, rows, time + LOGO_PERIOD), "the lighting cycle loops seamlessly");
  }
}

// Compare the actual per-cell RGB values, including the cycle boundary. A low
// frame rate or an abrupt light reset used to look like a flash or a stutter.
function colours(frame) {
  return frame.flatMap(line => {
    const cells = [];
    let fg = [0, 0, 0], bg = [0, 0, 0];
    for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]/g)) {
      if (token.startsWith("\x1b")) {
        const codes = token.slice(2, -1).split(";").map(Number);
        for (let i = 0; i < codes.length; i++) {
          if ((codes[i] === 38 || codes[i] === 48) && codes[i + 1] === 2) {
            if (codes[i] === 38) fg = codes.slice(i + 2, i + 5); else bg = codes.slice(i + 2, i + 5);
            i += 4;
          } else if (codes[i] === 39) fg = [0, 0, 0]; else if (codes[i] === 49) bg = [0, 0, 0];
        }
      } else if (token === "▀") cells.push(...fg, ...bg);
      else if (token === "▄") cells.push(...bg, ...fg);
      else cells.push(...fg, ...fg);
    }
    return cells;
  });
}
for (let tick = 0; tick <= LOGO_PERIOD * 30; tick++) {
  const current = colours(logoFrame(96, 13, tick / 30));
  const next = colours(logoFrame(96, 13, (tick + 1) / 30));
  assert(current.every((value, i) => Math.abs(next[i] - value) <= 4), "neighbouring frames change gently");
}

class Screen {
  grid = Array.from({ length: 50 }, () => Array(120).fill(" "));
  row = 0;
  col = 0;
  saved = [0, 0];
  scrolls = 0;
  write(text) {
    for (let i = 0; i < text.length;) {
      if (text[i] === "\x1b") {
        if (text[i + 1] === "7") { this.saved = [this.row, this.col]; i += 2; continue; }
        if (text[i + 1] === "8") { [this.row, this.col] = this.saved; i += 2; continue; }
        const match = /^\x1b\[([?\d;]*)([A-Za-z~])/.exec(text.slice(i));
        assert(match, `unknown escape ${JSON.stringify(text.slice(i, i + 20))}`);
        const [n = 1, col = 1] = match[1].split(";").map(Number);
        switch (match[2]) {
          case "A": this.row = Math.max(0, this.row - n); break;
          case "B": this.row = Math.min(49, this.row + n); break;
          case "G": this.col = Math.max(0, n - 1); break;
          case "H": this.row = n - 1; this.col = col - 1; break;
          case "J":
            if (n === 2) { this.grid.forEach(row => row.fill(" ")); break; }
            for (let y = this.row + 1; y < 50; y++) this.grid[y].fill(" ");
            this.grid[this.row].fill(" ", this.col);
            break;
          case "K": this.grid[this.row].fill(" ", this.col); break;
          case "n":
            queueMicrotask(() => stdin.emit("data", Buffer.from(`\x1b[${this.row + 1};${this.col + 1}R`)));
            break;
        }
        i += match[0].length;
        continue;
      }
      const ch = text[i++];
      if (ch === "\r") this.col = 0;
      else if (ch === "\n") {
        this.col = 0;
        if (++this.row >= 50) {
          this.scrolls++;
          this.grid.shift(); this.grid.push(Array(120).fill(" "));
          this.row = 49;
        }
      } else this.grid[this.row][this.col++] = ch;
    }
  }
  lines() { return this.grid.map(line => line.join("")); }
}

const screen = new Screen();
const realWrite = process.stdout.write.bind(process.stdout);
const chunks = [];
process.stdout.write = chunk => { chunks.push(String(chunk)); screen.write(String(chunk)); return true; };
let logo;
try {
  banner({ provider: "Mock", model: "mock:m", effort: "high", cwdLabel: "~/project", sessionId: "hidden-session-id", version: "0.1.9" });
  const header = chunks.map(stripAnsi).join("");
  assert(!/Session:|Сессия:|hidden-session-id/.test(header), "the header omits session identifiers");
  assert(/Directory:|Каталог:/.test(header), "the other header fields remain");
  screen.row = 0; screen.col = 0; screen.grid.forEach(row => row.fill(" "));
  screen.write("WELCOME / provider / model\n" + "\n".repeat(10));
  logo = await logoIntro();
  assert(logo, "a roomy interactive terminal supports animation");
  setStartRow(screen.row + 1);
  const editor = new InputEditor({ history: [], status: () => composeStatus({ provider: "Mock", model: "mock:m", effort: "high", cwdLabel: "", contextUsed: 0, contextWindow: 1000, contextEstimated: false }) });
  const reading = editor.read();
  const before = screen.lines();
  const caret = [screen.row, screen.col];
  logo.start();
  await delay(200);
  const after = screen.lines();
  assert.equal(after[0], before[0], "header stays intact");
  assert.deepEqual(after.slice(-7), before.slice(-7), "composer and status stay intact");
  assert.deepEqual([screen.row, screen.col], caret, "caret survives every frame");
  assert.equal(screen.scrolls, 0, "animation never scrolls the terminal");
  assert.deepEqual(after, before, "the logo silhouette stays stable while the light moves");
  assert(chunks.some(chunk => chunk.includes("\x1b7")), "lighting frames are drawn while input is ready");
  const patches = chunks.filter(chunk => chunk.includes("\x1b7"));
  const fullFrameBytes = Buffer.byteLength(logoFrame(96, 12, 0.2).join("\n"));
  assert(patches.every(patch => Buffer.byteLength(patch) < fullFrameBytes * 0.8), "animation patches only changed cells");
  stdin.emit("data", Buffer.from("x"));
  const stoppedAt = chunks.length;
  await delay(180);
  assert.equal(chunks.length, stoppedAt, "first key stops all animation writes");
  stdin.emit("data", Buffer.from("\r"));
  assert.equal(await reading, "x", "the first key reaches the editor");

  // The startup view is temporary. Exercise the real REPL transition and a
  // live footer, because preserving its old pin would recreate the blank gap.
  const app = Object.create(App.prototype);
  let logoStopped = false;
  const welcomeBanner = () => banner({ provider: "Mock", model: "mock:m", effort: "high", cwdLabel: "~/project", sessionId: "hidden", version: "0.1.9" });
  Object.assign(app, {
    welcomeScreen: true,
    welcomeLogo: { stop: () => { logoStopped = true; } },
    promptPinned: true,
    showBanner: welcomeBanner,
  });
  app.dismissWelcome();
  assert(logoStopped, "dismissal stops animation before clearing");
  assert.equal(app.welcomeLogo, undefined);
  assert.equal(app.promptPinned, false, "the composer forgets the splash's geometry");
  assert(!screen.lines().some(row => /[\u2801-\u28ff]/.test(row)), "submission removes the logo");
  assert(screen.row < 12, "submission removes the splash padding");
  assert(screen.lines().some(row => row.includes("Directory:")), "the header remains visible");
  const headerEnd = screen.row;
  setFooter(() => ["working", "", "input", "", "status"]);
  userEcho("first submitted message");
  line("first assistant reply");
  setFooter(null);
  const messageRow = screen.lines().findIndex(row => row.includes("first submitted message"));
  assert(messageRow >= headerEnd && messageRow <= headerEnd + 3, "the first message starts directly under the header");
  const conversation = screen.lines();
  app.dismissWelcome();
  assert.deepEqual(screen.lines(), conversation, "later messages never clear the conversation");

  const resizeListeners = process.stdout.listenerCount("resize");
  const dataListeners = stdin.listenerCount("data");
  const resized = animateLogo(15, 12, 96, 16);
  resized.start();
  process.stdout.emit("resize");
  const resizedAt = chunks.length;
  await delay(100);
  assert.equal(chunks.length, resizedAt, "resize stops writes at stale coordinates");
  assert.equal(process.stdout.listenerCount("resize"), resizeListeners);
  assert.equal(stdin.listenerCount("data"), dataListeners);
  resized.stop();
  resized.start();
  await delay(100);
  assert.equal(chunks.length, resizedAt, "a stopped animation cannot restart");

  const bufferedWrite = process.stdout.write;
  let accepted = 0;
  process.stdout.write = chunk => { accepted++; return false; };
  const slow = animateLogo(15, 12, 96, 16);
  try {
    slow.start();
    await delay(220);
    assert.equal(accepted, 1, "a slow terminal never queues animation frames");
    process.stdout.emit("drain");
    await delay(300);
    assert.equal(accepted, 2, "animation resumes after the terminal drains");
  } finally {
    slow.stop();
    process.stdout.write = bufferedWrite;
  }
  assert.equal(process.stdout.listenerCount("drain"), 0, "stop cleans up blocked writes");

  process.env.TRCODE_NO_SPLASH = "1";
  assert.equal(await logoIntro(), undefined, "NO_SPLASH leaves a static logo");
  delete process.env.TRCODE_NO_SPLASH;
  assert.equal(await logoIntro({ animate: false }), undefined);
  Object.defineProperty(process.stdout, "columns", { value: 48, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
  const narrowAt = chunks.length;
  assert.equal(await logoIntro(), undefined);
  assert(chunks.slice(narrowAt).some(chunk => stripAnsi(chunk).includes("TRCode")), "small terminals retain the name");
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  const pipedAt = chunks.length;
  assert.equal(await logoIntro(), undefined);
  assert.equal(chunks.length, pipedAt, "redirected output has no splash or controls");
} finally {
  logo?.stop();
  releaseStdin();
  process.stdout.write = realWrite;
}
console.log("PASS monochrome dot artwork, smooth patches, backpressure, input safety and splash dismissal");
