/** Reading an API key from the terminal without echoing or corrupting it. */
import readline from "node:readline";
import { pushConsumer } from "./stdin.js";

const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);

/**
 * Cleans a pasted secret. Terminals in raw mode wrap pastes in bracketed-paste
 * markers (ESC[200~ … ESC[201~) and may append stray control bytes; left in
 * place these silently corrupt the key and surface as a confusing 401.
 */
export function sanitizeSecret(raw: string): string {
  const csi = new RegExp(ESC + "\\[[0-9;]*[~A-Za-z]", "g");
  const controls = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + DEL + "]", "g");
  return raw.replace(csi, "").replace(controls, "").trim().replace(/^["']|["']$/g, "").trim();
}

/** Reads a secret without echoing it. Returns "" when cancelled. */
export function askSecret(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question(promptText, (a) => {
        rl.close();
        resolve(sanitizeSecret(a));
      });
      return;
    }

    process.stdout.write(promptText);
    let release: () => void = () => {};

    let value = "";
    const done = (result: string) => {
      release();
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (s === CTRL_C || s === ESC) return done("");
      if (s === DEL || s === BACKSPACE) {
        if (value) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      // A paste arrives as one chunk and may carry its own trailing newline,
      // so split on the terminator rather than comparing the whole chunk.
      const eol = s.search(/[\r\n]/);
      const piece = eol === -1 ? s : s.slice(0, eol);
      value += piece;
      process.stdout.write("*".repeat(sanitizeSecret(piece).length));
      if (eol !== -1) return done(sanitizeSecret(value));
    };

    release = pushConsumer(onData);
  });
}
