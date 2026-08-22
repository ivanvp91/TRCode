/**
 * The interface language. Everything the user reads has to follow the setting
 * at print time — the command table in particular is built once at import,
 * long before /lang runs, so its labels have to be lazy.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-i18n-"));
process.env.TRCODE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
Object.defineProperty(process.stdout, "columns", { value: 92, configurable: true });

const ESC = String.fromCharCode(27);
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");

const { saveConfig } = await import("../dist/config.js");
const { t, count, plural3 } = await import("../dist/i18n.js");
const render = await import("../dist/ui/render.js");
const { composeStatus } = await import("../dist/ui/inputbox.js");
const { printCommandIndex, commandSuggestions } = await import("../dist/ui/commands.js");

/** Captures whatever the given call prints. */
function captured(fn) {
  let out = "";
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = real;
  }
  return strip(out);
}

const bannerText = () =>
  captured(() =>
    render.banner({
      provider: "Kimi",
      model: "kimi:k3",
      effort: "high",
      cwdLabel: "C:/proj",
      sessionId: "s1",
      version: "0.1.0",
    }),
  );
const statusText = () =>
  strip(
    composeStatus({
      provider: "Kimi",
      model: "kimi:k3",
      effort: "high",
      cwdLabel: "~/p",
      contextUsed: 1,
      contextWindow: 100,
      contextEstimated: false,
    }).left,
  );
const helpOf = (name) => commandSuggestions(name)[0]?.hint ?? "";

// ── English by default ────────────────────────────────────────────────────
{
  const b = bannerText();
  ok("шапка по умолчанию английская", /Directory:/.test(b) && /Provider:/.test(b), b.slice(0, 60));
  ok("статус по умолчанию английский", /thinking:/.test(statusText()), statusText());
  ok("справка команды английская", /switch model/.test(helpOf("/model")), helpOf("/model"));
  ok("группы английские", /settings/.test(captured(printCommandIndex)));
}

// ── switched to Russian ───────────────────────────────────────────────────
saveConfig({ lang: "ru" });
{
  const b = bannerText();
  ok("шапка переведена", /Каталог:/.test(b) && /Поставщик:/.test(b) && /Модель:/.test(b), b.slice(0, 80));
  ok("приветствие переведено", /добро пожаловать/.test(b));
  ok("в шапке не осталось английских ярлыков", !/Directory:|Session:|Version:/.test(b));
  ok("статус переведён", /мышление:/.test(statusText()), statusText());

  // The command table is a module-level constant: without lazy labels it would
  // still be English here.
  ok("справка команды переведена", /сменить модель/.test(helpOf("/model")), helpOf("/model"));
  ok("аргументы команды переведены", /имя\|алиас/.test(helpOf("/model")), helpOf("/model"));
  const index = captured(printCommandIndex);
  ok("группы переведены", /основное/.test(index) && /настройки/.test(index) && /прочее/.test(index));
  ok("заголовок списка переведён", /Команды/.test(index));
}

// ── Russian plurals ───────────────────────────────────────────────────────
{
  const forms = (n) => plural3(n, "модель", "модели", "моделей");
  ok("1 модель", forms(1) === "модель");
  ok("2 модели", forms(2) === "модели");
  ok("5 моделей", forms(5) === "моделей");
  // The rule is on the last two digits, so the teens are all "моделей".
  ok("11 моделей", forms(11) === "моделей");
  ok("21 модель", forms(21) === "модель");
  ok("112 моделей", forms(112) === "моделей");
  ok("count склеивает число и слово", count(3, ["model", "models"], ["модель", "модели", "моделей"]) === "3 модели");
  ok("t выбирает русский", t("no", "да") === "да");
}

// ── and back ──────────────────────────────────────────────────────────────
saveConfig({ lang: "en" });
ok("возврат к английскому", /Directory:/.test(bannerText()) && /switch model/.test(helpOf("/model")));
ok("count по-английски", count(3, ["model", "models"], ["модель", "модели", "моделей"]) === "3 models");

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* temp dir is disposable */
}

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok || !t.detail ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
