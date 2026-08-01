/** One-line text prompt: echoing, editable, cancellable. */
import { c, cursor, width } from "./ansi.js";
import { indent } from "./layout.js";
import { out, line } from "./render.js";
import { pushConsumer } from "./stdin.js";

const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
/** Written this way so the source file stays plain text. */
const CONTROL_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + DEL + "]", "g");

/**
 * Asks for a single line, prefilled with `initial`. Returns null when the user
 * cancels with Esc — an empty string is a valid answer and stays distinct.
 * Unlike the main editor this owns no frame and no history: it is a one-shot.
 */
export function askLine(label: string, initial = ""): Promise<string | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    let value = initial;
    let drawn = false;

    const paint = () => {
      if (drawn) {
        cursor.clearLine();
        cursor.toColumn(1);
      }
      out(indent + c.brightCyan("❯ ") + c.gray(label + " ") + value);
      drawn = true;
    };

    let release: () => void = () => {};
    const finish = (result: string | null) => {
      release();
      cursor.clearLine();
      cursor.toColumn(1);
      line(indent + (result === null ? c.gray("▸ cancelled") : c.green("▸ " + (result || "(untitled)"))));
      resolve(result);
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (s === CTRL_C || s === ESC) return finish(null);
      if (s === "\r" || s === "\n") return finish(value.trim());
      if (s === CTRL_U) {
        value = "";
        return paint();
      }
      if (s === DEL || s === BACKSPACE) {
        // Drop a whole code point, so an emoji does not leave half of itself.
        value = [...value].slice(0, -1).join("");
        return paint();
      }
      // Escape sequences (arrows, function keys) carry no text to insert.
      if (s.startsWith(ESC)) return;
      const text = s.replace(CONTROL_CHARS, "");
      if (!text) return;
      if (width(value + text) > 100) return;
      value += text;
      paint();
    };

    paint();
    release = pushConsumer(onData);
  });
}
