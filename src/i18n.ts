/**
 * Interface language.
 *
 * English is the key: a string is still written where it is used, with the
 * Russian text beside it, and `t("Model", "Модель")` keeps both visible in the
 * code that prints them. The other languages live in catalogues keyed by that
 * same English text (`src/i18n/<code>.ts`), so adding one is one file and no
 * call site changes — and a string that has no translation yet falls back to
 * English instead of disappearing.
 *
 * Text with a value in it is written as a template:
 * `t("Deleted {id}", "Удалена {id}", { id })`. Only the interface is
 * translated. Model ids, provider names, paths, commands and anything the API
 * returns stay as they are.
 */
import { loadConfig, type Lang } from "./config.js";
import { catalogs } from "./i18n/catalogs.js";

export type Params = Record<string, string | number>;

export interface Catalog {
  /** English source string → translation. */
  strings: Record<string, string>;
  /**
   * Plural forms for `count(...)`, keyed by the English pair (`model|models`).
   * Categories are the CLDR ones; a language fills in the forms its own rule
   * uses and the rest fall back to `other`.
   */
  plurals?: Record<string, Partial<Record<Intl.LDMLPluralRule, string>>>;
}

export function lang(): Lang {
  return loadConfig().lang;
}

function catalogFor(language: Lang): Catalog | undefined {
  if (language === "en" || language === "ru") return undefined;
  return catalogs[language];
}

const FILL = /\{(\w+)\}/g;

/** Replaces `{name}` with the value; an unknown name stays as it was written. */
function fill(text: string, params: Params): string {
  return text.replace(FILL, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Picks the string for the current language. */
export function t(en: string, ru: string, params?: Params): string {
  const language = lang();
  const text = language === "ru" ? ru : language === "en" ? en : catalogFor(language)?.strings[en] ?? en;
  return params ? fill(text, params) : text;
}

/**
 * Russian needs three plural forms where English needs two: 1 модель,
 * 2 модели, 5 моделей. The rule is on the last two digits, not the value.
 */
export function plural3(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const pluralRules = new Map<string, Intl.PluralRules>();

function pluralRule(language: string): Intl.PluralRules {
  let rule = pluralRules.get(language);
  if (!rule) {
    rule = new Intl.PluralRules(language);
    pluralRules.set(language, rule);
  }
  return rule;
}

/**
 * A count with its noun in whichever language is on: the English pair, the
 * Russian triple, or the catalogue's forms for the languages that need neither.
 * `n(3, ["model","models"], ["модель","модели","моделей"])`.
 */
export function count(n: number, en: [string, string], ru: [string, string, string]): string {
  const language = lang();
  if (language === "ru") return `${n} ${plural3(n, ru[0], ru[1], ru[2])}`;
  if (language !== "en") {
    const forms = catalogFor(language)?.plurals?.[`${en[0]}|${en[1]}`];
    if (forms) {
      const word = forms[pluralRule(language).select(n)] ?? forms.other ?? forms.one;
      if (word) return `${n} ${word}`;
    }
  }
  return `${n} ${n === 1 ? en[0] : en[1]}`;
}
