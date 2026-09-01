/**
 * The model chooser: a favorites tab, then one tab per connected provider,
 * each listing its models under lab sections.
 */
import { c } from "./ansi.js";
import {
  openModal,
  pick,
  pickMulti,
  type ModalAction,
  type ModalResult,
  type PickerItem,
  type PickerOptions,
  type PickerTab,
} from "./picker.js";

import { fmtTokens } from "../usage.js";
import { groupByVendor, incompatibleReason, usableModels } from "../provider/models.js";
import { providerLabel, splitModelId, wireModelId } from "../provider/registry.js";
import { loadConfig, saveConfig } from "../config.js";
import { t } from "../i18n.js";
import { success, hint } from "./render.js";
import type { ModelInfo } from "../types.js";

export interface ModelPickerOptions {
  catalog: ModelInfo[];
  current: string;
  defaultModel: string;
  /** Heading for the list; the default names it "Models". */
  title?: string;
  /** One line under the title — what this list is scoped to, usually. */
  subtitle?: string;
  /** Buttons along the foot of the panel. */
  actions?: ModalAction[];
  /** Multi-select only: Enter with nothing marked answers with an empty set. */
  allowEmpty?: boolean;
  /** Show every model, including ones this client cannot drive. */
  includeIncompatible?: boolean;
  /**
   * The favorites tab: on for every place a person picks one model — leaving
   * it off there would make a star they cannot reach. Set-lists that act per
   * row instead (the brain panel, the subagent pool) drop it: their tabs are
   * already scoped by provider.
   */
  favoritesTab?: boolean;
  /**
   * Pool the favorites tab draws from, when it is wider than `catalog`. The
   * model chooser narrows `catalog` to one provider and passes the whole
   * catalogue here, so the stars keep spanning every host and picking one
   * switches the session across providers. Panels whose answer must be
   * callable by the provider in use leave this unset: their own pool then
   * bounds the stars too.
   */
  favoritesCatalog?: ModelInfo[];
  /**
   * The built-in favorite button, on unless switched off. It answers with
   * itself and the panel handles it — stars flip and the panel comes straight
   * back — so callers never see the action at all.
   */
  favoriteAction?: boolean;
  /** Passed through to the panel: lets the caller repaint it while open. */
  onOpen?: PickerOptions["onOpen"];
}

/**
 * Reads the stars; only ones this catalog still serves are shown. Given the
 * model in use, the favoritesAllProviders setting applies too — off, the list
 * narrows to the host that model belongs to.
 */
export function favoriteIds(catalog: ModelInfo[], current?: string): string[] {
  const cfg = loadConfig();
  const here = current ? splitModelId(current).providerId : "";
  return cfg.favoriteModels.filter(
    (id) =>
      catalog.some((m) => m.id === id) &&
      (!here || cfg.favoritesAllProviders !== false || splitModelId(id).providerId === here),
  );
}

/** Marks or unmarks one model. Returns whether it is starred now. */
export function toggleFavorite(id: string): boolean {
  const cfg = loadConfig();
  const next = cfg.favoriteModels.includes(id)
    ? cfg.favoriteModels.filter((m) => m !== id)
    : [...cfg.favoriteModels, id];
  saveConfig({ favoriteModels: next }, { replace: ["favoriteModels"] });
  return next.includes(id);
}

/**
 * Rows for one pool of models: lab sections, newest first inside each. A pool
 * spanning several hosts carries the provider next to the name — the same
 * model served by two of them is two rows, and only that column tells them
 * apart. `byName` sorts on the bare name instead of the date, so those two
 * rows land side by side; the favorites tab uses it.
 */
function poolRows(opts: ModelPickerOptions, models: ModelInfo[], byName = false): PickerItem[] {
  if (!models.length) return [];

  // Names are shown without their routing prefix — a column of repeated
  // "alibabacloud:" is width spent on nothing. The full id stays the row's
  // value, so both spellings still match when typing to filter.
  const bare = (id: string) => wireModelId(id);
  const host = (id: string) => providerLabel(splitModelId(id).providerId);
  const hosts = new Set(models.map((m) => splitModelId(m.id).providerId));
  const width = Math.min(34, Math.max(...models.map((m) => bare(m.id).length)) + 1);
  // Only worth a column when the list actually spans more than one host —
  // the favorites tab does, a single provider's tab does not.
  const hostWidth = hosts.size > 1 ? Math.max(...models.map((m) => host(m.id).length)) + 2 : 0;
  const rows: PickerItem[] = [];

  for (const group of groupByVendor(models)) {
    rows.push({ value: `__${group.vendor}`, label: "", header: group.vendor });
    const list = byName
      ? [...group.models].sort(
          (a, b) => bare(a.id).localeCompare(bare(b.id)) || host(a.id).localeCompare(host(b.id)),
        )
      : group.models;
    for (const m of list) {
      const why = incompatibleReason(m);
      const marks = [
        m.id === opts.defaultModel ? c.brightGreen("★") : "",
        m.id === opts.current ? c.brightCyan("●") : "",
      ]
        .filter(Boolean)
        .join("");
      const ctxWin = m.contextWindow ? `ctx ${fmtTokens(m.contextWindow)}` : "";
      const price = m.pricing ? `$${m.pricing.input}/$${m.pricing.output}` : "";
      rows.push({
        value: m.id,
        label: bare(m.id).padEnd(width),
        // The provider rides in the hint rather than the label: typing
        // "openrouter" then filters to it, and the dim is the picker's own.
        hint: [hostWidth ? host(m.id).padEnd(hostWidth) : "", marks, ctxWin].filter(Boolean).join(" "),
        badge: why ? c.red(why) : price,
      });
    }
  }
  return rows;
}

export const FAVORITE_TAB = "favorite";
const FAVORITE_ACTION = "favorite";

/**
 * The models behind the favorites tab: every host the panel's pool reaches,
 * since the tab is how one switches between them — unless the setting says to
 * keep it to the provider in use, which favoriteIds applies.
 */
function favoritePool(opts: ModelPickerOptions): ModelInfo[] {
  const byId = new Map((opts.favoritesCatalog ?? opts.catalog).map((m) => [m.id, m]));
  return favoriteIds([...byId.values()], opts.current)
    .map((id) => byId.get(id))
    .filter((m): m is ModelInfo => Boolean(m));
}

/**
 * Tabs = Favorites, then every provider the catalog knows. Ordered with the
 * session's host first, the rest alphabetical — ←→ walks them without leaving
 * the list, and whichever lab sits behind each tab is grouped inside it.
 */
function providerTabs(opts: ModelPickerOptions, withFavorites = true): PickerTab[] {
  const models = opts.includeIncompatible ? opts.catalog : usableModels(opts.catalog);
  const here = splitModelId(opts.current).providerId;
  const ids = [...new Set(models.map((m) => splitModelId(m.id).providerId))].sort((a, b) =>
    (a === here ? "" : providerLabel(a)).localeCompare(b === here ? "" : providerLabel(b)),
  );
  const tabs: PickerTab[] = withFavorites
    ? [{ key: FAVORITE_TAB, label: t("Favorites", "Избранное"), count: favoritePool(opts).length }]
    : [];
  for (const id of ids) {
    tabs.push({
      key: id,
      label: providerLabel(id),
      count: models.filter((m) => splitModelId(m.id).providerId === id).length,
    });
  }
  return tabs;
}

function itemsFor(opts: ModelPickerOptions, tabKey: string): PickerItem[] {
  const models = opts.includeIncompatible ? opts.catalog : usableModels(opts.catalog);
  if (tabKey === FAVORITE_TAB) return poolRows(opts, favoritePool(opts), true);
  return poolRows(
    opts,
    models.filter((m) => splitModelId(m.id).providerId === tabKey),
  );
}

const FAVORITE_BUTTON: ModalAction = {
  id: FAVORITE_ACTION,
  label: t("Toggle favorite", "В избранное"),
  hotkey: "f",
};

function withFavoriteButton(actions: ModalAction[] | undefined, on: boolean): ModalAction[] {
  const rest = (actions ?? []).filter((a) => a.id !== FAVORITE_ACTION);
  return on ? [...rest, FAVORITE_BUTTON] : rest;
}

/**
 * Runs the panel, absorbing the favorite button: stars flip with a word of
 * feedback and the same panel comes straight back, so unstarring from the
 * favorites tab costs nothing. Everything else is handed to the caller as is.
 */
async function runPanel(
  open: (actions: ModalAction[]) => Promise<ModalResult | null>,
  opts: ModelPickerOptions,
): Promise<ModalResult | null> {
  for (;;) {
    const res = await open(withFavoriteButton(opts.actions, opts.favoriteAction !== false));
    if (res?.kind === "action" && res.id === FAVORITE_ACTION) {
      if (!res.value) continue;
      const on = toggleFavorite(res.value);
      if (on)
        success(
          t(
            `Favorite: ${c.brightMagenta(wireModelId(res.value))}`,
            `В избранном: ${c.brightMagenta(wireModelId(res.value))}`,
          ),
        );
      else hint(t(`Removed from favorites: ${wireModelId(res.value)}`, `Убрана из избранного: ${wireModelId(res.value)}`));
      continue;
    }
    return res;
  }
}

const EMPTY_FAVORITES = (): string =>
  t(
    "No favorites yet — put the cursor on a model and hit the Toggle favorite button.",
    "Избранных пока нет — поставьте курсор на модель и нажмите кнопку «В избранное».",
  );

/**
 * The favorites editor: the same provider tabs, checkboxes instead of a
 * one-row toggle. Space marks and unmarks while scrolling — across tabs too,
 * the marks survive a tab switch — Enter saves the whole set and Esc throws
 * the session's edits away. Clearing everything is a button, not an accident:
 * an Enter on an empty set just says so and keeps the panel up.
 */
export async function editFavorites(
  opts: ModelPickerOptions & { selected?: string[] },
): Promise<string[] | null> {
  const actions: ModalAction[] = [
    { id: "fav-save", label: t("Save", "Сохранить"), hotkey: "s" },
    { id: "fav-clear", label: t("Clear all", "Очистить всё"), hotkey: "x", tone: "danger" },
  ];
  for (;;) {
    const res = await openModal({
      title: opts.title ?? t("Favorites", "Избранное"),
      subtitle:
        opts.subtitle ??
        t(
          "Space marks or clears a model, ←→ switches provider, Enter saves. Preselected — already starred.",
          "Пробел отмечает или снимает модель, ←→ переключает поставщика, Enter сохраняет. Отмечено то, что уже в избранном.",
        ),
      tabs: providerTabs(opts),
      initialTab: FAVORITE_TAB,
      initial: opts.current,
      // The stars as saved, not favoriteIds(): that one hides ids the catalog
      // in hand cannot serve, and Enter writes the whole set back — a host
      // that is logged out, or still loading, would lose its favorites.
      selected: opts.selected ?? loadConfig().favoriteModels,
      allowEmpty: true,
      empty: EMPTY_FAVORITES(),
      groupGap: true,
      items: (tabKey) => itemsFor({ ...opts, includeIncompatible: false }, tabKey),
      actions,
      multi: true,
    });
    if (!res) return null; // Esc — leave things as they are
    if (res.kind === "action") {
      if (res.id === "fav-clear") return [];
      if (res.id === "fav-save") return res.values;
      continue;
    }
    // Enter: non-empty set answers; on an empty one say so and keep editing.
    if (!res.values.length) {
      hint(
        t(
          "Nothing marked — clear all with the button, or Esc to leave as is.",
          "Ничего не отмечено — очистить всё можно кнопкой, либо Esc, чтобы оставить как есть.",
        ),
      );
      continue;
    }
    return res.values;
  }
}

/**
 * The panel itself, buttons and all. The caller loops on the result: a button
 * changes what the list is showing and the panel comes straight back up, so
 * refreshing a catalogue or widening the scope never costs a re-typed command.
 */
export function openModelModal(opts: ModelPickerOptions): Promise<ModalResult | null> {
  const showFavs = opts.favoritesTab !== false && favoritePool(opts).length > 0;
  return runPanel(
    (actions) =>
      openModal({
        title: opts.title ?? "Models",
        // A getter, like the rows: the subtitle is redrawn on every repaint,
        // so a caller counting models keeps that number honest while the
        // catalog is still loading behind the panel.
        get subtitle() {
          return opts.subtitle;
        },
        tabs: providerTabs(opts),
        initialTab: showFavs ? FAVORITE_TAB : splitModelId(opts.current).providerId,
        initial: opts.current,
        actions,
        empty: EMPTY_FAVORITES(),
        // Lab sections read as groups on every tab.
        groupGap: true,
        items: (tabKey) => itemsFor(opts, tabKey),
        onOpen: opts.onOpen,
      }),
    opts,
  );
}

export async function pickModel(opts: ModelPickerOptions): Promise<string | null> {
  const showFavs = opts.favoritesTab !== false && favoritePool(opts).length > 0;
  const res = await runPanel(
    async (actions) => {
      const value = await pick({
        title: opts.title ?? "Models",
        subtitle: opts.subtitle,
        tabs: providerTabs(opts),
        initialTab: showFavs ? FAVORITE_TAB : splitModelId(opts.current).providerId,
        initial: opts.current,
        empty: EMPTY_FAVORITES(),
        groupGap: true,
        items: (tabKey) => itemsFor(opts, tabKey),
      });
      // `pick` folds the panel down to a bare value; re-wrap it so runPanel can
      // treat a favorites-tab answer like any other.
      return value === null ? null : ({ kind: "item", value, values: [value], tab: "" } as ModalResult);
    },
    opts,
  );
  return res && res.kind === "item" ? res.value : null;
}

/**
 * The same tabs, choosing several — for the places where a set is the answer
 * rather than one model: which models subagents may be launched on.
 */
export async function pickModels(opts: ModelPickerOptions & { selected?: string[] }): Promise<string[] | null> {
  const res = await runPanel(
    async () => {
      const values = await pickMulti({
        title: opts.title ?? "Models",
        subtitle: opts.subtitle,
        tabs: providerTabs(opts),
        initialTab: splitModelId(opts.current).providerId,
        initial: opts.current,
        selected: opts.selected,
        allowEmpty: opts.allowEmpty,
        empty: EMPTY_FAVORITES(),
        groupGap: true,
        items: (tabKey) => itemsFor(opts, tabKey),
      });
      return values === null
        ? null
        : ({ kind: "item", value: values[0] ?? "", values, tab: "" } as ModalResult);
    },
    opts,
  );
  return res && res.kind === "item" ? res.values : null;
}

/** The multi-select panel with its buttons, for callers that act on them. */
export function openModelsModal(
  opts: ModelPickerOptions & { selected?: string[] },
): Promise<ModalResult | null> {
  return runPanel((actions) =>
    openModal({
      title: opts.title ?? "Models",
      subtitle: opts.subtitle,
      tabs: providerTabs(opts),
      initialTab: splitModelId(opts.current).providerId,
      initial: opts.current,
      selected: opts.selected,
      allowEmpty: opts.allowEmpty,
      actions,
      empty: EMPTY_FAVORITES(),
      groupGap: true,
      items: (tabKey) => itemsFor(opts, tabKey),
      multi: true,
    }),
    opts,
  );
}

/**
 * Several models, from several hosts — the tabs are the providers rather than
 * the output types. A panel of models from one vendor shares that vendor's
 * blind spots, so crossing hosts is the point rather than an edge case, and
 * ←/→ is how you get there without leaving the list.
 */
export async function pickModelsAcrossProviders(
  opts: ModelPickerOptions & { selected?: string[] },
): Promise<string[] | null> {
  const text = usableModels(opts.catalog).filter((m) => servesText(m));
  const providers = [...new Set(text.map((m) => splitModelId(m.id).providerId))].sort((a, b) =>
    providerLabel(a).localeCompare(providerLabel(b)),
  );
  const tabs: PickerTab[] = [
    ...(opts.favoritesTab === false
      ? []
      : [
          {
            key: FAVORITE_TAB,
            label: t("Favorites", "Избранное"),
            count: favoritePool({ ...opts, favoritesCatalog: text }).length,
          },
        ]),
    ...providers.map((id) => ({
      key: id,
      label: providerLabel(id),
      count: text.filter((m) => splitModelId(m.id).providerId === id).length,
    })),
  ];
  const here = splitModelId(opts.current).providerId;

  return pickMulti({
    title: opts.title ?? "Models",
    subtitle: opts.subtitle,
    tabs,
    initialTab: splitModelId(opts.current).providerId,
    initial: opts.current,
    selected: opts.selected,
    allowEmpty: opts.allowEmpty,
    actions: withFavoriteButton(opts.actions, false),
    empty: EMPTY_FAVORITES(),
    groupGap: true,
    items: (tabKey) => {
      if (tabKey === FAVORITE_TAB) {
        return poolRows(
          { ...opts, includeIncompatible: true },
          favoritePool({ ...opts, favoritesCatalog: text }),
          true,
        );
      }
      return poolRows(
        { ...opts, includeIncompatible: true },
        text.filter((m) => splitModelId(m.id).providerId === (tabKey || providers[0])),
      );
    },
  });
}

/** A text-capable chat model — what every panel here offers. */
function servesText(m: ModelInfo): boolean {
  return (m.modalities ?? [m.modality ?? "text"]).includes("text");
}
