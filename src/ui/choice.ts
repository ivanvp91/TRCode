/** Horizontal button row: ← → to move, Enter to confirm, letters as shortcuts. */
import { c, cursor, width } from "./ansi.js";
import { indent } from "./layout.js";
import { line, out } from "./render.js";
import { pushConsumer } from "./stdin.js";

const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
const LEFT = ESC + "[D";
const RIGHT = ESC + "[C";
const UP = ESC + "[A";
const DOWN = ESC + "[B";
const TAB = String.fromCharCode(9);

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** Single-key shortcut; also underlined in the label when present. */
  key?: string;
  tone?: "ok" | "warn" | "danger";
}

/**
 * Renders the buttons on one line and returns the chosen value. Falls back to
 * the default when stdin is not a terminal.
 */
export function choose<T extends string>(
  choices: Choice<T>[],
  opts: { initial?: T; fallback: T } = { fallback: choices[0].value },
): Promise<T> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve(opts.fallback);

  return new Promise((resolve) => {
    let index = Math.max(0, choices.findIndex((ch) => ch.value === opts.initial));
    let drawn = false;

    const paint = () => {
      if (drawn) {
        cursor.clearLine();
        cursor.toColumn(1);
      }
      const buttons = choices
        .map((ch, i) => {
          const tone = ch.tone === "danger" ? c.red : ch.tone === "warn" ? c.yellow : c.green;
          const text = ` ${ch.label} `;
          return i === index ? c.inverse(c.bold(tone(text))) : c.gray("[") + tone(ch.label) + c.gray("]");
        })
        .join("  ");
      out(indent + buttons + c.gray("   ←/→ · Enter to confirm"));
      drawn = true;
    };

    let release: () => void = () => {};
    cursor.hide();
    paint();

    const finish = (value: T) => {
      release();
      cursor.clearLine();
      cursor.toColumn(1);
      const picked = choices.find((ch) => ch.value === value);
      const tone = picked?.tone === "danger" ? c.red : picked?.tone === "warn" ? c.yellow : c.green;
      line(indent + tone("▸ " + (picked?.label ?? value)));
      cursor.show();
      resolve(value);
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (s === CTRL_C || s === ESC) return finish(opts.fallback);
      if (s === "\r" || s === "\n") return finish(choices[index].value);
      if (s === LEFT || s === UP) {
        index = (index - 1 + choices.length) % choices.length;
        return paint();
      }
      if (s === RIGHT || s === DOWN || s === TAB) {
        index = (index + 1) % choices.length;
        return paint();
      }
      const hit = choices.findIndex((ch) => ch.key && ch.key.toLowerCase() === s.toLowerCase());
      if (hit !== -1) {
        index = hit;
        return finish(choices[hit].value);
      }
    };

    release = pushConsumer(onData);
  });
}

export { width as _width };
