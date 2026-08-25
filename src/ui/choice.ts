/** Horizontal button row: ← → to move, Enter to confirm, letters as shortcuts. */
import { c, clipAnsi, cursor, esc, termWidth, width } from "./ansi.js";
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
  opts: { initial?: T; fallback: T; hint?: string; cancel?: () => void } = { fallback: choices[0].value },
): Promise<T> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve(opts.fallback);

  return new Promise((resolve) => {
    let index = Math.max(0, choices.findIndex((ch) => ch.value === opts.initial));
    /** Physical rows the last paint left on screen — what the next one clears. */
    let drawnRows = 0;

    /**
     * The buttons, wrapped into physical rows by hand.
     *
     * A row long enough to wrap by itself is the bug this exists to avoid: the
     * terminal's own wrap puts the cursor on the last row only, so the next
     * repaint clears that row and leaves every row above it on screen — one
     * more copy of the buttons per keypress. Wrapping here means the count of
     * rows is known, and a repaint can clear exactly what it drew. A single
     * button wider than the terminal is clipped for the same reason: it is the
     * one case where keeping the button whole would cost the row count.
     */
    const buttonRows = (): string[] => {
      const max = termWidth() - 1;
      const lead = width(indent);
      const parts = choices.map((ch, i) => {
        const tone = ch.tone === "danger" ? c.red : ch.tone === "warn" ? c.yellow : c.green;
        const text = ` ${ch.label} `;
        const button = i === index ? c.inverse(c.bold(tone(text))) : c.gray("[") + tone(ch.label) + c.gray("]");
        return width(button) > max - lead ? clipAnsi(button, max - lead) : button;
      });
      const rows: string[] = [];
      let row = indent;
      let w = lead;
      for (const part of parts) {
        const sep = w > lead ? "  " : "";
        if (w > lead && w + width(sep) + width(part) > max) {
          rows.push(row);
          row = indent + part;
          w = lead + width(part);
          continue;
        }
        row += sep + part;
        w += width(sep) + width(part);
      }
      // The buttons stay whole; the hint is what yields when the row does not
      // fit — a clipped hint reads as a styled dash, a clipped button is a
      // button that cannot be read or picked.
      const room = max - w - 3;
      if (room > 4) row += c.gray("   " + clipAnsi(opts.hint ?? "←/→ · Enter to confirm", room));
      rows.push(row);
      return rows;
    };

    /** Back to the top-left of what was drawn, clearing all of it. */
    const rewind = (): string =>
      drawnRows ? esc.up(drawnRows - 1) + esc.toColumn(1) + esc.clearDown : "";

    const paint = () => {
      // One write, not one per row: a terminal that repaints between two of
      // them would be caught with the old rows cleared and the new ones not
      // there yet. Going through out() (not raw stdout) keeps this widget in
      // sync with render.ts's frame state.
      const rows = buttonRows();
      out(rewind() + rows.join("\n"));
      drawnRows = rows.length;
    };

    let release: () => void = () => {};
    cursor.hide();
    paint();

    const finish = (value: T) => {
      release();
      const picked = choices.find((ch) => ch.value === value);
      const tone = picked?.tone === "danger" ? c.red : picked?.tone === "warn" ? c.yellow : c.green;
      out(rewind() + indent + tone("▸ " + (picked?.label ?? value)));
      drawnRows = 0;
      line();
      cursor.show();
      resolve(value);
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      // Esc is "stop", not "pick the safe button": a prompt that only ever
      // denies one tool leaves the turn running, and the next tool asks again.
      // Whoever put the prompt up decides what stopping means.
      if (s === CTRL_C || s === ESC) {
        opts.cancel?.();
        return finish(opts.fallback);
      }
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

export { termWidth as _width };
