/** Providers, models, favourites, settings and /update. */
import { c } from "../ansi.js";
import { error, hint, info, line, plural, Spinner, success, warn } from "../render.js";
import { openModal, pick, pickMulti, type PickerItem } from "../picker.js";
import { editFavorites, openModelModal } from "../modelpicker.js";
import { loadConfig, saveConfig, configPath, rememberProjectState, VERSION, STATUS_FIELDS, type StatusField } from "../../config.js";
import { latestRelease, isNewer, applyUpdate } from "../../update.js";
import { fetchModels } from "../../provider/models.js";
import { DEFAULT_PROVIDER, modeConfig, modeFor, providerById, providerLabel, providers, providerState, rememberBaseUrl, rememberProviderState, type ProviderDef } from "../../provider/registry.js";
import { clearCredentials } from "../../provider/credentials.js";
import { chooseHost, loginProvider } from "../login.js";
import { t, count, t as tr } from "../../i18n.js";
import type { App } from "../repl.js";
import { currentProviderId, providerModels, defaultModelFor, setModel, warnIfIncompatible } from "./shared.js";

/** Records where the session currently is, so coming back restores it. */
export function rememberCurrent(app: App): void {
  rememberProviderState(currentProviderId(app), {
    model: app.session.model,
    effort: app.effortOverride,
  });
  rememberProjectState(app.cwd, { model: app.session.model, effort: app.effortOverride });
}

export function providerItems(app: App): PickerItem[] {
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
export async function switchToProvider(app: App, def: ProviderDef): Promise<void> {
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
export async function refreshCatalog(app: App, opts: { quiet?: boolean } = {}): Promise<void> {
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
export function setDefaultProvider(app: App, def: ProviderDef): void {
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
export async function setProviderHost(app: App, def: ProviderDef, given?: string): Promise<void> {
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
export async function logoutFromProvider(app: App, def: ProviderDef): Promise<void> {
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

// ── /settings ─────────────────────────────────────────────────────────────

/**
 * The settings panel. Grouped in sections — the status line first (what it
 * shows), then updates (whether the client looks for a release at all) — so
 * the list grows by section instead of turning into one flat wall of rows.
 */
export async function settingsModal(app: App): Promise<void> {
  const cfg = loadConfig();
  const fields: { key: StatusField; label: string; example: string }[] = [
    { key: "model", label: t("model and reasoning budget", "модель и бюджет мышления"), example: "kimi:k3:high" },
    { key: "tokens", label: t("tokens — in, cached, out, reasoning", "токены — вход, кэш, выход, мышление"), example: "↑ 1.1M · 920k cached ↓ 9.9k" },
    { key: "steps", label: t("how many steps the turn took", "сколько шагов занял ход"), example: "11 steps" },
    { key: "time", label: t("how long the turn ran", "сколько шёл ход"), example: "6m 05s" },
    { key: "speed", label: t("output speed", "скорость вывода"), example: "27 tok/s avg" },
  ];
  const updatesOn = cfg.updateCheck !== false;
  const skillsOn = cfg.skillsEnabled === true;
  const skillAutoOn = skillsOn && cfg.skillAuto !== false;
  const uilibAutoOn = cfg.uilibAuto !== false;
  const favAllOn = cfg.favoritesAllProviders !== false;
  const items: PickerItem[] = [
    {
      header: t("Auto-loading", "Автоподстановка"),
      value: "__hdr-auto",
      label: "",
    },
    {
      value: "skillAuto",
      label: t(
        "find and apply matching skills on their trigger words",
        "искать подходящие навыки по словам-триггерам и применять их",
      ),
      hint: c.dim(t("the ⚡ injections · /skills manages the catalog", "вставки ⚡ · каталогом управляет /skills")),
      badge: skillAutoOn ? c.brightGreen(t("on", "вкл")) : c.gray(t("off", "выкл")),
    },
    {
      value: "uilibAuto",
      label: t(
        "match design requests against the UI library",
        "подбирать макет из UI-библиотеки под запросы про дизайн",
      ),
      hint: c.dim(t("injected as <design-reference> · /uilib", "подставляется как <design-reference> · /uilib")),
      badge: uilibAutoOn ? c.brightGreen(t("on", "вкл")) : c.gray(t("off", "выкл")),
    },
    { header: t("Favorites", "Избранное"), value: "__hdr-fav", label: "" },
    {
      value: "favoritesAllProviders",
      label: t(
        "list favorites from every connected provider",
        "показывать избранное со всех подключённых поставщиков",
      ),
      hint: c.dim(
        t(
          "off — only what the provider in use serves · /fav edits the list",
          "выкл — только модели текущего поставщика · список правит /fav",
        ),
      ),
      badge: favAllOn ? c.brightGreen(t("on", "вкл")) : c.gray(t("off", "выкл")),
    },
    { header: t("Status line", "Строка состояния"), value: "__hdr-status", label: "" },
    ...fields.map((f) => ({
      value: `status:${f.key}`,
      label: f.label,
      hint: c.dim(f.example),
      badge: cfg.statusFields[f.key] !== false ? c.brightGreen(t("on", "вкл")) : c.gray(t("off", "выкл")),
    })),
    {
      header: t("Updates", "Обновления"),
      value: "__hdr-updates",
      label: "",
    },
    {
      value: "updateCheck",
      label: t(
        "check GitHub for a newer release at startup",
        "проверять GitHub на новую версию при старте",
      ),
      hint: c.dim(t("never installs anything by itself · /update does", "само ничего не ставит · установка через /update")),
      badge: updatesOn ? c.brightGreen(t("on", "вкл")) : c.gray(t("off", "выкл")),
    },
  ];
  const picked = await pickMulti({
    title: t("Settings", "Настройки"),
    subtitle: t("Space toggles a row; Enter saves.", "Пробел переключает строку; Enter сохраняет."),
    items,
    groupGap: true,
    selected: [
      ...(skillAutoOn ? ["skillAuto"] : []),
      ...(uilibAutoOn ? ["uilibAuto"] : []),
      ...(favAllOn ? ["favoritesAllProviders"] : []),
      ...fields.filter((f) => cfg.statusFields[f.key] !== false).map((f) => `status:${f.key}`),
      ...(updatesOn ? ["updateCheck"] : []),
    ],
    allowEmpty: true,
  });
  if (picked === null) return;

  const next: Record<StatusField, boolean> = { ...cfg.statusFields };
  for (const k of STATUS_FIELDS) next[k] = picked.includes(`status:${k}`);
  app.cfg = saveConfig({
    statusFields: next,
    updateCheck: picked.includes("updateCheck"),
    // Auto-selection lives only while the skills take part in requests at all:
    // an ⚡ injection without them would be a body nobody asked to see.
    skillAuto: skillsOn && picked.includes("skillAuto"),
    uilibAuto: picked.includes("uilibAuto"),
    favoritesAllProviders: picked.includes("favoritesAllProviders"),
  });
  const shown = STATUS_FIELDS.filter((k) => next[k]).length;
  const upd = picked.includes("updateCheck");
  success(
    t(
      `Saved: skills ${picked.includes("skillAuto") ? "on" : "off"}, UI library ${picked.includes("uilibAuto") ? "on" : "off"}, favorites ${picked.includes("favoritesAllProviders") ? "all providers" : "current provider"}, ${shown} of ${STATUS_FIELDS.length} status fields, update check ${upd ? "on" : "off"}.`,
      `Сохранено: навыки ${picked.includes("skillAuto") ? "вкл" : "выкл"}, UI-библиотека ${picked.includes("uilibAuto") ? "вкл" : "выкл"}, избранное ${picked.includes("favoritesAllProviders") ? "со всех поставщиков" : "только текущий поставщик"}, полей статуса ${shown} из ${STATUS_FIELDS.length}, проверка обновлений ${upd ? "вкл" : "выкл"}.`,
    ),
  );
}

// ── /update ───────────────────────────────────────────────────────────────

/**
 * Update from inside a session. The check runs here rather than through the
 * startup cache, so the answer is always current.
 */
export async function runUpdate(app: App): Promise<void> {
  await app.exclusiveInput(async () => {
    line();
    info(tr("Checking github.com/ivanvp91/TRCode releases…", "Проверяю релизы на github.com/ivanvp91/TRCode…"));
    let rel;
    try {
      rel = await latestRelease();
    } catch (err) {
      error(tr(`Could not reach GitHub: ${(err as Error).message}`, `GitHub недоступен: ${(err as Error).message}`));
      return;
    }
    if (!rel.version || !isNewer(VERSION, rel.version)) {
      success(tr(`Already on the latest version (${VERSION}).`, `Уже последняя версия (${VERSION}).`));
      return;
    }
    line(
      tr(
        `  New version available: ${c.bold(rel.version)} ${c.gray(`(current: ${VERSION})`)}`,
        `  Доступна новая версия: ${c.bold(rel.version)} ${c.gray(`(текущая: ${VERSION})`)}`,
      ),
    );
    try {
      await applyUpdate(rel);
      success(
        tr(
          `Updated to ${rel.version}. Restart the terminal to run the new build.`,
          `Обновлено до ${rel.version}. Перезапустите терминал, чтобы запустить новую сборку.`,
        ),
      );
      app.repaintHeader();
    } catch (err) {
      error(
        tr(
          `Update failed: ${(err as Error).message} — the previous install is untouched.`,
          `Не удалось обновиться: ${(err as Error).message} — прежняя сборка не тронута.`,
        ),
      );
    }
  });
}

// ── model and provider ─────────────────────────────────────────────────────

/**
 * The model panel. A button changes what the list is scoped to and the panel
 * comes straight back, so widening to every provider or re-reading the
 * catalogue never costs a re-typed command.
 */
export async function modelModal(app: App, opts: { only?: boolean } = {}): Promise<void> {
  // Open on every connected host; `only` narrows to the provider in use.
  let all = opts.only !== true;
  // The panel opens on the cached catalog and the live one is fetched behind
  // it: a provider that has just published a model shows it without a press
  // of Refresh, and a slow host delays nothing. When the answer lands while
  // the panel is still up, the rows follow it in place.
  let repaint: (() => void) | null = null;
  void fetchModels({ force: true })
    .then((catalog) => {
      app.catalog = catalog;
      app.rebuildTools();
      repaint?.();
    })
    .catch(() => {});
  for (;;) {
    const cfg = loadConfig();
    const provider = currentProviderId(app);
    const label = providerById(provider)?.label ?? provider;

    const res = await app.exclusiveInput(() =>
      openModelModal({
        // A getter rather than a snapshot, so the background re-read above
        // reaches rows the panel has already drawn. Every connected host at
        // once: one lab's models spread over several providers, and a chooser
        // that hides the others makes picking across hosts a detour through
        // /provider. The scope button narrows it back.
        get catalog() {
          return all ? providerModels(app, provider) : app.catalog;
        },
        get favoritesCatalog() {
          return app.catalog;
        },
        onOpen(update) {
          repaint = update;
          return () => void (repaint = null);
        },
        current: app.session.model,
        defaultModel: cfg.model,
        title: t("Model", "Модель"),
        // Counted on read, like the rows: a background catalog re-read must
        // not leave the panel quoting a number from before it landed.
        get subtitle() {
          const n = (all ? providerModels(app, provider) : app.catalog).length;
          return t(
            `${all ? label : "Every provider"} · ${n} models · ★ default · ● in use`,
            `${all ? label : "Все поставщики"} · ${n} · ★ по умолчанию · ● текущая`,
          );
        },
        actions: [
          { id: "refresh", label: t("Refresh", "Обновить"), hotkey: "r" },
          all
            ? { id: "scope", label: t("All providers", "Все поставщики"), hotkey: "a" }
            : { id: "scope", label: t(`Only ${label}`, `Только ${label}`), hotkey: "o" },
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
export async function providerModal(app: App): Promise<void> {
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


/**
 * The favorite editor: checkbox lists on the provider tabs, preselected with
 * the current stars. Space flips rows while scrolling, Enter saves the whole
 * set in one write; Esc cancels without touching anything. Clearing all is a
 * separate button inside the panel — not an accidental Enter.
 */
export async function favModal(app: App): Promise<void> {
  const picked = await app.exclusiveInput(() =>
    editFavorites({ catalog: app.catalog, current: app.session.model, defaultModel: loadConfig().model }),
  );
  if (picked === null) return;
  saveConfig({ favoriteModels: picked }, { replace: ["favoriteModels"] });
  app.cfg = loadConfig();
  if (!picked.length) return void success(t("Favorites cleared.", "Избранное очищено."));
  success(t(`Favorites: ${picked.length}`, `В избранном: ${count(picked.length, ["model", "models"], ["модель", "модели", "моделей"])}`));
}
