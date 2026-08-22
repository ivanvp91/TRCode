/**
 * Interface language.
 *
 * No key catalogue: a string is written where it is used, in both languages at
 * once. `t("Model", "Модель")` keeps the English text visible in the code that
 * prints it — a catalogue would move it two files away and make every message
 * a lookup that can silently go missing.
 *
 * Only the interface is translated. Model ids, provider names, paths, commands
 * and anything the API returns stay as they are.
 */
import { loadConfig, type Lang } from "./config.js";

export function lang(): Lang {
  return loadConfig().lang;
}

/** Picks the string for the current language. */
export function t(en: string, ru: string): string {
  return lang() === "ru" ? ru : en;
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

/**
 * A count with its noun in whichever language is on: the English pair, or the
 * Russian triple. `n(3, ["model","models"], ["модель","модели","моделей"])`.
 */
export function count(n: number, en: [string, string], ru: [string, string, string]): string {
  if (lang() === "ru") return `${n} ${plural3(n, ru[0], ru[1], ru[2])}`;
  return `${n} ${n === 1 ? en[0] : en[1]}`;
}
