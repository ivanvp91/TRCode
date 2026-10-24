/**
 * Raw-mode line editor that owns its own rendering.
 *
 * readline cannot be used here: every repaint it performs calls
 * clearScreenDown(), which erases anything drawn below the input — so a status
 * line underneath the prompt is impossible with it. Owning the input loop lets
 * us draw the frame, grow it across wrapped lines, and keep the status rows
 * pinned below.
 */
import { appendFileSync } from "node:fs";
import { stashPaste, takeCollapsed } from "./paste.js";
import { panelRows } from "./panel.js";
import { pushConsumer } from "./stdin.js";
import { c, clipAnsi, cursor, esc, hasColor, width } from "./ansi.js";
import { t } from "../i18n.js";
import { bandTextWidth, contentWidth, fullWidth, indent, PAD_LEFT, statusWidth } from "./layout.js";
import { contextRow } from "./inputbox.js";
import {
  expandedBlock,
  bandRow,
  bottomDrawn,
  bottomGap,
  bottomPinned,
  reclaimGap,
  takeFooterSlack,
  tailRows,
  screenHeight,
  noteBlankRows,
  sealBlankRows,
  line,
  padded,
  paintFrame,
} from "./render.js";

const CTRL_A = String.fromCharCode(1);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const CTRL_E = String.fromCharCode(5);
const CTRL_K = String.fromCharCode(11);
const CTRL_U = String.fromCharCode(21);
const CTRL_W = String.fromCharCode(23);
const BACKSPACE = String.fromCharCode(8);
const DEL = String.fromCharCode(127);
const ESC = String.fromCharCode(27);
const TAB = String.fromCharCode(9);

/** Everything below space except newline, plus DEL. */
const CONTROL_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(9) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");

const CTRL_L = String.fromCharCode(12);
/** Ctrl+O: prints the message the screen shortened. */
const CTRL_O = String.fromCharCode(15);
const LF = String.fromCharCode(10);
const FOCUS_IN = ESC + "[I";
const FOCUS_OUT = ESC + "[O";

/**
 * Everything a terminal might send for "newline, don't submit". In raw mode
 * plain Enter is CR, so LF is free to mean Ctrl+Enter — that is the split
 * Windows Terminal uses. The CSI forms come from terminals running the kitty
 * keyboard protocol or xterm's modifyOtherKeys, which do report the modifier.
 */
const NEWLINE_KEYS = new Set([
  LF, // Ctrl+Enter / Ctrl+J
  ESC + "\r", // Alt+Enter
  ESC + LF,
]);

/**
 * Enter with *any* modifier, in either reporting scheme:
 *   kitty            ESC [ 13 ; <mods> u
 *   modifyOtherKeys  ESC [ 27 ; <mods> ; 13 ~
 * Matching the whole family beats enumerating combinations — Ctrl+Shift+Enter
 * and Shift+Enter differ only in the modifier number.
 */
const MODIFIED_ENTER = new RegExp("^" + ESC + "\\[(?:13;[0-9]+u|27;[0-9]+;13~)$");

/** Extra sequences the user pinned in config → "newlineKeys". */
let extraNewlineKeys: string[] = [];
export function setExtraNewlineKeys(keys: string[]): void {
  extraNewlineKeys = keys.filter((k) => typeof k === "string" && k.length > 0);
}

/** True when this sequence inserts a newline instead of sending. */
export function isNewlineKey(s: string): boolean {
  return NEWLINE_KEYS.has(s) || MODIFIED_ENTER.test(s) || extraNewlineKeys.includes(s);
}
/** How long to wait for the rest of a split escape sequence. */
const ESCAPE_ASSEMBLY_MS = 40;
/** A bracketed paste that never closes is abandoned after this. */
const PASTE_TIMEOUT_MS = 3000;

/**
 * True when `s` looks like the beginning of an escape sequence whose final
 * byte has not arrived yet. A lone ESC is NOT partial — that is the Esc key.
 */
export function isPartialEscape(s: string): boolean {
  if (!s.startsWith(ESC)) return false;
  if (s.length > 16) return false; // too long to be a key; treat as text
  // A bare ESC is ambiguous: the Esc key, or the first byte of a sequence
  // whose tail is still in flight. Wait a moment and let the tail decide.
  if (s.length === 1) return true;
  // Only CSI (ESC[) and SS3 (ESCO) continue; ESC followed by anything else is
  // the Esc key plus ordinary input, and waiting for a tail would hang.
  const second = s[1];
  if (second !== "[" && second !== "O") return false;
  return !new RegExp("^" + ESC + "[\\[O][0-9;?]*[A-Za-z~]").test(s);
}

const PASTE_START = ESC + "[200~";
const PASTE_END = ESC + "[201~";
/** Ask the terminal to bracket pastes so they never look like keystrokes. */
const ENABLE_BRACKETED_PASTE = ESC + "[?2004h";
const DISABLE_BRACKETED_PASTE = ESC + "[?2004l";

export const KEY = {
  up: ESC + "[A",
  down: ESC + "[B",
  right: ESC + "[C",
  left: ESC + "[D",
  home: ESC + "[H",
  end: ESC + "[F",
  homeAlt: ESC + "[1~",
  endAlt: ESC + "[4~",
  del: ESC + "[3~",
};

/**
 * Shift+Tab. `ESC[Z` is the classic backtab; the other two come from terminals
 * running the kitty keyboard protocol or xterm's modifyOtherKeys, which report
 * Tab-with-shift as a modified key instead.
 */
export const SHIFT_TAB = [ESC + "[Z", ESC + "[27;2;9~", ESC + "[9;2u"];

export interface EditorStatus {
  /** Left part of the first status row. */
  left: string;
  /** Right part of the first status row (hint). */
  hint: string;
  /** Right-aligned second status row. */
  context: string;
  /** Session name immediately before context on the second status row. */
  session?: string;
}

export interface Suggestion {
  value: string;
  hint: string;
}

/**
 * The command dropdown, drawn identically under the idle composer and under
 * the turn bar — the same list, the same keys, wherever the line is typed.
 *
 * `room` is the height it keeps while the filter narrows it down: a block at
 * the bottom of the screen that changes height has to give rows back
 * somewhere, and either place leaves a hole next to the input.
 */
export function suggestionLines(
  menu: Suggestion[],
  menuIdx: number,
  w: number,
  room = 6,
  keys = "  ↑↓ · Enter to pick · Esc to dismiss",
  /** Fill the block out to `room` rows — the composer's own layout needs that. */
  pad = true,
): string[] {
  if (!menu.length) return [];
  const visible = Math.min(room, menu.length);
  const half = Math.floor(visible / 2);
  const start = Math.max(0, Math.min(menuIdx - half, menu.length - visible));
  const nameWidth = Math.min(22, Math.max(...menu.map((m) => m.value.length)) + 1);

  const rows: string[] = [];
  for (let i = start; i < start + visible; i++) {
    const item = menu[i];
    const active = i === menuIdx;
    const marker = active ? c.brightCyan("→ ") : "  ";
    const name = active ? c.bold(c.brightCyan(item.value.padEnd(nameWidth))) : item.value.padEnd(nameWidth);
    const hintRoom = Math.max(10, w - nameWidth - 8);
    const hint = c.dim(item.hint.length > hintRoom ? item.hint.slice(0, hintRoom - 1) + "…" : item.hint);
    rows.push(indent + "  " + marker + name + " " + hint);
  }
  if (!pad) {
    // An overlay: just the list, plus the one row that says what the keys do.
    rows.push(indent + "    " + c.gray(`(${menuIdx + 1}/${menu.length})`) + c.dim(keys));
    return rows;
  }
  for (let i = visible; i < room; i++) rows.push("");
  rows.push(indent + "    " + c.gray(`(${menuIdx + 1}/${menu.length})`) + c.dim(keys));
  return rows;
}

export interface EditorOptions {
  /** Re-read on every repaint so model/context changes show immediately. */
  status: () => EditorStatus;
  /** Shared, mutated on submit. */
  history: string[];
  /** Tab completion for slash commands. */
  complete?(partial: string): string[];
  /** Live dropdown under the frame; returns [] to keep it closed. */
  suggest?(buffer: string): Suggestion[];
  /** How many suggestion rows to show at once. */
  suggestRows?: number;
  /** Shift+Tab: cycles the confirmation mode without leaving the input. */
  onToggleMode?(): void;
  /**
   * The first keystroke of a read. The welcome animation paints cells at fixed
   * screen coordinates; from the moment the frame starts growing, scrolling or
   * the menu overlay can move the rows under it, and those coordinates stop
   * pointing at the logo.
   */
  onFirstKey?(): void;
}

/**
 * Bracketed paste is terminal state, not process state: if we exit without
 * turning it off, the user's shell inherits it and pastes start arriving with
 * visible escape markers.
 */
let bracketedPasteOn = false;
function setBracketedPaste(on: boolean): void {
  if (on === bracketedPasteOn || !process.stdout.isTTY) return;
  bracketedPasteOn = on;
  process.stdout.write(on ? ENABLE_BRACKETED_PASTE : DISABLE_BRACKETED_PASTE);
}
process.on("exit", () => {
  if (bracketedPasteOn) process.stdout.write(DISABLE_BRACKETED_PASTE);
});

/**
 * Raw-input logging for diagnosing terminal quirks. Set TRCODE_DEBUG_KEYS to a
 * file path and every chunk the terminal delivers is appended as hex plus a
 * readable form — the only reliable way to see what a terminal really sends on
 * a focus change or a paste.
 */
const KEYLOG = process.env.TRCODE_DEBUG_KEYS;
function logKeys(label: string, s: string): void {
  if (!KEYLOG) return;
  const hex = Buffer.from(s, "utf8").toString("hex").replace(/(..)/g, "$1 ").trim();
  const readable = s.replace(new RegExp(ESC, "g"), "<ESC>").replace(/\r/g, "<CR>").replace(/\n/g, "<LF>");
  try {
    appendFileSync(KEYLOG, `${new Date().toISOString()} ${label.padEnd(9)} ${hex}   ${readable}\n`);
  } catch {
    /* diagnostics must never break input */
  }
}

/** Strips terminal noise from a pasted chunk while keeping newlines. */

export function cleanPaste(s: string): string {
  return s
    .replace(new RegExp(ESC + "\\[[0-9;]*[~A-Za-z]", "g"), "")
    .replace(CONTROL_CHARS, "")
    .replace(/\r\n?/g, "\n");
}

/**
 * Wraps a buffer into rows that fit inside the frame. Shared with the turn
 * bar, whose input must look and steer exactly like this one.
 *
 * The break goes at the last space that still fits, and only a run with no
 * space in it — a path, base64, minified JSON — is cut by force. A terminal
 * splits words down the middle; an editor does not, and reading your own
 * sentence back with a word sawn in half is the difference.
 */
export function wrapBuf(buf: string, inner: number): string[] {
  return rowSpansOf(buf, inner).map((r) => buf.slice(r.start, r.start + r.len));
}

/** Buffer index → (row, column) inside the wrapped text. */
export function locatePos(buf: string, pos: number, inner: number): { row: number; col: number } {
  const rows = rowSpansOf(buf, inner);
  const clamped = Math.max(0, Math.min(pos, buf.length));
  const at = clampToRows(rows, clamped);
  return { row: at, col: Math.min(clamped - rows[at].start, rows[at].len) };
}

/**
 * The row a buffer index falls on: the last one starting at or before it. On a
 * wrap boundary that is the row below, which is where the next character —
 * and the caret — are.
 */
function clampToRows(rows: { start: number; len: number }[], pos: number): number {
  let at = 0;
  while (at + 1 < rows.length && rows[at + 1].start <= pos) at++;
  return at;
}

/** Where each wrapped row starts in the buffer, and how long it is. */
export function rowSpansOf(buf: string, inner: number): { start: number; len: number }[] {
  const width = Math.max(1, inner);
  const rows: { start: number; len: number }[] = [];
  let at = 0;
  for (const para of buf.split("\n")) {
    if (!para.length) {
      rows.push({ start: at, len: 0 });
    } else {
      let i = 0;
      while (i < para.length) {
        // A row never opens on the space the previous row broke at: that space
        // is the break, not the first character of a line.
        if (i > 0) while (i < para.length && para[i] === " ") i++;
        if (i >= para.length) break;
        const room = Math.min(width, para.length - i);
        if (room === para.length - i) {
          rows.push({ start: at + i, len: room });
          break;
        }
        // Break after the last space that still fits, and only cut inside a run
        // when there is no space to break at at all — a path, base64, minified
        // JSON. The space rides at the end of the row; the band pads it anyway.
        const space = para.lastIndexOf(" ", i + room - 1);
        const len = space > i ? space - i + 1 : room;
        rows.push({ start: at + i, len });
        i += len;
      }
    }
    at += para.length + 1; // +1 for the newline itself
  }
  return rows.length ? rows : [{ start: 0, len: 0 }];
}

export class InputEditor {
  private buf = "";
  private pos = 0;
  private renderedRows = 0;
  private cursorRow = 0;
  /** Rows this frame opened under the transcript to reach the bottom edge. */
  private dropRows = 0;
  /** Rows of the conversation the menu overlay is covering, and what was there. */
  private overlayCount = 0;
  private overlaySaved: string[] = [];
  private historyIdx = -1;
  private draft = "";
  private menu: Suggestion[] = [];
  private menuIdx = 0;
  private menuDismissed = false;
  private lastMenuBuf: string | null = null;
  /** Set between ESC[200~ and ESC[201~ while a bracketed paste arrives. */
  private pasting = false;
  private pasteBuf = "";
  private pasteStarted = 0;
  /** Half-received escape sequence waiting for the rest of its bytes. */
  private pendingEsc = "";
  private pendingTimer: NodeJS.Timeout | null = null;

  /** Consumes and clears the buffered partial escape sequence. */
  private takePending(): string {
    const held = this.pendingEsc;
    this.pendingEsc = "";
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    return held;
  }

  /**
   * Holds a partial sequence for a few milliseconds. If the rest never comes
   * it was a bare Esc after all, so the fragment is dropped rather than typed.
   */
  private holdPartial(s: string, onTimeout: (held: string) => void): void {
    this.pendingEsc = s;
    this.pendingTimer = setTimeout(() => {
      const held = this.pendingEsc;
      this.pendingEsc = "";
      this.pendingTimer = null;
      if (held) onTimeout(held);
    }, ESCAPE_ASSEMBLY_MS);
    this.pendingTimer.unref?.();
  }

  /**
   * Redraws the frame without assuming the old one is still where we left it.
   * After a window switch, a resize or an external write the terminal may have
   * scrolled, and erasing by cursor arithmetic would eat the wrong lines.
   */
  private repaint(): void {
    // Redraw in place. erase() clears from the frame's first row downward, so
    // nothing is left behind; dropping the tracked geometry here would skip
    // that erase and stack a second frame on top of the first one.
    this.draw();
  }

  constructor(private opts: EditorOptions) {}

  /**
   * Inserts the paste once its end marker shows up. Returns true when the
   * paste completed, false while more chunks are still expected.
   */
  private tryFinishPaste(): boolean {
    const end = this.pasteBuf.indexOf(PASTE_END);
    if (end === -1) {
      // Guard against a terminal that never sends the closing marker.
      if (this.pasteBuf.length > 1_000_000) {
        this.pasting = false;
        this.insert(stashPaste(cleanPaste(this.pasteBuf)));
        this.pasteBuf = "";
        return true;
      }
      return false;
    }
    const text = this.pasteBuf.slice(0, end);
    this.pasting = false;
    this.pasteBuf = "";
    // Held aside when it is big: the frame shows a token, the model gets
    // the whole thing back when the line is sent.
    this.insert(stashPaste(cleanPaste(text).replace(/\n$/, "")));
    return true;
  }

  /** The dropdown tracks the buffer; Esc closes it until the buffer changes. */
  private refreshMenu(): void {
    if (!this.opts.suggest) return;
    // While walking the history the arrows belong to the history, not to a
    // dropdown that pops up merely because a recalled line starts with "/".
    const browsing = this.historyIdx !== -1;
    const next = this.menuDismissed || browsing ? [] : this.opts.suggest(this.buf);
    if (next.length !== this.menu.length || next[0]?.value !== this.menu[0]?.value) this.menuIdx = 0;
    this.menu = next;
    if (this.menuIdx >= this.menu.length) this.menuIdx = Math.max(0, this.menu.length - 1);
  }

  /** Replaces the typed command with the highlighted one. */
  private applySuggestion(): boolean {
    const pick = this.menu[this.menuIdx];
    if (!pick) return false;
    if (pick.value === this.buf.trim()) return false;
    this.buf = pick.value + " ";
    this.pos = this.buf.length;
    this.menuDismissed = false;
    this.refreshMenu();
    return true;
  }

  /** Aborts a pending read(), restoring the terminal. Safe to call twice. */
  cancel(): void {
    this.abortRead?.();
  }

  private abortRead: (() => void) | null = null;

  /**
   * Seeds the next read(). Used when a turn ends with unsent text still in the
   * bar — throwing away what the user typed would be worse than anything else
   * this class does.
   */
  prefill(text: string): void {
    this.pendingPrefill = text;
  }
  /** Kept apart from `draft`, which history navigation owns during a read. */
  private pendingPrefill = "";

  /** Resolves with the submitted line, or null on Ctrl+C / Ctrl+D. */
  read(): Promise<string | null> {
    const stdin = process.stdin;
    this.buf = this.pendingPrefill;
    this.pendingPrefill = "";
    this.pos = this.buf.length;
    this.historyIdx = -1;
    this.renderedRows = 0;
    this.cursorRow = 0;
    this.menu = [];
    this.menuIdx = 0;
    this.menuDismissed = false;
    this.lastMenuBuf = null;
    this.dropRows = 0;

    return new Promise((resolve) => {
      setBracketedPaste(true);
      // Attached at the end of read(), once onData exists.
      let release: () => void = () => {};

      const onResize = () => this.repaint();
      process.stdout.on("resize", onResize);

      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        this.abortRead = null;
        release();
        process.stdout.removeListener("resize", onResize);
        setBracketedPaste(false);
        this.pasting = false;
        this.pasteBuf = "";
        this.takePending();
        this.erase();
        // The frame had been dropped to the bottom of the screen, and the rows
        // it opened above itself are blank. Walking back up puts the cursor on
        // the last line of the transcript, so the echo, the answer and any
        // panel open right under the conversation instead of at the bottom of
        // a mostly empty screen. The rows are owed to the next block, which
        // opens them again when the input comes back.
        if (this.dropRows) {
          process.stdout.write(esc.up(this.dropRows));
          reclaimGap(this.dropRows);
          this.dropRows = 0;
        }
        cursor.show();
        resolve(value);
      };

      // Lets the REPL unwind this read from the outside, e.g. on Ctrl+C.
      this.abortRead = () => finish(null);

      let firstKey = false;
      const handle = (s: string, final: boolean): void => {
        logKeys(final ? "flush" : "chunk", s);
        // The welcome animation paints at fixed coordinates, and from here on
        // the screen can move under it. One keystroke is all the signal needed.
        if (!firstKey && s.length) {
          firstKey = true;
          this.opts.onFirstKey?.();
        }
        // An escape sequence can be split across chunks; a half-read one must
        // not be treated as text, or stray "[" characters land in the buffer.
        if (!final && isPartialEscape(s)) {
          // Whatever the tail turns out to be, decide once it arrives — or
          // once the wait expires and it is simply the Esc key.
          return this.holdPartial(s, (held) => handle(held, true));
        }

        // Focus in/out. Some terminals report these; on returning to the window
        // the frame is repainted from scratch, because a desynced frame is
        // exactly what makes the prompt look frozen.
        if (s === FOCUS_IN || s === FOCUS_OUT) {
          logKeys("focus", s === FOCUS_IN ? "in" : "out");
          if (s === FOCUS_IN) this.repaint();
          return;
        }

        // Bracketed paste: the terminal brackets the clipboard in
        // ESC[200~ … ESC[201~ and may split it across several chunks.
        if (this.pasting) {
          // A paste that never closes would swallow every later keystroke.
          if (Date.now() - this.pasteStarted > PASTE_TIMEOUT_MS) {
            this.pasting = false;
            this.insert(cleanPaste(this.pasteBuf));
            this.pasteBuf = "";
            this.draw();
          } else {
            this.pasteBuf += s;
            return this.tryFinishPaste() ? this.draw() : undefined;
          }
        }
        if (s.includes(PASTE_START)) {
          this.pasting = true;
          this.pasteStarted = Date.now();
          this.pasteBuf = s.slice(s.indexOf(PASTE_START) + PASTE_START.length);
          return this.tryFinishPaste() ? this.draw() : undefined;
        }

        // A multi-character chunk that is not a known key is pasted text.
        if (s.length > 2 && !s.startsWith(ESC)) {
          this.insert(cleanPaste(s).replace(/\n$/, ""));
          return this.draw();
        }

        // Newline instead of send. Plain Enter is CR in raw mode, so LF means
        // Ctrl+Enter (Ctrl+J) — the split Windows Terminal and conhost use.
        // The rest are the sequences other terminals emit for Shift/Alt+Enter.
        if (isNewlineKey(s)) {
          this.insert("\n");
          return this.draw();
        }

        switch (s) {
          case "\r": {
            // Trailing backslash continues onto a new line instead of sending.
            if (this.buf.endsWith("\\")) {
              this.buf = this.buf.slice(0, -1);
              this.pos = Math.min(this.pos, this.buf.length);
              this.insert("\n");
              return this.draw();
            }
            if (this.menu.length && this.applySuggestion()) return this.draw();
            return finish(this.buf);
          }
          case CTRL_C:
            if (this.buf) {
              this.buf = "";
              this.pos = 0;
              return this.draw();
            }
            return finish(null);
          case CTRL_D:
            if (!this.buf) return finish(null);
            return;
          case BACKSPACE:
          case DEL:
            this.markEdited();
            if (this.pos > 0) {
              this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos);
              this.pos--;
            }
            return this.draw();
          case KEY.del:
            this.markEdited();
            if (this.pos < this.buf.length) this.buf = this.buf.slice(0, this.pos) + this.buf.slice(this.pos + 1);
            return this.draw();
          case KEY.left:
            if (this.pos > 0) this.pos--;
            return this.draw();
          case KEY.right:
            if (this.pos < this.buf.length) this.pos++;
            return this.draw();
          case KEY.home:
          case KEY.homeAlt:
          case CTRL_A:
            this.pos = 0;
            return this.draw();
          case KEY.end:
          case KEY.endAlt:
          case CTRL_E:
            this.pos = this.buf.length;
            return this.draw();
          case KEY.up:
            if (this.menu.length) this.menuIdx = (this.menuIdx - 1 + this.menu.length) % this.menu.length;
            else if (!this.moveLine(-1)) this.historyStep(-1);
            return this.draw();
          case KEY.down:
            if (this.menu.length) this.menuIdx = (this.menuIdx + 1) % this.menu.length;
            else if (!this.moveLine(1)) this.historyStep(1);
            return this.draw();
          case CTRL_U:
            this.markEdited();
            this.buf = this.buf.slice(this.pos);
            this.pos = 0;
            return this.draw();
          case CTRL_K:
            this.markEdited();
            this.buf = this.buf.slice(0, this.pos);
            return this.draw();
          case CTRL_W: {
            this.markEdited();
            // bash's unix-word-rubout: kill the word, keep the space before it.
            const left = this.buf.slice(0, this.pos).replace(/\S+$/, "");
            this.buf = left + this.buf.slice(this.pos);
            this.pos = left.length;
            return this.draw();
          }
          case TAB:
            if (this.menu.length) this.applySuggestion();
            else this.completeWord();
            return this.draw();
          case SHIFT_TAB[0]:
          case SHIFT_TAB[1]:
          case SHIFT_TAB[2]:
            // The status row is re-read on every draw, so the new mode shows
            // itself without printing anything above the frame.
            this.opts.onToggleMode?.();
            return this.draw();
          case CTRL_L:
            return this.repaint();
          case CTRL_O: {
            // The frame is at the bottom of the screen and owns those rows:
            // the block goes above it, then the frame comes back.
            const block = takeCollapsed();
            if (!block) return;
            this.erase();
            line();
            for (const l of expandedBlock(block.text)) padded(l);
            line();
            return this.draw();
          }
          case ESC:
            // Esc closes the dropdown; with none open it repaints, which is
            // the cheap way out of any frame desync.
            if (this.menu.length) {
              this.menuDismissed = true;
              this.menu = [];
              return this.draw();
            }
            return this.repaint();
          default: {
            // Anything left that carries printable characters is text. A chunk
            // starting with ESC lands here too (an unrecognised key sequence,
            // or a paste the terminal did not bracket) — stripping the escape
            // codes leaves exactly the characters the user meant to enter.
            const text = cleanPaste(s).replace(/\n$/, "");
            if (text) {
              this.insert(text);
              return this.draw();
            }
          }
        }
      };

      const onData = (chunk: Buffer) => handle(this.takePending() + chunk.toString("utf8"), false);

      release = pushConsumer(onData);
      this.draw();
    });
  }

  private insert(text: string): void {
    if (!text) return;
    this.markEdited();
    this.buf = this.buf.slice(0, this.pos) + text + this.buf.slice(this.pos);
    this.pos += text.length;
  }

  /**
   * Editing a recalled line turns it back into a draft: the arrows go to the
   * cursor/history again and the suggestion dropdown may reopen.
   */
  private markEdited(): void {
    this.historyIdx = -1;
  }

  /**
   * The vertical arrows serve two purposes on one key. Inside the draft they
   * move between the rows the frame shows, which is what the key does in
   * every editor; only from the top row (or the bottom) do they fall through
   * to the history, which is what it does in every shell. Returns false when
   * there is no row that way — that is the caller's cue to walk the history.
   *
   * Rows here are what the eye sees, not what the buffer holds: a long line
   * the frame had to wrap covers several rows, and walking it must not jump
   * to another prompt halfway through. Hence the same wrapping draw() uses,
   * rather than a count of newlines.
   *
   * While a recalled line is being browsed the history keeps the arrows, or a
   * multi-line entry would trap them and there would be no way back.
   */
  private moveLine(dir: -1 | 1): boolean {
    if (this.historyIdx !== -1) return false;
    const rows = rowSpansOf(this.buf, bandTextWidth());
    // The caret sits on the last row starting at or before it; on a wrap
    // boundary that is the row below, which is where draw() parks it too.
    let at = 0;
    while (at + 1 < rows.length && rows[at + 1].start <= this.pos) at++;
    const target = at + dir;
    if (target < 0 || target >= rows.length) return false;
    const col = this.pos - rows[at].start;
    this.pos = rows[target].start + Math.min(col, rows[target].len);
    return true;
  }

  private historyStep(dir: -1 | 1): void {
    const h = this.opts.history;
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

  private completeWord(): void {
    if (!this.opts.complete) return;
    const upto = this.buf.slice(0, this.pos);
    const m = /(\S*)$/.exec(upto);
    const partial = m ? m[1] : "";
    if (!partial.startsWith("/")) return;
    const hits = this.opts.complete(partial);
    if (hits.length === 1) {
      const add = hits[0].slice(partial.length) + " ";
      this.insert(add);
      return;
    }
    if (hits.length > 1) {
      // Extend to the longest shared prefix, which is what a shell does.
      let common = hits[0];
      for (const h of hits) {
        while (!h.startsWith(common)) common = common.slice(0, -1);
      }
      if (common.length > partial.length) this.insert(common.slice(partial.length));
    }
  }

  /** Wraps the buffer into rows that fit inside the frame. */
  private wrap(inner: number): string[] {
    return wrapBuf(this.buf, inner);
  }

  /** Buffer index → (row, column) inside the wrapped text. */
  private locate(inner: number): { row: number; col: number } {
    return locatePos(this.buf, this.pos, inner);
  }

  private erase(): void {
    if (!this.renderedRows) return;
    // One write, like every other frame here: the walk up and the clear must
    // not be two separate repaints for the terminal to show.
    process.stdout.write(esc.toColumn(1) + esc.up(this.cursorRow) + esc.clearDown);
    this.renderedRows = 0;
    this.cursorRow = 0;
    // What is printed next starts at the frame's old top, under the blank rows
    // it dropped over — they are history now, not a gap above the input.
    sealBlankRows();
  }

  /**
   * The dropdown rows, drawn over the conversation above the composer rather
   * than inside its frame. A menu that is part of the frame makes the frame
   * grow and shrink, and a block on the bottom edge cannot give rows back
   * without either a hole under the status or a scroll — on an empty session
   * the hole has nothing to fill it. Overlaid, the composer never moves.
   *
   * The rows come back wrapped in a panel: a grey border in the composer's own
   * ink, and a background a shade off the terminal's, so the list reads as a
   * thing floating over the text instead of a few lines of it.
   */
  private menuRows(w: number): string[] {
    if (!this.menu.length) return [];
    const body = suggestionLines(this.menu, this.menuIdx, w, this.opts.suggestRows ?? 6, undefined, false);
    return panelRows(body);
  }

  private syncMenu(): void {
    if (this.lastMenuBuf !== this.buf) {
      this.menuDismissed = false;
      this.lastMenuBuf = this.buf;
    }
    this.refreshMenu();
  }

  private draw(): void {
    if (!process.stdout.isTTY) return;
    this.syncMenu();

    const w = contentWidth();
    const inner = bandTextWidth();
    const rows = this.wrap(inner);
    const st = this.opts.status();
    // A line that starts with "!" is a shell command, not a message. Say it
    // where the keys are advertised — the moment before Enter is the only time
    // the difference can still change what happens.
    if (this.buf.startsWith("!") && this.buf.slice(1).trim()) {
      st.hint = c.dim(t("↵ runs it in the shell · the model never sees it", "↵ выполнит в оболочке · модели это не уйдёт"));
    }

    const lines: string[] = [];
    // The composer is the band the message will become once it is sent —
    // nothing frames it: a box around an input reads as a dialog, and this is
    // the conversation itself. The band keeps a row of its own colour above
    // and below the text, so the line has height instead of a hairline, and a
    // dark row separates it from whatever was printed above.
    lines.push("");
    lines.push(bandRow());
    // The first row the draft itself occupies: the caret is parked relative
    // to it, and a row added above the band must not move the caret with it.
    const textTop = lines.length;
    for (const [i, r] of rows.entries()) {
      const marker = i === 0 ? c.brightCyan("› ") : "  ";
      lines.push(bandRow(indent + marker + c.brightWhite(r.padEnd(inner))));
    }
    lines.push(bandRow());

    // The command menu is not part of the frame any more: it is painted over
    // the rows above the composer (see paintOverlay). A block that grew to hold
    // it would drag the composer up the screen and leave a hole under the
    // status when it closed — on an empty session, a hole with nothing to fill
    // it. The frame's height is now the same whether the menu is open or not.
    const menu = this.opts.suggest ? this.menuRows(w) : [];

    // A dark row between the band and the status: the band is the conversation,
    // the status is chrome, and without the gap the two read as one block.
    lines.push("");

    const gap = Math.max(2, statusWidth() - width(st.left) - width(st.hint));
    lines.push(indent + st.left + " ".repeat(gap) + st.hint);
    lines.push(indent + contextRow(st, statusWidth()));

    // Every row below is counted as one, and the walk back up on the next
    // repaint counts the same way. A row wider than the terminal breaks that:
    // it takes two physical rows, the walk stops one short, and the repaint
    // lands below the old frame instead of over it — one ghost frame per
    // keystroke. Clipping is what keeps a rendered line worth exactly one row.
    const room = fullWidth();

    for (const [i, l] of lines.entries()) if (width(l) > room) lines[i] = clipAnsi(l, room);

    // The whole repaint goes out as one write. Clearing the old box first and
    // drawing the new one after left a moment with nothing on screen, and on
    // every keystroke that moment is what flickered. Writing over the old rows
    // instead means no frame ever shows the box missing. The caret is hidden
    // for the walk: otherwise it reads as jumping a line up and snapping back.
    const prev = this.renderedRows;
    const reclaimed = prev ? 0 : takeFooterSlack(lines.length);
    const shrink = Math.max(0, prev - lines.length);
    // Return rows freed by a shorter draft immediately. Shifting the visible
    // transcript down keeps it adjacent to the input while the status stays
    // at the bottom, without accumulating padding during history navigation.
    const returned = bottomPinned() ? shrink : 0;
    // A taller window (or the first draw under a banner) opens rows below the
    // prompt, and the prompt follows them down: the composer belongs on the
    // last line of the screen, not wherever the frame happened to be left.
    // Rows reclaimed from a bar that came off the screen have already moved it
    // there — asking for a drop on top of that move would open a gap under the
    // stats, which is exactly the strip the reclaim exists to avoid.
    const drop = reclaimed ? 0 : bottomGap(lines.length);
    // The overlay puts back what it covers from the row log, so the blank rows
    // that hold the composer away from the transcript have to be in it: a menu
    // over a gap must restore a gap, not the last lines of the conversation.
    if (drop > 0) {
      this.dropRows += drop;
      noteBlankRows(drop);
    }
    let frame = esc.hide;
    if (prev) frame += esc.toColumn(1) + esc.up(this.cursorRow);
    // Only cleared footer rows are discarded. Moving the transcript with the
    // composer avoids converting the live spinner/preview height into a gap.
    // Capped at the screen: scrolling further than that only pushes the
    // conversation into the scrollback and leaves a blank terminal behind.
    const freed = Math.min(reclaimed + returned, Math.max(0, screenHeight() - lines.length));
    if (freed) frame += esc.clearDown + esc.scrollDown(freed) + esc.down(freed);
    if (drop) frame += esc.clearDown + "\n".repeat(drop);
    // Column 1 first, then wipe the row: what a shortened line used to occupy
    // has to go, and the emulators in the tests model K the same way.
    frame += lines.map((l) => esc.toColumn(1) + esc.clearRight + l).join("\n");
    if (!drop && shrink > 0 && !returned) frame += "\n" + esc.clearDown + esc.up(1);

    // Park the cursor inside the frame, on the row the caret belongs to.
    const { row, col } = this.locate(inner);
    const lastRow = lines.length - 1;
    const targetRow = textTop + row;
    const caretCol = PAD_LEFT + 2 + col + 1;
    frame += esc.up(lastRow - targetRow) + esc.toColumn(caretCol) + esc.show;
    paintFrame(frame);

    bottomDrawn(lines.length, drop > 0 || reclaimed > 0);
    this.paintOverlay(menu, targetRow, caretCol);
    this.renderedRows = lines.length;
    this.cursorRow = targetRow;
  }

  /**
   * Draws the menu over the rows above the frame, and puts back what it covered
   * when it shrinks or closes.
   *
   * The caret is at `caretRow` (0-based, inside the frame) when this runs, so
   * the rows the menu needs are `caretRow + menu.length` steps up from here.
   * The screen cannot be read back, so what stood there is remembered in
   * `saved` when the menu is first painted and written back when it goes away.
   * Every row it writes ends in a newline, which leaves the cursor in column 1:
   * `caretCol` puts it back after the text, or the block cursor sits in the
   * margin to the left of the "›".
   */
  private paintOverlay(menu: string[], caretRow: number, caretCol: number): void {
    if (!process.stdout.isTTY) return;
    // Never above the top of the screen: a frame that starts on row 0 has no
    // room for any of it, and a menu drawn past the edge would clobber the
    // composer instead of covering the conversation.
    const above = Math.max(0, screenHeight() - this.renderedRows);
    const count = Math.min(menu.length, above);
    const restore = this.overlayCount;
    if (!count && !restore) return;
    let seq = esc.hide;
    if (restore) {
      seq += esc.up(caretRow + restore);
      seq += this.overlaySaved.map((l) => esc.toColumn(1) + esc.clearRight + l).join("\n") + "\n";
      seq += esc.down(caretRow);
      this.overlaySaved = [];
      this.overlayCount = 0;
    }
    if (count) {
      // What is there now, before anything of the menu covers it.
      this.overlaySaved = tailRows(count);
      this.overlayCount = count;
      seq += esc.up(caretRow + count);
      seq += menu.map((l) => esc.toColumn(1) + esc.clearRight + l).join("\n") + "\n";
      seq += esc.down(caretRow);
    }
    seq += esc.toColumn(caretCol) + esc.show;
    process.stdout.write(seq);
  }
}

/** Line reader for pipes and redirected input — no rendering at all. */
export class PipeReader {
  private queue: string[] = [];
  private waiter: ((v: string | null) => void) | null = null;
  private closed = false;
  private buffer = "";
  private started = false;

  private start(): void {
    if (this.started) return;
    this.started = true;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const l = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nl + 1);
        this.deliver(l);
      }
    });
    process.stdin.on("end", () => {
      if (this.buffer) {
        this.deliver(this.buffer);
        this.buffer = "";
      }
      this.closed = true;
      this.deliver(null);
    });
    process.stdin.resume();
  }

  private deliver(v: string | null): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(v);
      return;
    }
    if (v !== null) this.queue.push(v);
  }

  read(): Promise<string | null> {
    this.start();
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}
