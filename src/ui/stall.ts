/**
 * "The host has gone quiet — keep waiting?" asked over the running bar.
 *
 * It used to be an ordinary inline button row with the bar stepped aside: the
 * turn bar vanished, the buttons stood on a row near the bottom of the screen,
 * and the answer that arrived while the question was still up was written
 * straight onto them — the widget's next repaint then cleared the rows of that
 * answer. As part of the bar's frame the question keeps the input line where
 * it belongs, every line of the answer lands above it through the usual
 * erase-and-redraw, and a question the stream has outlived removes itself.
 */
import { t } from "../i18n.js";
import { c, clipAnsi, termWidth } from "./ansi.js";
import { indent } from "./layout.js";
import { line, refreshFooter, setFooterAbove } from "./render.js";
import { pushConsumer } from "./stdin.js";

const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
const LEFT = ESC + "[D";
const RIGHT = ESC + "[C";
const UP = ESC + "[A";
const DOWN = ESC + "[B";
const TAB = String.fromCharCode(9);

interface Option {
  value: boolean;
  label: string;
  key: string;
  tone: "ok" | "danger";
}

export interface StallPromptOptions {
  /** Aborts when the stream moves again, or the request stops: the question is moot. */
  signal: AbortSignal;
}

/**
 * Resolves true to keep waiting, false to give the request up. Non-TTY falls
 * back to "stop", the same answer the hard timeout would give.
 */
export function stallPrompt(opts: StallPromptOptions): Promise<boolean> {
  if (!process.stdin.isTTY || opts.signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const options: Option[] = [
      { value: true, label: t("Keep waiting", "Ждать дальше"), key: "w", tone: "ok" },
      { value: false, label: t("Abort the request", "Прервать запрос"), key: "n", tone: "danger" },
    ];
    let index = 0;
    let frame: string[] = [""];
    let installed = false;
    let closed = false;
    let release: () => void = () => {};

    const paint = () => {
      const button = (o: Option, i: number): string => {
        const tone = o.tone === "danger" ? c.red : c.green;
        if (i === index) return c.inverse(c.bold(tone(` ${o.label} `)));
        return c.gray("[") + tone(o.label) + c.gray("]");
      };
      const row =
        indent + button(options[0], 0) + "   " + button(options[1], 1) + c.gray("   ←/→ · Enter to confirm");
      frame = [clipAnsi(row, Math.max(20, termWidth() - 1))];
      if (installed) refreshFooter();
      else {
        installed = true;
        setFooterAbove(() => frame);
      }
    };

    const finish = (keep: boolean, announce = false) => {
      if (closed) return;
      closed = true;
      opts.signal.removeEventListener("abort", onAbort);
      release();
      if (installed) {
        setFooterAbove(null);
        installed = false;
      }
      if (announce) {
        const o = options[index];
        const tone = o.tone === "danger" ? c.red : c.green;
        line(indent + c.green("▸ ") + tone(o.label));
      }
      resolve(keep);
    };

    // The stall resolved itself: data arrived, so there is nothing left to
    // ask. The row goes without a trace — nothing was chosen.
    const onAbort = () => finish(true);

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      // Esc is "stop", as everywhere else: leaving the request running after
      // the user asked to stop is the one answer that cannot be taken back.
      if (s === CTRL_C || s === ESC) return finish(false, true);
      if (s === "\r" || s === "\n") return finish(options[index].value, true);
      if (s === LEFT || s === UP || s === RIGHT || s === DOWN || s === TAB) {
        index = (index + 1) % options.length;
        return paint();
      }
      const hit = options.findIndex((o) => o.key === s.toLowerCase());
      if (hit !== -1) {
        index = hit;
        return finish(options[hit].value, true);
      }
    };

    opts.signal.addEventListener("abort", onAbort, { once: true });
    paint();
    release = pushConsumer(onData);
  });
}
