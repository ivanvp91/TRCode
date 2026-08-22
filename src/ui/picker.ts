/** Interactive list picker: arrow keys, type-to-filter, sections, tabs. */
import { t } from "../i18n.js";
import { c, clipAnsi, cursor } from "./ansi.js";
import { contentWidth, indent } from "./layout.js";
import { line, out } from "./render.js";
import { pushConsumer } from "./stdin.js";

const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
const UP = ESC + "[A";
const DOWN = ESC + "[B";
const RIGHT = ESC + "[C";
const LEFT = ESC + "[D";
const TAB = String.fromCharCode(9);
/** Written this way so the source file stays plain text. */
const CONTROL_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + DEL + "]", "g");

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
  return run(opts, false) as Promise<string | null>;
}

/**
 * The same list, choosing several. Space marks a row, Enter returns everything
 * marked — or, when nothing is marked, the row under the cursor, so a list
 * used for one thing does not need a different key to answer with one thing.
 */
export function pickMulti(opts: PickerOptions & { selected?: string[] }): Promise<string[] | null> {
  return run(opts, true) as Promise<string[] | null>;
}

function run(opts: PickerOptions & { selected?: string[] }, multi: boolean): Promise<string | string[] | null> {
  const stdin = process.stdin;
  const tabs = opts.tabs ?? [];
  const resolveItems = (tabKey: string): PickerItem[] =>
    typeof opts.items === "function" ? opts.items(tabKey) : opts.items;

  let tabIndex = Math.max(0, tabs.findIndex((t) => t.key === opts.initialTab));
  if (!tabs.length) tabIndex = 0;

  if (!stdin.isTTY) return Promise.resolve(null);
  const chosen = new Set<string>(opts.selected ?? []);

  return new Promise((resolve) => {
    // Chrome above and below the page: title, tabs, search field, key hints
    // and the position counter.
    const pageSize = Math.min(opts.pageSize ?? 14, Math.max(4, (process.stdout.rows || 24) - 10));
    let filter = "";
    let all: PickerItem[] = resolveItems(tabs[tabIndex]?.key ?? "");
    let index = 0;
    let rendered = 0;

    /**
     * Every word has to appear somewhere in the row, in any order: with 500
     * models in a list, "qwen max" is how a person looks for `qwen3.8-max`,
     * and a plain substring search finds nothing for it.
     */
    const matches = (it: PickerItem, words: string[]): boolean => {
      const hay = `${it.label} ${it.value}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    };

    /** Selectable entries only. */
    const visible = (): PickerItem[] => {
      const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
      const kept: PickerItem[] = [];
      let pendingHeader: PickerItem | null = null;
      for (const it of all) {
        if (it.header) {
          pendingHeader = it;
          continue;
        }
        if (words.length && !matches(it, words)) continue;
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
      // The search field sits above the list, where the typing goes. Hiding it
      // in the footer made a long list look unsearchable — the whole point is
      // that it is visible before anyone thinks to try typing into it.
      const matched = selectableIdx(rows).length;
      const totalItems = all.filter((it) => !it.header).length;
      const counter = filter ? `${matched}/${totalItems}` : String(totalItems);
      const field = filter
        ? c.brightYellow(filter) + c.brightCyan("▏")
        : c.dim(t("search — just type", "поиск — просто печатайте"));
      const searchWidth = Math.max(10, w - counter.length - 6);
      buf.push(c.brightCyan("⌕ ") + clipAnsi(field, searchWidth).padEnd(0) + c.gray(`  ${counter}`));
      buf.push(
        c.gray(
          multi
            ? t(
                "↑↓ move · Space mark · Enter confirm · Esc cancel · ^U clear",
                "↑↓ выбор · Пробел отметить · Enter подтвердить · Esc отмена · ^U очистить",
              )
            : t(
                "↑↓ move · Enter select · Esc cancel · ^U clear",
                "↑↓ выбор · Enter выбрать · Esc отмена · ^U очистить",
              ),
        ),
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
        const box = multi ? (chosen.has(item.value) ? c.brightGreen("[x] ") : c.gray("[ ] ")) : "";
        const name = active ? c.bold(c.brightCyan(item.label)) : item.label;
        const hint = item.hint ? c.dim(" " + item.hint) : "";
        const badge = item.badge ? c.gray(" " + item.badge) : "";
        buf.push(`${marker}${box}${clipAnsi(name + hint + badge, w - 4 - (multi ? 4 : 0))}`);
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

    const finish = (value: string | string[] | null) => {
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
        const here = item && !item.header ? item.value : null;
        if (!multi) return finish(here);
        // Nothing marked: the row under the cursor is the answer, so one list
        // serves both jobs without a second key to learn.
        return finish(chosen.size ? [...chosen] : here ? [here] : []);
      }
      if (s === " " && multi) {
        const item = visible()[index];
        if (item && !item.header) {
          if (chosen.has(item.value)) chosen.delete(item.value);
          else chosen.add(item.value);
        }
        return draw();
      }
      if (s === UP) return move(-1), draw();
      if (s === DOWN) return move(1), draw();
      if (s === LEFT) return switchTab(-1), draw();
      if (s === RIGHT || s === TAB) return switchTab(1), draw();
      if (s === DEL || s === BACKSPACE) {
        filter = filter.slice(0, -1);
        return draw();
      }
      if (s === CTRL_U) {
        filter = "";
        return draw();
      }
      // Anything left that is not an escape sequence is text for the search.
      // Taken as a chunk rather than a character: a pasted model name arrives
      // in one read, and a one-character rule dropped the whole paste.
      if (s === " " && multi) return; // handled above; never search text here
      if (s.startsWith(ESC)) return;
      const text = s.replace(CONTROL_CHARS, "");
      if (text) {
        filter += text;
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
