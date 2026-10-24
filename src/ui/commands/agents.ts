/** /brain, /swarm and /subagents: models that work alongside the main one. */
import { c } from "../ansi.js";
import { error, hint, line, padded, rule, success, warn } from "../render.js";
import { openModal, pick, type PickerItem, type PickerTab } from "../picker.js";
import { choose } from "../choice.js";
import { FAVORITE_TAB, favoriteIds, openModelsModal, pickModelsAcrossProviders } from "../modelpicker.js";
import { loadConfig, saveConfig } from "../../config.js";
import { resolveModelId, groupByVendor, incompatibleReason, servesModality, usableModels } from "../../provider/models.js";
import { providerLabel, splitModelId, wireModelId } from "../../provider/registry.js";
import { configuredRoster, runSwarm, swarmMain, swarmRoster } from "../../agent/swarm.js";
import { subagentMode } from "../../agent/subagent.js";
import { t, count } from "../../i18n.js";
import type { ModelInfo } from "../../types.js";
import type { App } from "../repl.js";
import { currentProviderId, providerModels } from "./shared.js";
import { refreshCatalog } from "./providers.js";

// ── /brain ────────────────────────────────────────────────────────────────

/** The panel as it stands, minus anything this client can no longer reach. */
export function brainPanel(app: App): string[] {
  return loadConfig().brainModels.filter((m) => app.catalog.some((x) => x.id === m));
}

export function brainNeedsPanel(): void {
  error(
    t(
      "A panel needs at least two models that this client can reach.",
      "Совету нужны хотя бы две модели, доступные этому клиенту.",
    ),
  );
  hint(t("Choose them with /brain models", "Выбрать: /brain models"));
}

/**
 * The panel as it stands, minus anything this client can no longer reach.
 * The main model is a panel member first: if it was dropped from the panel or
 * cannot be reached, the session's model writes instead.
 */
export function brainMain(app: App, panel: string[]): string {
  const cfg = loadConfig();
  if (cfg.brainMainModel && panel.includes(cfg.brainMainModel)) return cfg.brainMainModel;
  return app.session.model;
}

/** Who sits on the panel — one multi-select spanning every connected host. */
export async function brainPanelModal(app: App): Promise<void> {
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
  success(t("Panel: {panel}", "Совет: {panel}", { panel: picked.map(wireModelId).join(", ") }));
}

/** The panel as it stands, and the question to put to it. */
export async function brainModal(app: App): Promise<void> {
  for (;;) {
    const cfg = loadConfig();
    const configured = loadConfig().brainModels;
    const reachable = brainPanel(app);
    const mainModel = cfg.brainMainModel || app.session.model;
    const items: PickerItem[] = configured.map((id) => {
      const providerId = splitModelId(id).providerId;
      const okHere = reachable.includes(id);
      const marks =
        (id === mainModel ? c.brightGreen("★ ") : "  ") +
        (okHere ? "" : c.red("✗ "));
      return {
        value: id,
        label: (marks + wireModelId(id)).padEnd(30),
        hint: okHere
          ? c.dim(providerLabel(providerId)) +
            (id === cfg.brainMainModel ? c.brightGreen(t("  · main", "  · главная")) : "")
          : c.red(t("not reachable from here", "отсюда недоступна")),
        badge: id === mainModel && cfg.brainMainModel ? "" : id === mainModel ? c.gray(t("session", "сессия")) : "",
      };
    });

    const tabs: PickerTab[] = [
      { key: "panel", label: t("Active models", "Активные модели"), count: configured.length },
    ];
    // The favorite tab before the catalogue: the same list, cut down to the
    // models a person has already singled out.
    const favs = favoriteIds(app.catalog, app.session.model);
    if (favs.length) {
      tabs.push({ key: FAVORITE_TAB, label: t("Favorites", "Избранное"), count: favs.length });
    }
    // The catalogue tab: the same place a model is added is where one is
    // excluded, so the panel never has to be rebuilt to drop a member.
    const text = usableModels(app.catalog).filter((m) => servesModality(m, "text"));
    if (text.length) {
      tabs.push({ key: "all", label: t("All models", "Все модели"), count: text.length });
    }

    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("Brain", "Совет моделей"),
        subtitle: t(
          "Space marks models, Enter applies the marks to the panel (★ marks the main model — it writes the final answer).",
          "Пробел отмечает модели, Enter применяет отметки к совету (★ — главная модель, она пишет итог).",
        ),
        tabs,
        initialTab: "panel",
        search: false,
        // Every row is a checkbox on the panel itself: a whole batch is added
        // or dropped in one Enter instead of reopening the panel per model.
        multi: true,
        selected: configured,
        allowEmpty: true,
        empty: t("No panel yet — choose the models first.", "Совета пока нет — сначала выберите модели."),
        groupGap: [FAVORITE_TAB, "all"],
        actions: [
          { id: "ask", label: t("Ask…", "Спросить…"), hotkey: "a", disabled: reachable.length < 2 },
          { id: "main", label: t("Make main", "Сделать главной"), hotkey: "m" },
          { id: "models", label: t("Choose models…", "Выбрать модели…"), hotkey: "c" },
          {
            id: "clear",
            label: t("Clear", "Очистить"),
            hotkey: "x",
            tone: "danger",
            disabled: !configured.length,
          },
        ],
        items: (tabKey) =>
          tabKey === FAVORITE_TAB
            ? modelsAsRows(favs.map((id) => app.catalog.find((m) => m.id === id)!).filter(Boolean))
            : tabKey === "all"
              ? modelsAsRows(app.catalog)
              : items,
      }),
    );
    if (!res) return;

    if (res.kind === "action" && res.id !== "ask") {
      if (res.id === "models") {
        await brainPanelModal(app);
        continue;
      }
      if (res.id === "main") {
        // The button carries the row that was under the cursor; with nothing
        // under it (an empty panel, a header), the current choice stands.
        await setBrainMain(app, res.value ?? cfg.brainMainModel);
        continue;
      }
      if (res.id === "clear") {
        saveConfig({ brainModels: [], brainMainModel: "" }, { replace: ["brainModels"] });
        app.cfg = loadConfig();
        success(t("Panel cleared.", "Совет очищен."));
        continue;
      }
      continue;
    }

    // Enter returns the whole checked set, whichever tabs it was marked on.
    // Newly checked rows join the panel, unchecked rows leave it — in one save.
    if (res.kind === "item") {
      const next = [...new Set(res.values)];
      const added = next.filter((id) => !configured.includes(id));
      const removed = configured.filter((id) => !next.includes(id));
      if (!added.length && !removed.length) return;
      saveConfig(
        {
          brainModels: next,
          brainMainModel: cfg.brainMainModel && next.includes(cfg.brainMainModel) ? cfg.brainMainModel : "",
        },
        { replace: ["brainModels"] },
      );
      app.cfg = loadConfig();
      if (!next.length) return void success(t("Panel cleared.", "Совет очищен."));
      const delta = [added.length ? `+${added.length}` : "", removed.length ? `−${removed.length}` : ""]
        .filter(Boolean)
        .join(" ");
      success(
        t("Panel ({count}): {panel}", "Совет ({count}): {panel}", {
          count: next.length,
          panel: next.map(wireModelId).join(", "),
        }) + (delta ? c.dim(` · ${delta}`) : ""),
      );
      return;
    }

    // "Ask" is the button (and /brain <question>): the panel answers as a panel,
    // so which row the cursor was on never mattered.
    const panel = brainPanel(app);
    if (panel.length < 2) {
      brainNeedsPanel();
      return;
    }
    // The question goes through the ordinary composer, not a bare prompt line:
    // it looks and edits like every other message, and the answer that follows
    // grows from the same place the user just typed in.
    line();
    padded(c.bold(t("The question:", "Вопрос:")));
    const question = (await app.askComposer())?.trim();
    if (!question) return;
    await app.runBrain(question, panel);
    return;
  }
}

/** Saves the main model when it sits on the panel; says so either way. */
export async function setBrainMain(app: App, model: string | null): Promise<void> {
  if (!model) {
    hint(t("Put the cursor on a model first.", "Сначала поставьте курсор на модель."));
    return;
  }
  const panel = loadConfig().brainModels;
  if (!panel.includes(model)) {
    warn(
      t("{model} is not on the panel — add it before making it main.", "{model} нет в совете — сначала добавьте её.", {
        model: wireModelId(model),
      }),
    );
    return;
  }
  saveConfig({ brainMainModel: model });
  app.cfg = loadConfig();
  success(t("Main model: {model}", "Главная модель: {model}", { model: wireModelId(model) }));
}

/** The whole catalogue as picker rows — vendor sections, newest first. */
export function modelsAsRows(catalog: ModelInfo[]): PickerItem[] {
  const models = usableModels(catalog).filter((m) => servesModality(m, "text"));
  const bare = (id: string) => wireModelId(id);
  const width = Math.min(34, Math.max(...models.map((m) => bare(m.id).length)) + 1);
  const rows: PickerItem[] = [];
  for (const group of groupByVendor(models)) {
    rows.push({ value: `__${group.vendor}`, label: "", header: group.vendor });
    for (const m of group.models) {
      rows.push({
        value: m.id,
        label: bare(m.id).padEnd(width),
        hint: c.dim(providerLabel(splitModelId(m.id).providerId)),
        badge: incompatibleReason(m) ? "" : m.pricing ? `$${m.pricing.input}/$${m.pricing.output}` : "",
      });
    }
  }
  return rows;
}

// ── /swarm ────────────────────────────────────────────────────────────────

/** The roster as it would run right now: the chosen one, else the automatic pick. */
export function swarmNow(app: App): string[] {
  return swarmRoster(app.catalog, app.session.model, 3);
}

/** Who runs in the swarm — one multi-select spanning every connected host. */
export async function swarmPanelModal(app: App): Promise<void> {
  const cfg = loadConfig();
  const picked = await app.exclusiveInput(() =>
    pickModelsAcrossProviders({
      catalog: app.catalog,
      current: app.session.model,
      defaultModel: app.session.model,
      selected: cfg.swarmModels,
      allowEmpty: true,
      title: t("Roster for /swarm", "Рой для /swarm"),
      subtitle: t(
        "Space marks a model, ←→ switches provider, Enter confirms. Nothing marked — the roster is picked for you.",
        "Пробел отмечает модель, ←→ переключает поставщика, Enter подтверждает. Ничего не отмечено — рой подбирается сам.",
      ),
    }),
  );
  if (picked === null) return;
  // A synthesiser dropped from the roster cannot merge answers it never saw.
  saveConfig(
    { swarmModels: picked, swarmMainModel: picked.includes(cfg.swarmMainModel) ? cfg.swarmMainModel : "" },
    { replace: ["swarmModels"] },
  );
  app.cfg = loadConfig();
  if (!picked.length) {
    return void success(
      t("Roster cleared — /swarm picks its own models again.", "Список очищен — /swarm снова подбирает модели сам."),
    );
  }
  success(t("Swarm: {models}", "Рой: {models}", { models: picked.map(wireModelId).join(", ") }));
}

/** Saves the synthesiser when it sits on the roster; says so either way. */
export function setSwarmMain(app: App, model: string | null): void {
  if (!model) return hint(t("Put the cursor on a model first.", "Сначала поставьте курсор на модель."));
  if (!swarmNow(app).includes(model)) {
    return warn(
      t("{model} is not on the roster — add it before making it the synthesiser.", "{model} нет в рое — сначала добавьте её.", {
        model: wireModelId(model),
      }),
    );
  }
  saveConfig({ swarmMainModel: model });
  app.cfg = loadConfig();
  success(t("Synthesis: {model}", "Сведение: {model}", { model: wireModelId(model) }));
}

/** Asks for the task, then runs the roster the panel was showing. */
export async function askSwarm(app: App, roster: string[]): Promise<void> {
  if (roster.length < 2) {
    error(
      t(
        "A swarm needs at least two models this client can reach.",
        "Рою нужны хотя бы две модели, доступные этому клиенту.",
      ),
    );
    return void hint(t("Choose them with /swarm models", "Выбрать: /swarm models"));
  }
  line();
  padded(c.bold(t("The task:", "Задача:")));
  const task = (await app.askComposer())?.trim();
  if (!task) return;
  await runSwarm(app, task, roster);
}

/**
 * The roster as it stands, and the task to throw at it. Same shape as /brain:
 * the chosen models on the first tab, the stars and the catalogue behind it,
 * and Enter on a row there adds or removes it without a second panel.
 */
export async function swarmModal(app: App): Promise<void> {
  for (;;) {
    const cfg = loadConfig();
    const configured = cfg.swarmModels;
    const roster = swarmNow(app);
    // Nothing chosen — or nothing left of it — means the rows on the first tab
    // are the automatic pick rather than a saved list, and they say so.
    const auto = !configuredRoster(app.catalog).length;
    const synth = swarmMain(app.session.model, roster);
    const shown = configured.length ? configured : roster;
    // The name is padded before the mark is glued on, so the provider column
    // stays put: a coloured ★ is a dozen invisible characters wide.
    const width = Math.min(34, Math.max(...shown.map((id) => wireModelId(id).length), 0) + 2);
    const items: PickerItem[] = shown.map((id) => {
      const okHere = app.catalog.some((m) => m.id === id);
      const mark = id === synth ? c.brightGreen("★ ") : "  ";
      return {
        value: id,
        label: mark + wireModelId(id).padEnd(width),
        hint: okHere
          ? c.dim(providerLabel(splitModelId(id).providerId)) +
            (id === synth ? c.brightGreen(t("  · synthesis", "  · сведение")) : "")
          : c.red(t("✗ not reachable from here", "✗ отсюда недоступна")),
        badge: auto ? c.gray(t("auto", "авто")) : "",
      };
    });

    const tabs: PickerTab[] = [
      { key: "roster", label: t("Roster", "Рой"), count: shown.length },
    ];
    const favs = favoriteIds(app.catalog, app.session.model);
    if (favs.length) tabs.push({ key: FAVORITE_TAB, label: t("Favorites", "Избранное"), count: favs.length });
    const text = usableModels(app.catalog).filter((m) => servesModality(m, "text"));
    if (text.length) tabs.push({ key: "all", label: t("All models", "Все модели"), count: text.length });

    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("Swarm", "Рой"),
        subtitle: auto
          ? t(
              "Picked automatically — the session's model plus a different vendor each. Enter on a row in All models pins a roster.",
              "Подобран автоматически — модель сессии плюс по одной от других вендоров. Enter по строке во «Всех моделях» закрепит состав.",
            )
          : t(
              "★ merges the answers. Enter on a row in All models adds or removes it.",
              "★ сводит ответы. Enter по строке во «Всех моделях» добавляет или убирает её.",
            ),
        tabs,
        initialTab: "roster",
        search: false,
        empty: t("No models to run — connect a provider first.", "Моделей нет — сначала подключите поставщика."),
        groupGap: [FAVORITE_TAB, "all"],
        actions: [
          { id: "run", label: t("Run…", "Запустить…"), hotkey: "r", disabled: roster.length < 2 },
          { id: "main", label: t("Make synthesiser", "Сделать сводящей"), hotkey: "m" },
          { id: "models", label: t("Choose models…", "Выбрать модели…"), hotkey: "c" },
          {
            id: "clear",
            label: t("Clear", "Очистить"),
            hotkey: "x",
            tone: "danger",
            disabled: !configured.length,
          },
        ],
        items: (tabKey) =>
          tabKey === FAVORITE_TAB
            ? modelsAsRows(favs.map((id) => app.catalog.find((m) => m.id === id)!).filter(Boolean))
            : tabKey === "all"
              ? modelsAsRows(app.catalog)
              : items,
      }),
    );
    if (!res) return;

    if (res.kind === "action" && res.id !== "run") {
      if (res.id === "models") {
        await swarmPanelModal(app);
        continue;
      }
      if (res.id === "main") {
        // The button carries the row under the cursor; with nothing under it
        // (a header, an empty list) the current choice stands.
        setSwarmMain(app, res.value ?? cfg.swarmMainModel);
        continue;
      }
      if (res.id === "clear") {
        saveConfig({ swarmModels: [], swarmMainModel: "" }, { replace: ["swarmModels"] });
        app.cfg = loadConfig();
        success(t("Roster cleared — /swarm picks its own models again.", "Список очищен — /swarm снова подбирает модели сам."));
        continue;
      }
      continue;
    }

    // A row answered from the catalogue or the favorites tab pins or unpins a
    // member; from the roster tab, Enter runs. The tab comes back with it.
    if (res.kind === "item" && (res.tab === "all" || res.tab === FAVORITE_TAB)) {
      // The first pin freezes what was on screen: dropping the automatic pick
      // for one hand-chosen model would leave a swarm of one.
      const base = configured.length ? configured : roster;
      const next = base.includes(res.value) ? base.filter((m) => m !== res.value) : [...base, res.value];
      saveConfig(
        { swarmModels: next, swarmMainModel: cfg.swarmMainModel === res.value ? "" : cfg.swarmMainModel },
        { replace: ["swarmModels"] },
      );
      app.cfg = loadConfig();
      success(
        next.includes(res.value)
          ? t("Added: {model}", "Добавлена: {model}", { model: wireModelId(res.value) })
          : t("Removed: {model}", "Убрана: {model}", { model: wireModelId(res.value) }),
      );
      continue;
    }

    // "Run", and Enter on a roster row, are the same thing: the swarm runs as a
    // swarm, so which row the cursor was on never mattered.
    await askSwarm(app, swarmNow(app));
    return;
  }
}

// ── /subagents ────────────────────────────────────────────────────────────

/** Only what this key can actually launch a subagent on — the tool's own rule. */
export function subagentPool(app: App, providerId: string) {
  return providerModels(app, providerId).filter((m) => m.chatCapable !== false && servesModality(m, "text"));
}

export function noSubagentModels(providerId: string): void {
  error(
    t("{provider} has no model a subagent could run on.", "У {provider} нет моделей для субагентов.", {
      provider: providerLabel(providerId),
    }),
  );
}

/** Puts one more model on the list without walking the whole catalogue. */
export function addSubagentModel(app: App, named: string): void {
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
        "{model} is not a model of {provider} a subagent could run on.",
        "{model} — не модель {provider}, на которой может работать субагент.",
        { model: added, provider: providerLabel(provider) },
      ),
    );
  }
  const current = loadConfig().subagentModels?.[provider] ?? [];
  // Adding a model to the list is asking for the list to be used.
  saveConfig({
    subagentModels: { [provider]: [...new Set([...current, added])] },
    subagentMode: { [provider]: "list" },
  });
  app.cfg = loadConfig();
  app.rebuildTools();
  success(
    t("{provider}: subagents also run on {model}.", "{provider}: субагенты работают также на {model}.", {
      provider: providerLabel(provider),
      model: wireModelId(added),
    }),
  );
}

/**
 * Switches between the two ways subagents get a model. The chosen list is left
 * in the config either way — "the session's model" is a mode, not a wipe, so
 * coming back to a list of five costs one keystroke instead of five choices.
 */
export function setSubagentMode(app: App, mode: "session" | "list"): void {
  const provider = currentProviderId(app);
  const list = loadConfig().subagentModels?.[provider] ?? [];
  if (mode === "list" && !list.length) {
    warn(
      t("{provider} has no list yet — mark the models first.", "У {provider} ещё нет списка — сначала отметьте модели.", {
        provider: providerLabel(provider),
      }),
    );
    return void hint(t("Space marks a model, Enter saves.", "Пробел отмечает модель, Enter сохраняет."));
  }
  saveConfig({ subagentMode: { [provider]: mode } });
  app.cfg = loadConfig();
  app.rebuildTools();
  if (mode === "session") {
    return void success(
      t(
        "{provider}: subagents run on the session's model{kept}.",
        "{provider}: субагенты работают на модели сессии{keptRu}.",
        {
          provider: providerLabel(provider),
          kept: list.length ? ` — the list of ${list.length} is kept, unused` : "",
          keptRu: list.length ? ` — список из ${list.length} сохранён, но не используется` : "",
        },
      ),
    );
  }
  success(
    t("Subagents on {provider}: {models}", "Субагенты у {provider}: {models}", {
      provider: providerLabel(provider),
      models: list.map(wireModelId).join(", "),
    }),
  );
}

/** Forgets the list for this provider, and with it the choice of using one. */
export function clearSubagentModels(app: App): void {
  const provider = currentProviderId(app);
  const models = { ...loadConfig().subagentModels };
  const modes = { ...loadConfig().subagentMode };
  delete models[provider];
  delete modes[provider];
  saveConfig({ subagentModels: models, subagentMode: modes }, { replace: ["subagentModels", "subagentMode"] });
  app.cfg = loadConfig();
  app.rebuildTools();
  success(
    t(
      "{provider}: the list is gone — subagents run on the session's model.",
      "{provider}: список удалён — субагенты работают на модели сессии.",
      { provider: providerLabel(provider) },
    ),
  );
}

export function setSubagentAuto(app: App, enabled: boolean): void {
  const provider = currentProviderId(app);
  saveConfig({ subagentAuto: { [provider]: enabled } });
  app.cfg = loadConfig();
  app.rebuildTools();
  success(t("{provider}: subagent auto {state}.", "{provider}: авто запуск субагентов {stateRu}.", {
    provider: providerLabel(provider),
    state: enabled ? "on" : "off",
    stateRu: enabled ? "включён" : "выключен",
  }));
}

export async function subagentsModal(app: App, required = false): Promise<void> {
  for (;;) {
    const provider = currentProviderId(app);
    const pool = subagentPool(app, provider);
    if (!pool.length) return noSubagentModels(provider);
    const current = loadConfig().subagentModels?.[provider] ?? [];
    // Two ways to get a model, and the panel says which one is in force: the
    // marks stay on screen in either, so the list is never lost to a mode.
    const mode = subagentMode(provider);
    const auto = loadConfig().subagentAuto?.[provider] === true;
    const onSession = t("the session's model", "модель сессии");
    const onList = t("the {count} marked below", "{count} отмеченных ниже", { count: current.length });

    const res = await app.exclusiveInput(() =>
      openModelsModal({
        // No favoritesCatalog here: a subagent runs on the key the session is
        // using, so the task tool only ever offers this provider's models — a
        // star from another host would be marked and then silently dropped.
        catalog: pool,
        current: app.session.model,
        defaultModel: app.session.model,
        selected: current,
        allowEmpty: true,
        title: required ? t("Choose models to launch subagents", "Выберите модели для запуска субагентов") : t("Models for subagents", "Модели для субагентов"),
        subtitle: t(
          "{provider} · auto {auto} · subagents run on {target}{kept} · Space marks a model, Enter saves and uses the list.",
          "{provider} · auto {auto} · субагенты работают на: {target}{keptRu} · Пробел отмечает модель, Enter сохраняет и включает список.",
          {
            provider: providerLabel(provider),
            auto: auto ? "on" : "off",
            target: mode === "list" ? onList : onSession,
            kept: mode === "session" && current.length ? ` · a list of ${current.length} is kept, unused` : "",
            keptRu: mode === "session" && current.length ? ` · список из ${current.length} сохранён, но не используется` : "",
          },
        ),
        actions: [
          { id: "auto", label: auto ? t("Auto: on", "Авто: вкл") : t("Auto: off", "Авто: выкл"), hotkey: "u" },
          mode === "list"
            ? { id: "session", label: t("Use the session's model", "Только модель сессии"), hotkey: "a" }
            : {
                id: "list",
                label: t("Use the marked list", "Использовать список"),
                hotkey: "a",
                disabled: !current.length,
              },
          { id: "refresh", label: t("Refresh", "Обновить"), hotkey: "r" },
          {
            id: "clear",
            label: t("Forget the list", "Удалить список"),
            hotkey: "x",
            tone: "danger",
            disabled: !current.length,
          },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "action") {
      if (res.id === "auto") {
        setSubagentAuto(app, !auto);
        continue;
      }
      if (res.id === "session") return setSubagentMode(app, "session");
      if (res.id === "list") return setSubagentMode(app, "list");
      if (res.id === "clear") return clearSubagentModels(app);
      if (res.id === "refresh") {
        await refreshCatalog(app);
        continue;
      }
      continue;
    }

    // Marking models is choosing to use them; marking none is the other mode.
    saveConfig({
      subagentModels: { [provider]: res.values },
      subagentMode: { [provider]: res.values.length ? "list" : "session" },
    });
    app.cfg = loadConfig();
    app.rebuildTools();
    if (!res.values.length) {
      return void success(
        t("{provider}: the session's model only.", "{provider}: только модель сессии.", { provider: providerLabel(provider) }),
      );
    }
    return void success(
      t("Subagents on {provider}: {models}", "Субагенты у {provider}: {models}", {
        provider: providerLabel(provider),
        models: res.values.map(wireModelId).join(", "),
      }),
    );
  }
}
