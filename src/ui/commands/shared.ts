/** Types and helpers shared by the slash-command modules. */
import { warn } from "../render.js";
import { loadConfig, saveConfig, rememberProjectState, type Effort } from "../../config.js";
import { findModel, incompatibleReason } from "../../provider/models.js";
import { providerState, rememberProviderState, splitModelId } from "../../provider/registry.js";
import { t, count } from "../../i18n.js";
import type { App } from "../repl.js";

export type Group = "main" | "session" | "settings" | "other";

export const GROUP_ORDER: Group[] = ["main", "session", "settings", "other"];

/** Group headings, shown by /help and the command index. */
export const groupLabel = (g: Group): string =>
  ({
    main: t("main", "основное"),
    session: t("session", "сессия"),
    settings: t("settings", "настройки"),
    other: t("other", "прочее"),
  })[g];

export const effortHint = (e: Effort): string =>
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
export type Text = string | (() => string);
export const txt = (v?: Text): string => (typeof v === "function" ? v() : (v ?? ""));

export interface Command {
  name: string;
  group: Group;
  args?: Text;
  help: Text;
  /** Returns false to exit the REPL. */
  run(app: App, rest: string): Promise<boolean | void>;
}

/** "500k", "2m", "128000" → a token count; null when it is not one. */
export function parseTokens(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1);
  return n >= 1000 && n <= 20e6 ? Math.round(n) : null;
}

/** Which provider the session is currently talking to. */
export function currentProviderId(app: App): string {
  return splitModelId(app.session.model).providerId;
}

export function providerModels(app: App, providerId: string) {
  return app.catalog.filter((m) => splitModelId(m.id).providerId === providerId);
}

/**
 * The model to land on when switching to a provider: where it was left last,
 * else the alias login created, else the configured default when it belongs
 * there, else whatever the provider offers first.
 */
export function defaultModelFor(app: App, providerId: string): string | null {
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
export function setModel(app: App, id: string): void {
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

/** Says so plainly when a chosen model cannot be driven through this client. */
export function warnIfIncompatible(app: App, id: string): void {
  const m = findModel(id, app.catalog);
  const why = m ? incompatibleReason(m) : null;
  if (!why) return;
  warn(t(`${id} cannot be driven through /v1/chat/completions — ${why}. Requests to it will fail.`, `${id} нельзя вести через /v1/chat/completions — ${why}. Запросы к ней будут падать.`));
}
