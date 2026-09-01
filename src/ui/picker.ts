/**
 * The modal chooser: a bordered panel with a search field, optional sections,
 * a scrolling list and a row of buttons.
 *
 * Everything a command used to print as a wall of text — a catalogue, a list
 * of skills, the models a subagent may use — is shown here instead, and the
 * sub-commands that used to be typed (`add`, `auto`, `refresh`) are the
 * buttons along the bottom. They stay commands on the command line; the panel
 * is for the times you do not remember which word it was.
 */
import { t } from "../i18n.js";
import { c, clipAnsi, cursor, width } from "./ansi.js";
import { contentWidth, indent } from "./layout.js";
import { line, out } from "./render.js";
import { pushConsumer } from "./stdin.js";
import {
  innerWidth,
  modalBottom,
  modalButtons,
  modalField,
  modalFooter,
  modalKeys,
  modalRow,
  modalSearchPlaceholder,
  modalSep,
  modalTabs,
  modalTop,
  type ModalAction,
} from "./modal.js";

const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
const UP = ESC + "[A";
const DOWN = ESC + "[B";
const RIGHT = ESC + "[C";
const LEFT = ESC + "[D";
const SHIFT_TAB = ESC + "[Z";
const TAB = String.fromCharCode(9);
/** Written this way so the source file stays plain text. */
const CONTROL_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + DEL + "]", "g");

export type { ModalAction };

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
  /** Buttons along the foot of the panel — the typed sub-commands, clickable. */
  actions?: ModalAction[];
  /** One line of explanation under the title. */
  subtitle?: string;
  /**
   * Already-styled rows drawn between the subtitle and the list — a totals
   * line, a legend. Passed through untouched, so the caller keeps its colours.
   */
  notes?: string[] | ((tabKey: string) => string[]);
  /**
   * A panel that reports rather than asks: no cursor on the rows, Enter
   * closes it. The arrows still scroll, and the buttons still work.
   */
  readOnly?: boolean;
  /** Force the search field on or off; by default it appears for long lists. */
  search?: boolean;
  /** Shown in place of the list when there is nothing to show. */
  empty?: string;
  /**
   * Multi-select only: Enter with nothing marked answers with an empty set
   * rather than the row under the cursor. For the lists where "none" is a
   * real answer — no panel, no extra subagent models — and not an accident.
   */
  allowEmpty?: boolean;
  /**
   * A blank line before every section heading except the first. A tab key may
   * be listed here to turn it on for that tab alone — the favorite tab's
   * provider sections read as groups, one modality's list does not.
   */
  groupGap?: boolean | string[];
  /**
   * Called once the panel is up, with a function that re-reads `items` and
   * redraws in place — for a list that improves while open, like a catalog
   * re-fetched in the background. May return a cleanup, run when it closes.
   */
  onOpen?: (update: () => void) => (() => void) | void;
}

/** What the panel was closed with. */
export type ModalResult =
  | { kind: "item"; value: string; values: string[]; tab: string }
  | { kind: "action"; id: string; value: string | null; values: string[]; tab: string };

/** Returns the chosen value, or null when cancelled. */
export function pick(opts: PickerOptions): Promise<string | null> {
  return openModal(opts).then((r) => (r && r.kind === "item" ? r.value : null));
}

/**
 * The same list, choosing several. Space marks a row, Enter returns everything
 * marked — or, when nothing is marked, the row under the cursor, so a list
 * used for one thing does not need a different key to answer with one thing.
 */
export function pickMulti(opts: PickerOptions & { selected?: string[] }): Promise<string[] | null> {
  return openModal({ ...opts, multi: true }).then((r) => (r && r.kind === "item" ? r.values : null));
}

/**
 * The full panel: the answer is either a row or a button, and the caller
 * decides what to do about either. A button carries the row that was under
 * the cursor, because "delete" and "edit" are about the row you are looking at.
 */
export function openModal(
  opts: PickerOptions & { multi?: boolean; selected?: string[] },
): Promise<ModalResult | null> {
  const stdin = process.stdin;
  const multi = opts.multi === true;
  const tabs = opts.tabs ?? [];
  const actions = (opts.actions ?? []).filter(Boolean);
  const resolveItems = (tabKey: string): PickerItem[] =>
    typeof opts.items === "function" ? opts.items(tabKey) : opts.items;

  let tabIndex = Math.max(0, tabs.findIndex((tab) => tab.key === opts.initialTab));
  if (!tabs.length) tabIndex = 0;

  if (!stdin.isTTY) return Promise.resolve(null);
  const chosen = new Set<string>(opts.selected ?? []);

  return new Promise((resolve) => {
    let filter = "";
    let all: PickerItem[] = resolveItems(tabs[tabIndex]?.key ?? "");
    let index = 0;
    let rendered = 0;
    /** First row of the current page; moves only when the cursor hits an edge. */
    let viewStart = 0;
    /** The list owns the keyboard until Tab hands it to the buttons. */
    let focus: "list" | "buttons" = "list";
    let buttonIdx = actions.findIndex((a) => !a.disabled);
    if (buttonIdx < 0) buttonIdx = 0;

    const totalItems = () => all.filter((it) => !it.header).length;
    /** Short lists are their own index; a field over four rows is clutter. */
    const searchOn = () => opts.search ?? totalItems() > 4;

    /**
     * Every word has to appear somewhere in the row, in any order: with 500
     * models in a list, "qwen max" is how a person looks for `qwen3.8-max`,
     * and a plain substring search finds nothing for it.
     */
    const matches = (it: PickerItem, words: string[]): boolean => {
      const hay = `${it.label} ${it.value} ${it.hint ?? ""}`.toLowerCase();
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

    const moveButton = (dir: 1 | -1) => {
      const usable = actions.map((a, i) => (a.disabled ? -1 : i)).filter((i) => i !== -1);
      if (!usable.length) return;
      const at = usable.indexOf(buttonIdx);
      buttonIdx = usable[(at + dir + usable.length) % usable.length];
    };

    const switchTab = (dir: 1 | -1) => {
      if (tabs.length < 2) return;
      tabIndex = (tabIndex + dir + tabs.length) % tabs.length;
      all = resolveItems(tabs[tabIndex].key);
      filter = "";
      index = 0;
      viewStart = 0;
      syncIndex(visible());
    };

    const currentValue = (): string | null => {
      const item = visible()[index];
      return item && !item.header ? item.value : null;
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
      const inner = innerWidth(w);
      const buf: string[] = [];

      buf.push(modalTop(w, opts.title));
      buf.push(modalRow(w));
      if (opts.subtitle) {
        for (const l of wrapPlain(opts.subtitle, inner)) buf.push(modalRow(w, c.dim(l)));
        buf.push(modalRow(w));
      }
      const notes = typeof opts.notes === "function" ? opts.notes(tabs[tabIndex]?.key ?? "") : opts.notes;
      if (notes?.length) {
        for (const l of notes) buf.push(modalRow(w, l));
        buf.push(modalRow(w));
      }
      for (const l of modalTabs(w, tabs, tabIndex)) buf.push(l);

      const matched = selectableIdx(rows).length;
      const counter = filter ? `${matched}/${totalItems()}` : String(totalItems());
      if (searchOn()) {
        for (const l of modalField(w, {
          text: filter,
          placeholder: modalSearchPlaceholder(),
          counter,
          focused: focus === "list",
        })) {
          buf.push(l);
        }
        buf.push(modalRow(w));
      }

      // What is left for the list once the chrome above and below is counted.
      const buttonRows = modalButtons(w, actions, focus === "buttons" ? buttonIdx : null);
      const chromeBelow = 1 /* pad */ + (buttonRows.length ? buttonRows.length + 1 : 0) + 1 /* footer */ + 1 /* bottom */;
      // Gaps before section headings inside the page are part of its height:
      // the slice can hold fewer items than `pageSize` when it carries gaps.
      const gapOn = Array.isArray(opts.groupGap)
        ? opts.groupGap.includes(tabs[tabIndex]?.key ?? "")
        : opts.groupGap === true;
      const room = Math.max(4, (process.stdout.rows || 24) - buf.length - chromeBelow - 3);
      const pageSize = Math.min(opts.pageSize ?? 14, room);

      // Anchor the window at the top and slide it only when the cursor walks
      // past an edge. Re-centering on every step redraws the whole panel from
      // a different offset, which reads as the screen scrolling; walking rows
      // inside the page must leave everything else untouched.
      //
      // The page budget is in *drawn* lines: a gap before a header costs one,
      // a header itself one more, so how many rows fit depends on where the
      // window starts. buildPage turns a start index into exactly the rows the
      // frame will draw, never exceeding pageSize drawn lines.
      const buildPage = (start: number): PickerItem[] => {
        const pageRows: PickerItem[] = [];
        let used = 0;
        for (let i = start; i < rows.length; i++) {
          const cost = i > start && gapOn && rows[i].header && !rows[i - 1].header ? 2 : 1;
          if (used + cost > pageSize) break;
          pageRows.push(rows[i]);
          used += cost;
        }
        return pageRows;
      };
      /** Row index of the last selectable row a window at start shows. */
      const drawnEnd = (start: number): number => {
        const pageRows = buildPage(start);
        for (let i = pageRows.length - 1; i >= 0; i--) if (!pageRows[i].header) return start + i;
        return start;
      };
      if (index < viewStart) viewStart = index;
      while (index > drawnEnd(viewStart) && viewStart < rows.length - 1) viewStart++;

      // Headers lead their section: a window starting on a model whose group
      // heading sits above it would draw that model headless. Slide the top
      // back past headers — and re-check the cursor afterwards, since the
      // widened page may now end before it (the list tail case).
      while (viewStart > 0 && rows[viewStart]?.header) viewStart--;
      while (index > drawnEnd(viewStart) && viewStart < rows.length - 1) viewStart++;
      const page = buildPage(viewStart);

      if (!page.length) {
        buf.push(modalRow(w, c.dim(filter ? t("nothing matches", "ничего не найдено") : (opts.empty ?? t("nothing here yet", "здесь пока пусто")))));
      }

      for (const [i, item] of page.entries()) {
        const abs = viewStart + i;
        if (item.header) {
          if (gapOn && abs > 0 && rows[abs - 1] && !rows[abs - 1].header) {
            buf.push(modalRow(w));
          }
          buf.push(modalSep(w, item.header));
          continue;
        }
        const active = abs === index && focus === "list" && !opts.readOnly;
        const marker = abs === index && !opts.readOnly ? c.brightCyan("❯ ") : "  ";
        const box = multi ? (chosen.has(item.value) ? c.brightGreen("[x] ") : c.gray("[ ] ")) : "";
        const name = active ? c.bold(c.brightCyan(item.label)) : item.label;
        const hint = item.hint ? c.dim(" " + item.hint) : "";
        const badge = item.badge ? c.gray(" " + item.badge) : "";
        buf.push(modalRow(w, `${marker}${box}${clipAnsi(name + hint + badge, inner - 2 - (multi ? 4 : 0))}`));
      }

      buf.push(modalRow(w));
      if (buttonRows.length) {
        buf.push(modalSep(w));
        for (const l of buttonRows) buf.push(l);
      }

      const total = selectableIdx(rows).length;
      const keys =
        focus === "buttons"
          ? [modalKeys.move().replace("↑↓", "←→"), t("Enter run", "Enter выполнить"), modalKeys.back(), modalKeys.close()].join(" · ")
          : opts.readOnly
            ? [modalKeys.scroll(), tabs.length > 1 ? modalKeys.tabs() : "", buttonRows.length ? modalKeys.buttons() : "", modalKeys.close()]
                .filter(Boolean)
                .join(" · ")
            : [
              modalKeys.move(),
              multi ? modalKeys.mark() : "",
              multi ? modalKeys.confirm() : modalKeys.select(),
              tabs.length > 1 ? modalKeys.tabs() : "",
              buttonRows.length ? modalKeys.buttons() : "",
              modalKeys.close(),
            ]
              .filter(Boolean)
              .join(" · ");
      const position = total > page.length ? `${selectableIdx(rows).indexOf(index) + 1}/${total}` : "";
      buf.push(modalFooter(w, keys, position));
      buf.push(modalBottom(w));

      for (const l of buf) line(indent + l);
      rendered = buf.length;
    };

    let release: () => void = () => {};
    let stopLive: (() => void) | void;
    let closed = false;
    cursor.hide();
    syncIndex(visible());
    if (opts.initial) {
      const rows = visible();
      const at = rows.findIndex((r) => r.value === opts.initial && !r.header);
      if (at !== -1) index = at;
    }
    draw();

    const finish = (value: ModalResult | null) => {
      closed = true;
      if (typeof stopLive === "function") stopLive();
      release();
      clear();
      cursor.show();
      resolve(value);
    };

    const activeTab = () => tabs[tabIndex]?.key ?? "";

    const answerItem = () => {
      const here = currentValue();
      if (!multi) return finish(here === null ? null : { kind: "item", value: here, values: here ? [here] : [], tab: activeTab() });
      // Nothing marked: the row under the cursor is the answer, so one list
      // serves both jobs without a second key to learn.
      const values = chosen.size ? [...chosen] : opts.allowEmpty ? [] : here ? [here] : [];
      return finish({ kind: "item", value: values[0] ?? "", values, tab: activeTab() });
    };

    const runAction = (id: string) =>
      finish({ kind: "action", id, value: currentValue(), values: [...chosen], tab: activeTab() });

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");

      if (s === CTRL_C || s === ESC) return finish(null);

      // Alt+key reaches a button from anywhere: the search field owns every
      // bare letter, and a terminal spells Alt+x as ESC followed by x. The
      // number is the reliable half — a Russian label has no Latin letter to
      // underline — and the letter is there for the labels that do.
      if (s.length === 2 && s[0] === ESC && /[a-zA-Zа-яА-Я0-9]/.test(s[1])) {
        const n = Number(s[1]);
        const byNumber = Number.isInteger(n) && n >= 1 ? actions[n - 1] : undefined;
        const hit =
          byNumber ?? actions.find((a) => a.hotkey && a.hotkey.toLowerCase() === s[1].toLowerCase());
        if (hit && !hit.disabled) return runAction(hit.id);
        return;
      }

      if (s === SHIFT_TAB) {
        if (!actions.length) return switchTab(-1), draw();
        if (focus === "buttons") {
          const usable = actions.map((a, i) => (a.disabled ? -1 : i)).filter((i) => i !== -1);
          if (buttonIdx === usable[0]) focus = "list";
          else moveButton(-1);
        } else {
          focus = "buttons";
          buttonIdx = Math.max(0, actions.map((a, i) => (a.disabled ? -1 : i)).filter((i) => i !== -1).pop() ?? 0);
        }
        return draw();
      }

      if (s === TAB) {
        if (!actions.length) return switchTab(1), draw();
        if (focus === "list") {
          focus = "buttons";
          const usable = actions.map((a, i) => (a.disabled ? -1 : i)).filter((i) => i !== -1);
          buttonIdx = usable[0] ?? 0;
        } else {
          const usable = actions.map((a, i) => (a.disabled ? -1 : i)).filter((i) => i !== -1);
          if (buttonIdx === usable[usable.length - 1]) focus = "list";
          else moveButton(1);
        }
        return draw();
      }

      if (focus === "buttons") {
        if (s === "\r" || s === "\n") {
          const a = actions[buttonIdx];
          return a && !a.disabled ? runAction(a.id) : undefined;
        }
        if (s === LEFT) return moveButton(-1), draw();
        if (s === RIGHT) return moveButton(1), draw();
        if (s === UP || s === DOWN) {
          focus = "list";
          return draw();
        }
        // Anything typed is a search: the field is where letters belong, and
        // wanting to type is wanting the list back.
        if (!s.startsWith(ESC)) {
          const text = s.replace(CONTROL_CHARS, "");
          if (text) {
            focus = "list";
            filter += text;
            return draw();
          }
        }
        return;
      }

      // A panel that only reports has nothing to answer with: Enter closes it,
      // the way Esc does. A multi panel with nothing marked answers only when
      // the caller allowed an empty set — an Enter on a bare row must not
      // silently wipe a set the user sees unchecked because a filter hides
      // the marked rows.
      if (s === "\r" || s === "\n") {
        if (opts.readOnly) return finish(null);
        return answerItem();
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
      // A page at a time, for lists too long to walk: the terminal spells
      // PageUp/PageDown as ESC [5~ / ESC [6~.
      if (s === "\x1b[5~" || s === "\x1b[6~") {
        const dir = s === "\x1b[6~" ? 1 : -1;
        const rows = visible();
        const sel = selectableIdx(rows);
        if (!sel.length) return;
        const step = 7;
        const at = sel.indexOf(index);
        const next = sel[Math.max(0, Math.min(sel.length - 1, (at < 0 ? 0 : at) + dir * step))];
        if (next !== undefined) index = next;
        return draw();
      }
      if (s === LEFT) return switchTab(-1), draw();
      if (s === RIGHT) return switchTab(1), draw();
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
      if (s.startsWith(ESC)) return;
      const text = s.replace(CONTROL_CHARS, "");
      if (text) {
        filter += text;
        return draw();
      }
    };

    release = pushConsumer(onData);
    stopLive = opts.onOpen?.(() => {
      if (closed) return;
      // Keep the cursor on the row it was on, wherever that row moved to.
      const keep = currentValue();
      all = resolveItems(tabs[tabIndex]?.key ?? "");
      if (keep) {
        const at = visible().findIndex((r) => !r.header && r.value === keep);
        if (at !== -1) index = at;
      } else {
        index = 0;
      }
      viewStart = Math.max(0, Math.min(index - 2, Math.max(0, all.length - 1)));
      draw();
    });
  });
}

/** Plain-text wrap for the subtitle; the styling here is ours, not the caller's. */
function wrapPlain(s: string, max: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur && width(cur) + 1 + width(word) > max) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
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
