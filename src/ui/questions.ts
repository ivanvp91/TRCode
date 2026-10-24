/** The shared modal frame, with a wizard instead of a searchable catalogue. */
import { StringDecoder } from "node:string_decoder";
import { t } from "../i18n.js";
import type { UserQuestion, UserAnswer } from "../tools/questions.js";
import { c, width } from "./ansi.js";
import { contentWidth, indent } from "./layout.js";
import { setFooter, setFooterAbove, refreshFooter } from "./render.js";
import { pushConsumer } from "./stdin.js";
import { innerWidth, modalBottom, modalButtons, modalField, modalFooter, modalRow, modalSep, modalTop, type ModalAction } from "./modal.js";

const ESC = "\x1b";
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Wrap by terminal cells, also breaking long words and preserving newlines. */
function wrap(s: string, columns: number): string[] {
  const rows: string[] = [];
  for (const paragraph of s.split(/\r?\n/)) {
    let row = "";
    for (const ch of paragraph) {
      if (width(row + ch) > columns) { rows.push(row); row = ""; }
      row += ch;
    }
    rows.push(row);
  }
  return rows;
}

export function questionModal(
  questions: UserQuestion[],
  opts: { signal: AbortSignal; onCancel?: () => void },
): Promise<UserAnswer[] | null> {
  if (!process.stdin.isTTY || opts.signal.aborted || !questions.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    const answers = questions.map(() => ({ selected: new Set<number>(), custom: "" }));
    let step = 0;
    let index = 0;
    let focus: "list" | "custom" | "buttons" = questions[0].options.length ? "list" : "custom";
    let caret = 0;
    let button = 1;
    let view = 0;
    let frame: string[] = [];
    let installed = false;
    let closed = false;
    let release = () => {};
    let pending = "";
    let lastChunkCR = false;
    let escTimer: NodeJS.Timeout | undefined;
    let paste: string | null = null;
    const decoder = new StringDecoder("utf8");
    const review = () => step === questions.length;
    const current = () => answers[step];
    const ready = (i: number) => answers[i].selected.size > 0 || Boolean(answers[i].custom.trim());
    const actions = (): ModalAction[] => [
      { id: "back", label: t("Back", "Назад"), hotkey: "b", disabled: step === 0 },
      review()
        ? { id: "submit", label: "Submit", hotkey: "s", disabled: !answers.every((_, i) => ready(i)) }
        : { id: "next", label: t("Next", "Далее"), hotkey: "n", disabled: !ready(step) },
      { id: "cancel", label: t("Cancel", "Отмена"), hotkey: "c", tone: "danger" },
    ];
    const clear = () => {
      if (installed) { setFooterAbove(null); installed = false; }
    };
    const finish = (value: UserAnswer[] | null, cancelled = false) => {
      if (closed) return;
      closed = true;
      clearTimeout(escTimer);
      opts.signal.removeEventListener("abort", onAbort);
      process.stdout.removeListener("resize", onResize);
      process.stdin.removeListener("end", onEnd);
      release();
      clear();
      if (cancelled) opts.onCancel?.();
      resolve(value);
    };
    const onAbort = () => finish(null);
    const onEnd = () => finish(null, true);
    const onResize = () => draw();
    const enterStep = (next: number) => {
      step = next;
      index = review() ? 0 : (current().selected.values().next().value ?? (current().custom ? questions[step].options.length : 0));
      focus = review() ? "buttons" : questions[step].options.length ? "list" : "custom";
      caret = review() ? 0 : Array.from(current().custom).length;
      button = 1;
      view = 0;
      draw();
    };
    const runAction = (id: string) => {
      if (id === "cancel") return finish(null, true);
      if (id === "back" && step > 0) return enterStep(step - 1);
      if (id === "next" && !review() && ready(step)) return enterStep(step + 1);
      if (id === "submit" && review() && answers.every((_, i) => ready(i))) {
        return finish(answers.map((a, i) => ({
          question: questions[i].question,
          selected: [...a.selected].sort((x, y) => x - y).map((n) => questions[i].options[n].label),
          ...(a.custom.trim() ? { custom: a.custom.trim() } : {}),
        })));
      }
    };
    const select = (advance: boolean) => {
      if (review()) return enterStep(index);
      const q = questions[step];
      if (index === q.options.length) { focus = "custom"; caret = Array.from(current().custom).length; return draw(); }
      const a = current();
      if (q.multiSelect) {
        if (advance) return runAction("next");
        if (a.selected.has(index)) a.selected.delete(index); else a.selected.add(index);
      } else {
        a.selected.clear(); a.selected.add(index); a.custom = "";
        if (advance) return runAction("next");
      }
      draw();
    };
    const draw = (follow = true) => {
      if (closed) return;
      const w = contentWidth();
      const iw = innerWidth(w);
      const body: string[] = [];
      let target = 0;
      if (review()) {
        questions.forEach((q, i) => {
          if (i === index) target = body.length;
          for (const row of wrap(`${i === index && focus === "list" ? "❯ " : "  "}${i + 1}. ${q.question}`, iw)) body.push(modalRow(w, c.bold(row)));
          const a = answers[i];
          const value = [...a.selected].map((n) => q.options[n].label).concat(a.custom.trim() ? [a.custom.trim()] : []).join("; ");
          for (const row of wrap(value, iw - 2)) body.push(modalRow(w, "  " + c.brightGreen(row)));
          body.push(modalRow(w));
        });
      } else {
        const q = questions[step];
        for (const row of wrap(q.question, iw)) body.push(modalRow(w, c.bold(row)));
        body.push(modalRow(w));
        q.options.forEach((o, i) => {
          if (i === index) target = body.length;
          const active = i === index && focus === "list";
          const mark = q.multiSelect ? (current().selected.has(i) ? "[x] " : "[ ] ") : (current().selected.has(i) ? "● " : "○ ");
          const rows = wrap(`${i + 1}. ${o.label}`, iw - 6);
          body.push(modalRow(w, (active ? c.brightCyan("❯ ") : "  ") + c.brightGreen(mark) + (active ? c.bold(c.brightCyan(rows[0])) : rows[0])));
          for (const row of rows.slice(1)) body.push(modalRow(w, "      " + row));
          if (o.description) for (const row of wrap(o.description, iw - 6)) body.push(modalRow(w, "      " + c.dim(row)));
        });
        if (index === q.options.length || focus === "custom") target = body.length;
        body.push(modalRow(w, (index === q.options.length && focus !== "buttons" ? c.brightCyan("❯ ") : "  ") + t("Your answer", "Свой ответ")));
        const chars = Array.from(current().custom);
        const before = chars.slice(0, caret);
        const room = Math.max(6, iw - 14);
        while (width(before.join("")) >= room) before.shift();
        const text = focus === "custom" ? before.join("") + c.brightCyan("▏") + chars.slice(caret).join("") : current().custom;
        body.push(...modalField(w, { text, placeholder: t("Type your answer…", "Введите свой ответ…"), focused: false }));
      }
      const buttons = modalButtons(w, actions(), focus === "buttons" ? button : null);
      const room = Math.max(2, (process.stdout.rows || 24) - buttons.length - 10);
      if (follow) {
        if (target < view) view = target;
        if (target + (focus === "custom" ? 4 : 0) >= view + room) view = target + (focus === "custom" ? 4 : 0) - room + 1;
      }
      view = Math.max(0, Math.min(view, Math.max(0, body.length - room)));
      const title = review() ? t("Review answers", "Проверка ответов") : t("Questions", "Вопросы");
      const progress = review() ? t("Answers are sent only after Submit", "Ответы отправятся только после Submit")
        : t("Question {current} of {total}", "Вопрос {current} из {total}", { current: step + 1, total: questions.length }) + (questions[step].header ? ` · ${questions[step].header}` : "");
      const keys = focus === "custom" ? t("Type · Enter next · Tab buttons · Esc cancel", "Ввод · Enter далее · Tab кнопки · Esc отмена")
        : focus === "buttons" ? t("←→ buttons · Enter · Tab answers · Esc cancel", "←→ кнопки · Enter · Tab ответы · Esc отмена")
        : t("↑↓ choose · Enter next · Space mark · Tab buttons · Esc cancel", "↑↓ выбор · Enter далее · Пробел отметить · Tab кнопки · Esc отмена");
      const rows = [modalTop(w, title), modalRow(w, c.dim(progress)), modalSep(w), ...body.slice(view, view + room), modalSep(w), ...buttons,
        modalFooter(w, keys), modalFooter(w, t("Alt+B back · Alt+N next · Alt+S submit", "Alt+B назад · Alt+N далее · Alt+S submit"), body.length > room ? `${view + 1}–${Math.min(body.length, view + room)}/${body.length} PgUp/PgDn` : ""), modalBottom(w)];
      // Background workers can keep writing above the form without moving it.
      frame = rows.map((row) => indent + row);
      if (installed) refreshFooter();
      else { installed = true; setFooterAbove(() => frame); }
    };
    const insert = (text: string) => {
      if (review()) return;
      text = clean(text);
      if (!text) return;
      if (focus !== "custom") {
        focus = "custom"; index = questions[step].options.length;
        caret = Array.from(current().custom).length;
      }
      if (!questions[step].multiSelect) current().selected.clear();
      const chars = Array.from(current().custom);
      const added = Array.from(text).slice(0, Math.max(0, 4000 - chars.length));
      chars.splice(caret, 0, ...added); caret += added.length;
      current().custom = chars.join("");
      draw();
    };
    const key = (s: string) => {
      if (s === ESC || s === "\x03") return finish(null, true);
      if (/^\x1b[bnsc123]$/i.test(s)) {
        const a = actions();
        const n = Number(s[1]);
        const action = n ? a[n - 1] : a.find((a) => a.hotkey === s[1].toLowerCase());
        if (action && !action.disabled) runAction(action.id);
        return;
      }
      if (s === "\t" || s === ESC + "[Z") {
        focus = focus === "buttons" ? (review() || questions[step].options.length ? "list" : "custom") : "buttons";
        if (actions()[button].disabled) button = actions().findIndex((a) => !a.disabled);
        return draw();
      }
      if (s === ESC + "[5~" || s === ESC + "[6~") { view += s === ESC + "[5~" ? -5 : 5; return draw(false); }
      if (s === "\r" || s === "\n") {
        if (focus === "buttons") { const a = actions()[button]; if (!a.disabled) runAction(a.id); }
        else if (focus === "custom") runAction("next");
        else select(true);
        return;
      }
      if (focus === "buttons") {
        if (s === ESC + "[D" || s === ESC + "[C") {
          const direction = s === ESC + "[D" ? -1 : 1;
          do { button = (button + direction + 3) % 3; } while (actions()[button].disabled);
          return draw();
        }
        if (s === ESC + "[A" || s === ESC + "[B") { focus = review() || questions[step].options.length ? "list" : "custom"; return draw(); }
      }
      if (focus === "custom") {
        const chars = Array.from(current().custom);
        if (s === ESC + "[D") caret = Math.max(0, caret - 1);
        else if (s === ESC + "[C") caret = Math.min(chars.length, caret + 1);
        else if (s === ESC + "[H" || s === "\x01") caret = 0;
        else if (s === ESC + "[F" || s === "\x05") caret = chars.length;
        else if (s === "\x7f" || s === "\b") { if (caret) chars.splice(--caret, 1); }
        else if (s === ESC + "[3~") chars.splice(caret, 1);
        else if (s === "\x15") { chars.splice(0, caret); caret = 0; }
        else if (s === ESC + "[A" || s === ESC + "[B") { focus = "list"; index = questions[step].options.length; return draw(); }
        else { if (!s.startsWith(ESC) && s >= " ") insert(s); return; }
        current().custom = chars.join(""); return draw();
      }
      if (focus === "list") {
        const count = review() ? questions.length : questions[step].options.length + 1;
        if (s === ESC + "[A" || s === ESC + "[B") { index = (index + (s === ESC + "[A" ? -1 : 1) + count) % count; return draw(); }
        if (s === " ") return select(false);
        if (s === ESC + "[D") return runAction("back");
        if (s === ESC + "[C") return runAction("next");
        if (/^[1-7]$/.test(s) && !review()) { index = Math.min(Number(s) - 1, count - 1); return select(!questions[step].multiSelect); }
      }
      if (!s.startsWith(ESC) && s >= " ") insert(s);
    };
    // A read can contain several keys, a split escape sequence or a pasted form.
    const consume = () => {
      while (pending && !closed) {
        if (paste !== null) {
          const end = pending.indexOf(ESC + "[201~");
          if (end < 0) {
            const keep = pending.lastIndexOf(ESC);
            paste = (paste + (keep < 0 ? pending : pending.slice(0, keep))).slice(0, 4000);
            pending = keep < 0 ? "" : pending.slice(keep);
            return;
          }
          insert(paste + pending.slice(0, end)); paste = null; pending = pending.slice(end + 6); continue;
        }
        if (pending.startsWith(ESC + "[200~")) { paste = ""; pending = pending.slice(6); continue; }
        if (pending[0] === ESC) {
          if (pending.length === 1) {
            escTimer = setTimeout(() => { pending = ""; key(ESC); }, 60);
            return;
          }
          const seq = pending.match(/^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z]|[^\[O])/);
          if (!seq) return;
          pending = pending.slice(seq[0].length); key(seq[0]); continue;
        }
        const text = pending.match(/^[^\x00-\x1f\x7f\x1b]+/)?.[0];
        if (text && (focus === "custom" || text.length > 1)) { pending = pending.slice(text.length); insert(text); continue; }
        const ch = Array.from(pending)[0]; pending = pending.slice(ch.length); key(ch);
      }
    };
    draw();
    release = pushConsumer((buf) => {
      clearTimeout(escTimer);
      let text = decoder.write(buf);
      if (lastChunkCR && text.startsWith("\n")) { text = text.slice(1); lastChunkCR = false; }
      if (text) lastChunkCR = text.endsWith("\r");
      pending += text.replace(/\r\n/g, "\r");
      consume();
    });
    opts.signal.addEventListener("abort", onAbort, { once: true });
    process.stdout.on("resize", onResize);
    process.stdin.on("end", onEnd);
  });
}
