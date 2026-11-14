/**
 * A small form inside the same panel the choosers use: a title in the border,
 * one or two fields, a button row.
 *
 * It exists because a credential is two answers — the secret and what to call
 * it — and the raw one-line prompt drew neither a panel nor a name field: on a
 * screen full of bordered modals it read as the program having stopped
 * decorating halfway through. The frame is the picker's, so a login looks like
 * everything else the session asks.
 */
import { t } from "../i18n.js";
import { c, clipAnsi, cursor, esc, width } from "./ansi.js";
import { contentWidth, indent } from "./layout.js";
import { paintFrame } from "./render.js";
import { sanitizeSecret } from "./secret.js";
import { pushConsumer } from "./stdin.js";
import { innerWidth, modalBottom, modalButtons, modalFooter, modalKeys, modalRow, modalTop, type ModalAction } from "./modal.js";

const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
const TAB = String.fromCharCode(9);
const SHIFT_TAB = ESC + "[Z";
const UP = ESC + "[A";
const DOWN = ESC + "[B";
const RIGHT = ESC + "[C";
const LEFT = ESC + "[D";
const CONTROL_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + DEL + "]", "g");

export interface FormField {
  label: string;
  value?: string;
  /** Drawn as asterisks, and cleaned of paste debris before it is returned. */
  secret?: boolean;
  placeholder?: string;
}

export interface FormOptions {
  title: string;
  /** One line under the title: what this form is for. */
  subtitle?: string;
  fields: FormField[];
  /** Label of the confirm button; cancel is always there beside it. */
  submit?: string;
  /** Grey explanation lines between the fields and the buttons. */
  notes?: string[];
}

/**
 * Collects the fields in order and answers null on Esc. An empty string is a
 * real answer: the caller decides whether "no name" is allowed by filling in a
 * default first.
 */
export function askForm(opts: FormOptions): Promise<string[] | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  const values = opts.fields.map((f) => f.value ?? "");
  const submitLabel = opts.submit ?? t("Save", "Сохранить");

  return new Promise((resolve) => {
    let focus = 0;
    /** The buttons are reachable from the keyboard, like the picker's. */
    let onButtons = false;
    let buttonIdx = 0;
    let rendered = 0;
    let closed = false;
    const w = contentWidth();
    const inner = innerWidth(w);
    const actions: ModalAction[] = [
      { id: "save", label: submitLabel, hotkey: "s" },
      { id: "cancel", label: t("Cancel", "Отмена"), hotkey: "c", tone: "danger" },
    ];

    const clear = () => {
      if (!rendered) return;
      paintFrame(esc.toColumn(1) + esc.up(rendered) + esc.clearDown);
      rendered = 0;
    };

    const fieldRows = (field: FormField, value: string, at: number, focused: boolean): string[] => {
      const label = c.gray(field.label);
      const shown = field.secret ? "*".repeat([...value].length) : value;
      const body = shown ? c.brightWhite(shown) : c.dim(field.placeholder ?? "");
      const caret = focused ? c.brightCyan("▏") : "";
      const edge = focused ? c.brightCyan : c.gray;
      const fw = inner - 2;
      const room = Math.max(4, fw - 4);
      const text = clipAnsi(body + caret, room);
      const pad = " ".repeat(Math.max(0, room - width(text)));
      return [
        modalRow(w, " " + label),
        modalRow(w, " " + edge("╭" + "─".repeat(Math.max(0, fw - 2)) + "╮")),
        modalRow(w, " " + edge("│") + " " + text + pad + " " + edge("│")),
        modalRow(w, " " + edge("╰" + "─".repeat(Math.max(0, fw - 2)) + "╯")),
      ];
    };

    const legend = (): string =>
      onButtons
        ? [t("←→ button", "←→ кнопка"), t("Enter run", "Enter выполнить"), modalKeys.back(), modalKeys.close()].join(" · ")
        : [t("↑↓ field", "↑↓ поле"), t("Tab next field", "Tab следующее поле"), modalKeys.confirm(), modalKeys.close()].join(" · ");

    const draw = () => {
      const back = rendered ? esc.toColumn(1) + esc.up(rendered) : "";
      const buf: string[] = [];
      buf.push("");
      buf.push(modalTop(w, opts.title));
      buf.push(modalRow(w));
      if (opts.subtitle) {
        for (const l of wrap(opts.subtitle, inner)) buf.push(modalRow(w, c.dim(l)));
        buf.push(modalRow(w));
      }
      for (const [i, field] of opts.fields.entries()) {
        for (const l of fieldRows(field, values[i], i, !onButtons && i === focus)) buf.push(l);
      }
      if (opts.notes?.length) {
        buf.push(modalRow(w));
        for (const l of opts.notes) buf.push(modalRow(w, l));
      }
      buf.push(modalRow(w));
      buf.push(...modalButtons(w, actions, onButtons ? buttonIdx : null));
      buf.push(modalFooter(w, legend()));
      buf.push(modalBottom(w));

      paintFrame(
        esc.hide +
          back +
          buf.map((l) => esc.toColumn(1) + esc.clearRight + indent + l).join("\n") +
          "\n" +
          esc.clearDown,
      );
      rendered = buf.length;
    };

    let release: () => void = () => {};
    const finish = (answer: string[] | null) => {
      closed = true;
      release();
      clear();
      cursor.show();
      resolve(answer);
    };

    const insert = (raw: string) => {
      const field = opts.fields[focus];
      if (!field) return;
      // A paste arrives as one chunk and may carry a trailing newline and the
      // terminal's bracketed-paste markers; left in, they corrupt a key.
      const text = field.secret ? sanitizeSecret(raw) : raw.replace(CONTROL_CHARS, "");
      if (!text) return;
      if (field.secret && values[focus].length + text.length > 512) return;
      values[focus] += text;
      draw();
    };

    const submit = () => finish(values.map((v) => v.trim()));
    const runButton = (id: string) => (id === "save" ? submit() : finish(null));

    const onData = (buf: Buffer) => {
      if (closed) return;
      const s = buf.toString("utf8");
      if (s === CTRL_C || s === ESC) return finish(null);
      // Alt+1 confirms, alt+2 cancels — the buttons are there to be found, and
      // the numbers are the shortest way there.
      if (s.length === 2 && s[0] === ESC && (s[1] === "1" || s[1] === "2")) {
        return runButton(actions[Number(s[1]) - 1].id);
      }

      // The buttons own the keyboard once Tab has reached them, the way the
      // picker's do: arrows pick one, Enter runs it, Tab goes back to typing.
      if (onButtons) {
        if (s === "\r" || s === "\n") return runButton(actions[buttonIdx].id);
        if (s === RIGHT || s === TAB || s === DOWN) {
          buttonIdx = (buttonIdx + 1) % actions.length;
          return draw();
        }
        if (s === LEFT || s === SHIFT_TAB || s === UP) {
          buttonIdx = (buttonIdx - 1 + actions.length) % actions.length;
          return draw();
        }
        if (s.startsWith(ESC)) return;
        // Typing is wanting a field back, not a button.
        onButtons = false;
        const text = s.replace(CONTROL_CHARS, "");
        if (text) insert(text);
        else draw();
        return;
      }

      if (s === "\r" || s === "\n") return submit();
      if (s === TAB) {
        if (focus === opts.fields.length - 1) {
          onButtons = true;
          buttonIdx = 0;
        } else focus++;
        return draw();
      }
      if (s === SHIFT_TAB) {
        focus = (focus - 1 + opts.fields.length) % opts.fields.length;
        return draw();
      }
      if (s === DOWN) {
        focus = (focus + 1) % opts.fields.length;
        return draw();
      }
      if (s === UP) {
        focus = (focus - 1 + opts.fields.length) % opts.fields.length;
        return draw();
      }
      if (s === CTRL_U) {
        values[focus] = "";
        return draw();
      }
      if (s === DEL || s === BACKSPACE) {
        values[focus] = [...values[focus]].slice(0, -1).join("");
        return draw();
      }
      if (s.startsWith(ESC)) return;
      // Enter inside a paste is the end of the paste, not of the form.
      const eol = s.search(/[\r\n]/);
      insert(eol === -1 ? s : s.slice(0, eol));
      if (eol !== -1) submit();
    };

    cursor.hide();
    draw();
    release = pushConsumer(onData);
  });
}

/** Plain-text wrap; the styling is the panel's, not the caller's. */
function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur && width(cur) + 1 + width(word) > max) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}
