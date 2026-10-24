/**
 * One catalogue per interface language. English is the source text and lives in
 * the call sites; Russian lives there too (`t("Model", "Модель")`). Everything
 * else is a file in this directory, keyed by the English string, so a missing
 * translation simply reads in English.
 */
import type { Lang } from "../config.js";
import type { Catalog } from "../i18n.js";
import de from "./de.js";
import es from "./es.js";
import fr from "./fr.js";
import id from "./id.js";
import it from "./it.js";
import ja from "./ja.js";
import ms from "./ms.js";
import pl from "./pl.js";
import pt from "./pt.js";
import uk from "./uk.js";
import zh from "./zh.js";

export const catalogs: Record<Exclude<Lang, "en" | "ru">, Catalog> = { de, es, fr, id, it, ja, ms, pl, pt, uk, zh };
