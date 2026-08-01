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

/** Visible width, ignoring ANSI escapes. */
export function width(s: string): number {
  return stripAnsi(s).length;
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
    if (visible >= max - 1) break;
    out += s[i];
    visible++;
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
