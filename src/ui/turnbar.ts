/**
 * The bottom bar shown while a turn runs: spinner, input frame, status rows.
 *
 * Before this, the frame was torn down for the duration of a turn and the
 * spinner was the only thing left on screen — on a ten-minute run the terminal
 * looked like the CLI had forgotten about you. The bar keeps the prompt where
 * it always is, and anything typed into it is queued and sent when the current
 * turn finishes.
 */
import { c, width } from "./ansi.js";
import { contentWidth, indent } from "./layout.js";
import { fmtDuration } from "./layout.js";
import { refreshFooter, setFooter } from "./render.js";
import { pushConsumer } from "./stdin.js";
import { cleanPaste, isNewlineKey, type EditorStatus } from "./editor.js";

const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
const PASTE_START = ESC + "[200~";
const PASTE_END = ESC + "[201~";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface TurnBarOptions {
  status: () => EditorStatus;
  /** Cancels the running turn — Esc and Ctrl+C both land here. */
  onInterrupt: () => void;
}

export class TurnBar {
  private timer: NodeJS.Timeout | null = null;
  private release: (() => void) | null = null;
  private frame = 0;
  private started = 0;
  private label = "thinking";
  private inTokens = 0;
  private outTokens = 0;
  private buf = "";
  private queued: string[] = [];
  private pasting = false;

  constructor(private opts: TurnBarOptions) {}

  start(): void {
    if (!process.stdout.isTTY || this.timer) return;
    this.started = Date.now();
    setFooter(() => this.rows());
    this.timer = setInterval(() => {
      this.frame++;
      refreshFooter();
    }, 120);
    this.timer.unref?.();
    this.release = pushConsumer((b) => this.onData(b));
  }

  /** Steps aside so a permission prompt can own the bottom of the screen. */
  pause(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.release?.();
    this.release = null;
    setFooter(null);
  }

  resume(): void {
    if (this.timer || !this.started || !process.stdout.isTTY) return;
    setFooter(() => this.rows());
    this.timer = setInterval(() => {
      this.frame++;
      refreshFooter();
    }, 120);
    this.timer.unref?.();
    this.release = pushConsumer((b) => this.onData(b));
  }

  setLabel(label: string): void {
    if (this.label === label) return;
    this.label = label;
    refreshFooter();
  }

  setTokens(inTokens: number, outTokens: number): void {
    this.inTokens = inTokens;
    this.outTokens = outTokens;
  }

  /** Removes the bar and hands back what the user typed while waiting. */
  stop(): { queued: string[]; draft: string } {
    this.pause();
    this.started = 0;
    return { queued: this.queued, draft: this.buf.trim() };
  }

  // ── input ────────────────────────────────────────────────────────────────

  private onData(b: Buffer): void {
    let s = b.toString("utf8");

    if (this.pasting || s.includes(PASTE_START)) {
      const from = s.indexOf(PASTE_START);
      if (from !== -1) s = s.slice(from + PASTE_START.length);
      const to = s.indexOf(PASTE_END);
      this.pasting = to === -1;
      if (to !== -1) s = s.slice(0, to);
      this.insert(cleanPaste(s));
      return;
    }

    // Esc interrupts the turn; it does not clear the box, so a message typed
    // while waiting survives the interruption.
    if (s === ESC || s === CTRL_C) {
      this.opts.onInterrupt();
      return;
    }
    if (isNewlineKey(s)) return this.insert("\n");
    if (s === "\r" || s === "\n") return this.submit();
    if (s === CTRL_U) {
      this.buf = "";
      return refreshFooter();
    }
    if (s === DEL || s === BACKSPACE) {
      this.buf = [...this.buf].slice(0, -1).join("");
      return refreshFooter();
    }
    if (s.startsWith(ESC)) return; // arrows and friends: nothing to do here
    const text = cleanPaste(s);
    if (text) this.insert(text);
  }

  private insert(text: string): void {
    this.buf += text;
    refreshFooter();
  }

  private submit(): void {
    const text = this.buf.trim();
    if (!text) return;
    this.queued.push(text);
    this.buf = "";
    refreshFooter();
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  private rows(): string[] {
    const w = contentWidth();
    const inner = Math.max(10, w - 5);
    const st = this.opts.status();
    const rows: string[] = [];

    rows.push(indent + this.spinnerLine());
    for (const q of this.queued.slice(-2)) {
      rows.push(indent + c.gray("  ⎿ queued: ") + c.dim(clipRow(q, inner - 10)));
    }

    rows.push(indent + c.gray("╭" + "─".repeat(w - 2) + "╮"));
    for (const [i, r] of wrapBuffer(this.buf, inner).entries()) {
      const marker = i === 0 ? c.brightCyan("❯ ") : c.gray("  ");
      rows.push(indent + c.gray("│") + " " + marker + r.padEnd(inner) + c.gray("│"));
    }
    rows.push(indent + c.gray("╰" + "─".repeat(w - 2) + "╯"));

    const gap = Math.max(2, w - width(st.left) - width(st.hint));
    rows.push(indent + st.left + " ".repeat(gap) + st.hint);
    rows.push(indent + " ".repeat(Math.max(0, w - width(st.context))) + st.context);
    return rows;
  }

  private spinnerLine(): string {
    const elapsed = fmtDuration(Date.now() - this.started);
    const counts =
      this.inTokens || this.outTokens
        ? ` · ↑${fmtCompact(this.inTokens)} ↓${fmtCompact(this.outTokens)}`
        : "";
    const hint = this.buf.trim()
      ? c.gray("  enter to queue · esc to interrupt")
      : c.gray("  esc to interrupt · type to queue a message");
    return (
      c.brightMagenta(FRAMES[this.frame % FRAMES.length]) +
      " " +
      c.dim(this.label) +
      c.gray(` (${elapsed}${counts})`) +
      hint
    );
  }
}

/** Same wrapping the editor uses, so the frame looks identical mid-turn. */
function wrapBuffer(buf: string, inner: number): string[] {
  const rows: string[] = [];
  for (const para of buf.split("\n")) {
    if (!para.length) {
      rows.push("");
      continue;
    }
    for (let i = 0; i < para.length; i += inner) rows.push(para.slice(i, i + inner));
  }
  return rows.length ? rows : [""];
}

function clipRow(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(1, max - 1)) + "…";
}

function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}
