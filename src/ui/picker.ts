/** Interactive list picker: arrow keys, type-to-filter, sections, tabs. */
import { c, cursor } from "./ansi.js";
import { contentWidth, indent } from "./layout.js";
import { line, out, truncate } from "./render.js";
import { pushConsumer } from "./stdin.js";

const CTRL_C = String.fromCharCode(3);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
const UP = ESC + "[A";
const DOWN = ESC + "[B";
const RIGHT = ESC + "[C";
const LEFT = ESC + "[D";
const TAB = String.fromCharCode(9);

export interface PickerItem {
  value: string;
  label: string;
  hint?: string;
  badge?: string;
  /** Section heading: rendered, never selectable. */
  header?: string;
}

export interface PickerTab {
  key: string;
  label: string;
  /** Shown next to the label, e.g. a count. */
  count?: number;
}

export interface PickerOptions {
  title: string;
  /** Items for the active tab; recomputed whenever the tab changes. */
  items: PickerItem[] | ((tabKey: string) => PickerItem[]);
  tabs?: PickerTab[];
  initialTab?: string;
  initial?: string;
  pageSize?: number;
}

/** Returns the chosen value, or null when cancelled. */
export function pick(opts: PickerOptions): Promise<string | null> {
  const stdin = process.stdin;
  const tabs = opts.tabs ?? [];
  const resolveItems = (tabKey: string): PickerItem[] =>
    typeof opts.items === "function" ? opts.items(tabKey) : opts.items;

  let tabIndex = Math.max(0, tabs.findIndex((t) => t.key === opts.initialTab));
  if (!tabs.length) tabIndex = 0;

  if (!stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    const pageSize = Math.min(opts.pageSize ?? 14, Math.max(4, (process.stdout.rows || 24) - 9));
    let filter = "";
    let all: PickerItem[] = resolveItems(tabs[tabIndex]?.key ?? "");
    let index = 0;
    let rendered = 0;

    /** Selectable entries only. */
    const visible = (): PickerItem[] => {
      const f = filter.toLowerCase();
      const kept: PickerItem[] = [];
      let pendingHeader: PickerItem | null = null;
      for (const it of all) {
        if (it.header) {
          pendingHeader = it;
          continue;
        }
        if (f && !it.label.toLowerCase().includes(f) && !it.value.toLowerCase().includes(f)) continue;
        if (pendingHeader) {
          kept.push(pendingHeader);
          pendingHeader = null;
        }
        kept.push(it);
      }
      return kept;
    };

    const selectableIdx = (rows: PickerItem[]): number[] =>
      rows.map((r, i) => (r.header ? -1 : i)).filter((i) => i !== -1);

    const syncIndex = (rows: PickerItem[]) => {
      const sel = selectableIdx(rows);
      if (!sel.length) {
        index = 0;
        return;
      }
      if (!sel.includes(index)) index = sel[0];
    };

    const move = (dir: 1 | -1) => {
      const rows = visible();
      const sel = selectableIdx(rows);
      if (!sel.length) return;
      const at = sel.indexOf(index);
      index = sel[(at + dir + sel.length) % sel.length];
    };

    const switchTab = (dir: 1 | -1) => {
      if (tabs.length < 2) return;
      tabIndex = (tabIndex + dir + tabs.length) % tabs.length;
      all = resolveItems(tabs[tabIndex].key);
      filter = "";
      index = 0;
      syncIndex(visible());
    };

    const clear = () => {
      if (!rendered) return;
      cursor.up(rendered);
      cursor.toColumn(0);
      cursor.clearDown();
      rendered = 0;
    };

    const draw = () => {
      clear();
      const rows = visible();
      syncIndex(rows);
      const w = contentWidth();
      const buf: string[] = [];

      buf.push(c.bold(opts.title));
      if (tabs.length) {
        const strip = tabs
          .map((t, i) => {
            const text = ` ${t.label}${t.count !== undefined ? ` ${t.count}` : ""} `;
            return i === tabIndex ? c.inverse(c.bold(text)) : c.gray(`[${text.trim()}]`);
          })
          .join(" ");
        buf.push(strip + c.gray("   ←/→ or Tab to switch type"));
      }
      buf.push(
        c.gray("↑↓ move · Enter select · Esc cancel · type to filter") +
          (filter ? c.gray(" · filter: ") + c.brightYellow(filter) : ""),
      );

      // Keep the cursor roughly centred without slicing off headers.
      const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), Math.max(0, rows.length - pageSize)));
      const page = rows.slice(start, start + pageSize);

      if (!page.length) buf.push(c.dim("  nothing matches"));

      for (const [i, item] of page.entries()) {
        const abs = start + i;
        if (item.header) {
          const dashes = "─".repeat(Math.max(2, Math.min(24, w - item.header.length - 8)));
          buf.push(c.gray(` ── `) + c.bold(c.brightBlue(item.header)) + c.gray(` ${dashes}`));
          continue;
        }
        const active = abs === index;
        const marker = active ? c.brightCyan("❯ ") : "  ";
        const name = active ? c.bold(c.brightCyan(item.label)) : item.label;
        const hint = item.hint ? c.dim(" " + item.hint) : "";
        const badge = item.badge ? c.gray(" " + item.badge) : "";
        buf.push(`${marker}${truncate(name + hint + badge, w - 4)}`);
      }

      const total = selectableIdx(rows).length;
      if (total > page.length) buf.push(c.gray(`  ${selectableIdx(rows).indexOf(index) + 1}/${total}`));

      for (const l of buf) line(indent + l);
      rendered = buf.length;
    };

    let release: () => void = () => {};
    cursor.hide();
    syncIndex(visible());
    if (opts.initial) {
      const rows = visible();
      const at = rows.findIndex((r) => r.value === opts.initial && !r.header);
      if (at !== -1) index = at;
    }
    draw();

    const finish = (value: string | null) => {
      release();
      clear();
      cursor.show();
      resolve(value);
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");

      if (s === CTRL_C || s === ESC) return finish(null);
      if (s === "\r" || s === "\n") {
        const rows = visible();
        const item = rows[index];
        return finish(item && !item.header ? item.value : null);
      }
      if (s === UP) return move(-1), draw();
      if (s === DOWN) return move(1), draw();
      if (s === LEFT) return switchTab(-1), draw();
      if (s === RIGHT || s === TAB) return switchTab(1), draw();
      if (s === DEL || s === BACKSPACE) {
        filter = filter.slice(0, -1);
        return draw();
      }
      if (s >= " " && s.length === 1) {
        filter += s;
        return draw();
      }
    };

    release = pushConsumer(onData);
  });
}

/** Fallback for non-TTY: prints a numbered list, no interaction. */
export function printList(title: string, items: PickerItem[]): void {
  line(indent + c.bold(title));
  for (const it of items) {
    if (it.header) {
      line(indent + c.bold(c.brightBlue(` ── ${it.header} ──`)));
      continue;
    }
    out(indent + "  " + it.label);
    line(it.hint ? c.dim("  " + it.hint) : "");
  }
}
