/**
 * The UI library: what a design request finds in it, and what happens when it
 * finds nothing.
 *
 * Two halves are asserted here. The match, because it decides which mockup a
 * "нарисуй дизайн …" turn is drawn in — a wrong pick silently redesigns the
 * request in someone else's palette. And the blend, because fusing several
 * saved styles into one is a synthesis instruction, not a concatenation: if
 * every source no longer reaches the model, the model averages what is left.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-uilib-home-"));
process.env.TRCODE_HOME = HOME;

const { saveEntry, listEntries, getEntry, deleteEntry, slugify, uiLibraryDir } = await import("../dist/ui-library/store.js");
const { isDesignRequest, matchLibrary, designInjection, blendInjection } = await import("../dist/ui-library/match.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// ── storage ─────────────────────────────────────────────────────────────────
check("an empty library lists nothing", listEntries().length === 0);
check("slugify keeps it a folder name", slugify("SaaS · Dark!") === "saas-dark");

const add = (slug, title, summary, keywords) =>
  saveEntry({ slug, title, summary, keywords, addedAt: Date.now() }, `# ${title}\n\nPalette: ...`);

add("saas-dark", "SaaS · dark", "Dense dark dashboard, cyan accents", ["saas", "dashboard", "dark", "тёмный"]);
add("terminal-green", "Terminal · green", "Phosphor terminal, monospace everything", ["terminal", "cli", "терминал", "monospace"]);
add("docs-light", "Docs · light", "Airy documentation site", ["docs", "documentation", "документация", "light"]);

check("three entries land", listEntries().length === 3);
check("the brief comes back with the entry", getEntry("saas-dark")?.brief.includes("Palette"));
check("a missing entry is null, not a throw", getEntry("nope") === null);
let clashed = false;
try { add("saas-dark", "SaaS · dark", "again", []); } catch { clashed = true; }
check("saving over an entry refuses", clashed);

// A folder without entry.json is skipped rather than crashing the listing.
fs.mkdirSync(path.join(uiLibraryDir(), "junk"), { recursive: true });
check("a broken folder costs only itself", listEntries().length === 3);

// ── is this a design request at all ─────────────────────────────────────────
for (const yes of [
  "нарисуй дизайн лендинга",
  "сделай дизайн для дашборда",
  "design a pricing page",
  "нужен макет личного кабинета",
  "redesign the settings screen",
]) check(`design request: "${yes}"`, isDesignRequest(yes) === true);

for (const yes of [
  "нужны макеты для трёх экранов",
  "покажи макет страницы оплаты",
]) check(`design request through an ending: "${yes}"`, isDesignRequest(yes) === true);

// A phrase has to be a phrase: matched as a bare substring, "ui for" lives
// inside "gui format" and every one of these turns into a mockup picker.
for (const no of [
  "почини баг в дизайне базы данных",  // "дизайн" alone is not a request to draw
  "run the tests",
  "объясни, как работает роутер",
  "the gui format is wrong",           // ← "ui for"
  "prediction the model made",         // ← "design the" is not in here either
  "CONFIRMED — save it now",           // the answer to the save gate, not a request
  "kit ui kitchen sink",
]) check(`not a design request: "${no}"`, isDesignRequest(no) === false);

// Talking about the feature is not using it. The message that spec'd this very
// picker — "когда мы говорим нарисуй дизайн … должно быть 3 кнопки" — opened it.
for (const no of [
  "и так, когда мы говорим нарисуй дизайн и подключается uilib, должно быть 3 кнопки",
  "когда мы говорим нарисуй дизайн, должен открываться модал",
  "если пользователь пишет сделай макет, покажи список",
  "when the user says design a landing page, show the picker",
  "фраза «нарисуй дизайн» должна открывать библиотеку",
  "в uilib должно быть три кнопки: выбрать, смешать, с нуля",
]) check(`meta-talk is not a design request: "${no}"`, isDesignRequest(no) === false);

// …but the same words at the front of a sentence still are.
for (const yes of [
  "нарисуй дизайн модалки, должно быть 3 кнопки",
  "сделай макет лендинга, если получится — тёмный",
  "design a pricing page when you have a moment",
]) check(`a real request survives the meta guard: "${yes}"`, isDesignRequest(yes) === true);

// ── matching ────────────────────────────────────────────────────────────────
const m1 = matchLibrary("нарисуй дизайн тёмного дашборда для saas");
check("the saas mockup wins its own request", m1[0]?.entry.slug === "saas-dark", JSON.stringify(m1.map((m) => [m.entry.slug, m.score])));
check("the reason for the match is reported", m1[0]?.via.length > 0);

const m2 = matchLibrary("сделай дизайн для терминала");
check("a keyword matches through its ending", m2[0]?.entry.slug === "terminal-green", JSON.stringify(m2.map((m) => [m.entry.slug, m.score])));

check("an unrelated request matches nothing", matchLibrary("нарисуй дизайн упаковки для чая").length === 0);
check("noise words alone do not match", matchLibrary("нарисуй дизайн").length === 0);

// ── what reaches the model ──────────────────────────────────────────────────
const one = getEntry("saas-dark");
const inj = designInjection(one.entry, one.brief, true);
check("a single reference carries the brief", inj.includes("Palette") && inj.includes("<design-reference"));
check("an automatic pick says so", inj.includes("automatically"));
check("a manual pick says so", designInjection(one.entry, one.brief, false).includes("chosen by the user"));

const parts = ["saas-dark", "terminal-green", "docs-light"].map(getEntry);
const blend = blendInjection(parts);
for (const p of parts) {
  check(`the blend carries "${p.entry.title}" whole`, blend.includes(`<source name="${p.entry.title}">`) && blend.includes(p.brief.trim()));
}
check("the blend names every source in its title", parts.every((p) => blend.includes(p.entry.title)));
check("the blend asks for synthesis, not an average", /do not average|resolve their contradictions/i.test(blend));
check("the blend asks the model to show the resulting style", /Show the resulting style/i.test(blend));

// ── removal ─────────────────────────────────────────────────────────────────
check("removing an entry reports it", deleteEntry("docs-light") === true);
check("removing it twice does not", deleteEntry("docs-light") === false);
check("the library shrinks", listEntries().length === 2);

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\ndone: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
