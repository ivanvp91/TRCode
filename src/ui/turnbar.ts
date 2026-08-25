/**
 * The bottom bar shown while a turn runs: spinner, input frame, status rows.
 *
 * Before this, the frame was torn down for the duration of a turn and the
 * spinner was the only thing left on screen — on a ten-minute run the terminal
 * looked like the CLI had forgotten about you. The bar keeps the prompt where
 * it always is, and anything typed into it is queued and sent when the current
 * turn finishes.
 */
import { c, clipAnsi, width } from "./ansi.js";
import { contentWidth, indent, PAD_LEFT } from "./layout.js";
import { fmtDuration } from "./layout.js";
import { expandedBlock, line, padded, refreshFooter, setFooter } from "./render.js";
import { pushConsumer } from "./stdin.js";
import { cleanPaste, isPartialEscape, isNewlineKey, KEY, locatePos, rowSpansOf, SHIFT_TAB, type EditorStatus } from "./editor.js";
import { stashPaste, takeCollapsed } from "./paste.js";

const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);
const CTRL_O = String.fromCharCode(15);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
const PASTE_START = ESC + "[200~";
const PASTE_END = ESC + "[201~";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** What a raw chunk says about the Esc key. */
export type InterruptRead = "yes" | "no" | "pending";

const PASTE_OPEN = ESC + "[200~";
const PASTE_CLOSE = ESC + "[201~";

/**
 * Strips bracketed-paste payload, which is data and never keys.
 *
 * Pasting a terminal log while the model works used to cancel the turn: the
 * log carries escape bytes of its own — a title sequence, a bare \x1b in a
 * dump — and the scan below read them as somebody reaching for Esc. `inPaste`
 * says the chunk begins inside a paste that started in an earlier read.
 */
function withoutPaste(s: string, inPaste: boolean): string {
  let out = "";
  let i = 0;
  let inside = inPaste;
  for (;;) {
    if (inside) {
      const close = s.indexOf(PASTE_CLOSE, i);
      if (close === -1) return out;
      i = close + PASTE_CLOSE.length;
      inside = false;
      continue;
    }
    const open = s.indexOf(PASTE_OPEN, i);
    if (open === -1) return out + s.slice(i);
    out += s.slice(i, open);
    i = open + PASTE_OPEN.length;
    inside = true;
  }
}

/**
 * Whether a read carries an Esc or Ctrl+C keypress meant as "stop".
 *
 * Matching the whole chunk was too strict. A terminal delivers whatever has
 * accumulated since the last read, so Esc pressed while the model is streaming
 * — the one moment it matters — arrives glued to whatever else was typed, as
 * `\x1b\x1b` from an impatient second press, or as `\x1b` followed by the next
 * keystroke. None of those equal a bare Esc, and the turn ran on.
 *
 * Two things are not Esc, though, and reading them as Esc cancelled turns
 * nobody had touched: an Esc that opens a recognised sequence (`\x1b[`,
 * `\x1bO` — cursor keys, focus events, paste markers), and an Esc that is the
 * last byte of the chunk, which may simply be a sequence split across two
 * reads. The second one is "pending": it is Esc only if nothing follows.
 */
export function readInterrupt(s: string, inPaste = false): InterruptRead {
  if (s.includes(CTRL_C)) return "yes";
  // Alt+Enter is ESC followed by CR, and that is a newline in the message
  // being composed — not a cancel. Typing a multi-line note while the model
  // worked and reaching for a second line ended the turn.
  if (isNewlineKey(s)) return "no";
  // The same pair inside a longer chunk: the keystroke can arrive glued to
  // whatever was typed just before it.
  const newlineKey = new RegExp(ESC + "[\r\n]", "g");
  const keys = withoutPaste(s, inPaste).replace(newlineKey, "");
  let pending = false;
  for (let i = keys.indexOf(ESC); i !== -1; i = keys.indexOf(ESC, i + 1)) {
    const next = keys[i + 1];
    if (next === undefined) pending = true;
    else if (next !== "[" && next !== "O") return "yes";
  }
  return pending ? "pending" : "no";
}

/** Kept for callers with no paste state of their own. */
export function isInterrupt(s: string): boolean {
  return readInterrupt(s) === "yes";
}

/** How long a trailing Esc waits for the rest of its sequence. */
const ESC_HOLD_MS = 40;

/**
 * Reads Esc across chunk boundaries.
 *
 * A cursor key can arrive as `\x1b` in one read and `[A` in the next; a real
 * Esc press arrives as `\x1b` and nothing else. Telling them apart takes the
 * few milliseconds between the two, which is what this holds.
 */
export class InterruptWatcher {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private fire: () => void,
    private holdMs = ESC_HOLD_MS,
  ) {}

  /** True when this chunk cancelled the turn, so the caller can stop reading it. */
  feed(s: string, inPaste = false): boolean {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      // The tail of a split sequence — the held Esc was never a keypress.
      // Anything else means it was: the turn is cancelled, and the keystroke
      // that decided it is still a keystroke, so it goes on to the editing
      // logic rather than being eaten by the cancel.
      if (s[0] !== "[" && s[0] !== "O") {
        this.fire();
        return false;
      }
    }
    const read = readInterrupt(s, inPaste);
    if (read === "yes") {
      this.fire();
      return true;
    }
    if (read === "pending") {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.fire();
      }, this.holdMs);
      this.timer.unref?.();
    }
    return false;
  }

  /** Drops a held Esc; the turn it would have cancelled is already over. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
export interface TurnBarOptions {
  status: () => EditorStatus;
  /** Cancels the running turn — Esc and Ctrl+C both land here. */
  onInterrupt: () => void;
  /** Shift+Tab: cycles the confirmation mode, same as in the idle editor. */
  onToggleMode?: () => void;
  /** Submitted lines, for ↑ recall — the same list the idle editor walks. */
  history?: string[];
}

export class TurnBar {
  private timer: NodeJS.Timeout | null = null;
  private release: (() => void) | null = null;
  private frame = 0;
  private started = 0;
  private label = "thinking";
  private inTokens = 0;
  private outTokens = 0;
  private cachedTokens = 0;
  /** Rolling reasoning preview, shown above the spinner while a model thinks. */
  private thinking: string[] = [];
  /** Where the caret sits inside rows(), so the footer can show it there. */
  private caret = { row: 0, col: 0 };
  private buf = "";
  /** The caret inside `buf`; the bar used to append only, the arrows need it. */
  private pos = 0;
  /** -1 while typing; walking the history owns the index until an edit. */
  private historyIdx = -1;
  private draft = "";
  private queued: string[] = [];
  private pasting = false;
  private pasteBuf = "";
  private watch = new InterruptWatcher(() => this.opts.onInterrupt());
  /** The head of an escape sequence whose tail has not arrived yet. */
  private held = "";

  constructor(private opts: TurnBarOptions) {}

  start(): void {
    if (!process.stdout.isTTY || this.timer) return;
    this.started = Date.now();
    setFooter(() => this.rows(), () => this.caret);
    this.timer = setInterval(() => {
      this.frame++;
      refreshFooter();
    }, 120);
    this.timer.unref?.();
    this.release = pushConsumer((b) => this.onData(b));
  }

  /** Steps aside so a permission prompt can own the bottom of the screen. */
  pause(): void {
    this.watch.stop();
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.release?.();
    this.release = null;
    setFooter(null);
  }

  resume(): void {
    if (this.timer || !this.started || !process.stdout.isTTY) return;
    setFooter(() => this.rows(), () => this.caret);
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

  setTokens(inTokens: number, outTokens: number, cachedTokens?: number): void {
    this.inTokens = inTokens;
    this.outTokens = outTokens;
    // Text deltas update counts without knowing the cache split; keep the
    // share from the last request whose usage reported it.
    if (cachedTokens !== undefined) this.cachedTokens = cachedTokens;
  }

  setThinking(rows: string[]): void {
    this.thinking = rows;
    refreshFooter();
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

    // Read before the chunk is treated as text, and told whether a paste is
    // open: escape bytes inside pasted content are data, not a cancel.
    if (this.watch.feed(s, this.pasting)) return;

    // Only a genuinely cut sequence (ESC[ / ESCO without its final byte) is
    // held here. A lone ESC is NOT: the interrupt watcher above already waits
    // out its possible tail, and holding it too would glue the dead byte onto
    // whatever the user types next — dropping the keystroke entirely.
    if (!this.pasting && s.length > 1 && isPartialEscape(s)) {
      // A sequence cut across reads (a slow terminal, a busy stream): held
      // until its tail arrives, or it reads as text and stray "[" lands in
      // the draft — and ESC[Z never matches SHIFT_TAB at all.
      this.held = s;
      return;
    }
    if (this.held) {
      s = this.held + s;
      this.held = "";
    }

    if (this.pasting || s.includes(PASTE_START)) {
      const from = s.indexOf(PASTE_START);
      if (from !== -1) s = s.slice(from + PASTE_START.length);
      const to = s.indexOf(PASTE_END);
      this.pasting = to === -1;
      if (to !== -1) s = s.slice(0, to);
      // Held until the end marker: a paste that arrives in five chunks is one
      // paste, and stashing it piecemeal would leave five tokens behind.
      this.pasteBuf += s;
      if (this.pasting && this.pasteBuf.length < 1_000_000) return;
      this.pasting = false;
      const whole = this.pasteBuf;
      this.pasteBuf = "";
      this.insert(stashPaste(cleanPaste(whole)));
      return;
    }

    if (isNewlineKey(s)) return this.insert("\n");
    if (s === "\r" || s === "\n") return this.submit();
    if (s === CTRL_U) {
      this.buf = this.buf.slice(this.pos);
      this.pos = 0;
      return refreshFooter();
    }
    if (s === DEL || s === BACKSPACE) {
      // DEL is delete-right, the way the idle editor reads it.
      if (s === DEL && this.pos < this.buf.length) {
        this.buf = this.buf.slice(0, this.pos) + this.buf.slice(this.pos + 1);
        return refreshFooter();
      }
      if (this.pos > 0) {
        this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos);
        this.pos--;
      }
      return refreshFooter();
    }
    switch (s) {
      case KEY.left:
        if (this.pos > 0) this.pos--;
        return refreshFooter();
      case KEY.right:
        if (this.pos < this.buf.length) this.pos++;
        return refreshFooter();
      case KEY.home:
      case KEY.end:
        this.pos = s === KEY.home ? 0 : this.buf.length;
        return refreshFooter();
      case KEY.up:
      case KEY.down: {
        // Between the rows of a wrapped draft the arrows steer the caret;
        // from its top (or bottom) they fall through to the history.
        if (this.historyIdx === -1 && this.moveLine(s === KEY.up ? -1 : 1)) return refreshFooter();
        this.historyStep(s === KEY.up ? -1 : 1);
        return refreshFooter();
      }
      case CTRL_O: {
        // Same walk as in the idle editor: newest shortened block first, then
        // one further back. The bar steps aside for the block, and start()
        // puts it back below what was printed.
        const block = takeCollapsed();
        if (!block) return;
        this.pause();
        line();
        for (const l of expandedBlock(block.text)) padded(l);
        line();
        this.start();
        return;
      }
    }
    if (SHIFT_TAB.some((seq) => s.includes(seq))) {
      // A chunk can carry more than the key: "abc" + ESC[Z in one read, or two
      // presses glued together. Strip every occurrence, toggle once per key,
      // and keep what is left — usually nothing, but the surrounding text
      // still belongs to the draft.
      let rest = s;
      let presses = 0;
      for (const seq of SHIFT_TAB) {
        const hits = rest.split(seq).length - 1;
        presses += hits;
        rest = rest.split(seq).join("");
      }
      const text = cleanPaste(rest).replace(/\n$/, "");
      for (let i = 0; i < presses; i++) this.opts.onToggleMode?.();
      if (text) this.insert(text);
      return refreshFooter();
    }
    if (s.startsWith(ESC)) return; // arrows and friends: nothing to do here
    const text = cleanPaste(s);
    if (text) this.insert(text);
  }

  private insert(text: string): void {
    this.edited();
    this.buf = this.buf.slice(0, this.pos) + text + this.buf.slice(this.pos);
    this.pos += text.length;
    refreshFooter();
  }

  /**
   * Editing a recalled line hands the arrows back to the caret, exactly as in
   * the idle editor.
   */
  private edited(): void {
    this.historyIdx = -1;
  }

  /**
   * Same rule as InputEditor.moveLine: rows are what the eye sees — a wrapped
   * line covers several — and only past the first (or last) row do the arrows
   * become history.
   */
  private moveLine(dir: -1 | 1): boolean {
    const rows = rowSpansOf(this.buf, Math.max(10, contentWidth() - 5));
    let at = 0;
    while (at + 1 < rows.length && rows[at + 1].start <= this.pos) at++;
    const target = at + dir;
    if (target < 0 || target >= rows.length) return false;
    const col = this.pos - rows[at].start;
    this.pos = rows[target].start + Math.min(col, rows[target].len);
    return true;
  }

  /** The idle editor's walk: draft held aside, oldest up, newest back down. */
  private historyStep(dir: -1 | 1): void {
    const h = this.opts.history ?? [];
    if (!h.length) return;
    if (this.historyIdx === -1) {
      if (dir === 1) return;
      this.draft = this.buf;
      this.historyIdx = h.length - 1;
    } else {
      const next = this.historyIdx + dir;
      if (next < 0) return;
      if (next >= h.length) {
        this.historyIdx = -1;
        this.buf = this.draft;
        this.pos = this.buf.length;
        return;
      }
      this.historyIdx = next;
    }
    this.buf = h[this.historyIdx];
    this.pos = this.buf.length;
  }

  private submit(): void {
    const text = this.buf.trim();
    if (!text) return;
    this.queued.push(text);
    this.buf = "";
    this.pos = 0;
    this.edited();
    refreshFooter();
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  private rows(): string[] {
    const w = contentWidth();
    const inner = Math.max(10, w - 5);
    const st = this.opts.status();
    const queued = this.queued.slice(-2);
    const bufRows = wrapBuffer(this.buf, inner);
    // The frame, spinner and status have to fit on screen even while a model
    // dumps a long reasoning preview: a footer taller than the terminal
    // scrolls the input box off the bottom, which reads as it having vanished.
    const chrome =
      1 + // gap above the live block
      1 + // spinner
      queued.length +
      1 + // top border
      Math.max(1, bufRows.length) +
      1 + // bottom border
      2; // status
    const termRows = Math.max(10, process.stdout.rows || 24);
    const thinkRoom = Math.max(0, termRows - chrome - 1);
    const thinking = this.thinking.slice(-thinkRoom);

    const rows: string[] = [];

    // A gap between the transcript above and the live block: without it the
    // streamed text and the spinner (or reasoning preview) read as one blob.
    rows.push("");
    for (const tl of thinking) {
      rows.push(indent + "  " + c.dim(clipRow(tl, Math.max(10, w - 4))));
    }
    // The preview is its own block; without the gap its last line and the
    // spinner read as one.
    if (thinking.length) rows.push("");
    rows.push(indent + clipAnsi(this.spinnerLine(), w));
    for (const q of queued) {
      rows.push(indent + c.gray("  ⎿ queued: ") + c.dim(clipRow(q, inner - 10)));
    }

    rows.push(indent + c.gray("╭" + "─".repeat(w - 2) + "╮"));
    for (const [i, r] of bufRows.entries()) {
      const marker = i === 0 ? c.brightCyan("❯ ") : c.gray("  ");
      rows.push(indent + c.gray("│") + " " + marker + r.padEnd(inner) + c.gray("│"));
    }
    // The caret follows this.pos through the wrapped draft, the way the idle
    // editor parks it. bufRows end at the current last row, so the first of
    // them is where locatePos's rows count from.
    const at = locatePos(this.buf, this.pos, inner);
    const firstBufRow = rows.length - bufRows.length;
    this.caret = {
      row: firstBufRow + at.row,
      col: PAD_LEFT + 4 + at.col,
    };
    rows.push(indent + c.gray("╰" + "─".repeat(w - 2) + "╯"));

    const gap = Math.max(2, w - width(st.left) - width(st.hint));
    rows.push(indent + st.left + " ".repeat(gap) + st.hint);
    rows.push(indent + " ".repeat(Math.max(0, w - width(st.context))) + st.context);
    return rows;
  }

  private spinnerLine(): string {
    const elapsed = fmtDuration(Date.now() - this.started);
    const cached =
      this.cachedTokens && this.inTokens
        ? ` · ${Math.min(100, Math.round((this.cachedTokens / this.inTokens) * 100))}% cached`
        : "";
    const counts =
      this.inTokens || this.outTokens
        ? ` · ↑ ${fmtCompact(this.inTokens)} ↓ ${fmtCompact(this.outTokens)}${cached}`
        : "";
    // Average over the whole turn so far — thinking and tool calls included.
    const tps =
      this.outTokens && Date.now() - this.started > 1000
        ? ` · ${fmtCompact(Math.round(this.outTokens / ((Date.now() - this.started) / 1000)))} tok/s`
        : "";
    const hint = this.buf.trim()
      ? c.gray("  enter to queue · esc to interrupt")
      : c.gray("  esc to interrupt · type to queue a message");
    return (
      c.brightMagenta(FRAMES[this.frame % FRAMES.length]) +
      " " +
      c.dim(this.label) +
      c.gray(` (${elapsed}${counts}${tps})`) +
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

