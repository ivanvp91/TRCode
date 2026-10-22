/** Monochrome dotted TR monogram with a quiet, uniform breathing animation. */
import { esc } from "./ansi.js";
import { MONOGRAM, COMPACT_MONOGRAM } from "./logo-art.js";

interface Cell { ch: string; fg: string; bg: string }
export const LOGO_WIDTH = MONOGRAM[0].length;
export const LOGO_HEIGHT = MONOGRAM.length + 3;
export const LOGO_MIN_WIDTH = COMPACT_MONOGRAM[0].length;
export const LOGO_MIN_HEIGHT = COMPACT_MONOGRAM.length + 2;
export const LOGO_PERIOD = 12;
const FRAME_MS = 1000 / 60;
const RESET = "\x1b[39;49m";
const EMPTY: Cell = { ch: " ", fg: "\x1b[39m", bg: "\x1b[49m" };

function logoCells(columns: number, rows: number, seconds: number): Cell[][] {
  const frame: Cell[][] = Array.from({ length: rows }, () => Array(columns).fill(EMPTY));
  const level = Math.round(136 + 8 * Math.sin(seconds / LOGO_PERIOD * Math.PI * 2));
  // A single foreground colour for the entire mark, with the terminal's own
  // background visible between the dots. Geometry never moves or flashes.
  const fg = "\x1b[38;2;" + level + ";" + level + ";" + level + "m";
  const place = (text: string, y: number) => {
    const left = Math.max(0, Math.floor((columns - text.length) / 2));
    for (let x = 0; x < text.length && left + x < columns; x++) {
      if (text[x] !== " ") frame[y][left + x] = { ch: text[x], fg, bg: EMPTY.bg };
    }
  };
  if (columns < LOGO_MIN_WIDTH || rows < LOGO_MIN_HEIGHT) {
    if (rows) place("TRCode".slice(0, columns), Math.floor(rows / 2));
    return frame;
  }
  const full = columns >= LOGO_WIDTH && rows >= LOGO_HEIGHT;
  const artwork = full ? MONOGRAM : COMPACT_MONOGRAM;
  const height = full ? LOGO_HEIGHT : LOGO_MIN_HEIGHT;
  const top = Math.floor((rows - height) / 2);
  for (let y = 0; y < artwork.length; y++) place(artwork[y], top + y);
  place("T R C O D E", top + height - 1);
  return frame;
}

function segment(cells: Cell[], start = 0, end = cells.length, state = { fg: "", bg: "" }, reset = true): string {
  let text = "";
  for (let x = start; x < end; x++) {
    const { ch, fg, bg } = cells[x];
    if (fg !== state.fg) text += fg;
    if (bg !== state.bg) text += bg;
    text += ch;
    state.fg = fg;
    state.bg = bg;
  }
  return text + (reset ? RESET : "");
}

export function logoFrame(columns: number, rows: number, seconds = 0): string[] {
  return logoCells(columns, rows, seconds).map(row => segment(row));
}

/** Update only changed cell spans, so terminal transport does not queue frames. */
function changes(before: Cell[][], after: Cell[][], top: number, left: number): string {
  let frame = "";
  const state = { fg: "", bg: "" };
  for (let y = 0; y < after.length; y++) {
    const dirty = (x: number) => before[y][x].ch !== after[y][x].ch || before[y][x].fg !== after[y][x].fg || before[y][x].bg !== after[y][x].bg;
    for (let x = 0; x < after[y].length;) {
      if (!dirty(x)) { x++; continue; }
      const start = x++;
      while (x < after[y].length && dirty(x)) x++;
      frame += "\x1b[" + (top + y) + ";" + (left + start + 1) + "H" + segment(after[y], start, x, state, false);
    }
  }
  return frame ? frame + RESET : "";
}

export interface LogoAnimation { start(): void; stop(): void }

export function animateLogo(top: number, left: number, columns: number, rows: number): LogoAnimation {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let waiting = false;
  let lastTick = 0;
  const terminalColumns = process.stdout.columns, terminalRows = process.stdout.rows;
  const onDrain = () => { waiting = false; lastTick = performance.now(); };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    process.stdin.removeListener("data", stop);
    process.stdout.removeListener("resize", stop);
    process.stdout.removeListener("drain", onDrain);
  };
  return {
    start() {
      if (stopped || timer) return;
      lastTick = performance.now();
      let seconds = 0;
      let deadline = lastTick + FRAME_MS;
      let previous = logoCells(columns, rows, seconds);
      process.stdin.once("data", stop);
      process.stdout.once("resize", stop);
      const tick = () => {
        if (stopped) return;
        if (process.stdout.columns !== terminalColumns || process.stdout.rows !== terminalRows) return stop();
        if (!waiting) {
          const now = performance.now();
          // A stalled event loop slows the light instead of teleporting it.
          seconds += Math.min(now - lastTick, FRAME_MS * 2) / 1000;
          lastTick = now;
          const next = logoCells(columns, rows, seconds);
          const frame = changes(previous, next, top, left);
          if (frame) {
            previous = next;
            // One atomic patch, no erasing, scrolling or caret changes.
            if (!process.stdout.write(esc.syncOn + "\x1b7" + frame + "\x1b8" + esc.syncOff)) {
              waiting = true;
              process.stdout.once("drain", onDrain);
            }
          }
        }
        // Absolute deadlines avoid cumulative timer drift. A missed deadline
        // is skipped rather than followed by a burst of overdue frames.
        const now = performance.now();
        do { deadline += FRAME_MS; } while (deadline <= now);
        timer = setTimeout(tick, Math.max(1, deadline - now));
        timer.unref();
      };
      timer = setTimeout(tick, FRAME_MS);
      timer.unref();
    },
    stop,
  };
}
