/**
 * A frame trace, off unless asked for.
 *
 * The block at the bottom of the screen is drawn with cursor arithmetic, and
 * when something leaves a second copy of it on screen the question is always
 * the same: what did the app draw, where did it think it was, and what did the
 * terminal say about its own size at the time. None of that survives in a
 * screenshot — the numbers do, if they are written down as they happen.
 *
 * Switched on by the TRCODE_FRAME_TRACE environment variable (a path), or by a
 * file at ~/.trcode/frame-trace, which is the practical way to ask for a trace
 * from an app somebody else started: create the file, reproduce, read the log.
 * Writes are fire-and-forget so a half-written log never stalls a repaint.
 */
import { appendFile } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const marker = path.join(process.env.TRCODE_HOME || path.join(homedir(), ".trcode"), "frame-trace");
const file = process.env.TRCODE_FRAME_TRACE || `${marker}.log`;
const on = Boolean(process.env.TRCODE_FRAME_TRACE) || existsSync(marker);

let started = 0;

/** Appends one line to the trace; a no-op unless it is switched on. */
export function trace(event: string, data: Record<string, unknown> = {}): void {
  if (!on) return;
  if (!started) {
    started = Date.now();
    appendFile(file, `\n──── trcode frame trace ${new Date().toISOString()} ────\n`, () => {});
  }
  const at = ((Date.now() - started) / 1000).toFixed(2).padStart(7);
  const fields = Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === "number" ? Math.round(v * 100) / 100 : v}`)
    .join(" ");
  appendFile(file, `${at}s ${event}${fields ? " " + fields : ""}\n`, () => {});
}
