/** Dotted TR monogram in brushed silver, lit by a highlight that travels across it. */
import { esc } from "./ansi.js";
import { MONOGRAM, COMPACT_MONOGRAM } from "./logo-art.js";

interface Cell { ch: string; fg: string; bg: string }
export const LOGO_WIDTH = MONOGRAM[0].length;
export const LOGO_HEIGHT = MONOGRAM.length + 3;
export const LOGO_MIN_WIDTH = COMPACT_MONOGRAM[0].length;
export const LOGO_MIN_HEIGHT = COMPACT_MONOGRAM.length + 2;
/** One full sweep of the light, in seconds: the only thing that moves. */
export const LOGO_PERIOD = 10;
const FRAME_MS = 1000 / 30;
const RESET = "\x1b[39;49m";
const EMPTY: Cell = { ch: " ", fg: "\x1b[39m", bg: "\x1b[49m" };

// The mark keeps the grey it always had: a neutral ramp from deep steel on the
// left to polished silver on the right, with a specular band that travels over
// the surface. Nothing here has a hue, so the dots still read as one silver
// material rather than as a coloured sticker.
const STEEL = 0.42;         // darkest corner of the ramp
const SILVER = 0.82;        // brightest corner, before the highlight
const BAND_WIDTH = 0.36;    // share of the mark's width covered by the highlight
const BAND_LIFT = 0.24;
// Channels are rounded to 4-step shades: every frame then moves a shade by at
// most one step (so the highlight glides instead of stepping), while cells that
// sit on a smooth part of the ramp share an escape and travel as one run.
const QUANTUM = 4;

const palette = new Map<number, string>();

function ink(lightness: number): string {
  const channel = Math.min(1, Math.max(0, lightness));
  // The ramp tops out below 255 so every shade stays an exact multiple of the step.
  const level = Math.round(channel * 252 / QUANTUM) * QUANTUM;
  let escape = palette.get(level);
  if (!escape) {
    escape = "\x1b[38;2;" + level + ";" + level + ";" + level + "m";
    palette.set(level, escape);
  }
  return escape;
}

interface Region { left: number; top: number; width: number; height: number }

/** How bright the metal is on a cell, in mark-relative coordinates. */
function shade(u: number, v: number, seconds: number): string {
  // The highlight starts mid-mark, crosses it, returns, and is periodic, so the
  // loop is seamless and the very first frame already shows the sheen.
  const sweep = 0.5 + 0.5 * Math.sin(seconds / LOGO_PERIOD * Math.PI * 2);
  const edge = Math.max(0, 1 - Math.abs(u - sweep) / BAND_WIDTH);
  const gleam = edge * edge * (3 - 2 * edge);
  const ramp = 0.62 * u + 0.38 * (1 - v);
  // A steep middle is what separates brushed metal from a flat wash: the
  // extremes stay where the old grey was, only the transition tightens.
  const shaded = ramp * ramp * (3 - 2 * ramp);
  return ink(STEEL + (SILVER - STEEL) * shaded + BAND_LIFT * gleam);
}

function place(frame: Cell[][], text: string, y: number, region: Region, seconds: number): void {
  const row = frame[y];
  if (!row) return;
  const left = Math.max(0, Math.floor((row.length - text.length) / 2));
  const across = Math.max(1, region.width - 1);
  const down = Math.max(1, region.height - 1);
  for (let x = 0; x < text.length && left + x < row.length; x++) {
    if (text[x] === " ") continue;
    const u = Math.min(1, Math.max(0, (left + x - region.left) / across));
    const v = Math.min(1, Math.max(0, (y - region.top) / down));
    row[left + x] = { ch: text[x], fg: shade(u, v, seconds), bg: EMPTY.bg };
  }
}

function logoCells(columns: number, rows: number, seconds: number): Cell[][] {
  const frame: Cell[][] = Array.from({ length: rows }, () => Array(columns).fill(EMPTY));
  if (columns < LOGO_MIN_WIDTH || rows < LOGO_MIN_HEIGHT) {
    const name = "TRCode".slice(0, columns);
    const row = Math.floor(rows / 2);
    const left = Math.max(0, Math.floor((columns - name.length) / 2));
    place(frame, name, row, { left, top: row, width: name.length, height: 1 }, seconds);
    return frame;
  }
  const full = columns >= LOGO_WIDTH && rows >= LOGO_HEIGHT;
  const artwork = full ? MONOGRAM : COMPACT_MONOGRAM;
  const height = full ? LOGO_HEIGHT : LOGO_MIN_HEIGHT;
  const top = Math.floor((rows - height) / 2);
  const region: Region = {
    left: Math.max(0, Math.floor((columns - artwork[0].length) / 2)),
    top,
    width: artwork[0].length,
    height,
  };
  for (let y = 0; y < artwork.length; y++) place(frame, artwork[y], top + y, region, seconds);
  place(frame, "T R C O D E", top + height - 1, region, seconds);
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
