/**
 * The bottom bar shown while a turn runs: spinner, input frame, status rows.
 *
 * Before this, the frame was torn down for the duration of a turn and the
 * spinner was the only thing left on screen — on a ten-minute run the terminal
 * looked like the CLI had forgotten about you. The bar keeps the prompt where
 * it always is. Enter steers the running turn — the text joins it at the next
 * step, the way a word across the desk redirects someone mid-task — and Tab
 * queues a message for after it.
 */
import { c, clipAnsi, width } from "./ansi.js";
import { bandTextWidth, contentWidth, fullWidth, indent, PAD_LEFT, statusWidth } from "./layout.js";
import { fmtDuration } from "./layout.js";
import { expandedBlock, bandRow, line, padded, refreshFooter, setFooter } from "./render.js";
import { pushConsumer } from "./stdin.js";
import {
  cleanPaste,
  isPartialEscape,
  isNewlineKey,
  KEY,
  locatePos,
  rowSpansOf,
  SHIFT_TAB,
  suggestionLines,
  wrapBuf,
  type EditorStatus,
  type Suggestion,
} from "./editor.js";
import { stashPaste, takeCollapsed } from "./paste.js";
import { panelRows } from "./panel.js";
import { contextRow } from "./inputbox.js";
import { OutputRate } from "./rate.js";

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

/**
 * Cancels whatever is waiting when Esc (or Ctrl+C) is pressed.
 *
 * During a turn the bar below reads the keyboard. Everything else — the
 * browser login, the Code Assist project lookup, a catalog refresh — used to
 * print "esc to interrupt" with nobody listening at all, which is exactly what
 * "Esc does not interrupt" looks like from the outside. Returns the function
 * that gives the keyboard back.
 */
export function escWatch(onEsc: () => void): () => void {
  if (!process.stdin.isTTY) return () => {};
  const watch = new InterruptWatcher(onEsc);
  const release = pushConsumer((buf) => void watch.feed(buf.toString("utf8")));
  return () => {
    watch.stop();
    release();
  };
}
export interface TurnBarOptions {
  status: () => EditorStatus;
  /** Cancels the running turn — Esc and Ctrl+C both land here. */
  onInterrupt: () => void;
  /** Shift+Tab: cycles the confirmation mode, same as in the idle editor. */
  onToggleMode?: () => void;
  /** Submitted lines, for ↑ recall — the same list the idle editor walks. */
  history?: string[];
  /**
   * Enter mid-turn: the text joins the running turn at its next step instead of
   * waiting for the turn to end. Without it every submitted line is queued.
   */
  onSteer?: (text: string) => void;
  /**
   * Slash-command rows for the line being typed mid-turn. The bar is where a
   * command is typed as often as the idle prompt — a `/model` reached for while
   * the model thinks is the same command — so it gets the same dropdown.
   */
  suggest?: (buffer: string) => Suggestion[];
  /** Rows the dropdown keeps while the filter narrows it down. */
  suggestRows?: number;
}

/**
 * How many rows of reasoning the live bar shows. Capped on purpose: a preview
 * that grows line by line makes the bar taller every few seconds, and a bar at
 * the bottom of the screen that changes height has to give rows back somewhere.
 */
const PREVIEW_ROWS = 7;

/**
 * How many helpers the bar lists at once. A fan-out is usually two to five;
 * past this the list would be taller than the screen it shares with the input.
 */
const ACTIVITY_ROWS = 8;

export class TurnBar {
  private timer: NodeJS.Timeout | null = null;
  private release: (() => void) | null = null;
  private frame = 0;
  private started = 0;
  private label = "thinking";
  private inTokens = 0;
  private outTokens = 0;
  private cachedTokens = 0;
  /** Wall-clock the model actually spent streaming, for the live tok/s. */
  private rate = new OutputRate();
  /** Rolling reasoning preview, shown above the spinner while a model thinks. */
  private thinking: string[] = [];
  /** Running helpers and long-command progress, drawn above the spinner. */
  private activity: string[] = [];
  /** Once the preview has appeared, its rows stay reserved for the turn. */
  private previewShown = false;
  /** Where the caret sits inside rows(), so the footer can show it there. */
  private caret = { row: 0, col: 0 };
  private buf = "";
  /** The caret inside `buf`; the bar used to append only, the arrows need it. */
  private pos = 0;
  /** -1 while typing; walking the history owns the index until an edit. */
  private historyIdx = -1;
  private draft = "";
  /** Submitted lines, in the order they were typed; steer marks the ones the running turn takes. */
  private queued: { text: string; steer: boolean }[] = [];
  /** Command dropdown under the band, and the row the arrows are on. */
  private menu: Suggestion[] = [];
  private menuIdx = 0;
  /** Escape closed it; typing again opens it. */
  private menuDismissed = false;
  private lastMenuBuf: string | null = null;
  /** Rows the open command list adds to the bar; borrowed from the transcript. */
  private menuBlockRows = 0;
  private pasting = false;
  private pasteBuf = "";
  private watch = new InterruptWatcher(() => this.escape());
  /** The head of an escape sequence whose tail has not arrived yet. */
  private held = "";

  constructor(private opts: TurnBarOptions) {}

  start(): void {
    if (!process.stdout.isTTY || this.timer) return;
    this.started = Date.now();
    this.rate = new OutputRate();
    this.previewShown = false;
    this.menu = [];
    this.menuIdx = 0;
    this.menuDismissed = false;
    this.lastMenuBuf = null;
    setFooter(() => this.rows(), () => this.caret, () => this.menuBlockRows);
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
    setFooter(() => this.rows(), () => this.caret, () => this.menuBlockRows);
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

  /**
   * Output tokens that just streamed in. The speed in the spinner line is
   * measured over these and their timestamps, not over the turn's clock: a turn
   * spends most of its time in tools and waits, and dividing by that reported a
   * figure that had nothing to do with the model's throughput.
   */
  noteOutput(tokens: number): void {
    this.rate.note(tokens);
  }

  /** The step ended — its usage line has arrived, so generation time stops. */
  endOutput(): void {
    this.rate.close();
  }

  /** Milliseconds this turn's model spent generating, for the statistics line. */
  generationMs(): number {
    return this.rate.generationMs();
  }

  setThinking(rows: string[]): void {
    this.thinking = rows;
    if (rows.length) this.previewShown = true;
    refreshFooter();
  }

  /**
   * The helper list: one row per running subagent, plus progress lines from
   * /orchestrate and /swarm. Unlike the reasoning preview these rows are not
   * reserved for the turn — they go when the work they describe is done, and
   * the footer hands the rows back to the transcript.
   */
  setActivity(rows: string[]): void {
    this.activity = rows;
    refreshFooter();
  }

  /**
   * The answer has started: the reasoning preview has no more to say, and the
   * rows it holds are better given back *now* than at the end of the turn.
   *
   * Reserved to the end, they cost the composer its place: the bar stays five
   * rows taller than the idle input, and when the turn closes those rows have
   * nowhere to go but the gap between the answer and the input. Released while
   * the answer still streams, each row is handed back to the transcript, which
   * is writing anyway and takes them one by one.
   */
  endReasoning(): void {
    if (!this.previewShown && !this.thinking.length) return;
    this.previewShown = false;
    this.thinking = [];
    refreshFooter();
  }

  /** Removes the bar and hands back what the user typed while waiting. */
  stop(): { queued: string[]; draft: string } {
    this.pause();
    this.started = 0;
    this.rate.close();
    return { queued: this.queued.map((q) => q.text), draft: this.buf.trim() };
  }

  /**
   * The turn took the steered lines: their rows go, and what is left in the
   * list is only what was queued for after the turn.
   */
  markSteered(): void {
    if (!this.queued.some((q) => q.steer)) return;
    this.queued = this.queued.filter((q) => !q.steer);
    refreshFooter();
  }

  // ── input ────────────────────────────────────────────────────────────────

  /**
   * Esc with the command list open closes the list, as it does in the idle
   * composer. Reaching for Esc to put away a list typed by mistake used to
   * cancel the whole turn. With no list open it stops the turn, as before.
   */
  private escape(): void {
    if (this.menu.length) {
      this.menuDismissed = true;
      this.menu = [];
      refreshFooter();
      return;
    }
    this.opts.onInterrupt();
  }

  private onData(b: Buffer): void {
    let s = b.toString("utf8");

    // Ctrl+C is never a menu key: it stops the turn whatever is open.
    if (!this.pasting && s.includes(CTRL_C)) {
      this.watch.stop();
      this.opts.onInterrupt();
      return;
    }
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
    // Tab is the other half of Enter: the same message, but held for the next
    // turn instead of delivered into this one.
    if (s === "\t") return this.enqueue();
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
        // With the command dropdown open the arrows are its, as in the idea
        // composer: choosing a command is what the up key means there.
        if (this.menu.length) {
          this.menuIdx =
            s === KEY.up
              ? (this.menuIdx - 1 + this.menu.length) % this.menu.length
              : (this.menuIdx + 1) % this.menu.length;
          return refreshFooter();
        }
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
   * Keeps the dropdown in step with the line being typed. Called from rows(),
   * which every repaint goes through, so no edit can leave it stale.
   */
  private syncMenu(): void {
    if (!this.opts.suggest) return;
    if (this.lastMenuBuf !== this.buf) {
      this.menuDismissed = false;
      this.lastMenuBuf = this.buf;
    }
    const browsing = this.historyIdx !== -1;
    const next = this.menuDismissed || browsing ? [] : this.opts.suggest(this.buf);
    if (next.length !== this.menu.length || next[0]?.value !== this.menu[0]?.value) this.menuIdx = 0;
    this.menu = next;
    if (this.menuIdx >= this.menu.length) this.menuIdx = Math.max(0, this.menu.length - 1);
  }

  /** Puts the highlighted command in the line instead of sending it. */
  private applySuggestion(): boolean {
    const pick = this.menu[this.menuIdx];
    if (!pick) return false;
    if (pick.value === this.buf.trim()) return false;
    this.buf = pick.value + " ";
    this.pos = this.buf.length;
    this.menuDismissed = false;
    this.syncMenu();
    return true;
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
    const rows = rowSpansOf(this.buf, bandTextWidth());
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
    // Enter picks the highlighted command first, exactly as it does in the
    // composer; the picked line then goes out on the next Enter.
    if (this.menu.length && this.applySuggestion()) return refreshFooter();
    // A slash command is not something to say to the model — it is the REPL's,
    // and steering it into the running turn would have the model read "/model"
    // as prose. It waits for the turn to end, which is what Tab does.
    if (this.opts.onSteer && !text.startsWith("/")) {
      this.queued.push({ text, steer: true });
      this.opts.onSteer(text);
    } else {
      this.queued.push({ text, steer: false });
    }
    this.clear();
  }

  /** Tab: sent when this turn ends, as its own turn. */
  private enqueue(): void {
    const text = this.buf.trim();
    if (!text) return;
    this.queued.push({ text, steer: false });
    this.clear();
  }

  private clear(): void {
    this.buf = "";
    this.pos = 0;
    this.edited();
    refreshFooter();
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  private rows(): string[] {
    const w = contentWidth();
    const inner = bandTextWidth();
    this.syncMenu();
    const st = this.opts.status();
    const queued = this.queued.filter((q) => !q.steer).slice(-2);
    // Steered lines are still in the bar until the turn picks them up: with a
    // ten-minute build running, an input box that just emptied is the user's
    // message vanishing into silence.
    const steering = this.queued.filter((q) => q.steer).slice(-2);
    const bufRows = wrapBuf(this.buf, inner);
    // The preview area keeps its height for the rest of the turn once it has
    // appeared. A block that grows and shrinks while it sits at the bottom of
    // the screen cannot stay there: the rows it gives back are either blank
    // rows inside the conversation or blank rows at the bottom, and a gap
    // between two messages is the worse of the two.
    const preview = this.previewShown ? this.thinking.slice(-PREVIEW_ROWS) : [];
    const activity = this.activity.slice(-ACTIVITY_ROWS);
    // The dropdown keeps its height while the filter narrows it down (see
    // suggestionLines) and sits in a panel, so one number covers it here too:
    // the list rows, the keys row and the two borders.
    const menuRows = this.menu.length ? (this.opts.suggestRows ?? 6) + 1 + 2 : 0;
    const chrome =
      1 + // gap above the live block
      1 + // gap under the preview
      1 + // spinner
      queued.length +
      steering.length +
      1 + // gap above the input
      1 + // band row of its own above the text
      Math.max(1, bufRows.length) +
      1 + // band row of its own below the text
      (menuRows ? menuRows : 0) +
      1 + // gap above the status rows
      2; // status
    const termRows = Math.max(10, process.stdout.rows || 24);
    // A short window keeps the bar on screen: the preview gives rows back first,
    // because everything under it — the input and the status rows — has to stay
    // visible, and a bar taller than the screen would push them off it.
    const room = Math.max(0, termRows - chrome - 1);
    // The helper list keeps its rows ahead of the reasoning preview: it is the
    // only line about work that is actually running, and its height matters to
    // whoever is waiting on four subagents at once.
    const liveActivity = activity.slice(-Math.min(activity.length, room));
    const previewRows = Math.min(preview.length, Math.max(0, room - (liveActivity.length ? liveActivity.length + 1 : 0)));
    const thinking = preview.slice(-previewRows);

    const rows: string[] = [];

    // A gap between the transcript above and the live block: without it the
    // streamed text and the spinner (or reasoning preview) read as one blob.
    rows.push("");
    for (const a of liveActivity) {
      rows.push(indent + "  " + clipAnsi(a, Math.max(10, w - 4)));
    }
    // The list is its own block, like the preview under it: without a row
    // between them the last helper row reads as part of the reasoning text.
    if (liveActivity.length) rows.push("");
    for (const tl of thinking) {
      rows.push(indent + "  " + c.dim(clipRow(tl, Math.max(10, w - 4))));
    }
    // The area is reserved, so a shorter preview leaves blank rows under the
    // transcript rather than moving everything below it.
    for (let i = thinking.length; i < previewRows; i++) rows.push("");
    // The preview is its own block: without a row between it and the spinner
    // the reasoning text and the status read as one paragraph.
    if (previewRows) rows.push("");
    rows.push(indent + clipAnsi(this.spinnerLine(), w));
    for (const q of steering) {
      rows.push(indent + c.cyan("  ⎿ steering: ") + c.dim(clipRow(q.text, inner - 12)));
    }
    for (const q of queued) {
      rows.push(indent + c.gray("  ⎿ queued: ") + c.dim(clipRow(q.text, inner - 10)));
    }

    // The command dropdown sits *above* the band, in the same panel the idle
    // composer draws: a list under the line you type reads as part of the
    // status bar, and every extra row below the input pushes the status rows
    // off the screen.
    const menuBlock = this.menu.length
      ? panelRows(suggestionLines(this.menu, this.menuIdx, w, this.opts.suggestRows ?? 6))
      : [];
    // No gap of its own under the panel: the band's own gap row follows, and
    // two blank rows there read as the list having nothing to do with the input.
    for (const l of menuBlock) rows.push(l);
    // The list is drawn over the transcript rather than pushing it up (see
    // setFooter's cover): it lives for a few keystrokes, and a bar that grew
    // for it left that many blank rows above itself once it closed.
    this.menuBlockRows = menuBlock.length;

    // The band keeps a row of its own colour above and below the text: a
    // one-row strip reads as a hairline, not as the line you type on.
    rows.push("");
    rows.push(bandRow());
    for (const [i, r] of bufRows.entries()) {
      const marker = i === 0 ? c.brightCyan("› ") : "  ";
      rows.push(bandRow(indent + marker + c.brightWhite(r.padEnd(inner))));
    }
    // The caret follows this.pos through the wrapped draft, the way the idle
    // editor parks it. bufRows end at the current last row, so the first of
    // them is where locatePos's rows count from.
    const at = locatePos(this.buf, this.pos, inner);
    const firstBufRow = rows.length - bufRows.length;
    this.caret = {
      row: firstBufRow + at.row,
      col: PAD_LEFT + 2 + at.col,
    };
    rows.push(bandRow());
    // A dark row between the band and the status: the band is the conversation,
    // the status is chrome, and without the gap the two read as one block.
    rows.push("");

    const gap = Math.max(2, statusWidth() - width(st.left) - width(st.hint));
    rows.push(indent + st.left + " ".repeat(gap) + st.hint);
    rows.push(indent + contextRow(st, statusWidth()));
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
    // Tokens per second of generation — the minutes a tool call or a rate-limit
    // wait takes are not the model's speed. See OutputRate.
    const rate = this.rate.perSecond();
    const tps = rate === null ? "" : ` · ${fmtCompact(Math.round(rate))} tok/s`;
    const command = this.buf.trim().startsWith("/");
    const hint = this.menu.length
      ? c.gray("  enter to pick · esc to close the list")
      : this.buf.trim()
        ? command && this.opts.onSteer
          ? c.gray("  enter to queue the command · esc to interrupt")
          : c.gray(this.opts.onSteer ? "  enter to steer · tab to queue · esc to interrupt" : "  enter to queue · esc to interrupt")
        : c.gray(this.opts.onSteer ? "  esc to interrupt · type to steer" : "  esc to interrupt · type to queue a message");
    return (
      c.brightMagenta(FRAMES[this.frame % FRAMES.length]) +
      " " +
      // The model's own colour in the status rows: what the model is doing
      // right now reads at a glance, not as one more grey line.
      c.brightCyan(this.label) +
      c.gray(` (${elapsed}${counts}${tps})`) +
      hint
    );
  }
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
