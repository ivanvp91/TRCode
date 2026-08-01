/** Transcript rendering: markdown-ish streaming, banners, spinners, diffs. */
import { c, cursor, width } from "./ansi.js";
import { PAD_LEFT, contentWidth, fmtDuration, fullWidth, indent, pad } from "./layout.js";

export function out(s = ""): void {
  process.stdout.write(s);
}
export function line(s = ""): void {
  process.stdout.write(s + "\n");
}
/** Writes a line inside the chat margins. */
export function padded(s = ""): void {
  line(pad(s));
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
  model: string;
  defaultModel: string;
  effort: string;
  cwdLabel: string;
  sessionId: string;
  version: string;
  /** Rendered under the box; nudges toward a better setup when one exists. */
  tip?: { title: string; detail: string };
}

const LOGO = ["▛▀▀▀▀▀▜", "▌ █ █ ▐", "▙▄▄▄▄▄▟"];

export function banner(info: BannerInfo): void {
  const w = contentWidth();
  const inner = w - 2;

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
  row(
    "   " + c.brightCyan(LOGO[0]) + "   " + c.bold(c.brightBlue("Welcome to TokenRouter Code!")),
  );
  row("   " + c.brightCyan(LOGO[1]) + "   " + c.gray("Send ") + c.bold("/help") + c.gray(" for help, ") + c.bold("/") + c.gray(" for the command list"));
  row("   " + c.brightCyan(LOGO[2]));
  row();
  field("Directory:", info.cwdLabel);
  field("Session:", info.sessionId);
  field(
    "Model:",
    info.model + (info.effort === "off" ? "" : c.gray("  thinking: ") + c.brightMagenta(info.effort)),
  );
  field("Version:", info.version);
  row();
  padded(c.brightBlue("╰" + "─".repeat(inner) + "╯"));

  if (info.tip) {
    line();
    padded(c.brightYellow("✦ ") + c.brightBlue(info.tip.title));
    padded("  " + c.gray(info.tip.detail));
  }
  line();
}

export function userEcho(text: string): void {
  line();
  // The star marks the turn, not every line of it.
  for (const [i, l] of wrapText(text, contentWidth() - 2).entries()) {
    line(pad((i === 0 ? c.brightYellow("✦ ") : "  ") + c.bold(l)));
  }
  line();
}

export function assistantPrefix(model: string): void {
  padded(c.brightMagenta("●") + " " + c.dim(model));
}

export function toolStart(name: string, summary: string): void {
  padded(
    c.brightCyan("⏺ ") + c.bold(name) + c.gray("(") + c.dim(truncate(summary, contentWidth() - 12)) + c.gray(")"),
  );
}

export function toolDone(ok: boolean, detail: string): void {
  const mark = ok ? c.green("  └ ") : c.red("  └ ");
  const all = detail.split("\n");
  // Diffs live here, so indentation is preserved — only the length is clipped.
  for (const l of all.slice(0, 12)) line(pad(mark + c.dim(clip(l, contentWidth() - 6))));
  if (all.length > 12) padded(c.gray(`    … ${all.length - 12} more lines`));
}

export function info(s: string): void {
  padded(c.cyan("ℹ ") + s);
}
export function warn(s: string): void {
  padded(c.yellow("⚠ ") + s);
}
export function error(s: string): void {
  padded(c.red("✖ ") + s);
}
export function success(s: string): void {
  padded(c.green("✔ ") + s);
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
  return width(flat) <= max ? flat : flat.slice(0, max - 1) + "…";
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
export class MarkdownStream {
  private buf = "";
  private inFence = false;
  private wroteAny = false;

  push(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const l = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.emitLine(l);
    }
  }

  /** Flush the trailing partial line. */
  end(): void {
    if (this.buf) {
      this.emitLine(this.buf);
      this.buf = "";
    }
    if (this.wroteAny) line();
  }

  private emitLine(l: string): void {
    this.wroteAny = true;
    const w = contentWidth();
    if (/^\s*```/.test(l)) {
      this.inFence = !this.inFence;
      padded(c.gray(l.trim()));
      return;
    }
    if (this.inFence) {
      padded(c.dim(clip(l, w)));
      return;
    }
    if (/^#{1,6}\s/.test(l)) {
      padded(c.bold(l));
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

/** Pipe-table → aligned columns. Falls back to plain rows when it does not fit. */
function renderTable(rows: string[], w: number, dim?: boolean): string[] {
  const cells = rows
    .filter((r) => !TABLE_SEP.test(r))
    .map((r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim()));
  if (!cells.length) return [];

  const cols = Math.max(...cells.map((r) => r.length));
  const widths = new Array(cols).fill(0);
  for (const row of cells) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i], width(cell))));
  }

  // " │ " between columns; shrink the widest column until the row fits.
  const gutters = (cols - 1) * 3;
  let total = widths.reduce((a, b) => a + b, 0) + gutters;
  while (total > w && Math.max(...widths) > 6) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest]--;
    total--;
  }

  const hadHeader = rows.some((r) => TABLE_SEP.test(r));
  const soft = (s: string) => (dim ? c.dim(s) : s);
  const outRows: string[] = [];
  cells.forEach((row, r) => {
    const parts = widths.map((cw, i) => padCell(row[i] ?? "", cw));
    const text = parts.join(c.gray(" │ "));
    outRows.push(hadHeader && r === 0 ? c.bold(text) : soft(text));
    if (hadHeader && r === 0) outRows.push(c.gray(widths.map((cw) => "─".repeat(cw)).join("─┼─")));
  });
  return outRows;
}

function padCell(s: string, w: number): string {
  const flat = s.replace(/`/g, "");
  const shown = width(flat) > w ? clip(flat, w) : flat;
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
        ? ` · ↑${fmtCompact(this.inTokens)} ↓${fmtCompact(this.outTokens)}`
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
    cursor.show();
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
export function renderDiff(before: string, after: string, contextLines = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);
  const parts: string[] = [];
  let pending: string[] = [];
  let sinceChange = Infinity;

  for (const op of ops) {
    if (op.type === "same") {
      sinceChange++;
      if (sinceChange <= contextLines) parts.push(c.dim("   " + op.text));
      else pending.push(op.text);
      continue;
    }
    if (pending.length) {
      const tail = pending.slice(-contextLines);
      if (pending.length > contextLines) parts.push(c.gray("   ⋮"));
      for (const t of tail) parts.push(c.dim("   " + t));
      pending = [];
    }
    sinceChange = 0;
    parts.push(op.type === "add" ? c.green(" + " + op.text) : c.red(" - " + op.text));
  }
  return parts.join("\n");
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
