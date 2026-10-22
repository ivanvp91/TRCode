/** Transcript rendering: markdown-ish streaming, banners, spinners, diffs. */
import { c, cursor, cutToWidth, esc, hasColor, stripAnsi, width, wrapAnsi } from "./ansi.js";
import { PAD_LEFT, contentWidth, fmtDuration, fullWidth, indent, pad } from "./layout.js";
import { t, count } from "../i18n.js";
import { rememberCollapsed } from "./paste.js";
import { highlight, langOf } from "./highlight.js";
import { animateLogo, logoFrame, LOGO_MIN_WIDTH, LOGO_MIN_HEIGHT, LOGO_HEIGHT, type LogoAnimation } from "./logo.js";
import { queryCursorRow } from "./stdin.js";

// ── sticky footer ───────────────────────────────────────────────────────────

/**
 * A block pinned to the bottom of the screen that transcript output scrolls
 * above: during a turn it holds the spinner, the input frame and the status
 * rows, so the prompt never disappears while the model works. Every write goes
 * through out()/line(), which erase it first and redraw it afterwards.
 */
type FooterFn = () => string[];
/** Where the caret belongs inside the footer: 0-based row and cell column. */
type FooterCaretFn = () => { row: number; col: number } | null;
let footerFn: FooterFn | null = null;
let footerCaretFn: FooterCaretFn | null = null;
/**
 * How many of the footer's rows are borrowed rather than owned: drawn over the
 * transcript rows above the bar instead of pushing them up, and handed back
 * from the row log when they go. The turn bar's command list is such a block —
 * it lives for a few keystrokes, and a bar that grew for it and shrank again
 * left a ten-row hole above itself for the rest of the turn.
 */
type FooterCoverFn = () => number;
let footerCoverFn: FooterCoverFn | null = null;
/** Borrowed rows at the top of the frame on screen. */
let footerCover = 0;
/** Borrowed rows of the frame footerFrame() just built. */
let frameCover = 0;
let footerRows = 0;
/** The row the cursor was parked on after the last draw, for the next erase. */
let footerCursorRow = 0;

// Hiding the cursor is terminal state, not process state: exiting while it is
// hidden leaves the user's shell without a caret. Restored on the way out,
// however the process ends.
if (process.stdout.isTTY) {
  process.on("exit", () => cursor.show());
}

/** The frame drawn last, so a repaint that would change nothing is skipped. */
let lastFrame: string[] | null = null;

// ── the block sits on the last line of the screen ───────────────────────────
//
// A terminal has no way to hold a block at the bottom: everything is a stream.
// So the block is dropped there once — the rows it leaves above itself are
// blank, and as the transcript grows they fill in — and after that it keeps its
// place by scrolling, because every line written above it is one row of scroll.
// A window that grows opens rows below the block, and the block drops again by
// exactly that much.

/** The row the cursor stood on when the session started, if the terminal said. */
let startRow: number | null = null;
/** True once the block ends on the last line of the screen. */
let pinned = false;
/** Rows the block still has to open below itself to get back down there. */
let pendingDrop = 0;
/** Height of the block that was just taken off the screen. */
let slackRows = 0;
/** A fresh cursor probe after that block was removed, when available. */
let slackCursorRow: number | null = null;
/** Screen height when that block was removed. */
let slackScreenRows = 0;
/** Rows written by the transcript when that block came down. */
let slackMark = 0;
/** Rows the transcript has moved the cursor down since setStartRow(). */
let rowsMoved = 0;
/** Blank rows the bar owes at its own top after a shrink — see footerFrame(). */
let footerPad = 0;
/** The pad the frame on screen was built with, for the caret. */
let framePad = 0;
let lastScreenRows = 0;

function screenRows(): number {
  return Math.max(10, process.stdout.rows || 24);
}

/** Tells the bar where the prompt is about to be drawn, so it can reach the bottom. */
export function setStartRow(row: number | null, preserveFooterSlack = false): void {
  startRow = row;
  // A re-measure after a footer came off the screen keeps the fact that the
  // block was at the bottom: the rows it owes are still owed, only the row
  // they are counted from is fresher.
  if (!preserveFooterSlack) pinned = false;
  pendingDrop = 0;
  rowsMoved = 0;
  footerPad = 0;
  if (preserveFooterSlack) slackCursorRow = row;
  else {
    slackCursorRow = null;
    if (row !== null) slackRows = 0;
  }
  lastScreenRows = screenRows();
}

/**
 * Follows the transcript down the screen.
 *
 * Where the session started is not enough to tell whether the block is at the
 * bottom: a session that opened near the top of a tall window scrolls there
 * after a few screens of answer, and from then on every block is bottom-bound
 * whatever `startRow` says. Counting the rows that went through here is a lower
 * bound — a long line wraps into more rows than it has newlines — so a screen
 * that has not scrolled yet is never mistaken for one that has.
 */
function movedRows(text: string): void {
  let n = 0;
  // A wrapped line moves the cursor down without a newline of its own, and the
  // rows it takes are the ones the block below owes: a turn's stats line that
  // wraps into two rows used to count as one, which left the composer a row low.
  const cols = Math.max(20, (process.stdout.columns || 80) - 1);
  for (const seg of text.split("\n")) {
    const w = width(seg);
    if (w > cols) n += Math.floor(w / cols);
  }
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  if (!n) return;
  rowsMoved += n;
  // The transcript eats the air the bar is holding above itself, one row per
  // line: that is what puts the bar back on the conversation instead of leaving
  // a gap between the two.
  if (footerPad) footerPad = Math.max(0, footerPad - n);
  // A cursor that never answered the startup probe sat somewhere on the first
  // line, so that is the highest it can have started from.
  if (!pinned && (startRow ?? 1) - 1 + rowsMoved >= screenRows()) pinned = true;
}

/**
 * Rows to open under the block, so its last line lands on the screen's last
 * line.
 *
 * The composer is glued to the bottom from the first frame: the transcript
 * grows into the empty rows above it, and the window never shows a strip of
 * nothing between the input and the status. Rows are owed once the block is
 * drawn (a terminal that never reported the cursor keeps it where it is) and
 * again whenever a taller window opens rows underneath.
 */
export function bottomGap(rows: number): number {
  if (pinned) return pendingDrop;
  if (startRow === null) return 0;
  return Math.max(0, screenRows() - startRow - rows + 1);
}

/** Records where the block ended up: from here on it is the bottom of the screen. */
export function bottomDrawn(rows: number, dropped = false): void {
  // Pinned means "the last row of the block is the last row of the screen".
  // That is true after a drop, and true when the block was drawn low enough
  // that it reached the edge by itself.
  const reached = dropped || (startRow !== null && startRow > Math.floor(screenRows() / 2));
  if (rows > 0 && reached) pinned = true;
  pendingDrop = 0;
  lastScreenRows = screenRows();
}

/** True when the block's last row is the last row of the screen. */
export function bottomPinned(): boolean {
  return pinned;
}

/** Rows the terminal can hold — the overlay must never wrap above the top. */
export function screenHeight(): number {
  return screenRows();
}


/** Rows the transcript has written since the block took the bottom edge. */
export function writtenRows(): number {
  return rowsMoved;
}

if (process.stdout.isTTY) {
  process.stdout.on("resize", () => {
    const rows = screenRows();
    // Only growth matters: a taller window opens rows under the block, and it
    // has to follow them down. A shorter one takes rows off the bottom, which
    // the next scroll already handles.
    if (pinned) pendingDrop += Math.max(0, rows - lastScreenRows);
    lastScreenRows = rows;
    lastFrame = null;
  });
}

// A terminal is free to repaint between two writes, and it does: split a frame
// across several of them and it gets caught half-drawn — the footer erased, its
// replacement not yet there. That empty gap, ten times a second while an answer
// streams, is the flicker. So a frame is built as one string and written once,
// wrapped in the synchronized-output pair for terminals that honour it (the
// rest ignore an unknown private mode).

/** Start of line, then wipe it — a shorter row must not leave a tail behind. */
const CLEAR_LINE = esc.toColumn(1) + esc.clearRight;

function paint(frame: string): void {
  if (frame) process.stdout.write(esc.syncOn + frame + esc.syncOff);
}

/**
 * Writes a frame someone else assembled, as one synchronized write. For the
 * parts of the UI that draw their own box — the input editor — so they share
 * this module's idea of what a frame is and of what was last written.
 */
export function paintFrame(frame: string): void {
  if (!frame) return;
  // The box counts as written text, exactly as the out() it replaces did:
  // ensureBlank() must not think the screen ends in a blank line.
  lastBlank = false;
  paint(frame);
}

/** Takes the footer off the screen; empty when there is nothing to erase. */
function eraseSeq(): string {
  if (!footerRows) return "";
  const from = footerCursorRow;
  const cover = footerCover;
  footerRows = 0;
  footerCursorRow = 0;
  footerCover = 0;
  lastFrame = null;
  // Hidden before it moves — a visible cursor walking to the erase point reads
  // as the caret jumping around the screen. Borrowed rows get their transcript
  // back, and the cursor ends where the bar's own rows began: that is where
  // the transcript continues.
  return esc.hide + esc.toColumn(1) + esc.up(from) + uncoverSeq(cover) + esc.clearDown;
}

/**
 * Writes back the transcript rows that the top `n` rows of the frame were
 * drawn over, from the cursor down, and leaves the cursor on the row under
 * them. The screen cannot be read back; the row log is what stood there.
 */
function uncoverSeq(n: number): string {
  if (n <= 0) return "";
  return tailRows(n).map((l) => CLEAR_LINE + l).join("\n") + "\n";
}

/**
 * Parks the caret where the footer says it belongs (the turn bar's input frame)
 * and shows it; without a spot the cursor stays hidden as before. Assumes the
 * cursor sits on the footer's last row.
 */
function caretSeq(lines: string[]): string {
  const caret = footerCaretFn?.() ?? null;
  const row = caret ? caret.row + framePad : -1;
  if (caret && row >= 0 && row < lines.length) {
    footerCursorRow = row;
    return esc.up(lines.length - 1 - row) + esc.toColumn(caret.col + 1) + esc.show;
  }
  footerCursorRow = lines.length - 1;
  return esc.hide;
}

/** Writes the footer where the cursor stands — for a screen without one. */
function drawSeq(lines: string[]): string {
  // The rows opened here are the ones that put the bar's last line on the last
  // line of the screen; after this draw the bar keeps its place by scrolling.
  // Borrowed rows are not owed: they go over the transcript above the cursor.
  const owned = lines.length - frameCover;
  const drop = bottomGap(owned);
  const body =
    esc.hide +
    (drop ? "\n".repeat(drop) : "") +
    esc.up(frameCover) +
    lines.map((l) => CLEAR_LINE + l).join("\n");
  footerRows = lines.length;
  footerCover = frameCover;
  lastFrame = lines;
  bottomDrawn(owned, drop > 0);
  return body + caretSeq(lines);
}

/**
 * Redraws the footer over itself. Writing on top of the old rows rather than
 * erasing them first is what keeps the bar from blinking: no frame ever exists
 * in which the bottom of the screen is blank.
 */
function repaintSeq(lines: string[]): string {
  const prev = footerRows;
  // A taller bar needs rows that do not exist yet, and where it takes them
  // from is the whole question. Starting `grow` rows higher took them from the
  // transcript, and painted the bar over lines that were already written —
  // most often the echo of the message that had just started the turn, which
  // is the last thing printed before the reasoning preview grows the bar. The
  // message was sent, answered, and nowhere on screen.
  //
  // The rows are opened at the bottom instead: newlines on the last row scroll
  // the screen, which moves the transcript up into the scrollback rather than
  // erasing it, and the bar still ends where it ended before — at the bottom.
  //
  // Only the rows the bar owns grow this way. Borrowed ones (see footerCover)
  // go over the transcript above, and come back off it from the row log.
  const prevOwned = prev - footerCover;
  const owned = lines.length - frameCover;
  const grow = Math.max(0, owned - prevOwned);
  let body = esc.hide + esc.toColumn(1) + esc.up(footerCursorRow);
  if (grow || frameCover !== footerCover) {
    // From the old frame's top: hand the borrowed rows back, which leaves the
    // cursor on the first row the bar owns, and build the new frame from there.
    body += uncoverSeq(footerCover);
    body += grow
      ? esc.down(prevOwned - 1) + "\n".repeat(grow) + esc.up(lines.length - 1)
      : esc.up(frameCover);
  }
  body += lines.map((l) => CLEAR_LINE + l).join("\n");
  // A shorter bar leaves rows of the taller one below it. Clearing them where
  // they stand leaves blanks under the bar; sliding the bar down over them
  // would leave them inside the conversation instead, and a gap between two
  // messages is the worse of the two. The step-down is skipped at the bottom
  // of the screen, where that row does not exist and stepping onto it scrolls
  // the whole transcript by a line.
  if (owned < prevOwned) body += pinned ? esc.clearDown : "\n" + esc.clearDown + esc.up(1);
  footerRows = lines.length;
  footerCover = frameCover;
  lastFrame = lines;
  return body + caretSeq(lines);
}

function eraseFooter(): void {
  paint(eraseSeq());
}

/**
 * The frame to draw: the block with the rows it owes held above it.
 *
 * A block that got shorter and kept its top would lift its bottom off the last
 * line of the screen and leave those rows blank under the status — the strip
 * that opens up the moment the reasoning preview collapses. So the rows it gave
 * up stay at the top of its own frame: the transcript lines that follow are
 * written into them, and until one arrives they read as air above the bar
 * rather than a hole under it.
 */
function footerFrame(block: string[]): string[] {
  // Borrowing needs the bar on the bottom edge: only then is everything above
  // it transcript, the rows the log remembers.
  const want = pinned && footerCoverFn ? Math.max(0, Math.min(footerCoverFn(), block.length)) : 0;
  const own = block.length - want;
  const height = footerPad + own;
  if (footerRows) {
    const prevOwned = footerRows - footerCover;
    if (height < prevOwned) footerPad += prevOwned - height;
    else if (height > prevOwned) footerPad = Math.max(0, footerPad - (height - prevOwned));
  }
  // Never above the top of the screen: what does not fit is grown, as before.
  frameCover = Math.min(want, Math.max(0, screenRows() - (footerPad + own) - 1));
  framePad = footerPad;
  return footerPad ? [...Array(footerPad).fill(""), ...block] : block;
}

function drawFooter(): void {
  if (!footerFn || !process.stdout.isTTY) return;
  const block = footerFn();
  if (!block.length) return;
  const lines = footerFrame(block);
  // A resize moved the last line of the screen: the bar has to come down to it,
  // and only a full redraw from above can do that.
  if (footerRows && pendingDrop > 0) {
    paint(eraseSeq());
    footerRows = 0;
  }
  paint(footerRows ? repaintSeq(lines) : drawSeq(lines));
}

function sameFrame(lines: string[]): boolean {
  return !!lastFrame && lastFrame.length === lines.length && lastFrame.every((l, i) => l === lines[i]);
}

/**
 * Installs (or with null removes) the bottom bar.
 *
 * The cursor is hidden for as long as the bar is up. Every write erases and
 * redraws it, which walks the cursor between the transcript and the bar — with
 * it visible, that reads as the caret flying around the screen while the model
 * works. Ownership sits here rather than in the spinner: the spinner stops on
 * the first token of the answer, and the bar outlives it by the whole turn.
 */
export function setFooter(fn: FooterFn | null, caret?: FooterCaretFn | null, cover?: FooterCoverFn | null): void {
  const had = footerRows > 0;
  if (!fn && had) {
    // Remember the cleared rows for the idle composer. It can reclaim them
    // without leaving an empty strip above the input or below the status.
    // Borrowed rows go back to the transcript, so they are not owed.
    slackRows = footerRows - footerCover;
    slackMark = rowsMoved;
    slackCursorRow = null;
    slackScreenRows = screenRows();
    footerPad = 0;
  }
  footerFn = fn;
  footerCaretFn = fn ? (caret ?? null) : null;
  footerCoverFn = fn ? (cover ?? null) : null;
  if (fn) { slackRows = 0; slackCursorRow = null; footerPad = 0; }
  if (!fn) {
    // Stopping: take the bar off the screen and leave the cursor visible.
    if (had) eraseFooter();
    footerRows = 0;
    lastFrame = null;
    cursor.show();
    return;
  }
  cursor.hide();
  // A new footer replaces the old one in place. Erasing first and drawing
  // again at the same row is what made a shorter bar leave a hole under itself,
  // and at the bottom of the screen that hole is exactly the empty strip the
  // eye catches: the new bar has to take the old one's place, not its top.
  drawFooter();
}

/** True while a block that came off the screen still owes rows to the next one. */
export function bottomSlackPending(): boolean {
  return slackRows > 0;
}

/**
 * Cleared rows below the transcript that the idle composer can reclaim by
 * moving the screen down. The transcript follows it, preserving one separator
 * above the input while the status still ends on the last row.
 */
export function takeFooterSlack(rows: number): number {
  if (!slackRows) return 0;
  const printed = rowsMoved - slackMark;
  // The rows are owed because a footer came off the screen — that is enough
  // evidence that the block below it can come down. `pinned` is not asked:
  // the slack probe deliberately re-measures the position, which clears it.
  const slack = slackCursorRow !== null
    ? Math.max(0, screenRows() - slackCursorRow - rows + 1)
    : Math.max(0, slackRows - printed - rows + screenRows() - slackScreenRows);
  slackRows = 0;
  slackCursorRow = null;
  if (slack) {
    pinned = true;
    pendingDrop = 0;
  }
  return slack;
}

/** Redraws the bar in place — for the spinner tick and status updates. */
export function refreshFooter(): void {
  if (!footerFn || !process.stdout.isTTY) return;
  // Mid-batch the transcript text is still held back, so the bar cannot be
  // redrawn yet: it would land above the lines that belong over it.
  if (batched) {
    batchWantsFooter = true;
    return;
  }
  const block = footerFn();
  if (!block.length) return;
  const lines = footerFrame(block);
  // Several callers can ask for the same frame between two spinner ticks
  // (a label change, a queued line, the tick itself). Drawing it twice costs
  // a repaint the eye can catch, and changes nothing.
  if (footerRows && pendingDrop <= 0 && sameFrame(lines)) return;
  // A resize moved the last line of the screen: the bar has to come down to it,
  // and only a full redraw from above can do that.
  if (footerRows && pendingDrop > 0) {
    paint(eraseSeq());
    footerRows = 0;
  }
  paint(footerRows ? repaintSeq(lines) : drawSeq(lines));
}

/** Whether the last thing written was an empty line — see ensureBlank(). */
let lastBlank = true;

/**
 * Collects the writes of one streamed chunk instead of emitting them, so a
 * paragraph of answer text costs a single frame rather than one per line.
 */
let batched: string[] | null = null;
/** A refresh asked for mid-batch, owed once the held-back text is out. */
let batchWantsFooter = false;

/** Runs `fn` with its output held back, then writes it as one frame. */
export function batch<T>(fn: () => T): T {
  if (batched) return fn(); // already inside one — the outer call flushes
  batched = [];
  batchWantsFooter = false;
  try {
    const result = fn();
    const text = batched.join("");
    batched = null;
    writeFrame(text);
    if (batchWantsFooter) refreshFooter();
    return result;
  } catch (e) {
    batched = null;
    throw e;
  } finally {
    batchWantsFooter = false;
  }
}

/**
 * The last rows the transcript printed, oldest first.
 *
 * An overlay — the command menu drawn above the composer — covers rows of the
 * conversation. The screen cannot be read back, so the way to lift it again is
 * to remember what stood there: this is that memory. Only transcript writes go
 * in; frames and the composer are not part of it.
 */
const rowLog: string[] = [];
const ROW_LOG_MAX = 80;
/** The row being written: it is not on the screen as a row until it is closed. */
let rowPending = "";
/** Blank rows held between the transcript and the composer, at the log's tail. */
let gapRows = 0;

function trimLog(): void {
  if (rowLog.length > ROW_LOG_MAX) rowLog.splice(0, rowLog.length - ROW_LOG_MAX);
}

/**
 * Printed rows go in *before* the gap: on screen the composer is separated from
 * the transcript by those blank rows, so a new line of the conversation lands
 * above them, not between them and the input.
 */
function logRows(s: string): void {
  const parts = (rowPending + s).split("\n");
  rowPending = parts.pop() ?? "";
  if (!parts.length) return;
  rowLog.splice(Math.max(0, rowLog.length - gapRows), 0, ...parts);
  trimLog();
}

/** The transcript's last `n` rows, oldest first; short rows pad with blanks. */
export function tailRows(n: number): string[] {
  const taken = rowLog.slice(Math.max(0, rowLog.length - n));
  while (taken.length < n) taken.unshift("");
  return taken;
}

/**
 * Rows of blank screen between the last printed line and the composer.
 *
 * They are part of what stands above the frame — an overlay that covers them
 * has to put blanks back, not the last lines of the transcript — so they are
 * recorded as rows, the same way printed lines are.
 */
export function noteBlankRows(n: number): void {
  if (n <= 0) return;
  gapRows += n;
  for (let i = 0; i < n; i++) rowLog.push("");
  trimLog();
}

/**
 * The composer that held the gap has left the screen. Its blank rows stay
 * where they are, and whatever is printed next lands *under* them, from the
 * frame's old top — so from here on they are ordinary rows of the log.
 *
 * Left open, the gap stayed at the log's tail for the rest of the session and
 * every later line was filed above it: anything restored from the log — the
 * command list closing — painted blanks over the last lines of the answer.
 */
export function sealBlankRows(): void {
  gapRows = 0;
}

function writeFrame(s: string): void {
  if (!s) return;
  logRows(s);
  if (!footerFn || !process.stdout.isTTY) {
    process.stdout.write(s);
    return;
  }
  // A partial line would put the bar on the same row as the text; leave the
  // redraw to the write that finishes the line. The bar is taken down first,
  // so the text lands in the rows it held, and drawn back under it.
  paint(eraseSeq() + s + drawSeq(footerFrame(footerFn())));
}

export function out(s = ""): void {
  if (s) lastBlank = /\n[ \t]*\n$/.test(s);
  if (s) movedRows(s);
  if (batched) {
    batched.push(s);
    return;
  }
  writeFrame(s);
}
export function line(s = ""): void {
  out(s + "\n");
  lastBlank = !stripAnsi(s).trim();
}

/**
 * One blank line before a new block, and never two. Tool calls printed right
 * under the last sentence of an answer read as part of it.
 */
export function ensureBlank(): void {
  if (!lastBlank) line();
}
/**
 * Writes a line inside the chat margins, wrapping it to fit.
 *
 * Everything the chat prints comes through here, and whatever was longer than
 * the terminal used to be wrapped by the terminal itself: the continuation
 * started in column 1, outside the margins, and the break landed mid-word. So
 * the wrap happens here, at the width the margins actually leave — and a line
 * that arrived indented keeps that indent on every row of it.
 */
export function padded(s = ""): void {
  const w = contentWidth();
  if (!s || width(s) <= w) return line(pad(s));
  const lead = /^[ 	]*/.exec(s)?.[0] ?? "";
  const body = lead ? s.slice(lead.length) : s;
  for (const l of wrapAnsi(body, w - lead.length)) line(pad(lead + l));
}

/** One indent step for anything subordinate to the line above it. */
const SUB = "    ";

/**
 * A secondary line — the grey explanation, hint or detail belonging to the
 * message above. Indented a step so a block reads as one thing rather than as
 * several messages of equal weight.
 */
export function hint(s = ""): void {
  // Wrapped for the same reason messages are: a continuation line that starts
  // in column 1 no longer reads as subordinate to anything.
  for (const l of wrapAnsi(s, contentWidth() - SUB.length)) padded(SUB + c.gray(l));
}

export function rule(label?: string): void {
  const w = contentWidth();
  if (!label) return line(pad(c.gray("─".repeat(w))));
  const text = ` ${label} `;
  const left = Math.max(0, Math.floor((w - width(text)) / 2));
  const right = Math.max(0, w - left - width(text));
  line(pad(c.gray("─".repeat(left)) + c.dim(text) + c.gray("─".repeat(right))));
}

export interface BannerInfo {
  /** Provider label, model and reasoning budget — the switchable three. */
  provider: string;
  model: string;
  effort: string;
  /** The host drops the budget for this model; the header leaves it out. */
  effortIgnored?: boolean;
  cwdLabel: string;
  sessionId: string;
  version: string;
  /**
   * Gray note after the version — "a newer release exists" or "an installed
   * update waits for a restart". Absent when there is nothing to say.
   */
  versionNote?: string;
  /** Rendered under the fields; nudges toward a better setup when one exists. */
  tip?: { title: string; detail: string };
}

/**
 * The header, as text. A boxed frame cost two rows of chrome and two columns of
 * every line; the working area is what the screen is for, so the fields are
 * plain lines under the greeting. It cannot be edited once printed, so whoever
 * changes what it states prints it again — see App.repaintHeader. `compact` is
 * the reprint: the fields alone, no greeting, which belongs to the startup.
 */
export function banner(info: BannerInfo & { compact?: boolean }): void {
  // The header states the same three switchable things as the status row, and a
  // budget the model never receives is not one of them.
  const modelValue =
    c.brightCyan(info.model) +
    (info.effort === "off" || info.effortIgnored
      ? ""
      : c.gray(t("  thinking: ", "  мышление: ")) + c.brightMagenta(info.effort));

  const fields: [string, string][] = [
    [t("Directory:", "Каталог:"), info.cwdLabel],
    [t("Provider:", "Поставщик:"), c.brightBlue(info.provider)],
    [t("Model:", "Модель:"), modelValue],
    [t("Version:", "Версия:"), info.version + (info.versionNote ? c.gray(`  ·  ${info.versionNote}`) : "")],
  ];

  line();
  if (!info.compact) {
    padded(c.bold(c.brightBlue(t("Welcome to TRCode!", "TRCode — добро пожаловать!"))));
    line();
  }
  for (const [label, value] of fields) padded(c.gray(label.padEnd(12)) + c.bold(value));

  if (info.tip) {
    line();
    padded(c.brightBlue(info.tip.title));
    padded(c.gray(info.tip.detail));
  }
  line();
}

/** Draw once, then start motion after the editor owns stdin. */
export async function logoIntro(opts: { animate?: boolean } = {}): Promise<LogoAnimation | undefined> {
  if (!process.stdout.isTTY) return;
  if (fullWidth() < LOGO_MIN_WIDTH + 2 || !hasColor) {
    padded(c.gray("TRCode"));
    return;
  }
  const row = await queryCursorRow();
  // The composer and its two status rows stay clear of the logo.
  const available = row === null ? LOGO_MIN_HEIGHT : screenRows() - row - 7;
  if (available < LOGO_MIN_HEIGHT) {
    padded(c.gray("TRCode"));
    return;
  }
  const columns = Math.min(96, fullWidth() - 6);
  // The block is the art itself, with no padding rows inside it: `gap` is then
  // the real distance to the header and to the input, so the wordmark sits in
  // the middle of the free area instead of high up with its space pooling
  // between it and the composer.
  const height = available >= LOGO_HEIGHT ? LOGO_HEIGHT : LOGO_MIN_HEIGHT;
  const left = Math.max(0, Math.floor((fullWidth() - columns) / 2));
  const gap = row === null ? 0 : Math.max(0, Math.floor((available - height) / 2));
  for (let i = 0; i < gap; i++) line();
  for (const art of logoFrame(columns, height)) line(" ".repeat(left) + art);
  if (row === null || opts.animate === false || process.env.TRCODE_NO_SPLASH || !process.stdin.isTTY) return;
  return animateLogo(row + gap, left, columns, height);
}

/**
 * How much of a long message is echoed before it is cut. A pasted log is
 * something you already have; scrolling past it twice — once in the frame,
 * once in the transcript — is what the cut exists to prevent.
 */
const ECHO_LINES = 5;

/**
 * One row of the band that marks text the user owns — the echoed message and
 * the input line share it, so what is typed and what was sent read alike.
 * Filled to the edge: a band that stops short reads as a selection.
 */
export function bandRow(content = ""): string {
  const w = fullWidth() - 1;
  return c.bgUser(content + " ".repeat(Math.max(0, w - width(content))));
}

export function userEcho(text: string): void {
  line();
  // The message sits on a band the full width of the terminal: a request and
  // the answer under it are the two halves of a turn, and without the band the
  // eye has to find where one stopped and the other began.
  const left = PAD_LEFT + 2;
  // The band is one column narrower than the terminal, and the text keeps two
  // of those cells clear on the right: a line that ends on the band's edge
  // looks cut off rather than wrapped.
  const all = wrapText(text, fullWidth() - left - 3);
  // Two lines over the limit is not worth a handle; a screenful is.
  const cut = all.length > ECHO_LINES + 2;
  const shown = cut ? all.slice(0, ECHO_LINES) : all;
  // The band carries a row of its own colour above and below the text: a
  // one-row strip reads as a hairline rather than as a block you wrote.
  line(bandRow());
  // The arrow marks the turn, not every line of it.
  for (const [i, l] of shown.entries()) {
    line(bandRow(indent + (i === 0 ? c.gray("› ") : "  ") + c.bold(c.brightWhite(l))));
  }
  if (cut) {
    rememberCollapsed(text);
    const rest = all.length - shown.length;
    line(
      bandRow(
        " ".repeat(left) +
          c.gray(
            t(`… ${rest} more lines · ctrl+o to see all of it`, `… ещё строк: ${rest} · ctrl+o — показать целиком`),
          ),
      ),
    );
  }
  line(bandRow());
  line();
}

export function assistantPrefix(model: string): void {
  padded(c.brightMagenta("●") + " " + c.dim(model));
}

/** A compact boundary between the model's work and its response. */
export function responseDivider(): void {
  ensureBlank();
  rule(t("Response", "Ответ"));
  line();
}

/**
 * Tool activity is indented one step further than the message it belongs to.
 * Flush against the text it read as a continuation of the answer. Same step as
 * `hint`, so everything subordinate lines up in one column.
 */
const TOOL_INDENT = SUB;

/**
 * What ran, by name.
 *
 * These were translated verbs — `Команда(npm test)`, `Правка(src/x.ts)` —
 * and a translated verb is one more thing to map back to the tool it stands
 * for while reading a log. The names stay in one language on purpose: they
 * are identifiers, like the command and the path beside them.
 */
const TOOL_VERB: Record<string, string> = {
  shell: "Ran",
  edit: "Edit",
  write: "Write",
  read: "Read",
  ls: "List",
  glob: "Glob",
  grep: "Grep",
  web_search: "WebSearch",
  fetch: "WebFetch",
  task: "Task",
  skill: "Skill",
  todo: "Todo",
};

/**
 * How much of a tool's own output is printed before the rest is folded away.
 * Enough to see what happened, not enough to bury the answer under a test
 * run — and nothing is lost, ctrl+o has the whole thing.
 */
const TOOL_LINES = 5;

export function toolStart(name: string, summary: string): void {
  const verb = TOOL_VERB[name] ?? name;
  const w = contentWidth();
  // A shell command is code, and it is coloured the way the code it touches is
  // coloured: the tool name carries the weight, the command keeps its syntax.
  // Everything else names its target in plain bold.
  const shell = name === "shell";
  const close = shell ? "" : c.gray(")");
  const head = c.green("•") + " " + c.bold(verb) + (shell ? " " : c.gray("("));
  const hang = width(head);
  // Two lines' worth: a real command — a cd, a pipe and a grep — does not fit
  // on one, and cutting it at the pipe hides the half that explains the
  // output underneath it.
  const clipped = truncate(summary, (w - hang) * 2 - 1);
  // A path too wide for one row is cut, not split: a path broken across two
  // rows reads as two different paths.
  const plain = fitTokens(clipped, w - hang);
  const body = shell ? highlight(plain, "bash") : c.bold(plain);
  const rows = wrapAnsi(body + close, w - hang);
  padded(head + rows[0]);
  // A command that runs onto a second line hangs under the command itself, the
  // way its output does — flush left it would read as another call.
  for (const l of rows.slice(1)) padded(" ".repeat(hang) + l);
}

/**
 * Prints a tool's output. `null` marks a call being replayed: the corner is
 * grey because whether it succeeded was not written down, only what came back.
 */
export function toolDone(ok: boolean | null, detail: string, kind: "text" | "diff" = "text"): void {
  // A diff arrives already laid out — bands, gutter and all — and dimming or
  // clipping it here would undo exactly that.
  if (kind === "diff") {
    const all = detail.split("\n");
    for (const l of all.slice(0, 40)) line(pad(TOOL_INDENT) + l);
    if (all.length > 40) {
      rememberCollapsed(detail);
      padded(
        TOOL_INDENT +
          c.gray(
            t(
              `  … +${all.length - 40} lines (ctrl+o to expand)`,
              `  … ещё ${count(all.length - 40, ["line", "lines"], ["строка", "строки", "строк"])} (ctrl+o — показать)`,
            ),
          ),
      );
    }
    // A block of code ends the thought it belongs to: the call under it reads
    // as part of the code without a row of air between them.
    ensureBlank();
    return;
  }
  const mark = ok === null ? c.gray("└ ") : ok ? c.green("└ ") : c.red("└ ");
  const all = detail.split("\n");
  // The corner marks the block, not every line of it: a run of results reads
  // as one thing when only the first line carries the gutter.
  for (const [i, l] of all.slice(0, TOOL_LINES).entries()) {
    line(pad(TOOL_INDENT + (i === 0 ? mark : "  ") + c.dim(clip(l, contentWidth() - 10))));
  }
  if (all.length > TOOL_LINES) {
    rememberCollapsed(detail);
    const rest = all.length - TOOL_LINES;
    padded(
      TOOL_INDENT +
        "  " +
        c.gray(
          t(
            `… +${rest} lines (ctrl+o to expand)`,
            `… ещё ${count(rest, ["line", "lines"], ["строка", "строки", "строк"])} (ctrl+o — показать)`,
          ),
        ),
    );
  }
}

/**
 * Prints a collapsed block back the way it was remembered.
 *
 * A diff is stored already laid out — bands, gutter, padding inside the
 * colour — and re-wrapping it would count the escape bytes as characters
 * (`wrapText` does) and break the bands mid-line. Anything carrying escapes
 * goes straight to the screen; plain text gets the markdown pass.
 */
export function expandedBlock(text: string): string[] {
  if (text.includes("\x1b")) return text.split("\n");
  return renderMarkdownBlock(text);
}

/**
 * A message with its glyph, wrapped by us rather than by the terminal: a line
 * that runs past the edge would otherwise continue in column 1, outside the
 * margins and under the glyph, breaking the block it belongs to. Continuation
 * lines are indented to sit under the text, not under the mark.
 */
function message(glyph: string, s: string): void {
  ensureBlank();
  // Wrapped with its colours intact: this used to strip them, so a long
  // message came out plain while a short one kept its highlighting.
  const lines = wrapAnsi(s, contentWidth() - 2);
  if (lines.length <= 1) return padded(glyph + s);
  padded(glyph + lines[0]);
  for (const l of lines.slice(1)) padded("  " + l);
}

// Each of these opens a new message, so it gets a blank line above it — one,
// never two, and never before the first thing on the screen.
export function info(s: string): void {
  message(c.cyan("ℹ "), s);
}
export function warn(s: string): void {
  message(c.yellow("⚠ "), s);
}
export function error(s: string): void {
  message(c.red("✖ "), s);
}
export function success(s: string): void {
  message(c.green("✔ "), s);
}

/** Simple pluraliser: plural(2, "step", "steps") → "steps". */
export function plural(n: number, one: string, many: string): string {
  return Math.abs(n) === 1 ? one : many;
}

export function truncate(s: string, max: number): string {
  if (max <= 1) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/**
 * A single token — usually a path — wider than the row it has is cut rather
 * than wrapped: a path broken across two rows reads as two paths. Whatever
 * followed it goes too, since the rest would start mid-argument.
 */
function fitTokens(s: string, row: number): string {
  const words = s.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (width(words[i]) > row) return [...words.slice(0, i), clip(words[i], row)].join(" ");
  }
  return s;
}

/** Cuts a line to width without collapsing its leading indentation. */
export function clip(s: string, max: number): string {
  if (max <= 1) return "";
  const flat = s.replace(/\t/g, "  ").replace(/\r/g, "");
  if (width(flat) <= max) return flat;
  return cutToWidth(flat, max - 1).text + "…";
}

export function wrapText(text: string, w: number): string[] {
  const lines: string[] = [];
  const width = Math.max(8, w);
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      lines.push(raw);
      continue;
    }
    let cur = "";
    for (const word of raw.split(" ")) {
      // A single unbroken run — base64, minified JSON, a wall of one character
      // — has no space to break at, so it has to be cut by force. Without this
      // it lands on screen as one enormous line and the line cap never fires.
      if (word.length > width) {
        if (cur) {
          lines.push(cur);
          cur = "";
        }
        for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
        cur = lines.pop() ?? "";
        continue;
      }
      if (cur && cur.length + word.length + 1 > width) {
        lines.push(cur);
        cur = word;
      } else {
        cur = cur ? cur + " " + word : word;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

/**
 * Streaming markdown highlighter. Tracks fenced code blocks across chunks so
 * we can dim code and bold headings without buffering the whole response.
 */
/**
 * The model thinking out loud, streamed as it arrives.
 *
 * Muted and indented a step, like `hint`: it is working-out, not the answer,
 * and it has to be distinguishable at a glance from what the agent actually
 * concluded. Line-buffered for the same reason MarkdownStream is — a delta can
 * end mid-word, and wrapping a fragment would break the line twice.
 */
export class ThinkingStream {
  private buf = "";
  private opened = false;
  private emitted = 0;
  private recent: string[] = [];

  /**
   * With `collapse`, lines feed a rolling preview (the turn bar) instead of
   * the transcript, and end() leaves a single summary line behind. The full
   * text is the caller's to keep — /reasoning prints it on demand.
   */
  constructor(private collapse?: { rows: number; onUpdate: (rows: string[]) => void }) {}

  push(chunk: string): void {
    this.buf += chunk;
    batch(() => {
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) !== -1) {
        const l = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        this.emit(l);
      }
    });
  }

  /** Flushes the trailing partial line and closes the block. */
  end(): void {
    if (this.buf) {
      this.emit(this.buf);
      this.buf = "";
    }
    if (this.collapse) {
      if (this.emitted) {
        ensureBlank();
        padded(
          c.gray("● ") +
            c.dim(t("thinking", "размышления")) +
            c.gray(
              t(
                ` · ${count(this.emitted, ["line", "lines"], ["строка", "строки", "строк"])} hidden · /reasoning to show`,
                ` · скрыто ${count(this.emitted, ["line", "lines"], ["строка", "строки", "строк"])} · /reasoning — показать`,
              ),
            ),
        );
        line();
      }
      this.collapse.onUpdate([]);
    } else if (this.opened) {
      line();
    }
    this.opened = false;
  }

  private emit(l: string): void {
    if (this.collapse) {
      const flat = l.trim();
      if (!flat) return;
      this.emitted++;
      this.recent.push(flat);
      if (this.recent.length > this.collapse.rows) this.recent.shift();
      this.collapse.onUpdate([...this.recent]);
      return;
    }
    if (!this.opened) {
      ensureBlank();
      padded(c.gray("● ") + c.dim(t("thinking", "размышления")));
      this.opened = true;
    }
    if (!l.trim()) return line();
    for (const w of wrapText(l, contentWidth() - SUB.length)) padded(SUB + c.dim(w));
  }
}

export class MarkdownStream {
  private buf = "";
  private inFence = false;
  private wroteAny = false;
  /** Pipe-table rows held back until the block ends — see flushTable(). */
  private table: string[] = [];

  push(chunk: string): void {
    this.buf += chunk;
    // One frame for the whole chunk: a delta carrying five lines redrew the
    // bar five times, and each redraw is a chance for the eye to catch it.
    batch(() => {
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) !== -1) {
        const l = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        this.emitLine(l);
      }
    });
  }

  /** Flush the trailing partial line. */
  end(): void {
    batch(() => {
      if (this.buf) {
        this.emitLine(this.buf);
        this.buf = "";
      }
      this.flushTable();
      if (this.wroteAny) line();
    });
  }

  /**
   * Column widths only exist once every row has arrived, so a table is held
   * back until the block closes and then printed aligned in one go.
   */
  private flushTable(): void {
    if (!this.table.length) return;
    const rows = this.table;
    this.table = [];
    for (const l of renderTable(rows, contentWidth())) padded(l);
  }

  private emitLine(l: string): void {
    // Providers may start the answer with several empty lines after reasoning.
    // They are transport whitespace, not paragraphs before the first sentence.
    if (!this.wroteAny && !l.trim()) return;
    this.wroteAny = true;
    const w = contentWidth();
    if (/^\s*```/.test(l)) {
      this.flushTable();
      this.inFence = !this.inFence;
      padded(c.gray(l.trim()));
      return;
    }
    if (this.inFence) {
      padded(c.dim(clip(l, w)));
      return;
    }
    if (TABLE_ROW.test(l)) {
      this.table.push(l);
      return;
    }
    this.flushTable();
    if (/^#{1,6}\s/.test(l)) {
      padded(c.bold(c.brightBlue(l.replace(/^#{1,6}\s*/, ""))));
      return;
    }
    if (/^\s*[-*]\s/.test(l)) {
      for (const [i, part] of wrapText(l.replace(/^(\s*)[-*]\s/, "$1"), w - 2).entries()) {
        padded(i === 0 ? c.brightCyan("• ") + inline(part) : "  " + inline(part));
      }
      return;
    }
    for (const part of wrapText(l, w)) padded(inline(part));
  }
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, code) => c.brightYellow(code))
    .replace(/\*\*([^*]+)\*\*/g, (_m, t) => c.bold(t));
}

// ── static markdown ─────────────────────────────────────────────────────────

export interface BlockOptions {
  /** Wrap width; defaults to the chat content width. */
  width?: number;
  /** Cut off after this many rendered lines and say how many were dropped. */
  maxLines?: number;
  /** Render everything dimmed — used for replayed history. */
  dim?: boolean;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;

/**
 * Renders finished markdown into terminal lines. Unlike MarkdownStream this
 * sees the whole text at once, so it can align tables — which is exactly what
 * a replayed answer needs: `truncate()` used to flatten a table into one
 * unreadable paragraph.
 */
export function renderMarkdownBlock(text: string, opts: BlockOptions = {}): string[] {
  const w = opts.width ?? contentWidth();
  const soft = (s: string) => (opts.dim ? c.dim(s) : s);
  const raw = text.replace(/\r/g, "").split("\n");
  const outLines: string[] = [];
  let inFence = false;
  let blanks = 0;

  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];

    if (/^\s*```/.test(l)) {
      inFence = !inFence;
      // The left bar already shows where the block runs, so the fence markers
      // themselves are noise — only the language tag is worth keeping.
      const lang = l.trim().replace(/^`+/, "").trim();
      if (inFence && lang) outLines.push(c.gray("│ ") + c.gray(lang));
      blanks = 0;
      continue;
    }
    if (inFence) {
      outLines.push(c.gray("│ ") + c.dim(clip(l, w - 2)));
      blanks = 0;
      continue;
    }
    if (!l.trim()) {
      // Collapse runs of blank lines; a replay wastes screen height otherwise.
      if (blanks === 0 && outLines.length) outLines.push("");
      blanks++;
      continue;
    }
    blanks = 0;

    if (TABLE_ROW.test(l)) {
      const rows: string[] = [];
      while (i < raw.length && TABLE_ROW.test(raw[i])) rows.push(raw[i++]);
      i--;
      outLines.push(...renderTable(rows, w, opts.dim));
      continue;
    }
    if (/^#{1,6}\s/.test(l)) {
      outLines.push(c.bold(c.brightBlue(l.replace(/^#{1,6}\s*/, ""))));
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) {
      outLines.push(c.gray("─".repeat(Math.min(w, 40))));
      continue;
    }
    const bullet = l.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      const body = wrapText(bullet[2], Math.max(10, w - bullet[1].length - 2));
      body.forEach((part, n) =>
        outLines.push(bullet[1] + (n === 0 ? c.brightCyan("• ") : "  ") + soft(inline(part))),
      );
      continue;
    }
    const numbered = l.match(/^(\s*)(\d+[.)])\s+(.*)$/);
    if (numbered) {
      const lead = numbered[1] + numbered[2] + " ";
      const body = wrapText(numbered[3], Math.max(10, w - lead.length));
      body.forEach((part, n) =>
        outLines.push(n === 0 ? numbered[1] + c.brightCyan(numbered[2]) + " " + soft(inline(part)) : " ".repeat(lead.length) + soft(inline(part))),
      );
      continue;
    }
    for (const part of wrapText(l, w)) outLines.push(soft(inline(part)));
  }

  while (outLines.length && !outLines[outLines.length - 1]) outLines.pop();

  const max = opts.maxLines ?? 0;
  if (max > 0 && outLines.length > max) {
    const hidden = outLines.length - max;
    return [...outLines.slice(0, max), c.gray(`… ${hidden} more ${plural(hidden, "line", "lines")}`)];
  }
  return outLines;
}

/**
 * Pipe-table → aligned columns. Cells that do not fit wrap onto extra lines
 * rather than being cut: in a replay the clipped-off half of a cell is content
 * the user cannot get back by scrolling.
 */
function renderTable(rows: string[], w: number, dim?: boolean): string[] {
  const cells = rows
    .filter((r) => !TABLE_SEP.test(r))
    .map((r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim().replace(/`/g, "")));
  if (!cells.length) return [];

  const cols = Math.max(...cells.map((r) => r.length));
  const widths = new Array(cols).fill(0);
  for (const row of cells) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i], width(cell))));
  }

  // " │ " between columns; shrink the widest column until the row fits.
  const gutters = (cols - 1) * 3;
  let total = widths.reduce((a, b) => a + b, 0) + gutters;
  while (total > w && Math.max(...widths) > 8) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest]--;
    total--;
  }

  const hadHeader = rows.some((r) => TABLE_SEP.test(r));
  const soft = (s: string) => (dim ? c.dim(s) : s);
  const outRows: string[] = [];
  cells.forEach((row, r) => {
    // Wrap every cell, then read the block off line by line.
    const parts = widths.map((cw, i) => wrapText(row[i] ?? "", cw));
    const height = Math.max(...parts.map((p) => p.length), 1);
    for (let ln = 0; ln < height; ln++) {
      const text = widths.map((cw, i) => padCell(parts[i][ln] ?? "", cw)).join(c.gray(" │ "));
      outRows.push(hadHeader && r === 0 ? c.bold(text) : soft(text));
    }
    if (hadHeader && r === 0) outRows.push(c.gray(widths.map((cw) => "─".repeat(cw)).join("─┼─")));
  });
  return outRows;
}

function padCell(s: string, w: number): string {
  const shown = width(s) > w ? clip(s, w) : s;
  return shown + " ".repeat(Math.max(0, w - width(shown)));
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The "thinking" line. Shows elapsed time plus live token counts, because a
 * long silence with no numbers is indistinguishable from a hang.
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private i = 0;
  private started = 0;
  private inTokens = 0;
  private outTokens = 0;
  /**
   * Whether Esc is actually wired to cancel this wait. A spinner sits in
   * places with no turn bar above it — a login, a catalog refresh — where
   * nothing reads the keyboard; advertising the key there and ignoring it is
   * the worst of both, so the hint is opt-in.
   */
  private cancelable: boolean;

  constructor(
    private label: string,
    opts: { escape?: boolean } = {},
  ) {
    this.cancelable = opts.escape === true;
  }

  start(): void {
    if (!process.stdout.isTTY || this.timer) return;
    if (!this.started) this.started = Date.now();
    cursor.hide();
    this.timer = setInterval(() => this.draw(), 120);
    this.timer.unref?.();
    this.draw();
  }

  setLabel(l: string): void {
    this.label = l;
  }

  /** Live counts; input is known up front, output grows as tokens stream. */
  setTokens(inTokens: number, outTokens: number): void {
    this.inTokens = inTokens;
    this.outTokens = outTokens;
  }

  private draw(): void {
    const elapsed = fmtDuration(Date.now() - this.started);
    const counts =
      this.inTokens || this.outTokens
        ? ` · ↑ ${fmtCompact(this.inTokens)} ↓ ${fmtCompact(this.outTokens)}`
        : "";
    const tps =
      this.outTokens && Date.now() - this.started > 1000
        ? ` · ${fmtCompact(Math.round(this.outTokens / ((Date.now() - this.started) / 1000)))} tok/s`
        : "";
    cursor.clearLine();
    cursor.toColumn(0);
    out(
      indent +
        c.brightMagenta(FRAMES[this.i++ % FRAMES.length]) +
        " " +
        // Same colour as the turn bar's label — see TurnBar.spinnerLine.
        c.brightCyan(this.label) +
        c.gray(` (${elapsed}${counts}${tps})`) +
        (this.cancelable ? c.gray("  esc to interrupt") : ""),
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    cursor.clearLine();
    cursor.toColumn(0);
    // Not ours to reveal while the bar is up: the turn is still running and
    // the answer is about to stream in under it.
    if (!footerFn) cursor.show();
  }

  reset(): void {
    this.started = 0;
    this.inTokens = 0;
    this.outTokens = 0;
  }
}

function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

/** Minimal unified-style diff for edit previews. */
/**
 * A diff the way a reviewer reads one: numbered lines, a ± marker, the changed
 * ones on a coloured band that runs to the right edge, and the code itself
 * syntax-coloured. The first line is the summary, so the caller can print the
 * whole block verbatim.
 */
/**
 * A looping generation can hand the write tool megabytes of content, and at
 * ~0.5ms per rendered row an uncapped diff blocks the event loop for hours —
 * a frozen spinner and a dead Esc. Nobody reads past a few hundred rows
 * anyway; the summary still counts everything.
 */
const MAX_DIFF_ROWS = 400;

export function renderDiff(before: string, after: string, opts: { path?: string; contextLines?: number } = {}): string {
  const contextLines = opts.contextLines ?? 2;
  const lang = opts.path ? langOf(opts.path) : "";
  // "" means no file at all, not a file holding one empty line — otherwise a
  // new file whose second line is blank reports that line as unchanged.
  const ops = diffLines(before === "" ? [] : before.split("\n"), after.split("\n"));

  /** `no: 0` marks the gap row that stands for the lines not shown. */
  const rows: { no: number; mark: " " | "-" | "+"; text: string }[] = [];
  let pending: { no: number; text: string }[] = [];
  let sinceChange = Infinity;
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;

  const flush = () => {
    if (!pending.length) return;
    // The gap goes where the lines were skipped, not at the top of the hunk.
    if (pending.length > contextLines) rows.push({ no: 0, mark: " ", text: "" });
    for (const p of pending.slice(-contextLines)) rows.push({ no: p.no, mark: " ", text: p.text });
    pending = [];
  };

  for (const op of ops) {
    if (op.type === "same") {
      oldNo++;
      newNo++;
      sinceChange++;
      if (sinceChange <= contextLines) rows.push({ no: newNo, mark: " ", text: op.text });
      else pending.push({ no: newNo, text: op.text });
      continue;
    }
    flush();
    sinceChange = 0;
    if (op.type === "add") {
      newNo++;
      added++;
      rows.push({ no: newNo, mark: "+", text: op.text });
    } else {
      oldNo++;
      removed++;
      // Numbered where it used to be: that is the line the reader still has.
      rows.push({ no: oldNo, mark: "-", text: op.text });
    }
  }

  const gutter = Math.max(3, String(rows.reduce((m, r) => Math.max(m, r.no), 0)).length);
  // Hoisted out of diffRow: the width query is a per-call syscall, and paying
  // it for every row is what made big diffs cost half a millisecond a line.
  const w = contentWidth();
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  const hidden = rows.length - shown.length;
  const tail = hidden
    ? [c.gray(t(`… ${count(hidden, ["row", "rows"], ["строка", "строки", "строк"])} not shown`, `… ${count(hidden, ["row", "rows"], ["строка", "строки", "строк"])} не показано`))]
    : [];
  // Unpadded: the caller decides the indent — the transcript and the
  // permission prompt put this block in different places.
  return ["└ " + c.gray(diffSummary(added, removed)), ...shown.map((r) => diffRow(r, gutter, lang, w)), ...tail].join("\n");
}

/** "Added 7 lines, removed 1 line" — either half is dropped when it is zero. */
function diffSummary(added: number, removed: number): string {
  const bits: string[] = [];
  // The colon keeps the Russian impersonal, so it agrees with 1 as well as 3 —
  // "Добавлено 1 строка" would need the feminine, "Добавлено: 1 строка" does not.
  if (added) bits.push(t(`Added ${added} ${plural(added, "line", "lines")}`, `Добавлено: ${count(added, ["line", "lines"], ["строка", "строки", "строк"])}`));
  if (removed) bits.push(t(`removed ${removed} ${plural(removed, "line", "lines")}`, `удалено: ${count(removed, ["line", "lines"], ["строка", "строки", "строк"])}`));
  if (!bits.length) return t("No changes", "Без изменений");
  return bits.join(", ");
}

function diffRow(row: { no: number; mark: " " | "-" | "+"; text: string }, gutter: number, lang: string, w: number): string {
  if (row.no === 0) return " ".repeat(gutter + 1) + c.gray("⋮");

  const num = String(row.no).padStart(gutter);
  const head = `${num} ${row.mark} `;
  // Cut before colouring: width() ignores escapes but cutToWidth() does not, so
  // clipping highlighted text would slice a sequence in half.
  const room = w - TOOL_INDENT.length - width(head);
  const code = highlight(clip(row.text, room), lang);

  if (row.mark === " ") return c.gray(num) + "   " + c.dim(code);

  // The band has to reach the edge, so the line is padded inside the colour.
  const gap = Math.max(0, room - width(code));
  return (row.mark === "+" ? c.bgAdd : c.bgDel)(
    (row.mark === "+" ? c.fgAdd(head) : c.fgDel(head)) + code + " ".repeat(gap),
  );
}

type DiffOp = { type: "same" | "add" | "del"; text: string };

/** Classic LCS diff — fine for the file sizes an edit tool touches. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // Bail out to a coarse diff on very large files.
    return [
      ...a.map((t) => ({ type: "del" as const, text: t })),
      ...b.map((t) => ({ type: "add" as const, text: t })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i++] });
    } else {
      ops.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });
  return ops;
}

export { PAD_LEFT, contentWidth, fullWidth, fmtDuration, pad };
