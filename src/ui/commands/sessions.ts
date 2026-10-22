/** Sessions: resume, manage, rewind, fork, edit and compact. */
import path from "node:path";
import { c } from "../ansi.js";
import { contentWidth, fmtAgo } from "../layout.js";
import { error, expandedBlock, hint, info, line, padded, plural, renderMarkdownBlock, Spinner, success, truncate, warn } from "../render.js";
import { pick, openModal, type PickerItem } from "../picker.js";
import { choose } from "../choice.js";
import { askLine } from "../prompt.js";
import { contextWindowFor } from "../../provider/models.js";
import { Session, type SessionMeta } from "../../session/session.js";
import { compactSession, contextPressure } from "../../session/compact.js";
import { pushConsumer } from "../stdin.js";
import { dropStore, forgetFrom, listCheckpoints, rewindFiles, type Checkpoint } from "../../session/checkpoint.js";
import { collapsedCount, collapsedText } from "../paste.js";
import { dropSessionHistory } from "../../session/history.js";
import { fmtTokens, historyTokens } from "../../usage.js";
import { t, count } from "../../i18n.js";
import type { App } from "../repl.js";

/** How full a saved session is, coloured by how close it is to the window. */
export function sessionFill(app: App, m: SessionMeta): { tokens: number; window: number; pct: number; tint: (s: string) => string } {
  const window = contextWindowFor(m.model, app.catalog);
  const tokens = m.tokens ?? 0;
  const pct = Math.round((tokens / window) * 100);
  const tint = pct >= 80 ? c.red : pct >= 50 ? c.yellow : c.gray;
  return { tokens, window, pct, tint };
}

export function sessionItem(app: App, m: SessionMeta): PickerItem {
  const { tokens, window, pct, tint } = sessionFill(app, m);
  // The row has to survive truncation at the terminal edge, so the size — the
  // reason this list exists — goes first and the title takes what is left.
  const size = tint(`~${fmtTokens(tokens)}`.padStart(7) + `/${fmtTokens(window)} ${String(pct).padStart(3)}%`);
  return {
    value: m.id,
    label: truncate(m.title, 40).padEnd(41),
    hint: size + c.gray(`  ${String(m.messageCount).padStart(3)} msgs  ${fmtAgo(m.updatedAt)}`),
  };
}

/** The detail card shown between picking a session and deciding what to do. */
export function sessionCard(app: App, s: Session): void {
  const meta: SessionMeta = {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    model: s.model,
    createdAt: s.createdAt,
    updatedAt: Date.now(),
    messageCount: s.messages.length,
    tokens: historyTokens(s.messages),
  };
  const { tokens, window, pct, tint } = sessionFill(app, meta);
  const barWidth = Math.min(32, contentWidth() - 12);
  const filled = Math.min(barWidth, Math.round((tokens / window) * barWidth));

  line();
  padded(c.bold(truncate(s.title || "(untitled)", contentWidth() - 2)));
  padded(
    c.gray(`${s.id} · ${s.model} · ${s.messages.length} ${plural(s.messages.length, "message", "messages")}`) +
      (s.compactions ? c.gray(` · compacted ${s.compactions}×`) : ""),
  );
  padded(
    tint("█".repeat(filled)) +
      c.gray("░".repeat(barWidth - filled)) +
      "  " +
      tint(`~${fmtTokens(tokens)}`) +
      c.gray(` of ${fmtTokens(window)} tokens (${pct}%)`),
  );
  if (pct >= 50) padded(c.gray("Compacting first frees room and cuts what every later turn costs."));
  line();
}

/** Adopts a loaded session as the current one. */
export function adoptSession(app: App, loaded: Session): void {
  app.session.save();
  app.session = loaded;
  app.usage = loaded.usage;
  app.readFiles.clear();
  app.rebuildTools();
}

export type SessionAction = "open" | "compact" | "rename" | "delete" | "cancel";

/** `/resume <id>`: card, three buttons, no list to fall back to. */
export async function openSession(app: App, id: string): Promise<void> {
  const loaded = Session.load(app.cwd, id);
  if (!loaded) return error(t(`Session not found: ${id}`, `Сессия не найдена: ${id}`));
  sessionCard(app, loaded);
  const action = await choose<SessionAction>(
    [
      { value: "open", label: "Continue as is", key: "c" },
      { value: "compact", label: "Compact and continue", key: "k", tone: "warn" },
      { value: "cancel", label: "Cancel", key: "b", tone: "danger" },
    ],
    { initial: "open", fallback: "cancel" },
  );
  if (action === "cancel") return;
  adoptSession(app, loaded);
  if (action === "compact") await compactNow(app, "", false);
  success(t(`Restored ${loaded.id} — ${loaded.messages.length} ${plural(loaded.messages.length, "message", "messages")}, model ${loaded.model}`, `Восстановлена ${loaded.id} — ${count(loaded.messages.length, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}, модель ${loaded.model}`));
  app.replayHistory();
}

/**
 * The manage list: the same rows as `/resume`, with a checkbox each.
 *
 * Space marks a session, so a run of them goes in one stroke — the buttons
 * along the foot act on everything marked. Enter keeps its old job of opening
 * the row under the cursor, which is why the list answers both ways.
 */
async function manageList(app: App): Promise<string | null> {
  let marked: string[] = [];
  for (;;) {
    const metas = Session.list(app.cwd);
    if (!metas.length) return null;
    // The session being lived in is never deleted: its file is rewritten on the
    // next turn, and dropping the transcript buys nothing. It stays unmarked by
    // "select all" but can still be opened.
    const deletable = metas.filter((m) => m.id !== app.session.id).map((m) => m.id);
    const allMarked = deletable.length > 0 && deletable.every((id) => marked.includes(id));

    const res = await openModal({
      title: "Sessions",
      subtitle: t(
        "Space marks a session, Enter opens the row under the cursor, the buttons act on every marked row.",
        "Пробел отмечает сессию, Enter открывает строку под курсором, кнопки действуют на все отмеченные.",
      ),
      items: metas.map((m) => sessionItem(app, m)),
      initial: app.session.id,
      multi: true,
      selected: marked,
      actions: [
        {
          id: "all",
          label: allMarked ? t("Clear marks", "Снять отметки") : t("Select all", "Выбрать все"),
          hotkey: "a",
        },
        {
          id: "delete",
          // Always live: the confirm names the count, and a greyed-out button
          // reads as "bulk delete is broken", not as "nothing marked yet".
          label: t("Delete marked", "Удалить отмеченные"),
          hotkey: "d",
          tone: "danger",
        },
      ],
    });
    if (!res) return null;

    if (res.kind === "item") {
      if (res.values.length > 1) {
        hint(
          t(
            `${res.values.length} marked — the Delete button removes them all, Enter opens one row.`,
            `Отмечено ${res.values.length} — кнопка «Удалить» снесёт все, Enter открывает одну строку.`,
          ),
        );
        continue;
      }
      return res.values[0] ?? null;
    }
    if (res.id === "all") {
      marked = allMarked ? [] : deletable;
      continue;
    }
    if (res.id === "delete") {
      // The marks live in the panel, not in `marked` — Space inside it is the
      // freshest answer, and the button carries them back.
      if (!res.values.length) {
        hint(t("Nothing marked — Space marks a session.", "Ничего не отмечено — пробел отмечает сессию."));
        continue;
      }
      marked = (await deleteMarked(app, metas, res.values)) ? [] : res.values;
      continue;
    }
  }
}

/** Removes a whole marked set, after the same "are you sure" as one session. */
async function deleteMarked(app: App, metas: SessionMeta[], ids: string[]): Promise<boolean> {
  const targets = ids.filter((id) => id !== app.session.id);
  if (!targets.length) {
    warn(t("That is the session you are in — switch with /new first.", "Это текущая сессия — сначала переключитесь через /new."));
    return false;
  }

  const msgs = targets.reduce((n, id) => n + (metas.find((m) => m.id === id)?.messageCount ?? 0), 0);
  const sure = await choose<"yes" | "no">(
    [
      { value: "no", label: "Keep them", key: "n" },
      {
        value: "yes",
        label: t(
          `Delete ${count(targets.length, ["session", "sessions"], ["сессия", "сессии", "сессий"])} · ${count(msgs, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}`,
          `Удалить ${count(targets.length, ["session", "sessions"], ["сессия", "сессии", "сессий"])} · ${count(msgs, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}`,
        ),
        key: "y",
        tone: "danger",
      },
    ],
    { initial: "no", fallback: "no" },
  );
  if (sure !== "yes") return false;

  let done = 0;
  for (const id of targets) {
    dropStore(app.cwd, id);
    dropSessionHistory(app.cwd, id);
    if (Session.remove(app.cwd, id)) done++;
  }
  if (done < targets.length)
    warn(t(`${targets.length - done} could not be deleted.`, `Не удалось удалить: ${targets.length - done}.`));
  success(t(`Deleted ${done} ${plural(done, "session", "sessions")}.`, `Удалено ${count(done, ["session", "sessions"], ["сессия", "сессии", "сессий"])}.`));
  return done > 0;
}

/**
 * The session list. `resume` mode is about getting back into one; `manage` mode
 * adds renaming and deleting. Both loop, so every "no" lands back on the list
 * instead of dropping the user at the prompt.
 */
export async function browseSessions(app: App, mode: "resume" | "manage"): Promise<void> {
  for (;;) {
    const metas = Session.list(app.cwd);
    if (!metas.length) return info(t("No saved sessions.", "Сохранённых сессий нет."));

    // Nothing to interact with when input is piped — print and be done.
    if (!process.stdin.isTTY) {
      line();
      for (const m of metas) {
        const { tokens, pct, tint } = sessionFill(app, m);
        padded(
          `${m.id === app.session.id ? c.brightCyan("❯ ") : "  "}${c.bold(m.id)}  ` +
            `${c.gray(new Date(m.updatedAt).toLocaleString())}  ${c.dim(String(m.messageCount).padStart(3) + " msgs")}  ` +
            `${tint(`~${fmtTokens(tokens)}`.padStart(7) + ` ${String(pct).padStart(3)}%`)}  ${truncate(m.title, 40)}`,
        );
      }
      line();
      return;
    }

    const chosen =
      mode === "manage"
        ? await manageList(app)
        : await pick({
            title: "Pick a session",
            items: metas.map((m) => sessionItem(app, m)),
            initial: app.session.id,
          });
    if (!chosen) return;

    const loaded = Session.load(app.cwd, chosen);
    if (!loaded) {
      error(t(`Session not found: ${chosen}`, `Сессия не найдена: ${chosen}`));
      continue;
    }
    sessionCard(app, loaded);

    const action =
      mode === "manage"
        ? await choose<SessionAction>(
            [
              { value: "open", label: "Continue", key: "c" },
              { value: "rename", label: "Rename", key: "r" },
              { value: "delete", label: "Delete", key: "d", tone: "danger" },
              { value: "compact", label: "Compact", key: "k", tone: "warn" },
            ],
            { initial: "open", fallback: "cancel", hint: "←/→ · Enter to confirm · Esc back to the list" },
          )
        : await choose<SessionAction>(
            [
              { value: "open", label: "Continue as is", key: "c" },
              { value: "compact", label: "Compact and continue", key: "k", tone: "warn" },
              { value: "cancel", label: "Back to the list", key: "b", tone: "danger" },
            ],
            { initial: "open", fallback: "cancel" },
          );

    if (action === "cancel") continue;

    if (action === "rename") {
      const title = await askLine("New title:", loaded.title);
      if (title !== null) {
        loaded.rename(title);
        // The same session may be open right now; keep both copies in step.
        if (loaded.id === app.session.id) app.session.title = loaded.title;
        success(t(`Renamed to: ${loaded.title || "(untitled)"}`, `Переименована в: ${loaded.title || "(без названия)"}`));
      }
      continue;
    }

    if (action === "delete") {
      if (loaded.id === app.session.id) {
        warn(t("This is the session you are in — switch with /new first.", "Это текущая сессия — сначала переключитесь через /new."));
        continue;
      }
      const sure = await choose<"yes" | "no">(
        [
          { value: "no", label: "Keep", key: "n" },
          { value: "yes", label: `Delete ${loaded.messages.length} ${plural(loaded.messages.length, "message", "messages")}`, key: "y", tone: "danger" },
        ],
        { initial: "no", fallback: "no" },
      );
      if (sure === "yes") {
        // The snapshots exist to undo that session's edits; without it they
        // are unreachable bytes on disk.
        dropStore(app.cwd, loaded.id);
        dropSessionHistory(app.cwd, loaded.id);
        if (Session.remove(app.cwd, loaded.id)) success(t(`Deleted ${loaded.id}`, `Удалена ${loaded.id}`));
        else error(t(`Could not delete ${loaded.id}`, `Не удалось удалить ${loaded.id}`));
      }
      continue;
    }

    adoptSession(app, loaded);
    if (action === "compact") await compactNow(app, "", false);
    success(t(`Restored ${loaded.id} — ${loaded.messages.length} ${plural(loaded.messages.length, "message", "messages")}, model ${loaded.model}`, `Восстановлена ${loaded.id} — ${count(loaded.messages.length, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}, модель ${loaded.model}`));
    app.replayHistory();
    return;
  }
}

/**
 * `/erase`: every saved session of this project goes away in one stroke,
 * except the one being lived in — /sessions already refuses to delete the
 * session you are inside, and so does this.
 */
export async function eraseSessions(app: App): Promise<void> {
  const metas = Session.list(app.cwd, Number.MAX_SAFE_INTEGER).filter((m) => m.id !== app.session.id);
  if (!metas.length)
    return info(t("Only the current session is stored — nothing to erase.", "Сохранена только текущая сессия — стирать нечего."));

  const msgs = metas.reduce((n, m) => n + m.messageCount, 0);
  const sure = await choose<"yes" | "no">(
    [
      { value: "no", label: "Keep them", key: "n" },
      {
        value: "yes",
        label: `Erase ${metas.length} ${plural(metas.length, "session", "sessions")} · ${msgs} ${plural(msgs, "message", "messages")}`,
        key: "y",
        tone: "danger",
      },
    ],
    { initial: "no", fallback: "no" },
  );
  if (sure !== "yes") return;

  let done = 0;
  for (const m of metas) {
    // The same cleanup as a single delete above: snapshots and input history
    // are unreachable bytes once the file they belong to is gone.
    dropStore(app.cwd, m.id);
    dropSessionHistory(app.cwd, m.id);
    if (Session.remove(app.cwd, m.id)) done++;
  }
  if (done < metas.length) warn(t(`${metas.length - done} could not be deleted.`, `Не удалось удалить: ${metas.length - done}.`));
  success(t(`Erased ${done} ${plural(done, "session", "sessions")}.`, `Удалено ${count(done, ["session", "sessions"], ["сессия", "сессии", "сессий"])}.`));
}

/**
 * Undo a turn's file edits, and optionally the turn itself.
 *
 * The two halves are separate on purpose. Putting the files back but keeping
 * the conversation is the common case: the model still knows what it tried,
 * and can be told to try it differently. Dropping both is for a turn that was
 * a mistake from the prompt onwards.
 */
export async function rewindTurn(app: App, rest: string): Promise<void> {
  const points = listCheckpoints(app.session);
  if (!points.length) {
    return info(
      t(
        "Nothing to rewind — no file has been written in this session.",
        "Откатывать нечего — в этой сессии файлы не менялись.",
      ),
    );
  }

  const arg = rest.trim().toLowerCase();
  let chosen: Checkpoint | undefined;
  if (arg === "last") {
    chosen = points[0];
  } else {
    const value = await pick({
      title: t("Rewind to before which turn?", "Вернуть к состоянию до какого хода?"),
      items: points.map(
        (p): PickerItem => ({
          value: String(p.turn),
          label: truncate(p.prompt || t("(no prompt)", "(без запроса)"), 46).padEnd(47),
          hint:
            c.brightCyan(`${p.files.length} ${plural(p.files.length, "file", "files")}`.padStart(8)) +
            c.gray(`  ${fmtAgo(p.ts)}`),
        }),
      ),
    });
    if (!value) return;
    chosen = points.find((p) => String(p.turn) === value);
  }
  if (!chosen) return;

  line();
  padded(
    t(
      `Rewinding to before: ${truncate(chosen.prompt, 60)}`,
      `Возврат к состоянию до: ${truncate(chosen.prompt, 60)}`,
    ),
  );
  for (const f of chosen.files.slice(0, 12)) hint(c.gray("• ") + f);
  if (chosen.files.length > 12) {
    hint(c.gray(t(`… and ${chosen.files.length - 12} more`, `… и ещё ${chosen.files.length - 12}`)));
  }
  line();

  const what = await choose<"files" | "both" | "history" | "fork" | "cancel">(
    [
      { value: "files", label: t("Files only", "Только файлы"), key: "f" },
      { value: "both", label: t("Files and conversation", "Файлы и разговор"), key: "b", tone: "warn" },
      { value: "history", label: t("Conversation only", "Только разговор"), key: "c", tone: "warn" },
      {
        value: "fork",
        label: t("Fork here instead (nothing is undone)", "Ветка отсюда вместо отката (ничего не отменяется)"),
        key: "k",
      },
      { value: "cancel", label: t("Cancel", "Отмена"), key: "n", tone: "danger" },
    ],
    { initial: "files", fallback: "cancel" },
  );
  if (what === "cancel") return;
  if (what === "fork") {
    // A branch, not an undo: the original keeps its history and its files.
    const forked = Session.forkFrom(app.session, chosen.at);
    if (!forked || !forked.messages.length) return info(t("Nothing before that point to carry over.", "До этой точки ничего переносить."));
    forked.save();
    success(t(`Forked into ${forked.id} (${forked.messages.length} messages). Original untouched.`, `Ветка ${forked.id} (${forked.messages.length} сообщ.). Оригинал не тронут.`));
    const go = await choose<"switch" | "stay">(
      [
        { value: "switch", label: t("Switch to the fork now", "Перейти в ветку сейчас"), key: "s" },
        { value: "stay", label: t("Stay here", "Остаться здесь"), key: "n" },
      ],
      { initial: "switch", fallback: "stay" },
    );
    if (go === "switch") {
      adoptSession(app, forked);
      app.replayHistory();
    }
    return;
  }

  if (what !== "history") {
    const res = rewindFiles(app.session, chosen.turn);
    // What the model was allowed to write without re-reading is no longer what
    // is on disk: make it read again before its next edit.
    for (const f of [...res.restored, ...res.deleted]) {
      app.readFiles.delete(path.resolve(app.session.cwd, f));
    }
    const parts: string[] = [];
    if (res.restored.length) parts.push(t(`${res.restored.length} restored`, `восстановлено: ${res.restored.length}`));
    if (res.deleted.length) parts.push(t(`${res.deleted.length} removed`, `удалено: ${res.deleted.length}`));
    if (parts.length) success(parts.join(", "));
    if (res.diverged.length) {
      warn(
        t(
          `Changed outside this session — preserved and skipped: ${res.diverged.join(", ")}`,
          `Изменены вне сессии — сохранены и пропущены: ${res.diverged.join(", ")}`,
        ),
      );
    }
    if (res.failed.length) {
      error(
        t(
          `Could not restore: ${res.failed.join(", ")}`,
          `Не удалось восстановить: ${res.failed.join(", ")}`,
        ),
      );
    }
    // Those turns are undone; offering them again would restore nothing.
    forgetFrom(app.session, chosen.turn, [...res.diverged, ...res.failed]);
  }

  if (what !== "files") {
    app.session.messages = app.session.messages.slice(0, chosen.at);
    app.session.orchestration = null;
    if (!app.session.messages.length) Session.remove(app.cwd, app.session.id);
    else app.session.save();
    success(
      t(
        `Conversation rewound — ${app.session.messages.length} ${plural(app.session.messages.length, "message", "messages")} left.`,
        `Разговор откачен — осталось ${count(app.session.messages.length, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}.`,
      ),
    );
  } else {
    app.session.orchestration = null;
    // The files moved under the model's feet; say so in the history it reads.
    app.session.add({
      role: "user",
      content:
        `[system] The user rewound the working tree to how it was before: "${chosen.prompt}". ` +
        `These files were put back: ${chosen.files.join(", ")}. ` +
        `Re-read any of them before editing — what you last wrote there is gone.`,
    });
    app.session.save();
  }
}

/**
 * Branch the session at a past turn. Unlike /rewind nothing is undone: the
 * original session and its files stay as they are, and the user is moved into
 * a new session whose history ends just before the chosen turn — "what if I
 * had asked differently there" without losing the road already taken.
 */
export async function forkTurn(app: App, rest: string): Promise<void> {
  const points = listCheckpoints(app.session);
  const messages = app.session.messages;
  if (messages.length < 2) {
    return info(
      t(
        "Nothing to branch — this session has no history yet.",
        "Ветвить нечего — в этой сессии пока нет истории.",
      ),
    );
  }

  const arg = rest.trim().toLowerCase();
  let at: number;
  let label: string;
  if (arg === "start" || arg === "0") {
    at = 0;
    label = t("the very beginning", "самое начало");
  } else {
    // Turns with file edits first; when none exist, offer plain turn bounds
    // from user-message starts so an all-talk session can still be branched.
    const cuts = new Map<number, string>();
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user" && typeof messages[i].content === "string") {
        cuts.set(i, truncate(String(messages[i].content).replace(/\s+/g, " "), 46));
      }
    }
    for (const p of points) cuts.set(p.at, truncate(p.prompt || t("(no prompt)", "(без запроса)"), 46));

    let chosenKey: string | undefined;
    if (/^\d+$/.test(arg)) {
      chosenKey = arg;
    } else {
      const items = [...cuts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(
          ([idx, prompt]): PickerItem => ({
            value: String(idx),
            label: prompt.padEnd(47),
            hint: c.gray(`#${idx}`),
          }),
        );
      const picked = await pick({
        title: t("Branch from where?", "Ветвить от какого места?"),
        items,
      });
      if (picked === null) return;
      chosenKey = picked;
    }
    if (!chosenKey) return;
    at = Number(chosenKey);
    if (!Number.isInteger(at) || at < 0 || at >= messages.length) {
      return error(t(`No such position in the history: ${arg}`, `Такой позиции в истории нет: ${arg}`));
    }
    label = truncate(cuts.get(at) ?? `#${at}`, 60);
  }

  const forked = Session.forkFrom(app.session, at);
  if (!forked || !forked.messages.length) {
    return info(t("Nothing before that point to carry over.", "До этой точки ничего переносить."));
  }
  forked.save();

  padded(t(`Branching from: ${label}`, `Ветвление от: ${label}`));
  success(
    t(
      `Forked into ${forked.id} — ${forked.messages.length} ${plural(forked.messages.length, "message", "messages")}. The original ${app.session.id} is untouched.`,
      `Ветка ${forked.id} — ${count(forked.messages.length, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}. Оригинал ${app.session.id} не тронут.`,
    ),
  );

  const go = await choose<"switch" | "stay">(
    [
      { value: "switch", label: t("Switch to the fork now", "Перейти в ветку сейчас"), key: "s" },
      { value: "stay", label: t("Stay here", "Остаться здесь"), key: "n" },
    ],
    { initial: "switch", fallback: "stay" },
  );
  if (go === "switch") {
    adoptSession(app, forked);
    app.replayHistory();
  }
}

/**
 * Shared by /compact and "compact and continue" on resume. The resume path
 * skips the digest here — the replay right below prints it anyway.
 */
export async function compactNow(app: App, instructions: string, showDigest = true): Promise<void> {
  if (app.session.messages.length < 4) {
    info(t("The history is too short to compact.", "История слишком коротка для сжатия."));
    return;
  }
  const before = contextPressure(app.session, app.catalog);
  const sp = new Spinner("compacting context");
  sp.start();
  // Esc cancels a hung compaction request; without a consumer on the stdin
  // stack the keystroke would be dropped and the spinner would run forever.
  const abort = new AbortController();
  const release = process.stdin.isTTY
    ? pushConsumer((b) => {
        const s = b.toString("utf8");
        if (s === "\x1b" || s === "\x03") abort.abort();
      })
    : null;
  try {
    const res = await compactSession(app.session, {
      instructions: instructions.trim() || undefined,
      catalog: app.catalog,
      signal: abort.signal,
    });
    sp.stop();
    if (!res.summary) return info(t("Nothing to compact.", "Сжимать нечего."));
    const after = contextPressure(app.session, app.catalog);
    success(
      `Compacted ${res.droppedMessages} messages into a summary; ` +
        `${res.retainedUserMessages} recent user messages kept verbatim. ` +
        `Context ${Math.round(before.ratio * 100)}% → ${Math.round(after.ratio * 100)}% ` +
        `(~${fmtTokens(before.used)} → ~${fmtTokens(after.used)} tokens).`,
    );
    if (showDigest) {
      line();
      for (const l of renderMarkdownBlock(res.summary, { maxLines: 20, dim: true })) padded(l);
      line();
    }
  } catch (err) {
    sp.stop();
    if ((err as Error)?.name === "AbortError") warn(t("Interrupted.", "Прервано."));
    else error((err as Error).message);
  } finally {
    release?.();
  }
}

/**
 * Prints a message the screen showed short.
 *
 * The echo and the replayed history cut anything long down to five lines,
 * which is right for reading a conversation and wrong exactly once — when
 * you want the thing you pasted back.
 */
export function expandCollapsed(rest: string): void {
  const total = collapsedCount();
  if (!total) {
    return info(t("Nothing has been shortened on screen yet.", "На экране пока ничего не сокращалось."));
  }
  const arg = rest.trim();
  const id = arg ? Number(arg) : undefined;
  if (arg && (!Number.isInteger(id) || id! < 1 || id! > total)) {
    return warn(t(`No such block: 1–${total}.`, `Нет такого блока: 1–${total}.`));
  }
  const text = collapsedText(id);
  if (!text) return warn(t("Nothing to show.", "Показывать нечего."));
  line();
  for (const l of expandedBlock(text)) padded(l);
  line();
}

/**
 * Goes back to one of your own messages: everything after it is dropped and
 * the message itself lands back in the input frame to be rewritten.
 *
 * The point is the context, not the typing. A conversation that went the
 * wrong way carries the wrong way with it in every later request — editing
 * the question is the only way to stop paying for the answer.
 */
export async function editTurn(app: App, rest: string): Promise<void> {
  const msgs = app.session.messages;
  const mine = msgs
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === "user" && !m.meta?.hidden && !m.meta?.skill && typeof m.content === "string");
  if (!mine.length) {
    return info(t("Nothing to edit — you have not said anything yet.", "Править нечего — вы ещё ничего не написали."));
  }

  const arg = rest.trim().toLowerCase();
  let chosen = arg === "last" ? mine[mine.length - 1] : undefined;
  if (!chosen) {
    const value = await pick({
      title: t("Edit which message? Everything after it is dropped.", "Какое сообщение править? Всё после него будет удалено."),
      items: [...mine].reverse().map(({ m, i }): PickerItem => {
        const after = msgs.length - i - 1;
        return {
          value: String(i),
          label: truncate(String(m.content), 52).padEnd(53),
          hint:
            c.brightCyan(String(after).padStart(4)) +
            c.gray(t(" msgs after", " сообщ. после")) +
            (m.meta?.ts ? c.gray(`  ${fmtAgo(m.meta.ts)}`) : ""),
        };
      }),
    });
    if (!value) return;
    chosen = mine.find(({ i }) => String(i) === value);
  }
  if (!chosen) return;

  const dropped = msgs.length - chosen.i;
  // Files are a separate decision: /rewind owns the disk, this owns the
  // conversation, and conflating them would undo edits nobody asked about.
  app.session.messages = msgs.slice(0, chosen.i);
  app.session.orchestration = null;
  app.session.save();
  app.editor?.prefill(String(chosen.m.content));
  success(
    t(
      `Dropped ${dropped} ${plural(dropped, "message", "messages")}. The text is in the input — edit it and send.`,
      `Удалено ${count(dropped, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}. Текст в поле ввода — правьте и отправляйте.`,
    ),
  );
  hint(t("Files written after that turn are untouched — /rewind puts those back.", "Файлы, записанные после того хода, не тронуты — их вернёт /rewind."));
}
