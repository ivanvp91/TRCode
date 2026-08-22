/**
 * The answer language. It decides two things — what the system prompt tells the
 * model, and which description a skill presents itself with — and both have to
 * follow the setting without a restart.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-lang-"));
process.env.TRCODE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-proj-"));
const skillDir = (n) => {
  const d = path.join(PROJECT, ".trcode", "skills", n);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
fs.writeFileSync(
  path.join(skillDir("translated"), "SKILL.md"),
  "---\nname: translated\ndescription: Review a diff when asked\ndescription_ru: Разобрать дифф по просьбе\n---\n\nbody\n",
);
// A skill with no translation must keep working, just in English.
fs.writeFileSync(
  path.join(skillDir("english-only"), "SKILL.md"),
  "---\nname: english-only\ndescription: Only speaks English\n---\n\nbody\n",
);

const { loadConfig, saveConfig, LANGUAGES } = await import("../dist/config.js");
const { discoverSkills } = await import("../dist/skills/loader.js");
const { buildSystemPrompt } = await import("../dist/agent/prompt.js");

const prompt = () => buildSystemPrompt({ cwd: PROJECT, model: "m", skills: [] });
const descOf = (n) => discoverSkills(PROJECT).find((s) => s.name === n)?.description;

// ── the default is English ────────────────────────────────────────────────
ok("по умолчанию en", loadConfig().lang === "en", loadConfig().lang);
ok("английский в списке языков", LANGUAGES.some((l) => l.code === "en"));
ok("русский в списке языков", LANGUAGES.some((l) => l.code === "ru"));

{
  const p = prompt();
  ok("промпт просит отвечать по-английски", /Answer in English/.test(p));
  ok("и запрещает переводить код", /never translate them/i.test(p));
  // The old wording made the model follow whatever language a pasted log was
  // in; the directive is now explicit.
  ok("нет старого «языка пользователя»", !/Answer in the user's language/.test(p));
}
ok("описание навыка по умолчанию английское", descOf("translated") === "Review a diff when asked", descOf("translated"));

// ── switching to Russian ──────────────────────────────────────────────────
saveConfig({ lang: "ru" });
{
  const p = prompt();
  ok("промпт просит отвечать по-русски", /Answer in Russian/.test(p) && /по-русски/.test(p), p.slice(0, 0));
  ok("запрет на перевод кода остаётся", /never translate them/i.test(p));
}
ok("описание навыка стало русским", descOf("translated") === "Разобрать дифф по просьбе", descOf("translated"));
ok(
  "без перевода остаётся английское",
  descOf("english-only") === "Only speaks English",
  String(descOf("english-only")),
);

// ── and back ──────────────────────────────────────────────────────────────
saveConfig({ lang: "en" });
ok("возврат к en возвращает описание", descOf("translated") === "Review a diff when asked");

// ── every shipped skill carries a Russian description ─────────────────────
{
  const shipped = path.join(process.cwd(), ".trcode", "skills");
  const names = fs.readdirSync(shipped, { withFileTypes: true }).filter((e) => e.isDirectory());
  const missing = names.filter(
    (e) => !fs.readFileSync(path.join(shipped, e.name, "SKILL.md"), "utf8").includes("description_ru:"),
  );
  ok(`все ${names.length} штатных навыка переведены`, missing.length === 0, missing.map((e) => e.name).join(", "));
}

for (const dir of [HOME, PROJECT]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dirs are disposable */
  }
}

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok || !t.detail ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
