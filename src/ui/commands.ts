/** Slash commands, grouped from everyday to occasional. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { c } from "./ansi.js";
import { contentWidth, fmtAgo } from "./layout.js";
import { error, hint, info, line, padded, plural, renderMarkdownBlock, rule, Spinner, success, truncate, warn, wrapText } from "./render.js";
import { pick, type PickerItem } from "./picker.js";
import { choose } from "./choice.js";
import { pickModel, pickModels, pickModelsAcrossProviders } from "./modelpicker.js";
import { askSecret } from "./secret.js";
import { askLine } from "./prompt.js";
import { scanKeys } from "./keyscan.js";
import { setExtraNewlineKeys } from "./editor.js";
import {
  loadConfig,
  saveConfig,
  configPath,
  rememberProjectState,
  sessionsDir,
  VERSION,
  EFFORT_LEVELS,
  LANGUAGES,
  type Effort,
  type Lang,
} from "../config.js";
import {
  fetchModels,
  resolveModelId,
  findModel,
  usableModels,
  incompatibleReason,
  groupByVendor,
  groupByModality,
  servesModality,
  contextWindowFor,
  effortFor,
} from "../provider/models.js";
import { protocolFor } from "../provider/protocol.js";
import { verifyKey, modelRejectsEffort, modelRejectsCache, resetEffortLearning } from "../provider/client.js";
import {
  DEFAULT_PROVIDER,
  modeConfig,
  modeFor,
  providerById,
  providerLabel,
  providers,
  providerState,
  rememberBaseUrl,
  rememberProviderState,
  splitModelId,
  wireModelId,
  type ProviderDef,
} from "../provider/registry.js";
import { clearCredentials } from "../provider/credentials.js";
import { chooseHost, loginProvider } from "./login.js";
import { AUTO, promptModelFor } from "../agent/promptwriter.js";
import { Session, type SessionMeta } from "../session/session.js";
import { compactSession, contextPressure } from "../session/compact.js";
import { pushConsumer } from "./stdin.js";
import { dropStore, forgetFrom, listCheckpoints, rewindFiles, type Checkpoint } from "../session/checkpoint.js";
import { collapsedCount, collapsedText } from "./paste.js";
import { fmtTokens, fmtCost, historyTokens, estimateTokens } from "../usage.js";
import type { ModelUsage } from "../usage.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { runSwarm } from "../agent/swarm.js";
import { runOrchestration } from "../agent/orchestrator.js";
import { createSkill } from "../skills/loader.js";
import { memoryPath, memoryCount } from "../tools/memory.js";
import { resetPromptSnapshots } from "../agent/prompt.js";
import { connectMcpServers, mcpClients, stopMcpServers } from "../mcp/client.js";
import { t, count } from "../i18n.js";
import type { App } from "./repl.js";

type Group = "main" | "session" | "settings" | "other";

const GROUP_ORDER: Group[] = ["main", "session", "settings", "other"];

/** Group headings, shown by /help and the command index. */
const groupLabel = (g: Group): string =>
  ({
    main: t("main", "основное"),
    session: t("session", "сессия"),
    settings: t("settings", "настройки"),
    other: t("other", "прочее"),
  })[g];

const effortHint = (e: Effort): string =>
  ({
    off: t("send no parameter — the model's own default", "не слать параметр — как решит сама модель"),
    minimal: t("barely any reasoning — fastest and cheapest", "почти без размышлений — быстрее и дешевле всего"),
    low: t("brief reasoning", "короткие размышления"),
    medium: t("a balance of speed and quality", "баланс скорости и качества"),
    high: t("maximum reasoning — slower and pricier", "максимум размышлений — медленнее и дороже"),
  })[e];

/**
 * Lazy, so a language switch is picked up without reloading the module: the
 * command table is built once at import, long before /lang runs.
 */
type Text = string | (() => string);
const txt = (v?: Text): string => (typeof v === "function" ? v() : (v ?? ""));

interface Command {
  name: string;
  group: Group;
  args?: Text;
  help: Text;
  /** Returns false to exit the REPL. */
  run(app: App, rest: string): Promise<boolean | void>;
}

/** "500k", "2m", "128000" → a token count; null when it is not one. */
function parseTokens(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1);
  return n >= 1000 && n <= 20e6 ? Math.round(n) : null;
}

/** Which provider the session is currently talking to. */
function currentProviderId(app: App): string {
  return splitModelId(app.session.model).providerId;
}

function providerModels(app: App, providerId: string) {
  return app.catalog.filter((m) => splitModelId(m.id).providerId === providerId);
}

/**
 * The model to land on when switching to a provider: where it was left last,
 * else the alias login created, else the configured default when it belongs
 * there, else whatever the provider offers first.
 */
function defaultModelFor(app: App, providerId: string): string | null {
  const cfg = loadConfig();
  const mine = providerModels(app, providerId);
  const has = (id: string) => mine.some((m) => m.id === id);
  const remembered = providerState(providerId).model;
  if (remembered && has(remembered)) return remembered;
  const alias = cfg.aliases[providerId];
  if (alias && has(alias)) return alias;
  if (has(cfg.model)) return cfg.model;
  return mine.find((m) => m.chatCapable !== false)?.id ?? mine[0]?.id ?? null;
}

/**
 * Switches the session's model, records it against its provider and restates
 * the header — which is a reprint, the old one being scrollback by now.
 */
function setModel(app: App, id: string): void {
  const provider = splitModelId(id).providerId;
  app.session.model = id;
  app.rebuildTools();
  app.session.save();
  rememberProviderState(provider, { model: id });
  // …and against the project, which is what the next start here opens on.
  rememberProjectState(app.cwd, { model: id });
  // Naming a model from another provider is choosing that provider, so the
  // default follows the session rather than lagging a command behind.
  if (loadConfig().defaultProvider !== provider) {
    saveConfig({ defaultProvider: provider });
    app.cfg = loadConfig();
  }
  app.repaintHeader();
}

/** Records where the session currently is, so coming back restores it. */
export function rememberCurrent(app: App): void {
  rememberProviderState(currentProviderId(app), {
    model: app.session.model,
    effort: app.effortOverride,
  });
  rememberProjectState(app.cwd, { model: app.session.model, effort: app.effortOverride });
}

function providerItems(app: App): PickerItem[] {
  const cur = currentProviderId(app);
  return providers().map((p) => {
    const mode = modeFor(p.id);
    const n = providerModels(app, p.id).length;
    return {
      value: p.id,
      label: p.label,
      badge: p.id === cur ? t("current", "текущий") : undefined,
      hint: mode
        ? t(`${mode === "oauth" ? "subscription" : "API key"} · ${n} ${plural(n, "model", "models")}`, `${mode === "oauth" ? "подписка" : "ключ API"} · ${count(n, ["model", "models"], ["модель", "модели", "моделей"])}`)
        : t("not connected — Enter to log in", "не подключён — Enter, чтобы войти"),
    };
  });
}

/** Connects the provider if needed, then points the session at one of its models. */
async function switchToProvider(app: App, def: ProviderDef): Promise<void> {
  if (def.id === currentProviderId(app)) return info(t(`Already on ${def.label}.`, `Уже на ${def.label}.`));
  if (!modeFor(def.id)) {
    if (def.id === DEFAULT_PROVIDER) return error(t("No TokenRouter key. Run /login.", "Нет ключа TokenRouter. Наберите /login."));
    const res = await loginProvider(def, { exclusive: (fn) => app.exclusiveInput(fn) });
    // Switching needs a credential, not a working plan: a lapsed subscription
    // is reported by the login and is the user's to renew, not ours to veto.
    if (!res.connected) return;
    app.cfg = loadConfig();
    app.catalog = await fetchModels({ force: true });
  }
  const id = defaultModelFor(app, def.id);
  if (!id) return error(t(`${def.label} has no models to switch to.`, `У ${def.label} нет моделей для переключения.`));

  rememberCurrent(app);
  const state = providerState(def.id);
  app.session.model = id;
  app.effortOverride = state.effort;
  rememberProjectState(app.cwd, { model: id, effort: state.effort });
  app.rebuildTools();
  app.session.save();
  // Choosing a provider is choosing it, not borrowing it for one session: the
  // next start opens here too, on the model and budget just restored.
  saveConfig({ defaultProvider: def.id });
  app.cfg = loadConfig();

  app.repaintHeader();
  warnIfIncompatible(app, id);
  const n = providerModels(app, def.id).length;
  if (n > 1) hint(t(`${n} models here — pick another with /model`, `${count(n, ["model", "models"], ["модель", "модели", "моделей"])} здесь — другую выбрать через /model`));
}

/** Says so plainly when a chosen model cannot be driven through this client. */
function warnIfIncompatible(app: App, id: string): void {
  const m = findModel(id, app.catalog);
  const why = m ? incompatibleReason(m) : null;
  if (!why) return;
  warn(t(`${id} cannot be driven through /v1/chat/completions — ${why}. Requests to it will fail.`, `${id} нельзя вести через /v1/chat/completions — ${why}. Запросы к ней будут падать.`));
}

/** How full a saved session is, coloured by how close it is to the window. */
function sessionFill(app: App, m: SessionMeta): { tokens: number; window: number; pct: number; tint: (s: string) => string } {
  const window = contextWindowFor(m.model, app.catalog);
  const tokens = m.tokens ?? 0;
  const pct = Math.round((tokens / window) * 100);
  const tint = pct >= 80 ? c.red : pct >= 50 ? c.yellow : c.gray;
  return { tokens, window, pct, tint };
}

function sessionItem(app: App, m: SessionMeta): PickerItem {
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
function sessionCard(app: App, s: Session): void {
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
function adoptSession(app: App, loaded: Session): void {
  app.session.save();
  app.session = loaded;
  app.usage = loaded.usage;
  app.readFiles.clear();
  app.rebuildTools();
}

type SessionAction = "open" | "compact" | "rename" | "delete" | "cancel";

/** `/resume <id>`: card, three buttons, no list to fall back to. */
async function openSession(app: App, id: string): Promise<void> {
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
 * The session list. `resume` mode is about getting back into one; `manage` mode
 * adds renaming and deleting. Both loop, so every "no" lands back on the list
 * instead of dropping the user at the prompt.
 */
async function browseSessions(app: App, mode: "resume" | "manage"): Promise<void> {
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

    const chosen = await pick({
      title: mode === "manage" ? "Sessions" : "Pick a session",
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
 * Undo a turn's file edits, and optionally the turn itself.
 *
 * The two halves are separate on purpose. Putting the files back but keeping
 * the conversation is the common case: the model still knows what it tried,
 * and can be told to try it differently. Dropping both is for a turn that was
 * a mistake from the prompt onwards.
 */
async function rewindTurn(app: App, rest: string): Promise<void> {
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

  const what = await choose<"files" | "both" | "history" | "cancel">(
    [
      { value: "files", label: t("Files only", "Только файлы"), key: "f" },
      { value: "both", label: t("Files and conversation", "Файлы и разговор"), key: "b", tone: "warn" },
      { value: "history", label: t("Conversation only", "Только разговор"), key: "c", tone: "warn" },
      { value: "cancel", label: t("Cancel", "Отмена"), key: "n", tone: "danger" },
    ],
    { initial: "files", fallback: "cancel" },
  );
  if (what === "cancel") return;

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
          `Changed outside this session since — the newer content is gone: ${res.diverged.join(", ")}`,
          `Изменялись вне сессии — более новое содержимое потеряно: ${res.diverged.join(", ")}`,
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
    forgetFrom(app.session, chosen.turn);
  }

  if (what !== "files") {
    app.session.messages = app.session.messages.slice(0, chosen.at);
    if (!app.session.messages.length) Session.remove(app.cwd, app.session.id);
    else app.session.save();
    success(
      t(
        `Conversation rewound — ${app.session.messages.length} ${plural(app.session.messages.length, "message", "messages")} left.`,
        `Разговор откачен — осталось ${count(app.session.messages.length, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}.`,
      ),
    );
  } else {
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
 * Shared by /compact and "compact and continue" on resume. The resume path
 * skips the digest here — the replay right below prints it anyway.
 */
async function compactNow(app: App, instructions: string, showDigest = true): Promise<void> {
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
      `Compacted ${res.droppedMessages} messages into a digest. ` +
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
 * Picks the model that writes prompts for the provider in use, and remembers
 * it. Named outright it is taken as a name; without an argument the same list
 * the model picker shows opens, minus everything this provider cannot serve —
 * typing an id from memory is not a way to choose among four hundred models.
 */
/**
 * The first /prompt on a provider asks who should write, and remembers the
 * answer — including "the default one", which is an answer too. Everything
 * after that just works; `/prompt models` reopens the list.
 */
async function ensureWriterChosen(app: App): Promise<boolean> {
  const provider = currentProviderId(app);
  if (loadConfig().promptModels?.[provider]) return true;

  const fallback = promptModelFor(app.session.model, app.catalog);
  line();
  padded(c.bold(t("Which model should write the briefs?", "Какая модель будет писать задания?")));
  hint(
    t(
      "A small one is enough, and it is cheaper than letting the big one guess.",
      "Хватит маленькой — это дешевле, чем давать большой домысливать.",
    ),
  );
  const answer = await app.exclusiveInput(() =>
    choose<"pick" | "default">(
      [
        { value: "pick", label: t("Choose one", "Выбрать"), key: "c", tone: "ok" },
        { value: "default", label: t(`Keep ${wireModelId(fallback)}`, `Оставить ${wireModelId(fallback)}`), key: "d" },
      ],
      { initial: "pick", fallback: "default" },
    ),
  );
  if (answer === "pick") {
    await chooseWriter(app, "");
    // Backing out of the list is not an answer; ask again next time.
    return Boolean(loadConfig().promptModels?.[provider]);
  }
  saveConfig({ promptModels: { [provider]: AUTO } });
  app.cfg = loadConfig();
  hint(t(`Writing with ${fallback}. Change it with /prompt models.`, `Пишет ${fallback}. Сменить: /prompt models.`));
  return true;
}

async function chooseWriter(app: App, named: string): Promise<void> {
  const cfg = loadConfig();
  const provider = currentProviderId(app);

  if (/^(auto|reset|default)$/i.test(named)) {
    saveConfig({ promptModels: { [provider]: AUTO } });
    app.cfg = loadConfig();
    success(
      t(
        `${providerLabel(provider)}: the default writer — ${promptModelFor(app.session.model, app.catalog)}.`,
        `${providerLabel(provider)}: модель по умолчанию — ${promptModelFor(app.session.model, app.catalog)}.`,
      ),
    );
    return;
  }

  let id: string | null = null;
  if (named) {
    try {
      id = resolveModelId(named, app.catalog);
    } catch (err) {
      return void error((err as Error).message);
    }
  } else {
    // Only models this key can call, and only ones that can answer in text: a
    // writer is a chat turn like any other.
    const pool = providerModels(app, provider).filter(
      (m) => m.chatCapable !== false && servesModality(m, "text"),
    );
    if (!pool.length) {
      return void error(t(`${providerLabel(provider)} has no model that could write prompts.`, `У ${providerLabel(provider)} нет модели, которая могла бы писать промпты.`));
    }
    line();
    hint(t("The model that writes prompts for this provider", "Модель, которая пишет промпты у этого поставщика"));
    id = await app.exclusiveInput(() =>
      pickModel({
        catalog: pool,
        current: promptModelFor(app.session.model, app.catalog),
        defaultModel: app.session.model,
      }),
    );
    if (!id) return;
  }

  if (splitModelId(id).providerId !== provider) {
    return void error(
      t(
        `${id} belongs to another provider — a writer has to be one this key can call.`,
        `${id} у другого поставщика — писать промпты должна модель, доступная этому ключу.`,
      ),
    );
  }
  saveConfig({ promptModels: { [provider]: id } });
  app.cfg = loadConfig();
  success(t(`${providerLabel(provider)} writes prompts with ${id}.`, `${providerLabel(provider)}: промпты пишет ${id}.`));
}

/**
 * Prints a message the screen showed short.
 *
 * The echo and the replayed history cut anything long down to five lines,
 * which is right for reading a conversation and wrong exactly once — when
 * you want the thing you pasted back.
 */
function expandCollapsed(rest: string): void {
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
  for (const l of renderMarkdownBlock(text)) padded(l);
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
async function editTurn(app: App, rest: string): Promise<void> {
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

const COMMANDS: Command[] = [
  // ── main ────────────────────────────────────────────────────────────────
  {
    name: "/model",
    group: "main",
    args: () => t("[name|alias|all]", "[имя|алиас|all]"),
    help: () => t("switch model — the current provider's, or all with `all`", "сменить модель — текущего поставщика, `all` для всех"),
    async run(app, rest) {
      const arg = rest.trim();
      if (arg && arg !== "all") {
        // A name is searched across every provider: naming one is an explicit
        // enough request to cross over.
        const id = resolveModelId(arg, app.catalog);
        // The header states the provider, so crossing to another needs no
        // separate line about it.
        setModel(app, id);
        warnIfIncompatible(app, id);
        return;
      }

      const cfg = loadConfig();
      // Scoped to the provider in use: the other providers' models cannot be
      // served by it, and listing them only invites a 404.
      const provider = currentProviderId(app);
      const scoped = arg === "all" ? app.catalog : providerModels(app, provider);
      const catalog = scoped.length ? scoped : app.catalog;
      const chosen = await app.exclusiveInput(() =>
        pickModel({ catalog, current: app.session.model, defaultModel: cfg.model }),
      );
      if (!chosen) return;
      setModel(app, chosen);
      warnIfIncompatible(app, chosen);
      const aliasFor = Object.entries(cfg.aliases).find(([, v]) => v === chosen)?.[0];
      if (aliasFor) hint(t(`alias: /model ${aliasFor}`, `алиас: /model ${aliasFor}`));
      if (arg !== "all" && app.catalog.length > catalog.length) {
        hint(t(`showing ${catalog.length} from ${providerById(provider)?.label ?? provider} — /model all for every provider`, `показано ${catalog.length} у ${providerById(provider)?.label ?? provider} — /model all для всех поставщиков`));
      }
      if (chosen !== cfg.model) hint(t("make it the default: /default", "сделать моделью по умолчанию: /default"));
    },
  },
  {
    name: "/provider",
    group: "main",
    args: () => t("[name] | default [name] | host [name] [url] | logout <name>", "[имя] | default [имя] | host [имя] [url] | logout <имя>"),
    help: () => t("switch provider — the router or a direct subscription", "сменить поставщика — роутер или прямая подписка"),
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const others = providers().filter((p) => p.id !== DEFAULT_PROVIDER);

      if (parts[0] === "default") {
        const def = parts[1] ? providerById(parts[1].toLowerCase()) : providerById(currentProviderId(app));
        if (!def) return error(t(`Unknown provider: ${parts[1]}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${parts[1]}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
        if (!modeFor(def.id)) return error(t(`${def.label} is not connected — /provider ${def.id} connects it.`, `${def.label} не подключён — подключит /provider ${def.id}.`));
        // The remembered model is what a new session will open on, so pin the
        // current one when defaulting to the provider we are already using.
        if (def.id === currentProviderId(app)) rememberCurrent(app);
        saveConfig({ defaultProvider: def.id });
        app.cfg = loadConfig();
        success(t(`Default provider: ${c.brightYellow(def.label)}`, `Поставщик по умолчанию: ${c.brightYellow(def.label)}`));
        hint(t(`New sessions start on ${providerState(def.id).model ?? defaultModelFor(app, def.id) ?? loadConfig().model}.`, `Новые сессии будут открываться на ${providerState(def.id).model ?? defaultModelFor(app, def.id) ?? loadConfig().model}.`));
        return;
      }

      // The host a key belongs to is not always the one a provider defaults
      // to, and getting it wrong is reported as a rejected key. Changing it
      // must not cost a logout — the credential is still good.
      if (parts[0] === "host") {
        const named = parts.slice(1).find((p) => !/^https?:\/\//i.test(p));
        const def = named ? providerById(named.toLowerCase()) : providerById(currentProviderId(app));
        if (!def) return error(t(`Unknown provider: ${named}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${named}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
        if (def.id === DEFAULT_PROVIDER) {
          return error(t("TokenRouter's host lives in the config: baseUrl.", "Хост TokenRouter задаётся в конфиге: baseUrl."));
        }
        const given = parts.find((p) => /^https?:\/\//i.test(p));
        const url = given ?? (await chooseHost(def, (fn) => app.exclusiveInput(fn)));
        if (url === null) return;
        if (url) rememberBaseUrl(def.id, url);
        app.cfg = loadConfig();
        app.catalog = await fetchModels({ force: true });
        app.rebuildTools();
        const now = modeConfig(def.id, "apikey")?.baseUrl;
        success(t(`${def.label} host: ${now}`, `Сервер ${def.label}: ${now}`));
        if (modeFor(def.id)) hint(t(`The key stays as it is — /login ${def.id} replaces it.`, `Ключ остаётся прежним — заменить: /login ${def.id}.`));
        return;
      }

      if (parts[0] === "logout") {
        const def = parts[1] ? providerById(parts[1].toLowerCase()) : undefined;
        if (!def) return error(t(`Which provider? ${others.map((p) => p.id).join(", ") || "none to disconnect"}`, `Какого поставщика? ${others.map((p) => p.id).join(", ") || "отключать нечего"}`));
        if (def.id === DEFAULT_PROVIDER) return error(t("Remove the TokenRouter key with: trc auth logout", "Ключ TokenRouter удаляется так: trc auth logout"));
        if (!clearCredentials(def.id)) return warn(t(`${def.label} was not connected.`, `${def.label} не был подключён.`));
        app.catalog = await fetchModels({ force: true });
        success(t(`${def.label} disconnected.`, `${def.label} отключён.`));
        // The session was talking to it; leaving the model in place would only
        // produce a 401 on the next turn.
        if (currentProviderId(app) === def.id) {
          app.session.model = loadConfig().model;
          app.session.save();
          app.rebuildTools();
          info(t(`Model: ${app.session.model}`, `Модель: ${app.session.model}`));
        }
        return;
      }

      if (parts[0]) {
        const def = providerById(parts[0].toLowerCase());
        if (!def) return error(t(`Unknown provider: ${parts[0]}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${parts[0]}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
        return switchToProvider(app, def);
      }

      const chosen = await app.exclusiveInput(() =>
        pick({ title: t("Provider", "Поставщик"), items: providerItems(app), initial: currentProviderId(app) }),
      );
      if (!chosen) return;
      await switchToProvider(app, providerById(chosen)!);
    },
  },
  {
    name: "/lang",
    group: "settings",
    args: "[en|ru]",
    help: () => t("language for answers and skill descriptions", "язык ответов и описаний навыков"),
    async run(app, rest) {
      const arg = rest.trim().toLowerCase();
      const named = arg
        ? LANGUAGES.find((l) => l.code === arg || l.label.toLowerCase() === arg || l.native.toLowerCase() === arg)
        : undefined;
      if (arg && !named) {
        return error(t(`Unknown language: ${arg}. Available: ${LANGUAGES.map((l) => l.code).join(", ")}`, `Неизвестный язык: ${arg}. Доступны: ${LANGUAGES.map((l) => l.code).join(", ")}`));
      }

      const current = loadConfig().lang;
      const code =
        named?.code ??
        ((await app.exclusiveInput(() =>
          pick({
            title: "Language",
            items: LANGUAGES.map((l) => ({
              value: l.code,
              label: l.native.padEnd(10),
              hint: c.gray(l.code === current ? `${l.label} · current` : l.label),
            })),
            initial: current,
          }),
        )) as Lang | null);
      if (!code) return;

      saveConfig({ lang: code });
      app.cfg = loadConfig();
      // Both the system prompt and the skill descriptions are built from the
      // language, and both are cached — rebuild them rather than wait for the
      // next session.
      resetPromptSnapshots();
      app.rebuildTools();
      // The header is drawn in the interface language, so it is redrawn in the
      // new one — which also clears the screen of the old language.
      app.repaintHeader();
      const picked = LANGUAGES.find((l) => l.code === code)!;
      success(t(`Language: ${c.brightYellow(picked.native)}`, `Язык: ${c.brightYellow(picked.native)}`));
      hint(
        code === "ru"
          ? "Ответы и описания навыков — по-русски. Код, пути и команды остаются как есть."
          : "Answers and skill descriptions are in English. Code, paths and commands are never translated.",
      );
      // The prompt is rebuilt per turn, so the change lands on the next one.
      if (app.session.messages.length) hint(code === "ru" ? "Применится со следующего сообщения." : "Applies from the next message.");
    },
  },
  {
    name: "/effort",
    group: "main",
    args: "[off|minimal|low|medium|high] [save] | reset",
    help: () => t("reasoning budget", "бюджет размышлений"),
    async run(app, rest) {
      const cfg = loadConfig();
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const persist = parts.includes("save");
      const wanted = parts.find((p) => (EFFORT_LEVELS as string[]).includes(p)) as Effort | undefined;

      if (parts[0] === "reset") {
        const target = parts[1] === "all" ? undefined : app.session.model;
        resetEffortLearning(target);
        success(
          target
            ? `Forgot that ${target} rejects the reasoning budget — it will be probed again on the next request.`
            : "Cleared what was learned about reasoning support for every model.",
        );
        return;
      }

      if (parts.length && !wanted && !persist) {
        error(t(`Unknown level "${parts[0]}". Available: ${EFFORT_LEVELS.join(", ")}`, `Неизвестный уровень "${parts[0]}". Доступны: ${EFFORT_LEVELS.join(", ")}`));
        hint(t("Also: /effort reset re-probes support for the current model.", "Ещё: /effort reset заново проверит поддержку у текущей модели."));
        return;
      }

      const level =
        wanted ??
        ((await app.exclusiveInput(() =>
          pick({
            title: t(`Reasoning budget (now: ${app.effort()})`, `Бюджет размышлений (сейчас: ${app.effort()})`),
            items: EFFORT_LEVELS.map((l) => ({
              value: l,
              label: l.padEnd(10),
              hint: c.gray(effortHint(l)),
            })),
            initial: app.effort(),
          }),
        )) as Effort | null);

      if (!level) return;

      app.effortOverride = level;
      // Kept against the provider too: what one host charges for thinking, and
      // what it is worth there, does not carry over to the next.
      rememberProviderState(currentProviderId(app), { effort: level });
      rememberProjectState(app.cwd, { effort: level });
      if (persist) {
        saveConfig({ effort: level });
        app.cfg = loadConfig();
      }
      // The budget is one of the three things the header states, so restate it.
      app.repaintHeader();
      hint(persist ? t("Saved as the default.", "Сохранено как значение по умолчанию.") : t("This session only — add save to keep it.", "Только на эту сессию — добавьте save, чтобы запомнить."));
      if (level !== "off" && modelRejectsEffort(app.session.model)) {
        warn(t(`${app.session.model} rejected this parameter before — it is being omitted.`, `${app.session.model} уже отвергала этот параметр — он не отправляется.`));
        hint(t("Re-check with: /effort reset", "Перепроверить: /effort reset"));
      }
      if (level !== "off") {
        hint(
          `Sent as ${cfg.effortParam === "both" ? "the shape this model accepts" : cfg.effortParam}; ` +
            "dropped automatically if the model rejects it.",
        );
      }
    },
  },
  {
    name: "/yolo",
    group: "main",
    help: () => t("skip confirmations — tools run immediately", "без подтверждений — инструменты запускаются сразу"),
    async run(app, rest) {
      const arg = rest.trim().toLowerCase();
      const next = arg ? ["on", "1", "true"].includes(arg) : !app.broker.autoApprove;
      app.broker.autoApprove = next;
      if (next) {
        warn(t("YOLO on — file writes and shell commands run without asking.", "YOLO включён — запись файлов и команды оболочки идут без спроса."));
        hint(t("Turn it off with: /yolo off, or Shift+Tab.", "Выключить: /yolo off или Shift+Tab."));
      } else {
        success(t("YOLO off — confirmations are back.", "YOLO выключен — подтверждения вернулись."));
        hint(t("Shift+Tab flips it without typing a command.", "Shift+Tab переключает это без команды."));
      }
    },
  },
  {
    name: "/orchestrate",
    group: "main",
    args: () => t("<task>", "<задача>"),
    help: () => t("split a task into subtasks and run them on subagents", "разбить задачу на подзадачи и раздать субагентам"),
    async run(app, rest) {
      const task = rest.trim();
      if (!task) {
        warn(t("Name the task: /orchestrate <what to do>", "Назовите задачу: /orchestrate <что сделать>"));
        hint("The task is split into steps with dependencies; independent ones run in parallel.");
        hint("Unlike /swarm, which sends one whole task to several models.");
        return;
      }
      await runOrchestration(app, task);
    },
  },
  {
    name: "/swarm",
    group: "main",
    args: () => t("<task>", "<задача>"),
    help: () => t("swarm: several models solve it in parallel, then a synthesis pass", "рой: несколько моделей решают параллельно, затем сведение"),
    async run(app, rest) {
      const task = rest.trim();
      if (!task) return warn(t("Name the task: /swarm <what to solve>", "Назовите задачу: /swarm <что решить>"));
      await runSwarm(app, task);
    },
  },
  {
    name: "/compact",
    group: "main",
    args: () => t("[what to focus on]", "[на чём сфокусироваться]"),
    help: () => t("compact the history into a digest", "сжать историю в конспект"),
    async run(app, rest) {
      await compactNow(app, rest);
    },
  },
  {
    name: "/edit",
    group: "main",
    args: () => t("[last]", "[last]"),
    help: () => t("go back to one of your messages and rewrite it", "вернуться к своему сообщению и переписать его"),
    async run(app, rest) {
      await app.exclusiveInput(() => editTurn(app, rest));
    },
  },
  {
    name: "/expand",
    group: "main",
    args: () => t("[n]", "[n]"),
    help: () => t("print a shortened message in full", "показать сокращённое сообщение целиком"),
    async run(_app, rest) {
      expandCollapsed(rest);
    },
  },
  {
    name: "/rewind",
    group: "main",
    args: () => t("[last]", "[last]"),
    help: () => t("put files back to how they were before a turn", "вернуть файлы к состоянию до хода"),
    async run(app, rest) {
      await app.exclusiveInput(() => rewindTurn(app, rest));
    },
  },
  {
    name: "/new",
    group: "main",
    help: () => t("start a new session", "начать новую сессию"),
    async run(app) {
      app.session.save();
      const fresh = new Session({ cwd: app.cwd, model: app.session.model });
      app.session = fresh;
      app.usage = fresh.usage;
      app.readFiles.clear();
      app.broker.reset();
      app.todo.replace([]);
      app.rebuildTools();
      success(t("New session: ", "Новая сессия: ") + fresh.id);
    },
  },

  // ── session ─────────────────────────────────────────────────────────────
  {
    name: "/sessions",
    group: "session",
    args: "",
    help: () => t("browse, rename, delete or compact saved sessions", "просмотр, переименование, удаление и сжатие сессий"),
    async run(app) {
      await app.exclusiveInput(() => browseSessions(app, "manage"));
    },
  },
  {
    name: "/resume",
    group: "session",
    args: "[id]",
    help: () => t("restore a session", "восстановить сессию"),
    async run(app, rest) {
      const id = rest.trim();
      await app.exclusiveInput(() => (id ? openSession(app, id) : browseSessions(app, "resume")));
    },
  },
  {
    name: "/rename",
    group: "session",
    args: () => t("[title]", "[название]"),
    help: () => t("rename the current session", "переименовать текущую сессию"),
    async run(app, rest) {
      const given = rest.trim();
      const title = given || (await app.exclusiveInput(() => askLine("New title:", app.session.title)));
      if (title === null) return;
      app.session.rename(title);
      success(t(`Renamed to: ${app.session.title || "(untitled)"}`, `Переименована в: ${app.session.title || "(без названия)"}`));
    },
  },
  {
    name: "/brain",
    group: "main",
    args: () => t("<question> | models", "<вопрос> | models"),
    help: () =>
      t(
        "several models answer, read each other, and one writes the result",
        "несколько моделей отвечают, читают друг друга, одна сводит итог",
      ),
    async run(app, rest) {
      const arg = rest.trim();
      const cfg = loadConfig();

      if (/^models?$/i.test(arg)) {
        line();
        hint(
          t(
            "Space marks a model, ←/→ switches provider, Enter confirms. Two or three is a panel; more is mostly repetition.",
            "Пробел отмечает модель, ←/→ переключает поставщика, Enter подтверждает. Двух-трёх достаточно; дальше — повторы.",
          ),
        );
        const picked = await app.exclusiveInput(() =>
          pickModelsAcrossProviders({
            catalog: app.catalog,
            current: app.session.model,
            defaultModel: app.session.model,
            selected: cfg.brainModels,
            title: t("Panel for /brain", "Совет моделей для /brain"),
          }),
        );
        if (picked === null) return;
        saveConfig({ brainModels: picked }, { replace: ["brainModels"] });
        app.cfg = loadConfig();
        if (!picked.length) return void success(t("Panel cleared.", "Совет очищен."));
        return void success(
          t(`Panel: ${picked.map(wireModelId).join(", ")}`, `Совет: ${picked.map(wireModelId).join(", ")}`),
        );
      }

      const panel = cfg.brainModels.filter((m) => app.catalog.some((x) => x.id === m));
      if (panel.length < 2) {
        error(
          t(
            "A panel needs at least two models that this client can reach.",
            "Совету нужны хотя бы две модели, доступные этому клиенту.",
          ),
        );
        return void hint(t("Choose them with /brain models", "Выбрать: /brain models"));
      }

      const question = arg || (await app.exclusiveInput(() => askLine(t("The question:", "Вопрос:"), "")));
      if (!question) return;

      await app.runBrain(question, panel);
    },
  },
  {
    name: "/subagents",
    group: "settings",
    args: () => t("[model [id]] | auto", "[model [id]] | auto"),
    help: () =>
      t(
        "which models subagents may run on: `model [id]` adds one, `auto` resets to the session's model",
        "какие модели доступны субагентам: `model [id]` добавляет одну, `auto` сбрасывает на модель сессии",
      ),
    async run(app, rest) {
      const provider = currentProviderId(app);
      const cfg = loadConfig();
      const current = cfg.subagentModels?.[provider] ?? [];

      // Only what this key can actually launch a subagent on — the same rule
      // the tool itself applies.
      const pool = providerModels(app, provider).filter(
        (m) => m.chatCapable !== false && servesModality(m, "text"),
      );

      // /subagents model [id] — put one more model on the list without walking
      // the whole catalog; without an id it falls through to the chooser.
      if (/^models?\s+\S/i.test(rest.trim())) {
        if (!pool.length) {
          return void error(
            t(`${providerLabel(provider)} has no model a subagent could run on.`, `У ${providerLabel(provider)} нет моделей для субагентов.`),
          );
        }
        const named = rest.trim().replace(/^models?\s+/i, "").trim();
        let added: string;
        try {
          added = resolveModelId(named, app.catalog);
        } catch (err) {
          return void error((err as Error).message);
        }
        if (!pool.some((m) => m.id === added)) {
          return void error(
            t(
              `${added} is not a model of ${providerLabel(provider)} a subagent could run on.`,
              `${added} — не модель ${providerLabel(provider)}, на которой может работать субагент.`,
            ),
          );
        }
        const next = [...new Set([...current, added])];
        saveConfig({ subagentModels: { [provider]: next } });
        app.cfg = loadConfig();
        app.rebuildTools();
        return void success(
          t(
            `${providerLabel(provider)}: subagents also run on ${wireModelId(added)}.`,
            `${providerLabel(provider)}: субагенты работают также на ${wireModelId(added)}.`,
          ),
        );
      }

      if (/^(auto|reset|any|all)$/i.test(rest.trim())) {
        const next = { ...cfg.subagentModels };
        delete next[provider];
        saveConfig({ subagentModels: next }, { replace: ["subagentModels"] });
        app.cfg = loadConfig();
        app.rebuildTools();
        return void success(
          t(
            `${providerLabel(provider)}: subagents run on the session's model only.`,
            `${providerLabel(provider)}: субагенты работают только на модели сессии.`,
          ),
        );
      }

      if (!pool.length) {
        return void error(
          t(`${providerLabel(provider)} has no model a subagent could run on.`, `У ${providerLabel(provider)} нет моделей для субагентов.`),
        );
      }

      line();
      hint(
        t(
          "Space marks the models a subagent may run on, Enter confirms. Nothing marked — the session's model only.",
          "Пробел отмечает модели, на которых можно запускать субагентов, Enter подтверждает. Ничего не отмечено — только модель сессии.",
        ),
      );
      const picked = await app.exclusiveInput(() =>
        pickModels({
          catalog: pool,
          current: app.session.model,
          defaultModel: app.session.model,
          selected: current,
          title: t("Models for subagents", "Модели для субагентов"),
        }),
      );
      if (picked === null) return;

      saveConfig({ subagentModels: { [provider]: picked } });
      app.cfg = loadConfig();
      app.rebuildTools();
      if (!picked.length) {
        return void success(
          t(`${providerLabel(provider)}: the session's model only.`, `${providerLabel(provider)}: только модель сессии.`),
        );
      }
      success(
        t(
          `Subagents on ${providerLabel(provider)}: ${picked.map(wireModelId).join(", ")}`,
          `Субагенты у ${providerLabel(provider)}: ${picked.map(wireModelId).join(", ")}`,
        ),
      );
    },
  },
  {
    name: "/prompt_model",
    group: "settings",
    args: () => t("[id|auto]", "[id|auto]"),
    help: () => t("choose the model that writes prompts here", "выбрать модель, которая пишет промпты"),
    async run(app, rest) {
      await chooseWriter(app, rest.trim());
    },
  },
  {
    name: "/prompt",
    group: "session",
    args: () => t("<task> | model [id] | off|command|auto", "<задача> | model [id] | off|command|auto"),
    help: () =>
      t(
        "a small model turns a short ask into a brief for the big one",
        "маленькая модель разворачивает короткий запрос в задание для большой",
      ),
    async run(app, rest) {
      const arg = rest.trim();
      const cfg = loadConfig();

      // /prompt off | command | auto — when the rewriting happens at all.
      if (/^(off|command|auto)$/i.test(arg)) {
        const mode = arg.toLowerCase() as "off" | "command" | "auto";
        saveConfig({ promptMode: mode });
        app.cfg = loadConfig();
        const said = {
          off: t("never rewritten", "не переписывать"),
          command: t("only when /prompt asks", "только по команде /prompt"),
          auto: t("a new task is rewritten before it is sent", "новая задача переписывается перед отправкой"),
        }[mode];
        return void success(t(`Prompt mode: ${mode} — ${said}`, `Режим промптов: ${mode} — ${said}`));
      }

      // /prompt model [id] — the writer for the provider in use.
      if (/^models?/i.test(arg)) {
        await chooseWriter(app, arg.replace(/^models?/i, "").trim());
        return;
      }

      // /prompt <task> — compose one now.
      const task = arg || (await app.exclusiveInput(() => askLine(t("What do you want done?", "Что нужно сделать?"), "")));
      if (!task) return;

      if (!(await ensureWriterChosen(app))) return;
      const written = await app.composePrompt(task);
      if (!written) return;

      line();
      padded(c.gray(t("— brief —", "— задание —")));
      // Wrapped, not printed raw: a brief is a paragraph, and the terminal
      // wraps at column zero — leaving every line but the first outside the
      // margin the rest of the transcript keeps.
      for (const l of wrapText(written, contentWidth() - 2)) padded(l);
      line();
      const action = await app.exclusiveInput(() =>
        choose<"send" | "edit" | "drop">(
          [
            { value: "send", label: t("Send", "Отправить"), key: "s", tone: "ok" },
            { value: "edit", label: t("Edit first", "Поправить"), key: "e" },
            { value: "drop", label: t("Discard", "Отменить"), key: "n", tone: "danger" },
          ],
          { initial: "send", fallback: "drop" },
        ),
      );
      if (action === "send") return void app.queue(written);
      if (action === "edit") app.prefill(written);
    },
  },
  {
    name: "/context",
    group: "session",
    args: "[<tokens>|auto]",
    help: () => t("how full the context window is", "насколько заполнено окно контекста"),
    async run(app, rest) {
      const arg = rest.trim().toLowerCase();
      if (arg) {
        // The catalog endpoint publishes no window sizes, so a wrong guess is
        // the user's to correct — and the correction has to outlive the
        // session, hence the config rather than a session field.
        if (arg === "auto" || arg === "reset") {
          const next = { ...loadConfig().contextWindows };
          delete next[app.session.model];
          saveConfig({ contextWindows: next }, { replace: ["contextWindows"] });
          hint(t(`${app.session.model}: back to the reported or assumed size.`, `${app.session.model}: снова размер из каталога или оценка.`));
        } else {
          const pinned = parseTokens(arg);
          if (!pinned) {
            return void error(t(`Not a token count: ${rest.trim()} (try 500k, 2m, 128000)`, `Не похоже на число токенов: ${rest.trim()} (например 500k, 2m, 128000)`));
          }
          saveConfig({ contextWindows: { [app.session.model]: pinned } });
          hint(t(`${app.session.model}: window pinned to ${fmtTokens(pinned)} tokens.`, `${app.session.model}: окно закреплено на ${fmtTokens(pinned)} токенов.`));
        }
        app.cfg = loadConfig();
        // Cached catalog, re-decorated: the pin applies without a round trip.
        app.catalog = await fetchModels();
      }
      const { used, window, ratio } = contextPressure(app.session, app.catalog);
      const m = findModel(app.session.model, app.catalog);
      const barWidth = Math.min(40, contentWidth() - 10);
      const filled = Math.min(barWidth, Math.round(ratio * barWidth));
      line();
      padded(c.brightCyan("█".repeat(filled)) + c.gray("░".repeat(barWidth - filled)) + ` ${Math.round(ratio * 100)}%`);
      hint(
        `~${fmtTokens(used)} of ${fmtTokens(window)} tokens · ${app.session.messages.length} ${plural(app.session.messages.length, "message", "messages")}` +
          (app.session.compactions ? ` · compactions: ${app.session.compactions}` : ""),
      );
      if (!m?.contextWindow) {
        hint(t(`The API does not report the window size — this is an estimate. Pin the real one with /context 500k.`, `API не сообщает размер окна — это оценка. Закрепить настоящий: /context 500k.`));
      }
      line();
    },
  },
  {
    name: "/debug",
    group: "session",
    args: "request",
    help: () => t("where the tokens of a request go, by section", "куда уходят токены запроса, по секциям"),
    async run(app, rest) {
      const sub = rest.trim().toLowerCase();
      if (sub !== "request" && sub !== "req") {
        error(t(`Usage: /debug request`, `Использование: /debug request`));
        return;
      }
      const system = buildSystemPrompt({ cwd: app.cwd, model: app.session.model, skills: app.activeSkills });
      const tools = app.toolList();
      let schemas = 0;
      for (const tool of tools) {
        schemas += estimateTokens(tool.name + tool.description) + 12;
        schemas += estimateTokens(JSON.stringify(tool.parameters));
      }
      const msgs = app.session.messages.filter((m) => !m.meta?.hidden);
      const byRole = new Map<string, number>();
      for (const m of msgs) {
        let n = estimateTokens(String(m.content ?? ""));
        for (const tc of m.tool_calls ?? []) n += estimateTokens(tc.function.arguments) + 12;
        const role = m.role === "tool" ? "tool results" : m.role === "assistant" ? "assistant" : m.meta?.skill ? "skill" : m.role;
        byRole.set(role, (byRole.get(role) ?? 0) + n);
      }
      const history = historyTokens(msgs);
      const { used, window } = contextPressure(app.session, app.catalog);
      line();
      const rows: [string, number][] = [
        ["system prompt", estimateTokens(system)],
        ["tool schemas", schemas],
        ...[...byRole.entries()].sort((a, b) => b[1] - a[1]),
      ];
      const labelW = Math.max(...rows.map(([k]) => k.length));
      for (const [label, n] of rows) {
        const pct = used ? Math.round((n / used) * 100) : 0;
        padded(`  ${c.gray(label.padEnd(labelW))}  ~${fmtTokens(n).padStart(7)}  ${c.gray(`${String(pct).padStart(3)}%`)}`);
      }
      padded(`  ${c.bold("history".padEnd(labelW))}  ~${c.bold(fmtTokens(history)).padStart(7)}  ${c.gray("of the window:")} ${fmtTokens(window)}`);
      hint(t("estimates (~3.6 chars/token); the real count is in the usage line after a turn.", "оценки (~3.6 симв./токен); точные числа — в строке usage после хода."));
      line();
    },
  },
  {
    name: "/cost",
    group: "session",
    help: () => t("session token usage by model", "расход токенов по моделям"),
    async run(app) {
      const rows = app.usage.all();
      const t = app.usage.totals();
      line();
      rule(c.brightCyan(" session tokens "));
      if (!rows.length) {
        hint("No requests yet.");
        line();
        return;
      }
      const row = (model: string, u: { requests: number; input: number; cached: number; output: number; reasoning: number }) =>
        `${model.padEnd(30)} ${String(u.requests).padStart(5)} ${fmtTokens(u.input).padStart(9)} ` +
        `${fmtTokens(Math.round(u.input / Math.max(1, u.requests))).padStart(9)} ` +
        `${(u.cached ? fmtTokens(u.cached) : "—").padStart(9)} ` +
        `${fmtTokens(u.output).padStart(9)} ${(u.reasoning ? fmtTokens(u.reasoning) : "—").padStart(10)}`;

      padded(
        c.gray(
          `${"model".padEnd(30)} ${"reqs".padStart(5)} ${"input".padStart(9)} ${"per req".padStart(9)} ` +
            `${"cached".padStart(9)} ${"output".padStart(9)} ${"reasoning".padStart(10)}`,
        ),
      );
      for (const r of rows) padded(row(r.model, r));
      // A rule under a table is structure, not commentary: it has to line up
      // with the columns, so it keeps the table's own margin.
      padded(c.gray("─".repeat(Math.min(85, contentWidth()))));
      padded(c.bold(row("total", t)));

      // Caching is the difference between paying for the history once and
      // paying for it on every step, so a flat zero is worth pointing at.
      if (t.cached && t.input) {
        hint(
          `${Math.round((t.cached / t.input) * 100)}% of all input came from the provider cache, billed at its discounted rate — ` +
            `${fmtTokens(t.input - t.cached)} of ${fmtTokens(t.input)} was fresh and paid for in full.`,
        );
      }
      // What the session actually costs to serve, and what a metered plan
      // counts: reading the cache is nearly free on both, so fresh input plus
      // output is the number to watch — and the one that says whether the
      // history is staying append-only.
      if (t.requests > 1) {
        const billable = t.input - t.cached + t.output;
        hint(
          `Fresh input + output: ${fmtTokens(billable)} over ${t.requests} requests ` +
            `(${fmtTokens(Math.round(billable / t.requests))} per request). ` +
            `That is the part a prompt cache cannot make cheaper.`,
        );
      }
      const anthropic = rows.some((r) => protocolFor(r.model) === "anthropic");
      if (anthropic && !t.cached && t.requests > 1) {
        hint(
          "Nothing came back cached. Either the host drops cache_control, or the prefix keeps changing" +
            (modelRejectsCache(app.session.model) ? " — this model rejected it and it is now off." : "."),
        );
      }
      if (t.reasoning > t.output * 0.5) {
        line();
        hint(
          "More than half the output is the model thinking. It is billed as output;" +
            " lower it with /effort medium or /effort low.",
        );
      }

      line();
    },
  },
  {
    name: "/stat",
    group: "session",
    help: () => t("usage by provider and model, with period filters", "расход по провайдерам и моделям, с фильтром по периоду"),
    async run(app) {
      /** Every stored request row; per-model rows keep their lastUsed. */
      const loadAll = (): ModelUsage[] => {
        const out: ModelUsage[] = [];
        let dir: string;
        try {
          dir = sessionsDir(app.cwd);
        } catch {
          return [];
        }
        for (const n of fs.readdirSync(dir)) {
          if (!n.endsWith(".json")) continue;
          try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
            for (const u of data.usage ?? []) out.push(u);
          } catch {
            /* skip corrupt files */
          }
        }
        // The live session's numbers are fresher than its last save: its rows
        // replace whatever the file on disk still holds.
        return out.filter((u) => !app.usage.all().some((l) => l.model === u.model)).concat(app.usage.all());
      };

      const PERIODS = [
        { value: "today" as const, label: "Today", key: "t" },
        { value: "week" as const, label: "Week", key: "w" },
        { value: "month" as const, label: "Month", key: "m" },
        { value: "all" as const, label: "All time", key: "a" },
      ];
      const sinceOf = (p: (typeof PERIODS)[number]["value"]): number => {
        if (p === "all") return 0;
        const d = new Date();
        if (p === "today") d.setHours(0, 0, 0, 0);
        else if (p === "week") d.setDate(d.getDate() - 7);
        else d.setDate(d.getDate() - 30);
        return d.getTime();
      };

      const all = loadAll();
      line();
      rule(c.brightCyan(" usage "));
      if (!all.length) {
        hint("No usage recorded yet.");
        line();
        return;
      }

      /** Folds raw per-session rows into one ModelUsage per model. */
      const fold = (rows: ModelUsage[]): Map<string, ModelUsage> => {
        const m = new Map<string, ModelUsage>();
        for (const u of rows) {
          const e = m.get(u.model) ?? { ...u };
          for (const k of ["requests", "input", "output", "cached", "reasoning", "costUsd"] as const) e[k] += u[k];
          e.priceUnknown = e.priceUnknown || u.priceUnknown;
          e.lastUsed = Math.max(e.lastUsed ?? 0, u.lastUsed ?? 0);
          m.set(u.model, e);
        }
        return m;
      };

      const totalsLine = (rows: Map<string, ModelUsage>): void => {
        let input = 0, output = 0, cached = 0, reasoning = 0, cost = 0, reqs = 0, unknown = false, models = 0;
        for (const u of rows.values()) {
          input += u.input; output += u.output; cached += u.cached;
          reasoning += u.reasoning ?? 0; cost += u.costUsd; reqs += u.requests;
          models++;
          unknown = unknown || u.priceUnknown;
        }
        const fresh = Math.max(0, input - cached);
        padded(
          `${c.gray("models")} ${String(models).padStart(4)}  ${c.gray("reqs")} ${String(reqs).padStart(5)}  ` +
            `${c.gray("↑")} ${fmtTokens(fresh)} ${c.gray(`(${cached && input ? Math.round((cached / input) * 100) : 0}% cached)`.padEnd(13))}` +
            `${c.gray("↓")} ${fmtTokens(output)}  ` +
            `${c.gray("cost")} ${c.bold(fmtCost(cost, unknown))}`,
        );
      };

      // Overview first: everything on record.
      totalsLine(fold(all));
      hint(t("input* is fresh tokens only, cache reads are in the cached column.", "input* — только чистые токены, чтения из кеша — в колонке cached."));

      const renderTable = (rows: Map<string, ModelUsage>): void => {
        const byProvider = new Map<string, ModelUsage[]>();
        for (const u of rows.values()) {
          const pid = splitModelId(u.model).providerId;
          (byProvider.get(pid) ?? byProvider.set(pid, []).get(pid)!).push(u);
        }
        const row =
          (label: string, u: { requests: number; input: number; cached: number; output: number; reasoning: number }) =>
            `${label.padEnd(32)} ${String(u.requests).padStart(5)} ${fmtTokens(Math.max(0, u.input - u.cached)).padStart(9)} ` +
            `${(u.cached ? fmtTokens(u.cached) : "—").padStart(9)} ${fmtTokens(u.output).padStart(9)} ` +
            `${(u.reasoning ? fmtTokens(u.reasoning) : "—").padStart(10)}`;
        const header =
          c.gray(`${"model".padEnd(32)} ${"reqs".padStart(5)} ${"input*".padStart(9)} ${"cached".padStart(9)} ${"output".padStart(9)} ${"reasoning".padStart(10)}`);
        for (const pid of [...byProvider.keys()].sort()) {
          line();
          padded(c.bold(c.brightBlue(providerLabel(pid))));
          padded(header);
          let cost = 0;
          let unknown = false;
          const list = byProvider.get(pid)!;
          for (const u of list) {
            padded(row(u.model.includes(":") ? u.model.slice(u.model.indexOf(":") + 1) : u.model, u));
            cost += u.costUsd;
            unknown = unknown || u.priceUnknown;
          }
          const sub = list.reduce(
            (a, u) => ({
              requests: a.requests + u.requests,
              input: a.input + u.input,
              cached: a.cached + u.cached,
              output: a.output + u.output,
              reasoning: a.reasoning + (u.reasoning ?? 0),
            }),
            { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
          );
          padded(c.gray("─".repeat(Math.min(80, contentWidth()))));
          padded(c.gray(row("subtotal", sub)) + c.gray(`   cost ${fmtCost(cost, unknown)}`));
        }
      };

      // Drill down: pick a period, then a provider. Esc keeps it closed.
      const period = await choose(PERIODS.map((p) => ({ ...p, label: p.label === "All time" ? t("All time", "Всё время") : p.value === "today" ? t("Today", "Сегодня") : p.value === "week" ? t("Week", "Неделя") : t("Month", "Месяц"), key: p.key })), {
        fallback: "all",
        initial: "all",
        cancel: () => {},
      });
      const since = sinceOf(period);

      const inPeriod = all.filter((u) => !u.lastUsed || u.lastUsed >= since);
      const folded = fold(inPeriod);
      if (!folded.size) {
        line();
        hint(t("No usage in this period.", "За этот период расхода нет."));
        line();
        return;
      }

      const providers = [...new Set([...folded.values()].map((u) => splitModelId(u.model).providerId))].sort();
      const provChoices = [
        ...(providers.length > 1
          ? [{ value: "__all__" as const, label: t("All providers", "Все провайдеры"), key: "A" }]
          : []),
        ...providers.map((pid) => ({ value: pid, label: providerLabel(pid), key: pid[0]?.toUpperCase() })),
      ];
      const picked = providers.length > 1
        ? await choose(provChoices, { fallback: "__all__", initial: "__all__", cancel: () => {} })
        : providers[0];

      line();
      const periodLabel = period === "today" ? t("today", "сегодня") : period === "week" ? t("last 7 days", "7 дней") : period === "month" ? t("last 30 days", "30 дней") : t("all time", "всё время");
      rule(c.brightCyan(` ${periodLabel} `));
      renderTable(
        picked === "__all__"
          ? folded
          : new Map([...folded].filter(([model]) => splitModelId(model).providerId === picked)),
      );
      line();
    },
  },
  {
    name: "/mcp",
    group: "session",
    args: () => "[reload]",
    help: () => t("MCP servers: status and tools", "MCP-серверы: статус и инструменты"),
    async run(app, rest) {
      if (rest.trim().toLowerCase() === "reload") {
        stopMcpServers();
        connectMcpServers(app.cwd, (client) => {
          app.rebuildTools();
          if (client.state === "ready") info(t(`MCP ${client.id}: ${client.tools.length} tools connected.`, `MCP ${client.id}: подключено инструментов: ${client.tools.length}.`));
          else warn(t(`MCP ${client.id} failed: ${client.detail}`, `MCP ${client.id} не подключился: ${client.detail}`));
        });
        app.rebuildTools();
        return info(t("Reconnecting MCP servers…", "Переподключаю MCP-серверы…"));
      }

      const clients = mcpClients();
      if (!clients.length) {
        info(t("No MCP servers configured.", "MCP-серверы не настроены."));
        hint(
          t(
            `Add one to ${configPath()} (or .trcode/mcp.json in the project):`,
            `Добавьте сервер в ${configPath()} (или .trcode/mcp.json проекта):`,
          ),
        );
        padded(c.dim(`  "mcpServers": { "tradingview": { "command": "npx", "args": ["-y", "<package>"] } }`));
        line();
        return;
      }

      line();
      rule(c.brightCyan(" mcp "));
      for (const cl of clients) {
        const state =
          cl.state === "ready"
            ? c.green("ready")
            : cl.state === "starting"
              ? c.yellow("starting")
              : c.red(cl.state);
        const extra =
          cl.state === "ready"
            ? c.gray(` · ${count(cl.tools.length, ["tool", "tools"], ["инструмент", "инструмента", "инструментов"])}${cl.detail ? ` · ${cl.detail}` : ""}`)
            : c.gray(cl.detail ? ` · ${truncate(cl.detail, 80)}` : "");
        padded(`${cl.id.padEnd(20)} ${state}${extra}`);
        if (cl.state === "ready" && cl.tools.length) {
          const names = cl.tools.map((t2) => t2.name);
          padded(c.dim("  " + truncate(names.join(", "), contentWidth() - 4)));
        }
      }
      const total = clients.reduce((n, cl) => n + (cl.state === "ready" ? cl.tools.length : 0), 0);
      if (total > 20) {
        hint(
          t(
            `${total} tool schemas ride along in every request. Trim a server with "tools": ["name", …] in its config.`,
            `Схемы всех ${total} инструментов едут в каждом запросе. Урежьте сервер через "tools": ["имя", …] в его конфиге.`,
          ),
        );
      }
      line();
    },
  },
  {
    name: "/reasoning",
    group: "session",
    help: () => t("show the last turn's full reasoning", "полные размышления последнего хода"),
    async run(app) {
      const text = app.lastReasoning.trim();
      if (!text) return info(t("The last turn had no reasoning to show.", "В последнем ходе не было размышлений."));
      line();
      rule(c.brightCyan(t(" reasoning ", " размышления ")));
      for (const l of text.split("\n")) {
        if (!l.trim()) {
          line();
          continue;
        }
        for (const w of wrapText(l, contentWidth() - 2)) padded(c.dim(w));
      }
      line();
    },
  },

  // ── settings ────────────────────────────────────────────────────────────
  {
    name: "/default",
    group: "settings",
    args: () => t("[name|alias]", "[имя|алиас]"),
    help: () => t("pin the default model", "закрепить модель по умолчанию"),
    async run(app, rest) {
      const cfg = loadConfig();
      const target = rest.trim() ? resolveModelId(rest.trim(), app.catalog) : app.session.model;
      if (target === cfg.model) return info(t(`The default model is already ${c.brightYellow(target)}.`, `Модель по умолчанию уже ${c.brightYellow(target)}.`));
      saveConfig({ model: target });
      app.cfg = loadConfig();
      app.session.model = target;
      app.rebuildTools();
      app.session.save();
      success(t(`Default model: ${c.brightYellow(target)}`, `Модель по умолчанию: ${c.brightYellow(target)}`));
      hint(`Written to ${configPath()}. Applies to this session too.`);
    },
  },
  {
    name: "/models",
    group: "settings",
    args: "[all]",
    help: () => t("catalog of the current provider, by vendor — `all` for every provider", "каталог текущего поставщика по вендорам — `all` для всех"),
    async run(app, rest) {
      const showAll = /^all$/i.test(rest.trim());
      const sp = new Spinner("fetching the model catalog");
      sp.start();
      app.catalog = await fetchModels({ force: true });
      sp.stop();
      app.rebuildTools();

      // Scoped like /model: the other providers cannot serve this session, so
      // listing them among the ones that can is a way to pick a 404.
      const provider = currentProviderId(app);
      const mine = providerModels(app, provider);
      const pool = showAll || !mine.length ? app.catalog : mine;
      const shown = pool;
      // The routing prefix is dropped: within one provider every row carries
      // the same one, and across providers the host gets its own column rather
      // than a repeated prefix in front of every name.
      const bare = (id: string) => splitModelId(id).model;
      const hosts = new Set(shown.map((m) => splitModelId(m.id).providerId));
      const width = Math.min(34, Math.max(12, ...shown.map((m) => bare(m.id).length + 1)));

      // Type first, vendor inside it — the same split the catalog tags models
      // with. Only the text section can serve a session, so it comes first and
      // the rest are named for what they are rather than hidden as a count.
      for (const type of groupByModality(shown)) {
        line();
        padded(c.bold(c.brightYellow(`[${type.label}]`)) + c.gray(`  ${type.models.length}`));
        for (const group of groupByVendor(type.models)) {
          line();
          padded(c.gray("──── ") + c.bold(c.brightBlue(group.vendor)) + c.gray(" " + "─".repeat(Math.max(2, 30 - group.vendor.length))));
          for (const m of group.models) {
            const cur = m.id === app.session.model ? c.brightCyan("❯ ") : "  ";
            const why = incompatibleReason(m);
            const ctxWin = m.contextWindow ? `ctx ${fmtTokens(m.contextWindow)}` : "";
            const host = hosts.size > 1 ? providerLabel(splitModelId(m.id).providerId) : "";
            const tail = why ? c.red(why) : "";
            padded(`${cur}${bare(m.id).padEnd(width)} ${c.gray(ctxWin.padEnd(11))} ${c.dim(host.padEnd(14))} ${tail}`);
          }
        }
      }

      line();
      const byType = groupByModality(shown)
        .map((g) => `${g.label}: ${g.models.length}`)
        .join(" · ");
      info(
        showAll
          ? `${shown.length} models, every provider — ${byType}`
          : `${shown.length} models at ${providerLabel(provider)} — ${byType}`,
      );
      const unusable = shown.length - usableModels(shown).length;
      if (unusable > 0) hint(`${unusable} of them cannot be driven from here — the reason is on the row`);
      if (!showAll && app.catalog.length > pool.length) {
        hint(`${app.catalog.length - pool.length} more at other providers — /models all · switch with /provider`);
      }
    },
  },
  {
    name: "/aliases",
    group: "settings",
    help: () => t("short names for models", "короткие имена моделей"),
    async run() {
      const cfg = loadConfig();
      line();
      for (const [k, v] of Object.entries(cfg.aliases)) padded(`${c.brightGreen(k.padEnd(10))} → ${v}`);
      line();
      hint(`Edit them in ${configPath()} → "aliases".`);
    },
  },
  {
    name: "/permissions",
    group: "settings",
    args: () => t("[class] [ask|allow|deny]", "[класс] [ask|allow|deny]"),
    help: () => t("confirmation rules", "правила подтверждений"),
    async run(_app, rest) {
      const cfg = loadConfig();
      const [risk, mode] = rest.trim().split(/\s+/);
      if (!risk) {
        line();
        for (const [k, v] of Object.entries(cfg.permissions)) {
          const color = v === "allow" ? c.green : v === "deny" ? c.red : c.yellow;
          padded(`${k.padEnd(10)} ${color(v)}`);
        }
        line();
        hint("Change with: /permissions shell allow");
        return;
      }
      if (!["read", "write", "shell", "network", "agent"].includes(risk)) return error(t(`Unknown class: ${risk}`, `Неизвестный класс: ${risk}`));
      if (!["ask", "allow", "deny"].includes(mode)) return error(t("Mode must be ask, allow or deny", "Режим должен быть ask, allow или deny"));
      saveConfig({ permissions: { ...cfg.permissions, [risk]: mode } as any });
      success(`${risk} → ${mode}`);
    },
  },
  {
    name: "/login",
    group: "settings",
    args: () => t("[provider] [url]", "[поставщик] [url]"),
    help: () => t("connect a provider — the one in use unless another is named", "подключить поставщика — текущего, если не указан другой"),
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      // A host can be given straight away — `/login alibabacloud https://…` —
      // for the providers whose endpoint is per-account.
      const baseUrl = parts.find((p) => /^https?:\/\//i.test(p));
      const name = (parts.find((p) => p !== baseUrl) ?? "").toLowerCase();
      // Unnamed means the provider being used: asking for a TokenRouter key
      // while the session runs on Kimi answers a question nobody asked.
      const def = name ? providerById(name) : providerById(currentProviderId(app));
      if (!def) {
        return error(t(`Unknown provider: ${name}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${name}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
      }

      // A third-party provider goes through the shared flow, which may need
      // the keyboard for a device code — hence exclusiveInput.
      if (def.id !== DEFAULT_PROVIDER) {
        const res = await loginProvider(def, { baseUrl, exclusive: (fn) => app.exclusiveInput(fn) });
        if (!res.connected) return;
        app.cfg = loadConfig();
        app.catalog = await fetchModels({ force: true });
        app.rebuildTools();
        return;
      }

      const key = await app.exclusiveInput(() => askSecret(`  ${def.keyHint}: `));
      if (!key) return warn(t("Cancelled.", "Отменено."));
      const cfg = loadConfig();
      const sp = new Spinner("verifying the key");
      sp.start();
      const check = await verifyKey(cfg.baseUrl, key);
      sp.stop();
      if (!check.ok) return error(t(`Key rejected: ${check.detail}`, `Ключ отклонён: ${check.detail}`));
      saveConfig({ apiKey: key });
      app.cfg = loadConfig();
      app.catalog = await fetchModels({ force: true });
      app.rebuildTools();
      success(t(`Key saved to ${configPath()} — ${check.detail}`, `Ключ сохранён в ${configPath()} — ${check.detail}`));
      if (providers().length > 1) {
        hint(`Other providers: ${providers().filter((p) => p.id !== DEFAULT_PROVIDER).map((p) => `/login ${p.id}`).join(", ")}`);
      }
    },
  },
  {
    name: "/config",
    group: "settings",
    help: () => t("current configuration", "текущая конфигурация"),
    async run(app) {
      const cfg = loadConfig();
      const shown = { ...cfg, apiKey: cfg.apiKey ? cfg.apiKey.slice(0, 6) + "…" + cfg.apiKey.slice(-4) : null };
      line();
      hint(configPath());
      for (const l of JSON.stringify(shown, null, 2).split("\n")) padded(c.dim(l));
      line();
      hint(`Directory: ${app.cwd}`);
    },
  },
  {
    name: "/cwd",
    group: "settings",
    args: () => t("[path]", "[путь]"),
    help: () => t("change the working directory", "сменить рабочий каталог"),
    async run(app, rest) {
      if (!rest.trim()) return info(app.cwd);
      const next = path.resolve(app.cwd, rest.trim());
      try {
        process.chdir(next);
      } catch (err) {
        return error(t(`Failed: ${(err as Error).message}`, `Не вышло: ${(err as Error).message}`));
      }
      app.cwd = next;
      app.readFiles.clear();
      app.reloadHistory();
      app.rebuildTools();
      // The workspace listing is snapshotted per directory; a new one is due.
      resetPromptSnapshots();
      success(t(`Working directory: ${next}`, `Рабочий каталог: ${next}`));
    },
  },

  // ── other ───────────────────────────────────────────────────────────────
  {
    name: "/keys",
    group: "other",
    help: () => t("show what the terminal sends; pin your own newline key", "показать, что шлёт терминал; закрепить свою клавишу переноса"),
    async run(app) {
      const seen = await app.exclusiveInput(() => scanKeys());
      line();
      if (!seen.length) {
        warn(t("The terminal sent nothing at all.", "Терминал не прислал вообще ничего."));
        hint("It most likely swallows those combinations as its own shortcuts — the CLI never sees them.");
        hint("Use Ctrl+Enter, Alt+Enter, or a trailing backslash instead.");
        return;
      }

      // Anything that is not already a newline key is a candidate to become one.
      const candidates = seen.filter(
        (k) => !k.meaning.startsWith("insert a newline") && k.raw !== "\r" && k.raw.length > 1,
      );
      if (!candidates.length) {
        success(t("Every key you pressed is already recognised.", "Все нажатые клавиши уже распознаются."));
        return;
      }

      const last = candidates[candidates.length - 1];
      const chosen = await app.exclusiveInput(() =>
        pick({
          title: "Pin this as a newline key?",
          items: [
            { value: last.raw, label: last.readable.padEnd(22), hint: c.gray(last.hex) },
            { value: "", label: "do not pin".padEnd(22), hint: "" },
          ],
        }),
      );
      if (!chosen) return;

      const cfg = loadConfig();
      const keys = [...new Set([...(cfg.newlineKeys ?? []), chosen])];
      saveConfig({ newlineKeys: keys });
      setExtraNewlineKeys(keys);
      app.cfg = loadConfig();
      success(t("Pinned — that combination now inserts a newline.", "Закреплено — это сочетание теперь переносит строку."));
      hint(`Written to ${configPath()} → "newlineKeys".`);
    },
  },
  {
    name: "/tools",
    group: "other",
    help: () => t("tools available to the model", "инструменты, доступные модели"),
    async run(app) {
      line();
      for (const t of app.toolList()) {
        const risk = t.risk === "shell" ? c.red(t.risk) : t.risk === "write" ? c.yellow(t.risk) : c.gray(t.risk);
        padded(`${c.bold(t.name.padEnd(10))} ${risk.padEnd(16)} ${c.dim(truncate(t.description, contentWidth() - 32))}`);
      }
      line();
    },
  },
  {
    name: "/skills",
    group: "other",
    args: () => t("[on | off | new <name> [description] | gen <task> | edit <name> | auto [on|off] | global]", "[on | off | new <имя> [описание] | gen <задача> | edit <имя> | auto [on|off] | global]"),
    help: () => t("skills: turn on/off, list, create, edit", "навыки: включить/выключить, список, создание, правка"),
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (sub === "on" || sub === "off") {
        app.cfg = saveConfig({ skillsEnabled: sub === "on" });
        app.rebuildTools();
        if (sub === "on") {
          success(t("Skills are on — the catalog and the skill tool join every request.", "Навыки включены — каталог и тулз skill добавляются в каждый запрос."));
          hint(t(`Off again with: /skills off.`, `Выключить обратно: /skills off.`));
        } else {
          success(t("Skills are off — they no longer cost tokens on requests.", "Навыки выключены — они больше не тратят токены в запросах."));
        }
        return;
      }

      if (sub === "new") {
        const global = parts.includes("global");
        const args = parts.slice(1).filter((p) => p !== "global");
        const name = args[0];
        if (!name) return error(t("Name it: /skills new code-review [description]", "Дайте имя: /skills new code-review [описание]"));
        const { file, existed } = createSkill({
          cwd: app.cwd,
          name,
          description: args.slice(1).join(" "),
          scope: global ? "user" : "project",
        });
        app.rebuildTools();
        if (existed) warn(t(`That skill already exists: ${file}`, `Такой навык уже есть: ${file}`));
        else success(t(`Created ${file}`, `Создан ${file}`));
        hint("Open the file and write the procedure. The description line is what matters:");
        hint("the model decides whether to load the skill from it.");
        hint(`Edit it with: /skills edit ${name}`);
        return;
      }

      if (sub === "edit") {
        const name = parts[1];
        const skill = app.skills.find((s) => s.name === name);
        if (!skill) return error(t(`Skill not found: ${name ?? "(no name given)"}`, `Навык не найден: ${name ?? "(имя не указано)"}`));
        const file = path.join(skill.dir, "SKILL.md");
        const editor = process.env.VISUAL || process.env.EDITOR;
        if (!editor) {
          info(file);
          hint("EDITOR is not set — open the file in your own editor.");
          return;
        }
        await app.exclusiveInput(
          () =>
            new Promise<void>((resolve) => {
              const child = spawn(editor, [file], { stdio: "inherit" });
              child.on("close", () => resolve());
              child.on("error", (err: Error) => {
                error(t(`Could not launch ${editor}: ${err.message}`, `Не удалось запустить ${editor}: ${err.message}`));
                resolve();
              });
            }),
        );
        app.rebuildTools();
        success(t("Skills reloaded.", "Навыки перечитаны."));
        return;
      }

      if (sub === "auto") {
        const want = parts[1]?.toLowerCase();
        if (want && !["on", "off"].includes(want)) return error(t("Use: /skills auto [on|off]", "Использование: /skills auto [on|off]"));
        if (want) {
          app.cfg = saveConfig({ skillAuto: want === "on" });
          success(t(`Skill auto-selection ${want}.`, `Автовыбор навыков: ${want}.`));
        } else {
          info(t(`Skill auto-selection is ${app.cfg.skillAuto === false ? "off" : "on"}.`, `Автовыбор навыков ${app.cfg.skillAuto === false ? "выключен" : "включён"}.`));
        }
        const withTriggers = app.skills.filter((s) => s.auto && s.triggers.length).length;
        hint(
          `${withTriggers} of ${app.skills.length} skills carry trigger words; the rest wait for the model to pick them.`,
        );
        hint(
          t(
            "Matching runs on the request and again at every step of a turn, so a procedure still arrives when the work turns towards it.",
            "Совпадение ищется и в запросе, и на каждом шаге хода — процедура успевает прийти, когда работа сворачивает к ней.",
          ),
        );
        return;
      }

      if (sub === "gen") {
        const task = parts.slice(1).join(" ");
        if (!task) return error(t("Describe the task: /skills gen review pull requests", "Опишите задачу: /skills gen ревью пул-реквестов"));
        await app.turn(
          `Write a trcode skill for this task: "${task}".\n\n` +
            `A skill is a folder .trcode/skills/<name>/SKILL.md with frontmatter:\n` +
            `---\nname: <short-name>\ndescription: <WHEN to apply it, one sentence>\n` +
            `triggers: <comma-separated words a user would type for this, in every language they work in>\n---\n\n` +
            `Study the repository first so the procedure rests on this project's real commands and files ` +
            `rather than generalities. The body is a concrete procedure, what not to do, and the answer format. ` +
            `Keep it under 50 lines. Create the file with write.`,
        );
        app.rebuildTools();
        return;
      }

      app.rebuildTools();
      if (!app.skills.length) {
        info(t("No skills yet.", "Навыков пока нет."));
        hint("Scaffold one: /skills new <name> [description]");
        hint("Or let the agent write it: /skills gen <task to automate>");
        return;
      }
      const enabled = app.cfg.skillsEnabled === true;
      line();
      const autoOn = app.cfg.skillAuto !== false;
      for (const s of app.skills) {
        const scope = s.scope === "project" ? c.brightGreen("project") : c.gray("global");
        const mark = enabled && autoOn && s.auto && s.triggers.length ? c.brightYellow("⚡") : " ";
        const loaded = enabled && app.loadedSkills.has(s.name) ? c.green(" ·loaded") : "";
        padded(
          `${mark} ${c.bold(s.name.padEnd(20))} ${scope.padEnd(20)}${loaded} ` +
            c.dim(truncate(s.description, contentWidth() - 50)),
        );
      }
      line();
      if (!enabled) {
        warn(t("Skills are off — they are not sent with requests.", "Навыки выключены — в запросы они не отправляются."));
        hint(t("Turn them on when you need them: /skills on", "Включить, когда понадобятся: /skills on"));
        return;
      }
      hint(
        `⚡ = fires by itself on its trigger words (auto-selection is ${autoOn ? "on" : "off"}: /skills auto ${autoOn ? "off" : "on"}).`,
      );
      hint("Anything else the model loads itself when the task matches the description.");
      hint("New: /skills new <name> · Edit: /skills edit <name> · Generate: /skills gen <task>");
      hint(t("Turn off to stop paying for them: /skills off", "Выключить, чтобы не платить за них: /skills off"));
    },
  },
  {
    name: "/memory",
    group: "other",
    args: () => t("[on | off | show]", "[on | off | показать]"),
    help: () => t("project memory: on/off, show what is remembered", "память проекта: вкл/выкл, что запомнено"),
    async run(app, rest) {
      const sub = rest.trim().toLowerCase();
      const file = memoryPath(app.cwd);
      const enabled = loadConfig().memoryEnabled !== false;

      if (sub === "on" || sub === "off") {
        app.cfg = saveConfig({ memoryEnabled: sub === "on" });
        app.rebuildTools();
        resetPromptSnapshots();
        if (sub === "on") {
          success(t("Project memory is on — facts go to .trcode/memory.md and ride in the prompt.", "Память проекта включена — факты пишутся в .trcode/memory.md и едут в промпте."));
          hint(t(`Off again with: /memory off`, `Выключить обратно: /memory off`));
        } else {
          success(t("Project memory is off — the section and the tool leave the session.", "Память проекта выключена — секция и тулз memory уходят из сессии."));
        }
        return;
      }

      if (sub === "show" || sub === "list") {
        const facts = memoryCount(app.cwd) ? fs.readFileSync(file, "utf8").trim() : "";
        if (!facts) return info(t("Memory is empty.", "Память пуста."));
        line();
        for (const l of renderMarkdownBlock(facts)) padded(l);
        return;
      }

      // Bare `/memory` is a settings screen: state, where the file lives,
      // and a button row — the way it is reached most often.
      line();
      padded(c.bold(t("Project memory", "Память проекта")));
      info(
        enabled
          ? t("On — remembered facts join every request.", "Включена — запомненные факты добавляются к каждому запросу.")
          : t("Off — nothing is remembered or shown.", "Выключена — ничего не запоминается и не показывается."),
      );
      hint(`${file} · ${t("facts:", "фактов:")} ${memoryCount(app.cwd)}`);
      hint(t("The agent saves durable project facts there itself (the memory tool).", "Агент сам записывает туда прочные факты о проекте (тулз memory)."));
      if (!process.stdin.isTTY) return hint(t("Toggle with: /memory on | /memory off", "Переключить: /memory on | /memory off"));

      const answer = await app.exclusiveInput(() =>
        choose<"toggle" | "show">(
          [
            {
              value: "toggle",
              label: enabled ? t("Turn off", "Выключить") : t("Turn on", "Включить"),
              key: "o",
              tone: enabled ? "warn" : "ok",
            },
            { value: "show", label: t("Show", "Показать"), key: "s" },
          ],
          { initial: "toggle", fallback: "toggle", hint: t("←/→ · Enter to confirm", "←/→ · Enter — подтвердить") },
        ),
      );
      if (answer === "toggle") return this.run(app, enabled ? "off" : "on");
      if (answer === "show") return this.run(app, "show");
    },
  },
  {
    name: "/todo",
    group: "other",
    help: () => t("current plan", "текущий план"),
    async run(app) {
      line();
      line(app.todo.render());
      line();
    },
  },
  {
    name: "/init",
    group: "other",
    help: () => t("write AGENTS.md from the repository", "написать AGENTS.md по репозиторию"),
    async run(app) {
      await app.turn(
        "Study this repository and write AGENTS.md at its root — a short briefing for an agent working here. " +
          "Cover: what the project is, the stack, the directory layout, the build/test/lint commands (taken from real files, not invented), " +
          "and the conventions the code follows. Write densely, no filler, under 60 lines. If AGENTS.md already exists, update it.",
      );
    },
  },
  {
    name: "/clear",
    group: "other",
    help: () => t("clear the screen", "очистить экран"),
    async run(app) {
      app.repaintHeader();
    },
  },
  {
    name: "/version",
    group: "other",
    help: () => t("version", "версия"),
    async run() {
      info(`trcode ${VERSION} · node ${process.version} · ${process.platform}`);
    },
  },
  {
    name: "/help",
    group: "other",
    help: () => t("full help", "полная справка"),
    async run() {
      line();
      rule(c.brightCyan(" commands "));
      for (const g of GROUP_ORDER) {
        const inGroup = COMMANDS.filter((cmd) => cmd.group === g);
        if (!inGroup.length) continue;
        line();
        padded(c.bold(c.brightBlue(g.toUpperCase())));
        for (const cmd of inGroup) {
          const label = `${cmd.name}${cmd.args ? " " + txt(cmd.args) : ""}`;
          padded(`  ${c.bold(label.padEnd(34))} ${c.gray(txt(cmd.help))}`);
        }
      }
      line();
      hint("Plain text is a task for the agent.");
      hint("Shift+Tab turns confirmations off and on again.");
      hint("Ctrl+Enter inserts a newline (so does a trailing backslash).");
      hint("Esc interrupts the current turn. Ctrl+C exits.");
      line();
    },
  },
  {
    name: "/exit",
    group: "other",
    help: () => t("exit", "выход"),
    async run() {
      return false;
    },
  },
];

const ALIASES: Record<string, string> = {
  "/quit": "/exit",
  "/q": "/exit",
  "/?": "/help",
  "/h": "/help",
  "/orch": "/orchestrate",
  // The word is spelled one way and typed another. A command nobody can hit
  // first time is a command with a tax on it.
  "/promt": "/prompt",
  "/promt_model": "/prompt_model",
  "/promptmodel": "/prompt_model",
  "/promtmodel": "/prompt_model",
};

export function commandNames(): string[] {
  return [...COMMANDS.map((cmd) => cmd.name), ...Object.keys(ALIASES)].sort();
}

/**
 * Rows for the editor dropdown. Opens on a leading "/" and stays open only
 * while the first word is still being typed.
 */
export function commandSuggestions(buffer: string): { value: string; hint: string }[] {
  if (!buffer.startsWith("/")) return [];
  if (/\s/.test(buffer)) return [];
  const q = buffer.toLowerCase();
  const ordered = GROUP_ORDER.flatMap((g) => COMMANDS.filter((cmd) => cmd.group === g));
  return ordered
    .filter((cmd) => cmd.name.startsWith(q))
    .map((cmd) => ({ value: cmd.name, hint: cmd.args ? `${txt(cmd.args)}  —  ${txt(cmd.help)}` : txt(cmd.help) }));
}

export function isCommand(text: string): boolean {
  return text.startsWith("/");
}

/** Compact grouped listing shown when the user types just "/". */
export function printCommandIndex(): void {
  line();
  padded(c.bold(t("Commands", "Команды")) + c.gray(t("   /help for details", "   /help — подробно")));
  for (const g of GROUP_ORDER) {
    const names = COMMANDS.filter((cmd) => cmd.group === g).map((cmd) => cmd.name);
    if (!names.length) continue;
    padded(c.gray(groupLabel(g).padEnd(11)) + names.map((n) => c.brightCyan(n)).join(c.gray(" · ")));
  }
  line();
}

/** Returns false when the REPL should exit. */
export async function runCommand(app: App, text: string): Promise<boolean> {
  if (text.trim() === "/") {
    printCommandIndex();
    return true;
  }
  const space = text.indexOf(" ");
  const rawName = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : text.slice(space + 1);
  const name = ALIASES[rawName] ?? rawName;

  const cmd = COMMANDS.find((x) => x.name === name);
  if (!cmd) {
    const near = commandNames().filter((n) => n.startsWith(rawName.slice(0, 3)));
    error(t(`Unknown command ${rawName}${near.length ? ` — did you mean: ${near.join(", ")}` : ""}`, `Неизвестная команда ${rawName}${near.length ? ` — возможно: ${near.join(", ")}` : ""}`));
    return true;
  }
  const res = await cmd.run(app, rest);
  return res !== false;
}
