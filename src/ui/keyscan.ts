/**
 * Key inspector. Terminals disagree wildly about what Ctrl/Shift+Enter sends —
 * some send nothing at all because they swallow the combination as their own
 * shortcut. Rather than guessing, this shows the exact bytes and offers to pin
 * whatever arrived as a newline key.
 */
import { c } from "./ansi.js";
import { line, padded } from "./render.js";
import { pushConsumer } from "./stdin.js";
import { isNewlineKey } from "./editor.js";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

export interface CapturedKey {
  raw: string;
  hex: string;
  readable: string;
  meaning: string;
}

function readable(s: string): string {
  return s
    .replace(new RegExp(ESC, "g"), "<ESC>")
    .replace(/\r/g, "<CR>")
    .replace(/\n/g, "<LF>")
    .replace(/\t/g, "<TAB>")
    .replace(new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + "]", "g"), (ch) =>
      `<Ctrl+${String.fromCharCode(64 + ch.charCodeAt(0))}>`,
    );
}

const KNOWN: Record<string, string> = {
  [ESC + "[A"]: "previous prompt from history",
  [ESC + "[B"]: "next prompt from history",
  [ESC + "[C"]: "cursor right",
  [ESC + "[D"]: "cursor left",
  [ESC + "[H"]: "start of line",
  [ESC + "[F"]: "end of line",
  [ESC + "[3~"]: "delete character right",
  [String.fromCharCode(127)]: "delete character left",
  [String.fromCharCode(8)]: "delete character left",
  [String.fromCharCode(9)]: "complete command",
  [String.fromCharCode(3)]: "interrupt / exit",
  [String.fromCharCode(12)]: "repaint the frame",
  [String.fromCharCode(21)]: "erase to start of line",
  [String.fromCharCode(11)]: "erase to end of line",
  [String.fromCharCode(23)]: "erase word",
};

/**
 * What the CLI will actually do with this sequence. The newline check calls
 * into the editor rather than repeating its rules — a diagnostic that can
 * disagree with the real behaviour is worse than none.
 */
function meaningOf(s: string): string {
  if (s === CR) return "send the message";
  if (isNewlineKey(s)) return "insert a newline";
  if (KNOWN[s]) return KNOWN[s];
  if (s === ESC) return "interrupt / repaint";
  if (s.startsWith(ESC + "[")) return "unused";
  if (s.length === 1 && s < " ") return "control character, unused";
  return "ordinary input";
}

/**
 * Captures keystrokes until Esc is pressed twice or Ctrl+C. Returns everything
 * seen, newest last.
 */
export function scanKeys(): Promise<CapturedKey[]> {
  if (!process.stdin.isTTY) return Promise.resolve([]);

  return new Promise((resolve) => {
    const seen: CapturedKey[] = [];
    let lastWasEsc = false;

    line();
    padded(c.bold("Key inspector"));
    padded(c.gray("Press keys — this shows exactly what the CLI receives."));
    padded(c.gray("Try Ctrl+Enter, Shift+Enter, Ctrl+Shift+Enter."));
    padded(c.gray("Press Esc twice to finish."));
    line();

    const release = pushConsumer((chunk) => {
      const raw = chunk.toString("utf8");

      if (raw === String.fromCharCode(3)) {
        release();
        return resolve(seen);
      }
      if (raw === ESC) {
        if (lastWasEsc) {
          release();
          return resolve(seen);
        }
        lastWasEsc = true;
      } else {
        lastWasEsc = false;
      }

      const key: CapturedKey = {
        raw,
        hex: Buffer.from(raw, "utf8").toString("hex").replace(/(..)/g, "$1 ").trim(),
        readable: readable(raw),
        meaning: meaningOf(raw),
      };
      seen.push(key);
      padded(
        c.brightCyan(key.readable.padEnd(22)) + c.gray(key.hex.padEnd(26)) + c.dim(key.meaning),
      );
    });
  });
}
