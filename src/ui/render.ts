/** Transcript rendering: markdown-ish streaming, banners, spinners, diffs. */
import { c, cursor, cutToWidth, esc, stripAnsi, width, wrapAnsi } from "./ansi.js";
import { PAD_LEFT, contentWidth, fmtDuration, fullWidth, indent, pad } from "./layout.js";
import { t, count } from "../i18n.js";
import { rememberCollapsed } from "./paste.js";
import { highlight, langOf } from "./highlight.js";

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
  footerRows = 0;
  footerCursorRow = 0;
  lastFrame = null;
  // Hidden before it moves — a visible cursor walking to the erase point reads
  // as the caret jumping around the screen.
  return esc.hide + esc.toColumn(1) + esc.up(from) + esc.clearDown;
}

/**
 * Parks the caret where the footer says it belongs (the turn bar's input frame)
 * and shows it; without a spot the cursor stays hidden as before. Assumes the
 * cursor sits on the footer's last row.
 */
function caretSeq(lines: string[]): string {
  const caret = footerCaretFn?.() ?? null;
  if (caret && caret.row >= 0 && caret.row < lines.length) {
    footerCursorRow = caret.row;
    return esc.up(lines.length - 1 - caret.row) + esc.toColumn(caret.col + 1) + esc.show;
  }
  footerCursorRow = lines.length - 1;
  return esc.hide;
}

/** Writes the footer where the cursor stands — for a screen without one. */
function drawSeq(lines: string[]): string {
  const body = esc.hide + lines.map((l) => CLEAR_LINE + l).join("\n");
  footerRows = lines.length;
  lastFrame = lines;
  return body + caretSeq(lines);
}

/**
 * Redraws the footer over itself. Writing on top of the old rows rather than
 * erasing them first is what keeps the bar from blinking: no frame ever exists
 * in which the bottom of the screen is blank.
 */
function repaintSeq(lines: string[]): string {
  const prev = footerRows;
  let body =
    esc.hide + esc.toColumn(1) + esc.up(footerCursorRow) + lines.map((l) => CLEAR_LINE + l).join("\n");
  // A shorter bar leaves rows of the taller one below it. That row exists, so
  // stepping onto it to clear downwards cannot scroll the transcript.
  if (lines.length < prev) body += "\n" + esc.clearDown + esc.up(1);
  footerRows = lines.length;
  lastFrame = lines;
  return body + caretSeq(lines);
}

function eraseFooter(): void {
  paint(eraseSeq());
}

function drawFooter(): void {
  if (!footerFn || !process.stdout.isTTY) return;
  const lines = footerFn();
  if (!lines.length) return;
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
export function setFooter(fn: FooterFn | null, caret?: FooterCaretFn | null): void {
  if (footerRows) eraseFooter();
  footerFn = fn;
  footerCaretFn = fn ? (caret ?? null) : null;
  if (fn) {
    cursor.hide();
    drawFooter();
  } else {
    cursor.show();
  }
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
  const lines = footerFn();
  if (!lines.length) return;
  // Several callers can ask for the same frame between two spinner ticks
  // (a label change, a queued line, the tick itself). Drawing it twice costs
  // a repaint the eye can catch, and changes nothing.
  if (footerRows && sameFrame(lines)) return;
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

function writeFrame(s: string): void {
  if (!s) return;
  if (!footerFn || !process.stdout.isTTY) {
    process.stdout.write(s);
    return;
  }
  // A partial line would put the bar on the same row as the text; leave the
  // redraw to the write that finishes the line.
  paint(eraseSeq() + s + (s.endsWith("\n") ? drawSeq(footerFn()) : ""));
}

export function out(s = ""): void {
  if (s) lastBlank = /\n[ \t]*\n$/.test(s);
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
  cwdLabel: string;
  sessionId: string;
  version: string;
  /** Rendered under the box; nudges toward a better setup when one exists. */
  tip?: { title: string; detail: string };
}

const LOGO = [
  " ████████╗██████╗",
  " ╚══██╔══╝██╔══██╗",
  "    ██║   ██████╔╝",
  "    ██║   ██╔══██╗",
  "    ██║   ██║  ██║",
  "    ╚═╝   ╚═╝  ╚═╝",
];

/**
 * The header box. It cannot be edited once printed, so whoever changes what it
 * states repaints the screen and prints it again — see App.repaintHeader.
 */
export function banner(info: BannerInfo): void {
  const inner = contentWidth() - 2;
  const modelValue =
    c.brightCyan(info.model) + (info.effort === "off" ? "" : c.gray(t("  thinking: ", "  мышление: ")) + c.brightMagenta(info.effort));

  /** One framed row, padded to the box width. */
  const row = (content = "") => {
    const gap = Math.max(0, inner - width(content));
    padded(c.brightBlue("│") + content + " ".repeat(gap) + c.brightBlue("│"));
  };

  const field = (label: string, value: string) =>
    row("   " + c.gray(label.padEnd(12)) + c.bold(value));

  line();
  padded(c.brightBlue("╭" + "─".repeat(inner) + "╮"));
  row();
  const aside = [
    c.bold(c.brightBlue(t("Welcome to TRCode!", "TRCode — добро пожаловать!"))),
    "",
  ];
  const fields: [string, string][] = [
    [t("Directory:", "Каталог:"), info.cwdLabel],
    [t("Session:", "Сессия:"), info.sessionId],
    [t("Provider:", "Поставщик:"), c.brightBlue(info.provider)],
    [t("Model:", "Модель:"), modelValue],
    [t("Version:", "Версия:"), info.version],
  ];
  for (const [label, value] of fields) aside.push(c.gray(label.padEnd(12)) + c.bold(value));
  aside.push("", c.gray(t("Send ", "Наберите ")) + c.bold("/help") + c.gray(t(" for help, ", " для справки, ")) + c.bold("/") + c.gray(t(" for the command list", " для списка команд")));
  const logoTop = Math.floor((aside.length - LOGO.length) / 2);
  aside.forEach((text, i) => {
    const art = c.brightCyan((LOGO[i - logoTop] ?? "").padEnd(19));
    row("   " + art + (text ? "  " : "") + text);
  });
  row();
  padded(c.brightBlue("╰" + "─".repeat(inner) + "╯"));

  if (info.tip) {
    line();
    padded(c.brightYellow("✦ ") + c.brightBlue(info.tip.title));
    padded("  " + c.gray(info.tip.detail));
  }
  line();
}

/**
 * How much of a long message is echoed before it is cut. A pasted log is
 * something you already have; scrolling past it twice — once in the frame,
 * once in the transcript — is what the cut exists to prevent.
 */
const ECHO_LINES = 5;

export function userEcho(text: string): void {
  line();
  const all = wrapText(text, contentWidth() - 2);
  // Two lines over the limit is not worth a handle; a screenful is.
  const cut = all.length > ECHO_LINES + 2;
  const shown = cut ? all.slice(0, ECHO_LINES) : all;
  // The star marks the turn, not every line of it.
  for (const [i, l] of shown.entries()) {
    line(pad((i === 0 ? c.brightYellow("✦ ") : "  ") + c.bold(l)));
  }
  if (cut) {
    rememberCollapsed(text);
    const rest = all.length - shown.length;
    line(
      pad(
        "  " +
          c.gray(
            t(`… ${rest} more lines · ctrl+o to see all of it`, `… ещё строк: ${rest} · ctrl+o — показать целиком`),
          ),
      ),
    );
  }
  line();
}

export function assistantPrefix(model: string): void {
  padded(c.brightMagenta("●") + " " + c.dim(model));
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
  shell: "Bash",
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
  // Two lines' worth: a real command — a cd, a pipe and a grep — does not fit
  // on one, and cutting it at the pipe hides the half that explains the
  // output underneath it.
  const w = contentWidth();
  const rows = wrapAnsi(
    c.brightGreen("● ") + c.bold(verb) + c.gray("(") + c.bold(truncate(summary, w * 2 - 14)) + c.gray(")"),
    w,
  );
  padded(rows[0]);
  // A command that runs onto a second line hangs under the first, the way its
  // output does — flush left it would read as another call.
  for (const l of rows.slice(1)) padded("  " + l);
}

export function toolDone(ok: boolean, detail: string, kind: "text" | "diff" = "text"): void {
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
    return;
  }
  const mark = ok ? c.green("└ ") : c.red("└ ");
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

  constructor(private label: string) {}

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
    cursor.clearLine();
    cursor.toColumn(0);
    out(
      indent +
        c.brightMagenta(FRAMES[this.i++ % FRAMES.length]) +
        " " +
        c.dim(this.label) +
        c.gray(` (${elapsed}${counts})`) +
        c.gray("  esc to interrupt"),
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
    (row.mark === "+" ? c.green(head) : c.red(head)) + code + " ".repeat(gap),
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
