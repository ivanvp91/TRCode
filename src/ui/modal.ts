/**
 * Modal chrome: the bordered panel every chooser is drawn inside.
 *
 * The pieces here are pure string builders — they know a width and produce
 * rows, and nothing else. Whoever owns the screen (picker.ts) stacks them and
 * paints. That split is what lets the same panel be used for a list, a form or
 * a confirmation without any of them re-deriving where the border goes.
 *
 * The frame deliberately matches the input box: same rounded corners, same
 * gray, same left margin. A modal that looks like a different program has
 * opened is a modal the eye has to re-learn every time it appears.
 */
import { c, clipAnsi, width } from "./ansi.js";
import { t } from "../i18n.js";

/** Cells of chrome on each side of a row: the border, plus two of padding. */
const CHROME = 3;
const PAD = " ".repeat(CHROME - 1);

/** Content width inside a panel of this width. */
export function innerWidth(w: number): number {
  return Math.max(10, w - CHROME * 2);
}

/** Pads a styled string to a visible width, clipping when it overflows. */
function fit(s: string, w: number): string {
  const vis = width(s);
  if (vis > w) return clipAnsi(s, w);
  return s + " ".repeat(w - vis);
}

/** `╭─ Title ────────────╮` — the title lives in the border, not under it. */
export function modalTop(w: number, title: string): string {
  const label = title ? ` ${c.bold(c.brightCyan(title))} ` : "";
  // "╭─" + label + dashes + "╮" has to come to exactly w cells.
  const dashes = Math.max(0, w - 3 - width(label));
  return c.gray("╭─") + label + c.gray("─".repeat(dashes) + "╮");
}

export function modalBottom(w: number): string {
  return c.gray("╰" + "─".repeat(Math.max(0, w - 2)) + "╯");
}

/** One content row, padded to the border on both sides. */
export function modalRow(w: number, content = ""): string {
  return c.gray("│") + PAD + fit(content, innerWidth(w)) + PAD + c.gray("│");
}

/** A rule across the panel, optionally with a heading sitting on it. */
export function modalSep(w: number, label?: string): string {
  const inner = innerWidth(w);
  if (!label) return c.gray("├" + "─".repeat(Math.max(0, w - 2)) + "┤");
  const head = ` ${c.bold(c.brightBlue(label))} `;
  // Capped: a rule that runs the whole width competes with the border for
  // attention, and the heading is what the eye is meant to land on.
  const dashes = Math.max(2, Math.min(28, inner - width(head) - 2));
  return modalRow(w, c.gray("──") + head + c.gray("─".repeat(dashes)));
}

/**
 * The search field: its own little box inside the panel, so it reads as
 * something you type into rather than a line of status text. The counter sits
 * on the right edge of the field, where a "2/412" answers the only question
 * a filter raises — how much is left.
 */
export function modalField(
  w: number,
  opts: { text: string; placeholder: string; counter?: string; focused?: boolean },
): string[] {
  const inner = innerWidth(w);
  // The field is inset one cell from the panel's own padding.
  const fw = inner - 2;
  const counter = opts.counter ? c.gray(opts.counter) : "";
  // "│" + " " + "⌕ " + text + " " + counter + " " + "│" — seven cells of the
  // field are chrome, and the rest is what there is to type into.
  const room = Math.max(6, fw - 7 - width(counter));
  const typed = opts.text
    ? c.brightYellow(opts.text) + (opts.focused === false ? "" : c.brightCyan("▏"))
    : c.dim(opts.placeholder);
  const left = c.brightCyan("⌕ ") + fit(clipAnsi(typed, room), room);
  const edge = opts.focused === false ? c.gray : c.brightCyan;
  return [
    modalRow(w, " " + edge("╭" + "─".repeat(Math.max(0, fw - 2)) + "╮")),
    modalRow(w, " " + edge("│") + " " + left + " " + counter + " " + edge("│")),
    modalRow(w, " " + edge("╰" + "─".repeat(Math.max(0, fw - 2)) + "╯")),
  ];
}

export interface ModalAction {
  /** Returned to the caller when the button is pressed. */
  id: string;
  label: string;
  /**
   * A letter reachable as Alt+letter, underlined when it occurs in the label.
   * Terminals send Alt+x as ESC+x, which is why the buttons can carry
   * shortcuts at all — the search field owns every bare letter. Buttons are
   * numbered regardless, and Alt+number always works: a Russian label has no
   * Latin letter to underline, and a shortcut nobody can see is not one.
   */
  hotkey?: string;
  tone?: "ok" | "warn" | "danger";
  /** Greyed out and unreachable — shown so the panel's shape stays stable. */
  disabled?: boolean;
}

function toneOf(a: ModalAction) {
  return a.tone === "danger" ? c.red : a.tone === "warn" ? c.yellow : c.brightGreen;
}

/** The label, numbered, with its hotkey letter underlined where there is one. */
function buttonLabel(a: ModalAction, n: number): string {
  const body =
    a.hotkey && a.label.toLowerCase().includes(a.hotkey.toLowerCase())
      ? (() => {
          const at = a.label.toLowerCase().indexOf(a.hotkey!.toLowerCase());
          return a.label.slice(0, at) + c.underline(a.label[at]) + a.label.slice(at + 1);
        })()
      : a.label;
  return n <= 9 ? c.dim(String(n)) + " " + body : body;
}

/**
 * The button row. Buttons wrap onto as many rows as they need rather than
 * being clipped: a hidden button is a feature nobody finds.
 */
export function modalButtons(w: number, actions: ModalAction[], focused: number | null): string[] {
  if (!actions.length) return [];
  const inner = innerWidth(w);
  const rows: string[] = [];
  let row = "";
  let rowW = 0;

  for (const [i, a] of actions.entries()) {
    const label = buttonLabel(a, i + 1);
    const tone = a.disabled ? c.gray : toneOf(a);
    const btn =
      i === focused && !a.disabled
        ? c.inverse(c.bold(tone(` ${label} `)))
        : c.gray("[ ") + tone(label) + c.gray(" ]");
    const cell = width(btn) + 2;
    if (rowW && rowW + cell > inner) {
      rows.push(row);
      row = "";
      rowW = 0;
    }
    row += (rowW ? "  " : "") + btn;
    rowW += cell;
  }
  if (row) rows.push(row);
  return rows.map((r) => modalRow(w, r));
}

/** Tab strip: the panel's own sections, switched with ←/→. */
export function modalTabs(
  w: number,
  tabs: { label: string; count?: number }[],
  active: number,
): string[] {
  if (tabs.length < 2) return [];
  const strip = tabs
    .map((tab, i) => {
      const text = `${tab.label}${tab.count !== undefined ? ` ${tab.count}` : ""}`;
      return i === active ? c.inverse(c.bold(` ${text} `)) : c.gray("[ ") + c.white(text) + c.gray(" ]");
    })
    .join(" ");
  return [modalRow(w, strip), modalRow(w)];
}

/** The key legend at the foot of the panel, and the position counter. */
export function modalFooter(w: number, keys: string, counter?: string): string {
  const inner = innerWidth(w);
  const left = c.gray(keys);
  const right = counter ? c.gray(counter) : "";
  const gap = Math.max(1, inner - width(left) - width(right));
  return modalRow(w, left + " ".repeat(gap) + right);
}

/** Shared wording, so every panel names the same keys the same way. */
export const modalKeys = {
  move: () => t("↑↓ move", "↑↓ выбор"),
  scroll: () => t("↑↓ scroll", "↑↓ прокрутка"),
  select: () => t("Enter select", "Enter выбрать"),
  mark: () => t("Space mark", "Пробел отметить"),
  confirm: () => t("Enter confirm", "Enter подтвердить"),
  tabs: () => t("←→ section", "←→ раздел"),
  buttons: () => t("Tab or alt+№ buttons", "Tab или alt+№ кнопки"),
  back: () => t("Tab back to list", "Tab назад к списку"),
  close: () => t("Esc close", "Esc закрыть"),
  clear: () => t("^U clear", "^U очистить"),
};

export const modalSearchPlaceholder = (): string => t("search — just type", "поиск — просто печатайте");
