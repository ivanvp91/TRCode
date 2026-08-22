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
import { pushConsumer } from "./stdin.js";
import { c, cursor, esc, width } from "./ansi.js";
import { contentWidth, indent, PAD_LEFT } from "./layout.js";
import { line, padded, paintFrame, renderMarkdownBlock } from "./render.js";

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
function isPartialEscape(s: string): boolean {
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

const KEY = {
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
}

export interface Suggestion {
  value: string;
  hint: string;
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
/**
 * The cells of a frame row the text itself gets: the row is
 * "│" + space + "❯ " + text + "│" — five cells of chrome around it.
 */
function innerWidth(): number {
  return Math.max(10, contentWidth() - 5);
}

export function cleanPaste(s: string): string {
  return s
    .replace(new RegExp(ESC + "\\[[0-9;]*[~A-Za-z]", "g"), "")
    .replace(CONTROL_CHARS, "")
    .replace(/\r\n?/g, "\n");
}

export class InputEditor {
  private buf = "";
  private pos = 0;
  private renderedRows = 0;
  private cursorRow = 0;
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
        cursor.show();
        resolve(value);
      };

      // Lets the REPL unwind this read from the outside, e.g. on Ctrl+C.
      this.abortRead = () => finish(null);

      const handle = (s: string, final: boolean): void => {
        logKeys(final ? "flush" : "chunk", s);
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
            for (const l of renderMarkdownBlock(block.text)) padded(l);
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
    const rows = this.rowSpans(innerWidth());
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

  /** Where each wrapped row starts in the buffer, and how long it is. */
  private rowSpans(inner: number): { start: number; len: number }[] {
    const rows: { start: number; len: number }[] = [];
    let at = 0;
    for (const para of this.buf.split("\n")) {
      if (!para.length) rows.push({ start: at, len: 0 });
      else for (let i = 0; i < para.length; i += inner) rows.push({ start: at + i, len: Math.min(inner, para.length - i) });
      at += para.length + 1; // +1 for the newline itself
    }
    return rows.length ? rows : [{ start: 0, len: 0 }];
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
    const rows: string[] = [];
    for (const para of this.buf.split("\n")) {
      if (!para.length) {
        rows.push("");
        continue;
      }
      for (let i = 0; i < para.length; i += inner) rows.push(para.slice(i, i + inner));
    }
    return rows.length ? rows : [""];
  }

  /** Buffer index → (row, column) inside the wrapped text. */
  private locate(inner: number): { row: number; col: number } {
    let remaining = this.pos;
    let row = 0;
    for (const para of this.buf.split("\n")) {
      const lines = para.length ? Math.ceil(para.length / inner) : 1;
      if (remaining <= para.length) {
        return { row: row + Math.floor(remaining / inner), col: remaining % inner };
      }
      remaining -= para.length + 1; // +1 for the newline itself
      row += lines;
    }
    return { row: Math.max(0, row - 1), col: 0 };
  }

  private erase(): void {
    if (!this.renderedRows) return;
    // One write, like every other frame here: the walk up and the clear must
    // not be two separate repaints for the terminal to show.
    process.stdout.write(esc.toColumn(1) + esc.up(this.cursorRow) + esc.clearDown);
    this.renderedRows = 0;
    this.cursorRow = 0;
  }

  /** Dropdown rows drawn between the frame and the status lines. */
  private menuLines(w: number): string[] {
    if (!this.menu.length) return [];
    const visible = Math.min(this.opts.suggestRows ?? 6, this.menu.length);
    const half = Math.floor(visible / 2);
    const start = Math.max(0, Math.min(this.menuIdx - half, this.menu.length - visible));
    const nameWidth = Math.min(22, Math.max(...this.menu.map((m) => m.value.length)) + 1);

    const rows: string[] = [];
    for (let i = start; i < start + visible; i++) {
      const item = this.menu[i];
      const active = i === this.menuIdx;
      const marker = active ? c.brightCyan("→ ") : "  ";
      const name = active ? c.bold(c.brightCyan(item.value.padEnd(nameWidth))) : item.value.padEnd(nameWidth);
      const hintRoom = Math.max(10, w - nameWidth - 8);
      const hint = c.dim(item.hint.length > hintRoom ? item.hint.slice(0, hintRoom - 1) + "…" : item.hint);
      rows.push(indent + "  " + marker + name + " " + hint);
    }
    rows.push(indent + "    " + c.gray(`(${this.menuIdx + 1}/${this.menu.length})`) + c.dim("  ↑↓ · Enter to pick · Esc to dismiss"));
    return rows;
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
    const inner = innerWidth();
    const rows = this.wrap(inner);
    const st = this.opts.status();

    const lines: string[] = [];
    lines.push(indent + c.gray("╭" + "─".repeat(w - 2) + "╮"));
    for (const [i, r] of rows.entries()) {
      const marker = i === 0 ? c.brightCyan("❯ ") : c.gray("  ");
      lines.push(indent + c.gray("│") + " " + marker + r.padEnd(inner) + c.gray("│"));
    }
    lines.push(indent + c.gray("╰" + "─".repeat(w - 2) + "╯"));

    for (const l of this.menuLines(w)) lines.push(l);

    const gap = Math.max(2, w - width(st.left) - width(st.hint));
    lines.push(indent + st.left + " ".repeat(gap) + st.hint);
    lines.push(indent + " ".repeat(Math.max(0, w - width(st.context))) + st.context);

    // The whole repaint goes out as one write. Clearing the old box first and
    // drawing the new one after left a moment with nothing on screen, and on
    // every keystroke that moment is what flickered. Writing over the old rows
    // instead means no frame ever shows the box missing. The caret is hidden
    // for the walk: otherwise it reads as jumping a line up and snapping back.
    const prev = this.renderedRows;
    let frame = esc.hide;
    if (prev) frame += esc.toColumn(1) + esc.up(this.cursorRow);
    // Column 1 first, then wipe the row: what a shortened line used to occupy
    // has to go, and the emulators in the tests model K the same way.
    frame += lines.map((l) => esc.toColumn(1) + esc.clearRight + l).join("\n");
    // The box shrank — a closed suggestion menu, a deleted line. The row below
    // exists, so stepping onto it to clear downwards cannot scroll the screen.
    if (prev > lines.length) frame += "\n" + esc.clearDown + esc.up(1);

    // Park the cursor inside the frame, on the row the caret belongs to.
    const { row, col } = this.locate(inner);
    const lastRow = lines.length - 1;
    const targetRow = 1 + row;
    frame += esc.up(lastRow - targetRow) + esc.toColumn(PAD_LEFT + 4 + col + 1) + esc.show;
    paintFrame(frame);

    this.renderedRows = lines.length;
    this.cursorRow = targetRow;
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
