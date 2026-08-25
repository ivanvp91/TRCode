/** Slash commands, grouped from everyday to occasional. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { c } from "./ansi.js";
import { contentWidth, fmtAgo } from "./layout.js";
import { error, expandedBlock, hint, info, line, padded, plural, renderMarkdownBlock, rule, Spinner, success, truncate, warn, wrapText } from "./render.js";
import { openModal, pick, pickMulti, type ModalAction, type ModalResult, type PickerItem } from "./picker.js";
import { choose, type Choice } from "./choice.js";
import { openModelModal, openModelsModal, pickModelsAcrossProviders } from "./modelpicker.js";
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
  incompatibleReason,
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
import { loadProjections } from "../session/projection.js";
import { pushConsumer } from "./stdin.js";
import { dropStore, forgetFrom, listCheckpoints, rewindFiles, type Checkpoint } from "../session/checkpoint.js";
import { collapsedCount, collapsedText } from "./paste.js";
import { dropSessionHistory } from "../session/history.js";
import { fmtTokens, fmtCost, historyTokens, estimateTokens, dayKey } from "../usage.js";
import type { ModelUsage } from "../usage.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { runSwarm } from "../agent/swarm.js";
import { runOrchestration } from "../agent/orchestrator.js";
import { createSkill } from "../skills/loader.js";
import { memoryPath, memoryCount } from "../tools/memory.js";
import { resetPromptSnapshots } from "../agent/prompt.js";
import { connectMcpServers, mcpClients, stopMcpServers } from "../mcp/client.js";
import { t, count } from "../i18n.js";
import { listEntries, getEntry, deleteEntry, type UiEntry } from "../ui-library/store.js";
import { matchLibrary } from "../ui-library/match.js";
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

/**
 * Re-reads the catalogue from the provider, cache and all bypassed. This is
 * what `/models` used to be good for; the list itself is now the panel, so the
 * only part worth keeping is the refresh, and it lives on a button.
 */
async function refreshCatalog(app: App, opts: { quiet?: boolean } = {}): Promise<void> {
  const before = app.catalog.length;
  const sp = new Spinner(t("refreshing the model catalog", "обновляю каталог моделей"));
  sp.start();
  try {
    app.catalog = await fetchModels({ force: true });
  } finally {
    sp.stop();
  }
  app.rebuildTools();
  if (opts.quiet) return;
  const delta = app.catalog.length - before;
  const change = delta ? ` (${delta > 0 ? "+" : ""}${delta})` : "";
  success(
    t(
      `Catalog refreshed: ${app.catalog.length} models${change}.`,
      `Каталог обновлён: ${count(app.catalog.length, ["model", "models"], ["модель", "модели", "моделей"])}${change}.`,
    ),
  );
}

/** Pins the default provider — what a new session opens on. */
function setDefaultProvider(app: App, def: ProviderDef): void {
  if (!modeFor(def.id)) {
    return error(t(`${def.label} is not connected — /provider ${def.id} connects it.`, `${def.label} не подключён — подключит /provider ${def.id}.`));
  }
  // The remembered model is what a new session will open on, so pin the
  // current one when defaulting to the provider we are already using.
  if (def.id === currentProviderId(app)) rememberCurrent(app);
  saveConfig({ defaultProvider: def.id });
  app.cfg = loadConfig();
  success(t(`Default provider: ${c.brightYellow(def.label)}`, `Поставщик по умолчанию: ${c.brightYellow(def.label)}`));
  hint(t(`New sessions start on ${providerState(def.id).model ?? defaultModelFor(app, def.id) ?? loadConfig().model}.`, `Новые сессии будут открываться на ${providerState(def.id).model ?? defaultModelFor(app, def.id) ?? loadConfig().model}.`));
}

/**
 * Points a provider at another host. The credential is untouched: the host a
 * key belongs to is not always the one a provider defaults to, and getting it
 * wrong is reported as a rejected key rather than as a wrong address.
 */
async function setProviderHost(app: App, def: ProviderDef, given?: string): Promise<void> {
  if (def.id === DEFAULT_PROVIDER) {
    return error(t("TokenRouter's host lives in the config: baseUrl.", "Хост TokenRouter задаётся в конфиге: baseUrl."));
  }
  const url = given ?? (await chooseHost(def, (fn) => app.exclusiveInput(fn)));
  if (url === null) return;
  if (url) rememberBaseUrl(def.id, url);
  app.cfg = loadConfig();
  await refreshCatalog(app, { quiet: true });
  const now = modeConfig(def.id, "apikey")?.baseUrl;
  success(t(`${def.label} host: ${now}`, `Сервер ${def.label}: ${now}`));
  if (modeFor(def.id)) hint(t(`The key stays as it is — /login ${def.id} replaces it.`, `Ключ остаётся прежним — заменить: /login ${def.id}.`));
}

/** Drops a provider's credential, and the session's model with it if need be. */
async function logoutFromProvider(app: App, def: ProviderDef): Promise<void> {
  if (def.id === DEFAULT_PROVIDER) return error(t("Remove the TokenRouter key with: trc auth logout", "Ключ TokenRouter удаляется так: trc auth logout"));
  if (!clearCredentials(def.id)) return warn(t(`${def.label} was not connected.`, `${def.label} не был подключён.`));
  await refreshCatalog(app, { quiet: true });
  success(t(`${def.label} disconnected.`, `${def.label} отключён.`));
  // The session was talking to it; leaving the model in place would only
  // produce a 401 on the next turn.
  if (currentProviderId(app) === def.id) {
    app.session.model = loadConfig().model;
    app.session.save();
    app.rebuildTools();
    info(t(`Model: ${app.session.model}`, `Модель: ${app.session.model}`));
  }
}

/**
 * The model panel. A button changes what the list is scoped to and the panel
 * comes straight back, so widening to every provider or re-reading the
 * catalogue never costs a re-typed command.
 */
async function modelModal(app: App, opts: { all?: boolean } = {}): Promise<void> {
  let all = opts.all === true;
  for (;;) {
    const cfg = loadConfig();
    const provider = currentProviderId(app);
    const label = providerById(provider)?.label ?? provider;
    const mine = providerModels(app, provider);
    // Scoped to the provider in use: the other providers' models cannot be
    // served by it, and listing them only invites a 404.
    const scoped = all || !mine.length ? app.catalog : mine;

    const res = await app.exclusiveInput(() =>
      openModelModal({
        catalog: scoped,
        current: app.session.model,
        defaultModel: cfg.model,
        title: t("Model", "Модель"),
        subtitle: t(
          `${all ? "Every provider" : label} · ${scoped.length} models · ★ default · ● in use`,
          `${all ? "Все поставщики" : label} · ${scoped.length} · ★ по умолчанию · ● текущая`,
        ),
        actions: [
          { id: "refresh", label: t("Refresh", "Обновить"), hotkey: "r" },
          all
            ? { id: "scope", label: t(`Only ${label}`, `Только ${label}`), hotkey: "o" }
            : { id: "scope", label: t("All providers", "Все поставщики"), hotkey: "a" },
          { id: "default", label: t("Make default", "По умолчанию"), hotkey: "d" },
          { id: "provider", label: t("Provider…", "Поставщик…"), hotkey: "p" },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "action") {
      if (res.id === "refresh") {
        await refreshCatalog(app);
        continue;
      }
      if (res.id === "scope") {
        all = !all;
        continue;
      }
      if (res.id === "provider") {
        await providerModal(app);
        continue;
      }
      if (res.id === "default") {
        if (!res.value) continue;
        saveConfig({ model: res.value });
        app.cfg = loadConfig();
        setModel(app, res.value);
        warnIfIncompatible(app, res.value);
        success(t(`Default model: ${c.brightYellow(res.value)}`, `Модель по умолчанию: ${c.brightYellow(res.value)}`));
        hint(t(`Written to ${configPath()}. Applies to this session too.`, `Записано в ${configPath()}. Действует и в этой сессии.`));
        return;
      }
      continue;
    }

    setModel(app, res.value);
    warnIfIncompatible(app, res.value);
    const aliasFor = Object.entries(cfg.aliases).find(([, v]) => v === res.value)?.[0];
    if (aliasFor) hint(t(`alias: /model ${aliasFor}`, `алиас: /model ${aliasFor}`));
    if (res.value !== cfg.model) hint(t("make it the default: /default", "сделать моделью по умолчанию: /default"));
    return;
  }
}

/** The provider panel: connect, switch, re-point or disconnect, all in place. */
async function providerModal(app: App): Promise<void> {
  for (;;) {
    const cfg = loadConfig();
    const here = currentProviderId(app);
    const def = providerById(cfg.defaultProvider ?? DEFAULT_PROVIDER);
    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("Provider", "Поставщик"),
        subtitle: t(
          `In use: ${providerLabel(here)} · default: ${def?.label ?? "—"} · Enter switches this session`,
          `Сейчас: ${providerLabel(here)} · по умолчанию: ${def?.label ?? "—"} · Enter переключит сессию`,
        ),
        items: providerItems(app),
        initial: here,
        search: false,
        actions: [
          { id: "default", label: t("Make default", "По умолчанию"), hotkey: "d" },
          { id: "host", label: t("Host…", "Сервер…"), hotkey: "h" },
          { id: "refresh", label: t("Refresh models", "Обновить модели"), hotkey: "r" },
          { id: "logout", label: t("Disconnect", "Отключить"), hotkey: "x", tone: "danger" },
        ],
      }),
    );
    if (!res) return;

    const target = res.value ? providerById(res.value) : undefined;
    if (res.kind === "action") {
      if (res.id === "refresh") {
        await refreshCatalog(app);
        continue;
      }
      if (!target) continue;
      if (res.id === "default") setDefaultProvider(app, target);
      else if (res.id === "host") await setProviderHost(app, target);
      else if (res.id === "logout") await logoutFromProvider(app, target);
      continue;
    }

    if (target) await switchToProvider(app, target);
    return;
  }
}


// ── /brain ────────────────────────────────────────────────────────────────

/** The panel as it stands, minus anything this client can no longer reach. */
function brainPanel(app: App): string[] {
  return loadConfig().brainModels.filter((m) => app.catalog.some((x) => x.id === m));
}

function brainNeedsPanel(): void {
  error(
    t(
      "A panel needs at least two models that this client can reach.",
      "Совету нужны хотя бы две модели, доступные этому клиенту.",
    ),
  );
  hint(t("Choose them with /brain models", "Выбрать: /brain models"));
}

/** Who sits on the panel — one multi-select spanning every connected host. */
async function brainPanelModal(app: App): Promise<void> {
  const cfg = loadConfig();
  const picked = await app.exclusiveInput(() =>
    pickModelsAcrossProviders({
      catalog: app.catalog,
      current: app.session.model,
      defaultModel: app.session.model,
      selected: cfg.brainModels,
      allowEmpty: true,
      title: t("Panel for /brain", "Совет моделей для /brain"),
      subtitle: t(
        "Space marks a model, ←→ switches provider, Enter confirms. Two or three is a panel; more is mostly repetition.",
        "Пробел отмечает модель, ←→ переключает поставщика, Enter подтверждает. Двух-трёх достаточно; дальше — повторы.",
      ),
    }),
  );
  if (picked === null) return;
  saveConfig({ brainModels: picked }, { replace: ["brainModels"] });
  app.cfg = loadConfig();
  if (!picked.length) return void success(t("Panel cleared.", "Совет очищен."));
  success(t(`Panel: ${picked.map(wireModelId).join(", ")}`, `Совет: ${picked.map(wireModelId).join(", ")}`));
}

/** The panel as it stands, and the question to put to it. */
async function brainModal(app: App): Promise<void> {
  for (;;) {
    const configured = loadConfig().brainModels;
    const reachable = brainPanel(app);
    const items: PickerItem[] = configured.map((id) => ({
      value: id,
      label: wireModelId(id).padEnd(28),
      hint: reachable.includes(id)
        ? c.dim(providerLabel(splitModelId(id).providerId))
        : c.red(t("not reachable from here", "отсюда недоступна")),
    }));

    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("Brain", "Совет моделей"),
        subtitle: t(
          "They answer separately, read each other, and one writes the result. Enter puts a question to them.",
          "Они отвечают порознь, читают друг друга, одна сводит итог. Enter — задать им вопрос.",
        ),
        items,
        search: false,
        empty: t("No panel yet — choose the models first.", "Совета пока нет — сначала выберите модели."),
        actions: [
          { id: "ask", label: t("Ask…", "Спросить…"), hotkey: "a", disabled: reachable.length < 2 },
          { id: "models", label: t("Choose models…", "Выбрать модели…"), hotkey: "c" },
          {
            id: "clear",
            label: t("Clear", "Очистить"),
            hotkey: "x",
            tone: "danger",
            disabled: !configured.length,
          },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "action") {
      if (res.id === "models") {
        await brainPanelModal(app);
        continue;
      }
      if (res.id === "clear") {
        saveConfig({ brainModels: [] }, { replace: ["brainModels"] });
        app.cfg = loadConfig();
        success(t("Panel cleared.", "Совет очищен."));
        continue;
      }
    }

    // "Ask", and Enter on a row, are the same thing: the panel answers as a
    // panel, so which row the cursor was on never mattered.
    const panel = brainPanel(app);
    if (panel.length < 2) {
      brainNeedsPanel();
      return;
    }
    const question = await app.exclusiveInput(() => askLine(t("The question:", "Вопрос:"), ""));
    if (!question) return;
    await app.runBrain(question, panel);
    return;
  }
}

// ── /subagents ────────────────────────────────────────────────────────────

/** Only what this key can actually launch a subagent on — the tool's own rule. */
function subagentPool(app: App, providerId: string) {
  return providerModels(app, providerId).filter((m) => m.chatCapable !== false && servesModality(m, "text"));
}

function noSubagentModels(providerId: string): void {
  error(
    t(
      `${providerLabel(providerId)} has no model a subagent could run on.`,
      `У ${providerLabel(providerId)} нет моделей для субагентов.`,
    ),
  );
}

/** Puts one more model on the list without walking the whole catalogue. */
function addSubagentModel(app: App, named: string): void {
  const provider = currentProviderId(app);
  const pool = subagentPool(app, provider);
  if (!pool.length) return noSubagentModels(provider);

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
  const current = loadConfig().subagentModels?.[provider] ?? [];
  saveConfig({ subagentModels: { [provider]: [...new Set([...current, added])] } });
  app.cfg = loadConfig();
  app.rebuildTools();
  success(
    t(
      `${providerLabel(provider)}: subagents also run on ${wireModelId(added)}.`,
      `${providerLabel(provider)}: субагенты работают также на ${wireModelId(added)}.`,
    ),
  );
}

function resetSubagentModels(app: App): void {
  const provider = currentProviderId(app);
  const next = { ...loadConfig().subagentModels };
  delete next[provider];
  saveConfig({ subagentModels: next }, { replace: ["subagentModels"] });
  app.cfg = loadConfig();
  app.rebuildTools();
  success(
    t(
      `${providerLabel(provider)}: subagents run on the session's model only.`,
      `${providerLabel(provider)}: субагенты работают только на модели сессии.`,
    ),
  );
}

async function subagentsModal(app: App): Promise<void> {
  for (;;) {
    const provider = currentProviderId(app);
    const pool = subagentPool(app, provider);
    if (!pool.length) return noSubagentModels(provider);
    const current = loadConfig().subagentModels?.[provider] ?? [];

    const res = await app.exclusiveInput(() =>
      openModelsModal({
        catalog: pool,
        current: app.session.model,
        defaultModel: app.session.model,
        selected: current,
        allowEmpty: true,
        title: t("Models for subagents", "Модели для субагентов"),
        subtitle: t(
          `${providerLabel(provider)} · Space marks a model, Enter confirms. Nothing marked — the session's model only.`,
          `${providerLabel(provider)} · Пробел отмечает модель, Enter подтверждает. Ничего не отмечено — только модель сессии.`,
        ),
        actions: [
          { id: "auto", label: t("Session model only", "Только модель сессии"), hotkey: "a" },
          { id: "refresh", label: t("Refresh", "Обновить"), hotkey: "r" },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "action") {
      if (res.id === "auto") return resetSubagentModels(app);
      if (res.id === "refresh") {
        await refreshCatalog(app);
        continue;
      }
      continue;
    }

    saveConfig({ subagentModels: { [provider]: res.values } });
    app.cfg = loadConfig();
    app.rebuildTools();
    if (!res.values.length) {
      return void success(
        t(`${providerLabel(provider)}: the session's model only.`, `${providerLabel(provider)}: только модель сессии.`),
      );
    }
    return void success(
      t(
        `Subagents on ${providerLabel(provider)}: ${res.values.map(wireModelId).join(", ")}`,
        `Субагенты у ${providerLabel(provider)}: ${res.values.map(wireModelId).join(", ")}`,
      ),
    );
  }
}

// ── /skills ───────────────────────────────────────────────────────────────

/** Opens a file in the user's editor, or names it when there is none set. */
async function openInEditor(app: App, file: string): Promise<boolean> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    info(file);
    hint(t("EDITOR is not set — open the file in your own editor.", "EDITOR не задан — откройте файл своим редактором."));
    return false;
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
  return true;
}

function setSkillsEnabled(app: App, on: boolean): void {
  app.cfg = saveConfig({ skillsEnabled: on });
  app.rebuildTools();
  if (on) {
    success(
      t(
        "Skills are on — the catalog and the skill tool join every request.",
        "Навыки включены — каталог и тулз skill добавляются в каждый запрос.",
      ),
    );
  } else {
    success(
      t(
        "Skills are off — they no longer cost tokens on requests.",
        "Навыки выключены — они больше не тратят токены в запросах.",
      ),
    );
  }
}

async function editSkill(app: App, name: string | null): Promise<boolean> {
  const skill = app.skills.find((s) => s.name === name);
  if (!skill) {
    error(t(`Skill not found: ${name ?? "(no name given)"}`, `Навык не найден: ${name ?? "(имя не указано)"}`));
    return false;
  }
  const opened = await openInEditor(app, path.join(skill.dir, "SKILL.md"));
  app.rebuildTools();
  if (opened) success(t("Skills reloaded.", "Навыки перечитаны."));
  return opened;
}

/** The brief the agent is handed when it writes a skill for a task. */
function skillGenPrompt(task: string): string {
  return (
    `Write a trcode skill for this task: "${task}".\n\n` +
    `A skill is a folder .trcode/skills/<name>/SKILL.md with frontmatter:\n` +
    `---\nname: <short-name>\ndescription: <WHEN to apply it, one sentence>\n` +
    `triggers: <comma-separated words a user would type for this, in every language they work in>\n---\n\n` +
    `Study the repository first so the procedure rests on this project's real commands and files ` +
    `rather than generalities. The body is a concrete procedure, what not to do, and the answer format. ` +
    `Keep it under 50 lines. Create the file with write.`
  );
}

async function skillsModal(app: App): Promise<void> {
  for (;;) {
    app.rebuildTools();
    const cfg = loadConfig();
    const enabled = cfg.skillsEnabled === true;
    const autoOn = cfg.skillAuto !== false;
    const withTriggers = app.skills.filter((s) => s.auto && s.triggers.length).length;

    const items: PickerItem[] = app.skills.map((s) => ({
      value: s.name,
      label:
        (enabled && autoOn && s.auto && s.triggers.length ? c.brightYellow("⚡ ") : "  ") + s.name.padEnd(22),
      hint:
        (s.scope === "project" ? c.brightGreen("project") : c.gray("global")) +
        (enabled && app.loadedSkills.has(s.name) ? c.green(" ·loaded") : ""),
      badge: truncate(s.description, Math.max(20, contentWidth() - 58)),
    }));

    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("Skills", "Навыки"),
        subtitle: enabled
          ? t(
              `On · ${withTriggers} of ${app.skills.length} fire on their own trigger words (⚡, auto-selection ${autoOn ? "on" : "off"}) · Enter edits`,
              `Включены · ${withTriggers} из ${app.skills.length} срабатывают по своим словам (⚡, автовыбор ${autoOn ? "вкл" : "выкл"}) · Enter — правка`,
            )
          : t(
              "Off — nothing about them is sent with requests, so they cost nothing.",
              "Выключены — в запросы ничего не отправляется, и они ничего не стоят.",
            ),
        items,
        empty: t("No skills yet — create one, or let the agent write it.", "Навыков пока нет — создайте или попросите агента."),
        actions: [
          {
            id: "toggle",
            label: enabled ? t("Turn off", "Выключить") : t("Turn on", "Включить"),
            hotkey: "t",
            tone: enabled ? "warn" : "ok",
          },
          {
            id: "auto",
            label: autoOn ? t("Auto-select off", "Автовыбор выкл") : t("Auto-select on", "Автовыбор вкл"),
            hotkey: "u",
            disabled: !enabled,
          },
          { id: "new", label: t("New…", "Создать…"), hotkey: "n" },
          { id: "edit", label: t("Edit", "Править"), hotkey: "e", disabled: !app.skills.length },
          { id: "gen", label: t("Generate…", "Сгенерировать…"), hotkey: "g" },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "item") {
      await editSkill(app, res.value);
      continue;
    }

    if (res.id === "toggle") {
      setSkillsEnabled(app, !enabled);
      continue;
    }
    if (res.id === "auto") {
      app.cfg = saveConfig({ skillAuto: !autoOn });
      success(t(`Skill auto-selection ${!autoOn ? "on" : "off"}.`, `Автовыбор навыков: ${!autoOn ? "вкл" : "выкл"}.`));
      continue;
    }
    if (res.id === "edit") {
      await editSkill(app, res.value);
      continue;
    }
    if (res.id === "new") {
      const name = await app.exclusiveInput(() => askLine(t("Name:", "Имя:"), ""));
      if (!name) continue;
      const description = (await app.exclusiveInput(() => askLine(t("When to apply it:", "Когда применять:"), ""))) ?? "";
      const { file, existed } = createSkill({ cwd: app.cwd, name: name.trim(), description, scope: "project" });
      app.rebuildTools();
      if (existed) warn(t(`That skill already exists: ${file}`, `Такой навык уже есть: ${file}`));
      else success(t(`Created ${file}`, `Создан ${file}`));
      hint(
        t(
          "The description line is what matters: the model decides whether to load the skill from it.",
          "Главная строка — описание: по нему модель решает, загружать ли навык.",
        ),
      );
      continue;
    }
    if (res.id === "gen") {
      const task = await app.exclusiveInput(() => askLine(t("The task to automate:", "Задача для автоматизации:"), ""));
      if (!task) continue;
      await app.turn(skillGenPrompt(task));
      app.rebuildTools();
      return;
    }
  }
}


// ── /stat ─────────────────────────────────────────────────────────────────

const STAT_PERIODS = [
  { key: "today", label: () => t("Today", "Сегодня") },
  { key: "week", label: () => t("Week", "Неделя") },
  { key: "month", label: () => t("Month", "Месяц") },
  { key: "all", label: () => t("All time", "Всё время") },
] as const;

type StatPeriod = (typeof STAT_PERIODS)[number]["key"];

function statSince(p: StatPeriod): number {
  if (p === "all") return 0;
  const d = new Date();
  if (p === "today") d.setHours(0, 0, 0, 0);
  else if (p === "week") d.setDate(d.getDate() - 7);
  else d.setDate(d.getDate() - 30);
  return d.getTime();
}

/**
 * The first local day that still belongs to the period, as a daily-bucket key.
 * Calendar days, not rolling 24h windows: a bucket holds a whole day, and
 * slicing one would need timestamps it does not store.
 */
function statDayCutoff(p: StatPeriod): string {
  const back = p === "today" ? 0 : p === "week" ? 6 : 29;
  const d = new Date();
  d.setDate(d.getDate() - back);
  return dayKey(d.getTime());
}

/**
 * The share of one row that falls inside the period.
 *
 * A row is a whole session's aggregate, so lastUsed alone cannot say which
 * part of it belongs to "today": a session that ran for a month and made its
 * last request this morning used to show its entire month under Today.
 * Daily buckets give the true share. A row recorded before daily accounting
 * existed falls back to the session file's own date — closer than lastUsed,
 * which is only when the session was last touched.
 */
export function periodSlice(u: ModelUsage, p: StatPeriod): ModelUsage | null {
  if (p === "all") return u;
  if (!u.daily) {
    const cutoff = statDayCutoff(p);
    // The session id opens with YYYYMMDD — the day the session was created,
    // which is the best a legacy row can be dated by.
    const created = sessionDayOf(u);
    if (created) return created >= cutoff ? u : null;
    return !u.lastUsed || u.lastUsed >= statSince(p) ? u : null;
  }
  const cutoff = statDayCutoff(p);
  let requests = 0, input = 0, output = 0, cached = 0, reasoning = 0, costUsd = 0;
  let hit = false;
  for (const [k, d] of Object.entries(u.daily)) {
    if (k < cutoff) continue;
    hit = true;
    requests += d.requests;
    input += d.input;
    output += d.output;
    cached += d.cached;
    reasoning += d.reasoning ?? 0;
    costUsd += d.costUsd;
  }
  if (!hit) return null;
  return { model: u.model, requests, input, output, cached, reasoning, costUsd, priceUnknown: u.priceUnknown, lastUsed: u.lastUsed };
}

/** Every stored request row; the live session's rows replace what is on disk. */
function loadUsageRows(app: App): ModelUsage[] {
  const out: ModelUsage[] = [];
  let dir: string;
  try {
    dir = sessionsDir(app.cwd);
  } catch {
    return [];
  }
  // Skip the live session's own file, not every file that shares a model with
  // it: dropping rows by model threw away other sessions' history — and with
  // it most of the period totals — whenever the running model was reused.
  const liveFile = `${app.session.id}.json`;
  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith(".json") || n === liveFile) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      for (const u of data.usage ?? []) out.push({ ...u, sessionFile: n });    } catch {
      /* skip corrupt files */
    }
  }
  for (const u of app.usage.all()) out.push({ ...u, sessionFile: `${app.session.id}.json` });
  return out;
}

/** The YYYY-MM-DD a stored row's session was created, from its file name. */
function sessionDayOf(u: ModelUsage & { sessionFile?: string }): string {
  const stem = (u.sessionFile ?? "").slice(0, 12);
  if (!/^\d{8}-/.test(stem)) return "";
  return `${stem.slice(0, 4)}-${stem.slice(4, 6)}-${stem.slice(6, 8)}`;
}

/** Folds raw per-session rows into one ModelUsage per model. */
export function foldUsage(rows: ModelUsage[]): Map<string, ModelUsage> {
  const m = new Map<string, ModelUsage>();
  for (const u of rows) {
    // A fresh accumulator, not a copy of the row: the loop below adds the row
    // itself, and seeding with it counted the first session twice.
    const e = m.get(u.model) ?? {
      model: u.model,
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      costUsd: 0,
      priceUnknown: u.priceUnknown,
    };
    for (const k of ["requests", "input", "output", "cached", "reasoning", "costUsd"] as const) e[k] += u[k];
    e.priceUnknown = e.priceUnknown || u.priceUnknown;
    e.lastUsed = Math.max(e.lastUsed ?? 0, u.lastUsed ?? 0);
    m.set(u.model, e);
  }
  return m;
}

/** The one-line summary that sits above the table. */
function usageTotals(rows: Map<string, ModelUsage>): string {
  let input = 0, output = 0, cached = 0, cost = 0, reqs = 0, models = 0, unknown = false;
  for (const u of rows.values()) {
    input += u.input;
    output += u.output;
    cached += u.cached;
    cost += u.costUsd;
    reqs += u.requests;
    models++;
    unknown = unknown || u.priceUnknown;
  }
  const fresh = Math.max(0, input - cached);
  const cachedPct = cached && input ? Math.round((cached / input) * 100) : 0;
  return (
    `${c.gray(t("models", "моделей"))} ${c.bold(String(models))}   ` +
    `${c.gray(t("reqs", "запросов"))} ${c.bold(String(reqs))}   ` +
    `${c.gray("↑")} ${fmtTokens(fresh)} ${c.gray(`(${cachedPct}% cached)`)}   ` +
    `${c.gray("↓")} ${fmtTokens(output)}   ` +
    `${c.gray(t("cost", "стоимость"))} ${c.bold(c.brightGreen(fmtCost(cost, unknown)))}`
  );
}

/** The table body: a section per provider, its models, then a subtotal row. */
function usageRows(folded: Map<string, ModelUsage>, only: string | null): PickerItem[] {
  const byProvider = new Map<string, ModelUsage[]>();
  for (const u of folded.values()) {
    const pid = splitModelId(u.model).providerId;
    if (only && pid !== only) continue;
    (byProvider.get(pid) ?? byProvider.set(pid, []).get(pid)!).push(u);
  }

  // Each token cell carries its share of the row's total, so a glance tells
  // which side of the traffic — fresh input, cache reads, output — dominates.
  // Column widths come from the widest value in the table: a fixed width that
  // fits "1.2k" clips "245.04M(97%)" into the next column, and the row stops
  // being readable.
  const shown = [...folded.values()].filter((u) => !only || splitModelId(u.model).providerId === only);
  const cellText = (n: number, total: number): string => (n > 0 && total > 0 ? fmtTokens(n) + `(${Math.round((n / total) * 100)}%)` : "—");
  const widths = { req: 3, input: 6, cached: 6, output: 6, reasoning: 9 };
  for (const u of shown) {
    const total = u.input + u.output + (u.reasoning ?? 0);
    widths.req = Math.max(widths.req, String(u.requests).length);
    widths.input = Math.max(widths.input, cellText(Math.max(0, u.input - u.cached), total).length);
    widths.cached = Math.max(widths.cached, cellText(u.cached, total).length);
    widths.output = Math.max(widths.output, cellText(u.output, total).length);
    widths.reasoning = Math.max(widths.reasoning, cellText(u.reasoning ?? 0, total).length);
  }
  const cellOf = (u: { requests: number; input: number; cached: number; output: number; reasoning: number }): string => {
    const total = u.input + u.output + (u.reasoning ?? 0);
    return (
      `${String(u.requests).padStart(widths.req)} ` +
      `${cellText(Math.max(0, u.input - u.cached), total).padStart(widths.input)} ` +
      `${cellText(u.cached, total).padStart(widths.cached)} ` +
      `${cellText(u.output, total).padStart(widths.output)} ` +
      `${cellText(u.reasoning ?? 0, total).padStart(widths.reasoning)}`
    );
  };
  const tableWidth = widths.req + widths.input + widths.cached + widths.output + widths.reasoning + 5;
  const nameWidth = Math.max(12, Math.min(30, contentWidth() - tableWidth - 9));

  const items: PickerItem[] = [];
  for (const pid of [...byProvider.keys()].sort()) {
    const list = byProvider.get(pid)!.sort((a, b) => b.costUsd - a.costUsd);
    items.push({ value: `__${pid}`, label: "", header: providerLabel(pid) });
    items.push({
      value: `__head-${pid}`,
      label: c.gray(
        `${"model".padEnd(nameWidth)} ${"req".padStart(widths.req)} ${"input*".padStart(widths.input)} ${"cached".padStart(widths.cached)} ${"output".padStart(widths.output)} ${"reasoning".padStart(widths.reasoning)}`,
      ),
    });
    let cost = 0;
    let unknown = false;
    for (const u of list) {
      cost += u.costUsd;
      unknown = unknown || u.priceUnknown;
      items.push({
        value: u.model,
        label: truncate(wireModelId(u.model), nameWidth).padEnd(nameWidth) + " " + cellOf(u),
        badge: c.gray(fmtCost(u.costUsd, u.priceUnknown).padStart(9)),
      });
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
    items.push({
      value: `__sub-${pid}`,
      label: c.gray(t("subtotal", "итого").padEnd(nameWidth) + " " + cellOf(sub)),
      badge: c.bold(fmtCost(cost, unknown).padStart(9)),
    });
  }
  return items;
}

/**
 * The usage panel. The periods are its tabs and the providers its buttons, so
 * the two questions this report ever answers — since when, and whose key — are
 * both a keypress away instead of a re-run of the command.
 */
async function statModal(app: App): Promise<void> {
  const all = loadUsageRows(app);
  if (!all.length) {
    line();
    return void hint(t("No usage recorded yet.", "Расход пока не записан."));
  }

  // Every provider that ever appears, so the buttons do not come and go as
  // the period changes — a button that vanishes is one you cannot press back.
  const everyProvider = [...new Set(all.map((u) => splitModelId(u.model).providerId))].sort();
  // Slice each session's row to the period before folding: the fold throws
  // the daily buckets away, so they have to be read while they are still there.
  const foldFor = (p: string): Map<string, ModelUsage> => {
    const period = (p || "all") as StatPeriod;
    return foldUsage(all.map((u) => periodSlice(u, period)).filter((u): u is ModelUsage => u !== null));
  };

  let period: StatPeriod = "all";
  let only: string | null = null;

  for (;;) {
    const scope = (rows: Map<string, ModelUsage>): Map<string, ModelUsage> =>
      only ? new Map([...rows].filter(([m]) => splitModelId(m).providerId === only)) : rows;

    const actions: ModalAction[] = [
      ...(only ? [{ id: "__all", label: t("All providers", "Все поставщики") }] : []),
      ...everyProvider.filter((pid) => pid !== only).map((pid) => ({ id: pid, label: providerLabel(pid) })),
    ];

    const res: ModalResult | null = await app.exclusiveInput(() =>
      openModal({
        title: t("Usage", "Расход"),
        subtitle: t(
          "input* counts fresh tokens only — cache reads are the cached column. ←→ changes the period.",
          "input* — только чистые токены, чтения из кеша в колонке cached. ←→ меняет период.",
        ),
        notes: (tabKey) => {
          const rows = scope(foldFor(tabKey));
          return rows.size ? [usageTotals(rows)] : [];
        },
        tabs: STAT_PERIODS.map((p) => ({ key: p.key, label: p.label() })),
        initialTab: period,
        items: (tabKey) => usageRows(foldFor(tabKey), only),
        readOnly: true,
        search: false,
        empty: t("No usage in this period.", "За этот период расхода нет."),
        actions: actions.length > 1 ? actions : [],
      }),
    );
    if (!res || res.kind !== "action") return;
    // The panel reopens on the period it was left on, not on the one it opened
    // with: switching provider must not throw the period away.
    period = (res.tab || period) as StatPeriod;
    only = res.id === "__all" ? null : res.id;
  }
}


// ── /uilib ────────────────────────────────────────────────────────────────

/**
 * The library panel. Capture, blend and removal are the typed sub-commands
 * turned into buttons; Enter on a row shows what that mockup actually says,
 * which is the one thing a bare listing could never do.
 */
async function uiLibraryModal(app: App): Promise<void> {
  for (;;) {
    const entries = listEntries();
    const items: PickerItem[] = entries.map((e) => ({
      value: e.slug,
      label: e.title.padEnd(22),
      hint: c.dim(e.keywords.slice(0, 6).join(" ")),
      badge: truncate(e.summary, Math.max(16, contentWidth() - 64)),
    }));

    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("UI library", "Библиотека UI"),
        subtitle: t(
          "Saved mockups. A design request offers them by itself; Enter opens one's brief.",
          "Сохранённые макеты. Запрос на дизайн предложит их сам; Enter открывает бриф.",
        ),
        items,
        empty: t(
          "The library is empty — capture a design from a live site to start.",
          "Библиотека пуста — сохраните дизайн с живого сайта.",
        ),
        actions: [
          { id: "add", label: t("Capture a site…", "Сохранить сайт…"), hotkey: "c" },
          { id: "blend", label: t("Blend…", "Смешать…"), hotkey: "b", disabled: entries.length < 2 },
          { id: "match", label: t("Match a request…", "Подобрать под запрос…"), hotkey: "m", disabled: !entries.length },
          { id: "delete", label: t("Remove", "Удалить"), hotkey: "r", tone: "danger", disabled: !entries.length },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "item") {
      showUiEntry(res.value);
      continue;
    }

    if (res.id === "add") {
      const url = await app.exclusiveInput(() => askLine(t("Site to capture:", "Сайт для захвата:"), "https://"));
      if (!url || !/^https?:\/\/\S+$/i.test(url.trim())) {
        if (url) error(t("That is not a URL.", "Это не URL."));
        continue;
      }
      app.pendingUilibGate = (proposal) => app.confirmUiEntry(proposal);
      app.skipNextDesignMatch = true;
      await app.turn(uilibCapturePrompt(url.trim(), ""));
      return;
    }
    if (res.id === "blend") {
      const picked = await blendUiEntries(app);
      if (!picked || picked === "none") continue;
      startBlendTurn(app, picked);
      return;
    }
    if (res.id === "match") {
      const q = await app.exclusiveInput(() => askLine(t("Describe the design:", "Опишите дизайн:"), ""));
      if (!q) continue;
      renderMatches(app, q);
      continue;
    }
    if (res.id === "delete" && res.value) {
      const entry = entries.find((e) => e.slug === res.value);
      if (!entry) continue;
      const sure = await app.exclusiveInput(() =>
        choose<"yes" | "no">(
          [
            { value: "no", label: t("Keep", "Оставить"), key: "n" },
            { value: "yes", label: t("Remove", "Удалить"), key: "y", tone: "danger" },
          ],
          {
            initial: "no",
            fallback: "no",
            cancel: () => {},
            hint: t(`remove ${entry.title}?`, `удалить ${entry.title}?`),
          },
        ),
      );
      if (sure === "yes" && deleteEntry(entry.slug)) {
        success(t(`Removed ${entry.title}.`, `Удалено: ${entry.title}.`));
      }
      continue;
    }
  }
}

/** The brief itself, rendered as the markdown it is. */
function showUiEntry(slug: string): void {
  const found = getEntry(slug);
  if (!found) return void error(t(`No such entry: ${slug}`, `Такого макета нет: ${slug}`));
  line();
  rule(c.brightCyan(` ${found.entry.title} `));
  for (const l of renderMarkdownBlock(found.brief, { width: contentWidth() })) line(l);
  line();
  if (found.entry.source) hint(t(`from ${found.entry.source}`, `источник: ${found.entry.source}`));
  hint(t("A design request will offer this style by itself.", "Запрос на дизайн предложит этот стиль сам."));
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
 * Branch the session at a past turn. Unlike /rewind nothing is undone: the
 * original session and its files stay as they are, and the user is moved into
 * a new session whose history ends just before the chosen turn — "what if I
 * had asked differently there" without losing the road already taken.
 */
async function forkTurn(app: App, rest: string): Promise<void> {
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
  const res = await app.exclusiveInput(() =>
    openModal({
      title: t("Prompt model", "Модель промптов"),
      subtitle: t(
        "Which model should write the briefs? A small one is enough, and it is cheaper than letting the big one guess.",
        "Какая модель будет писать задания? Хватит маленькой — это дешевле, чем давать большой домысливать.",
      ),
      items: [
        {
          value: "default",
          label: t(`Keep ${wireModelId(fallback)}`, `Оставить ${wireModelId(fallback)}`),
          hint: t("the default writer, asked once", "модель по умолчанию, спрашивается один раз"),
        },
        {
          value: "pick",
          label: t("Choose one…", "Выбрать…"),
          hint: t("pick from the list", "выбрать из списка"),
        },
      ],
      search: false,
      actions: [{ id: "auto", label: t("Auto (default)", "Авто (по умолчанию)"), hotkey: "a" }],
    }),
  );
  if (!res) return false;
  if (res.kind === "action" && res.id === "auto" || (res.kind === "item" && res.value === "default")) {
    saveConfig({ promptModels: { [provider]: AUTO } });
    app.cfg = loadConfig();
    hint(t(`Writing with ${fallback}. Change it with /prompt models.`, `Пишет ${fallback}. Сменить: /prompt models.`));
    return true;
  }
  if (res.kind === "item" && res.value === "pick") {
    await chooseWriter(app, "");
    // Backing out of the list is not an answer; ask again next time.
    return Boolean(loadConfig().promptModels?.[provider]);
  }
  return false;
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

  if (named) {
    let id: string;
    try {
      id = resolveModelId(named, app.catalog);
    } catch (err) {
      return void error((err as Error).message);
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
    return;
  }

  // The same panel /model shows, scoped to this provider and with the writer's
  // own buttons along the foot. A button changes what is on offer and the
  // panel comes straight back, so widening to every provider or re-reading the
  // catalogue never costs a re-typed command.
  let all = false;
  for (;;) {
    const mine = providerModels(app, provider);
    // Scoped to the provider in use by default: its key cannot call the other
    // hosts' models, and listing them only invites a 404. The scope button is
    // there for the times the catalogue for this host came up empty.
    const scoped = all || !mine.length ? app.catalog : mine;
    const pool = scoped.filter((m) => m.chatCapable !== false && servesModality(m, "text"));
    const label = providerById(provider)?.label ?? provider;
    const writer = cfg.promptModels?.[provider];
    const current = writer && writer !== AUTO ? writer : promptModelFor(app.session.model, app.catalog);

    if (!pool.length) {
      await refreshCatalog(app);
      continue;
    }

    const res = await app.exclusiveInput(() =>
      openModelModal({
        catalog: pool,
        current,
        defaultModel: app.session.model,
        title: t("Prompt model", "Модель промптов"),
        subtitle: t(
          `${all ? "Every provider" : label} · ★ session model · ● in use · a small one is enough`,
          `${all ? "Все поставщики" : label} · ★ модель сессии · ● текущая · хватит маленькой`,
        ),
        actions: [
          { id: "auto", label: t("Auto (default)", "Авто (по умолчанию)"), hotkey: "a" },
          { id: "refresh", label: t("Refresh", "Обновить"), hotkey: "r" },
          all
            ? { id: "scope", label: t(`Only ${label}`, `Только ${label}`), hotkey: "o" }
            : { id: "scope", label: t("All providers", "Все поставщики"), hotkey: "s" },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "action") {
      if (res.id === "refresh") {
        await refreshCatalog(app);
        continue;
      }
      if (res.id === "scope") {
        all = !all;
        continue;
      }
      if (res.id === "auto") {
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
      continue;
    }

    if (!res.value || splitModelId(res.value).providerId !== provider) {
      warn(
        t(
          `${res.value} belongs to another provider — pin it with /model first.`,
          `${res.value} у другого поставщика — сначала переключитесь на него через /model.`,
        ),
      );
      continue;
    }
    saveConfig({ promptModels: { [provider]: res.value } });
    app.cfg = loadConfig();
    success(
      t(`${providerLabel(provider)} writes prompts with ${res.value}.`, `${providerLabel(provider)}: промпты пишет ${res.value}.`),
    );
    return;
  }
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

/** Ranked matches for an explicit /uilib match — a listing, not a picker. */
function renderMatches(app: App, q: string): void {
  const matches = matchLibrary(q);
  line();
  if (!matches.length) {
    hint(t("Nothing in the library matches that.", "Под это в библиотеке совпадений нет."));
    hint(t("Capture a design first: /uilib add <site-url>", "Сначала сохраните макет: /uilib add <url сайта>"));
    return;
  }
  for (const m of matches) {
    padded(
      `${c.bold(m.entry.slug.padEnd(24))} ${c.gray(`score ${String(Math.round(m.score)).padStart(3)}`)}  ` +
        c.dim(truncate(m.via.slice(0, 4).join(", "), Math.max(16, contentWidth() - 44))),
    );
  }
  line();
}

/**
 * The library picker for a design request: one modal with every saved mockup —
 * ranked by how well it matches the request — over three buttons. "Auto" takes
 * the best-ranked entry, "Blend" fuses several, "Unique design" draws from
 * scratch. Returns the picked entry (or several, for a blend), "none" when the
 * user wants a design from scratch, or null when the panel was dismissed.
 */
export async function pickUiEntry(
  app: App,
  request: string,
): Promise<{ entry: UiEntry; brief: string } | { entry: UiEntry; brief: string }[] | "none" | null> {
  const entries = listEntries();
  if (!entries.length) return null;
  // Matched first, in rank order; the rest of the library stays reachable below.
  const matched = new Set(matchLibrary(request).map((m) => m.entry.slug));
  const ranked = [
    ...matchLibrary(request).map((m) => m.entry),
    ...entries.filter((e) => !matched.has(e.slug)),
  ];
  line();
  hint(t("I can draw it in a style from your UI library:", "Могу нарисовать в стиле из вашей библиотеки макетов:"));
  const res = await app.exclusiveInput(() =>
    openModal({
      title: t("Design reference", "Дизайн-референс"),
      subtitle: t(
        "Pick a saved mockup for this request, or let the CLI decide.",
        "Выберите сохранённый макет под запрос или доверьтесь автоподбору.",
      ),
      items: ranked.map((e) => ({
        value: e.slug,
        label: e.title.padEnd(22),
        hint: c.dim(e.keywords.slice(0, 5).join(" ")),
        badge: truncate(e.summary, Math.max(16, contentWidth() - 64)),
      })),
      empty: t("The library is empty — capture a design with /uilib add.", "Библиотека пуста — сохраните макет через /uilib add."),
      actions: [
        { id: "auto", label: t("Auto-pick", "Авто-подбор"), hotkey: "a", tone: "ok" },
        { id: "blend", label: t("Blend several…", "Смешать несколько…"), hotkey: "b", disabled: entries.length < 2 },
        { id: "scratch", label: t("Unique design", "Уникальный дизайн"), hotkey: "u", tone: "warn" },
      ],
    }),
  );
  if (!res) return null;
  if (res.kind === "item") return getEntry(res.value);
  if (res.id === "auto") return ranked[0] ? getEntry(ranked[0].slug) : null;
  if (res.id === "blend") return blendUiEntries(app);
  if (res.id === "scratch") return "none";
  return null;
}

/**
 * Picking several mockups to fuse into one style. The multi-picker returns the
 * slugs; the confirm step after it is where the user sees what is about to be
 * blended and can still back out.
 */
async function blendUiEntries(app: App): Promise<{ entry: UiEntry; brief: string }[] | "none" | null> {
  const entries = listEntries();
  const picked = await app.exclusiveInput(() =>
    pickMulti({
      title: t("Blend which mockups?", "Какие макеты смешать?"),
      items: entries.map((e) => ({ value: e.slug, label: e.title, hint: e.summary })),
    }),
  );
  if (!picked || picked.length < 2) {
    if (picked?.length === 1) warn(t("Blending needs at least two — picked one.", "Для смешения нужно минимум два — выбран один."));
    return picked ? "none" : null;
  }
  const parts = picked.map((s) => getEntry(s)).filter((p): p is { entry: UiEntry; brief: string } => p !== null);
  line();
  padded(
    c.bold(t("Blend:", "Смешать:")) + " " + parts.map((p) => c.brightCyan(p.entry.title)).join(c.gray(" + ")),
  );
  const ok = await app.exclusiveInput(() =>
    choose<"yes" | "no">(
      [
        { value: "yes", label: t("Generate blend", "Сгенерировать смешение"), key: "G", tone: "ok" },
        { value: "no", label: t("Cancel", "Отмена"), key: "N", tone: "danger" },
      ],
      { initial: "yes", fallback: "yes", cancel: () => {} },
    ),
  );
  return ok === "yes" ? parts : "none";
}

/**
 * The blend turn: the model synthesises one style from the chosen briefs and
 * saves it as a new library entry, going through the same propose → confirm
 * gate as a capture. The blend itself is written into the session history by
 * the model, so the next "нарисуй дизайн …" matches it like any other entry.
 */
function startBlendTurn(app: App, parts: { entry: UiEntry; brief: string }[]): void {
  const briefs = parts.map((p) => `<source name="${p.entry.title}">\n${p.brief}\n</source>`).join("\n\n");
  app.pendingUilibGate = (proposal) => app.confirmUiEntry(proposal);
  app.skipNextDesignMatch = true;
  app.turn(
    `Blend these UI library mockups into ONE new coherent design style and save it into the trcode UI library.\n\n` +
      `${briefs}\n\n` +
      `Rules:\n` +
      `- Synthesise a style, do not average: take what each source does best (palette from one, typography from ` +
      `another, motion from a third…) and resolve their contradictions explicitly.\n` +
      `- The result must stand on its own: someone who has never seen the sources should be able to use the brief.\n` +
      `- Propose the entry BEFORE writing anything. Show exactly this form and stop:\n` +
      `  slug: <short-slug>\n  title: <human label>\n  summary: <one line on the style>\n  keywords: <comma-separated>\n\n` +
      `Then STOP and end your reply. The CLI will ask the user to confirm, edit or reject the proposal interactively.\n` +
      `- CONFIRMED arrives with the form unchanged (or corrected, if the user edited it): write two files under ` +
      `\`~/.trcode/ui-library/<slug>/\`: \`entry.json\` of shape\n` +
      `{ "slug": "...", "title": "...", "summary": "...", "keywords": ["..."], "addedAt": ${Date.now()} }\n` +
      `and \`design.md\` — the synthesized design brief, structured by palette / typography / spacing / components / motion.\n` +
      `- REJECTED means save nothing; acknowledge in one line.`,
  );
}

/**
 * Pulls the four-field proposal form out of the model's reply, so a confirm
 * can re-send exactly what was approved. Fields it never named stay blank —
 * the user saw the same reply and confirmed it as it was.
 */
export function extractEntryForm(reply: string): string {
  const fields = ["slug", "title", "summary", "keywords"];
  const got: string[] = [];
  for (const line of reply.split("\n")) {
    const m = /^\s*(slug|title|summary|keywords)\s*[:=]\s*(.*)$/i.exec(line);
    if (m && !got.some((g) => g.startsWith(`${m[1].toLowerCase()}:`))) {
      got.push(`${m[1].toLowerCase()}: ${m[2].trim()}`);
    }
  }
  const ordered = fields
    .map((f) => got.find((g) => g.startsWith(`${f}:`)))
    .filter((g): g is string => Boolean(g));
  return ordered.length ? ordered.join("\n") : reply.trim();
}

/**
 * The capture prompt: what the agent is to extract from the site and propose.
 */
function uilibCapturePrompt(url: string, label: string): string {
  const name = label || new URL(url).hostname.replace(/^www\./, "");
  return (
    `Analyse the visual design of ${url} and save it into the trcode UI library.\n\n` +
    `Steps:\n` +
    `1. Map the site first, not just the landing page: fetch ${url} and look for internal pages — ` +
    `the sitemap at <origin>/sitemap.xml (fetch returns it verbatim as XML), plus nav/footer links on the homepage. ` +
    `Pick 4-8 representative inner pages (pricing, docs, blog, dashboard, auth, changelog…) and fetch them too: a ` +
    `design often shows its real system on components the homepage never renders — tables, forms, empty states, ` +
    `code blocks, badges. The landing page alone is not enough: read at least three inner pages whenever the site ` +
    `has them, and say so explicitly when there genuinely is nothing else to open. If a page blocks fetching or is ` +
    `client-rendered, note that in the brief instead of guessing.\n` +
    `2. Across those pages extract the design system, not the content: colour palette with concrete values, ` +
    `typography scale, spacing rhythm, corner radii, borders and shadows, button/input/card anatomy, and any signature ` +
    `visual effects (animations, transitions, glows, gradients) worth copying. Fetching a raw CSS file is fine when it helps.\n` +
    `3. Decide what kind of product this design fits (SaaS dashboard, landing, docs, terminal app…) and 5-10 keywords ` +
    `a person would type when asking for such a design, in English and Russian ("saas, dark, dashboard, тёмный…").\n` +
    `4. Propose the entry BEFORE writing anything. Show exactly this form and stop:\n` +
    `   slug: <short-slug>\n   title: <human label>\n   summary: <one line on the style>\n` +
    `   keywords: <comma-separated>\n\n` +
    `Then STOP and end your reply. The CLI will ask the user to confirm, edit or reject the proposal interactively.\n` +
    `- CONFIRMED arrives with the form unchanged (or corrected, if the user edited it): write two files under ` +
    `\`~/.trcode/ui-library/<slug>/\`: \`entry.json\` of shape\n` +
    `{ "slug": "...", "title": "...", "summary": "...", "keywords": ["..."], "source": "${url}", "addedAt": ${Date.now()} }\n` +
    `and \`design.md\` — the design brief itself, structured by palette / typography / spacing / components / motion, ` +
    `concrete enough to reproduce the style without seeing the original site. End it with a "Pages read" list of ` +
    `the URLs the brief was actually taken from, marking any that could not be fetched — a brief drawn from the ` +
    `homepage alone is worth less than one drawn from six pages, and the reader has to be able to tell which it ` +
    `is. Then report where it was saved.\n` +
    `- REJECTED means save nothing; acknowledge in one line.\n\n` +
    `The entry name should mention "${name}".`
  );
}

const COMMANDS: Command[] = [
  // ── main ────────────────────────────────────────────────────────────────
  {
    name: "/model",
    group: "main",
    args: () => t("[name|alias|all|refresh]", "[имя|алиас|all|refresh]"),
    help: () =>
      t(
        "switch model — this provider's, `all` for every one, `refresh` to re-read the catalog",
        "сменить модель — текущего поставщика, `all` для всех, `refresh` перечитать каталог",
      ),
    async run(app, rest) {
      const arg = rest.trim();
      // The catalogue is cached, and a provider that has just published a
      // model is exactly when that shows. This is what /models was for.
      if (/^(refresh|reload|update|sync)$/i.test(arg)) {
        await refreshCatalog(app);
        return void hint(t("Pick one with /model.", "Выбрать: /model."));
      }
      if (arg && !/^all$/i.test(arg)) {
        // A name is searched across every provider: naming one is an explicit
        // enough request to cross over.
        const id = resolveModelId(arg, app.catalog);
        // The header states the provider, so crossing to another needs no
        // separate line about it.
        setModel(app, id);
        warnIfIncompatible(app, id);
        return;
      }
      await modelModal(app, { all: /^all$/i.test(arg) });
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
        return setDefaultProvider(app, def);
      }

      // The host a key belongs to is not always the one a provider defaults
      // to, and getting it wrong is reported as a rejected key. Changing it
      // must not cost a logout — the credential is still good.
      if (parts[0] === "host") {
        const named = parts.slice(1).find((p) => !/^https?:\/\//i.test(p));
        const def = named ? providerById(named.toLowerCase()) : providerById(currentProviderId(app));
        if (!def) return error(t(`Unknown provider: ${named}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${named}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
        return setProviderHost(app, def, parts.find((p) => /^https?:\/\//i.test(p)));
      }

      if (parts[0] === "logout") {
        const def = parts[1] ? providerById(parts[1].toLowerCase()) : undefined;
        if (!def) return error(t(`Which provider? ${others.map((p) => p.id).join(", ") || "none to disconnect"}`, `Какого поставщика? ${others.map((p) => p.id).join(", ") || "отключать нечего"}`));
        return logoutFromProvider(app, def);
      }

      if (parts[0]) {
        const def = providerById(parts[0].toLowerCase());
        if (!def) return error(t(`Unknown provider: ${parts[0]}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${parts[0]}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
        return switchToProvider(app, def);
      }

      await providerModal(app);
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
    name: "/uilib",
    group: "main",
    args: () =>
      t(
        "[add <site-url> | match <request> | blend | rm <slug>]  ·  bare /uilib lists the library",
        "[add <url сайта> | match <запрос> | blend | rm <слаг>]  ·  без аргументов — список библиотеки",
      ),
    help: () =>
      t(
        "UI mockup library: capture a site's design, then reuse it in design requests",
        "библиотека UI-макетов: сохранить дизайн сайта и потом применять его в запросах",
      ),
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      // Capture: the agent analyses the site, proposes an entry, the user
      // confirms or edits it. Everything interactive stays here; the agent only
      // writes the brief it is told to write.
      if (sub === "add" || sub === "capture") {
        const url = parts[1];
        if (!url || !/^https?:\/\//i.test(url)) {
          return error(t("Give the site: /uilib add https://example.com", "Укажите сайт: /uilib add https://example.com"));
        }
        const label = parts.slice(2).join(" ");
        app.pendingUilibGate = (proposal) => app.confirmUiEntry(proposal);
        app.skipNextDesignMatch = true;
        await app.turn(uilibCapturePrompt(url, label));
        return;
      }

      if (sub === "rm" || sub === "remove" || sub === "delete") {
        const slug = parts[1];
        if (!slug) return error(t("Which one: /uilib rm <slug>", "Какой удалить: /uilib rm <слаг>"));
        const ok = deleteEntry(slug);
        return ok
          ? success(t(`Removed ${slug}.`, `Удалено: ${slug}.`))
          : error(t(`No such entry: ${slug}`, `Такого макета нет: ${slug}`));
      }

      if (sub === "match") {
        const q = parts.slice(1).join(" ");
        if (!q) return error(t('What to match: /uilib match "saas dashboard dark"', 'Что сопоставить: /uilib match "saas dashboard dark"'));
        return renderMatches(app, q);
      }

      if (sub === "blend") {
        const picked = await blendUiEntries(app);
        if (!picked || picked === "none") return;
        return startBlendTurn(app, picked);
      }

      if (sub) return error(t(`Unknown subcommand: ${sub}`, `Неизвестная подкоманда: ${sub}`));

      await uiLibraryModal(app);
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
    name: "/fork",
    group: "session",
    args: () => t("[turn]", "[ход]"),
    help: () => t("branch the current session at a past turn; the original stays intact", "ветвление текущей сессии от прошлого хода; оригинал не трогается"),
    async run(app, rest) {
      await forkTurn(app, rest);
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
      if (/^models?$/i.test(arg)) return void (await brainPanelModal(app));
      if (arg) {
        const panel = brainPanel(app);
        if (panel.length < 2) return void brainNeedsPanel();
        return void (await app.runBrain(arg, panel));
      }
      await brainModal(app);
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
      const arg = rest.trim();

      // /subagents model [id] — put one more model on the list without walking
      // the whole catalogue; without an id it falls through to the panel.
      if (/^models?\s+\S/i.test(arg)) {
        return void addSubagentModel(app, arg.replace(/^models?\s+/i, "").trim());
      }
      if (/^(auto|reset|any|all)$/i.test(arg)) return void resetSubagentModels(app);
      await subagentsModal(app);
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
      await statModal(app);
    },
  },
  {
    name: "/trace",
    group: "session",
    args: () => "[n]",
    help: () => t("what the model was sent on each step: system, schemas, history, injected", "что уходило модели на каждом шаге: промпт, схемы, история, инъекции"),
    async run(app, rest) {
      const all = loadProjections(app.cwd, app.session.id);
      line();
      rule(c.brightCyan(" request trace "));
      if (!all.length) {
        hint(t(
          "No requests logged yet — projections appear after the first turn of this session.",
          "Запросов ещё не было — проекции появятся после первого хода этой сессии.",
        ));
        line();
        return;
      }
      const n = Math.max(1, Math.min(50, Number.parseInt(rest, 10) || 10));
      const rows = all.slice(-n);
      padded(
        c.gray(
          `${"step".padStart(4)} ${"time".padStart(8)} ${"system".padStart(8)} ${"schemas".padStart(8)} ` +
            `${"history".padStart(9)} ${"injected".padStart(9)} ${"trim→".padStart(7)} ${"cached".padStart(7)} ${"model"}`,
        ),
      );
      for (const p of rows) {
        const inj = p.injected.length ? fmtTokens(p.injected.reduce((s, i) => s + i.tokens, 0)) : "—";
        const time = new Date(p.ts).toTimeString().slice(0, 5);
        const cached = p.cachedTokens ? fmtTokens(p.cachedTokens) : "—";
        padded(
          `${String(p.step).padStart(4)} ${time.padStart(8)} ${fmtTokens(p.systemTokens).padStart(8)} ` +
            `${fmtTokens(p.schemaTokens).padStart(8)} ${fmtTokens(p.historyTokens).padStart(9)} ` +
            `${inj.padStart(9)} ${(p.trimmed ? `-${fmtTokens(p.trimSaved)}` : "—").padStart(7)} ` +
            `${cached.padStart(7)} ${c.gray(p.model)}`,
        );
      }
      // The injected column hides what it was; name it when there is anything.
      const sources = new Set(rows.flatMap((p) => p.injected.map((i) => i.source)));
      if (sources.size) hint(t(`Injected: ${[...sources].join(", ")}.`, `Инъекции: ${[...sources].join(", ")}.`));
      hint(t(
        "~estimates per request; history is what travelled after trim. /trace <n> for more steps.",
        "~оценки на запрос; history — то, что ушло после trim. /trace <n> — больше шагов.",
      ));
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
        setSkillsEnabled(app, sub === "on");
        if (sub === "on") hint(t("Off again with: /skills off.", "Выключить обратно: /skills off."));
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
        await editSkill(app, parts[1] ?? null);
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
        await app.turn(skillGenPrompt(task));
        app.rebuildTools();
        return;
      }

      await skillsModal(app);
    },
  },
  {
    name: "/preset",
    group: "other",
    args: () => t("[standard | minimal]", "[standard | minimal]"),
    help: () => t("tool set for this session: full or just shell+edit", "набор инструментов сессии: полный или только shell+edit"),
    async run(app, rest) {
      const want = rest.trim().toLowerCase();
      if (want && !["standard", "minimal"].includes(want)) {
        return error(t("Use: /preset standard | minimal", "Использование: /preset standard | minimal"));
      }
      const target = (want || "standard") as "standard" | "minimal";
      if (!want) {
        info(
          t(
            `Preset: ${app.preset}. /preset minimal keeps only shell and edit; /preset standard brings everything back.`,
            `Пресет: ${app.preset}. /preset minimal оставляет только shell и edit; /preset standard возвращает всё.`,
          ),
        );
        return;
      }
      if (target === app.preset) {
        return info(t(`Already on ${target}.`, `Уже включён ${target}.`));
      }
      app.presetOverride = target;
      // The preset decides both halves of a request: the tool list and the
      // base prompt. Both changed, so the cached prefix is void either way —
      // saying it beats the user wondering why the next request billed fresh.
      app.rebuildTools();
      resetPromptSnapshots();
      app.session.save();
      if (target === "minimal") {
        success(t("Minimal preset: two tools (shell, edit) and a short prompt.", "Минимальный пресет: два инструмента (shell, edit) и короткий промпт."));
        hint(t("Back with: /preset standard", "Вернуть: /preset standard"));
      } else {
        success(t("Standard preset: the full tool set and prompt are back.", "Стандартный пресет: полный набор инструментов и промпт возвращены."));
      }
      warn(t("The prompt changed — the next request rebuilds the cache from scratch.", "Промпт сменился — следующий запрос соберёт кэш заново."));
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
