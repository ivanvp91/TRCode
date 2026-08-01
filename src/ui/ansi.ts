/** Zero-dependency ANSI styling with graceful degradation. */

const noColor =
  process.env.NO_COLOR !== undefined ||
  process.env.TERM === "dumb" ||
  (!process.stdout.isTTY && process.env.FORCE_COLOR === undefined);

function wrap(open: number, close: number) {
  return (s: string) => (noColor ? s : `\x1b[${open}m${s}\x1b[${close}m`);
}

export const c = {
  reset: "\x1b[0m",
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
  brightRed: wrap(91, 39),
  brightGreen: wrap(92, 39),
  brightYellow: wrap(93, 39),
  brightBlue: wrap(94, 39),
  brightMagenta: wrap(95, 39),
  brightCyan: wrap(96, 39),
  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
  bgGray: wrap(100, 49),
};

export const hasColor = !noColor;

/**
 * Cells a code point occupies. Emoji and CJK take two, combining marks and
 * variation selectors take none — counting them all as one shifts every
 * column after them, which is what turns an aligned table into a ragged one.
 */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  // Scattered symbols that terminals still render double-width: ⌚ ⭐ ✅ ❌ …
  const WIDE_SYMBOLS = [
    [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
    [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
    [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
    [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
    [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
    [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
    [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
    [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
    [0x2b55, 0x2b55],
  ];
  for (const [lo, hi] of WIDE_SYMBOLS) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/** Visible width in terminal cells, ignoring ANSI escapes. */
export function width(s: string): number {
  let total = 0;
  for (const ch of stripAnsi(s)) total += charWidth(ch.codePointAt(0) ?? 0);
  return total;
}

/** Cuts plain text to a cell width, never splitting a surrogate pair. */
export function cutToWidth(s: string, max: number): { text: string; width: number } {
  let text = "";
  let used = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (used + cw > max) break;
    text += ch;
    used += cw;
  }
  return { text, width: used };
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Cuts a styled string to a visible width. Plain `truncate()` counts escape
 * bytes as characters, so a coloured row loses real text long before it
 * reaches the edge of the terminal.
 */
export function clipAnsi(s: string, max: number): string {
  if (max <= 1) return "";
  if (width(s) <= max) return s;
  let out = "";
  let visible = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const seq = /^\x1b\[[0-9;]*[A-Za-z]/.exec(s.slice(i));
      if (seq) {
        out += seq[0];
        i += seq[0].length - 1;
        continue;
      }
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (visible + cw > max - 1) break;
    out += ch;
    visible += cw;
    i += ch.length - 1;
  }
  return out + "…" + (noColor ? "" : "\x1b[0m");
}

export const cursor = {
  hide: () => process.stdout.write("\x1b[?25l"),
  show: () => process.stdout.write("\x1b[?25h"),
  // CSI 0 A means "move 1 line" to a terminal, so a zero move must be skipped.
  up: (n = 1) => {
    if (n > 0) process.stdout.write(`\x1b[${n}A`);
  },
  down: (n = 1) => {
    if (n > 0) process.stdout.write(`\x1b[${n}B`);
  },
  toColumn: (n = 0) => process.stdout.write(`\x1b[${n}G`),
  clearLine: () => process.stdout.write("\x1b[2K"),
  clearDown: () => process.stdout.write("\x1b[0J"),
  clearScreen: () => process.stdout.write("\x1b[2J\x1b[H"),
};

/** Real terminal width; margins are applied by the layout module. */
export function termWidth(): number {
  return Math.max(48, process.stdout.columns || 100);
}
