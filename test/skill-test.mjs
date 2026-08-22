/**
 * Skills: the frontmatter the loader accepts, and auto-selection — which is
 * the part that can go wrong quietly. A wrong pick sends a procedure the task
 * did not ask for and bills for it on every step after; a missed pick just
 * leaves the model to choose as before. The routing table below is therefore
 * asserted in both directions: what must fire, and what must not.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-skill-home-"));
process.env.TRCODE_HOME = HOME;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const { discoverSkills } = await import("../dist/skills/loader.js");
const { pickSkill, skillInjection, skillInterjector, stepText } = await import("../dist/skills/match.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// ── frontmatter ─────────────────────────────────────────────────────────────
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-skill-work-"));
const writeSkill = (name, frontmatter, body = "Do the thing.") => {
  const dir = path.join(WORK, ".trcode", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
};

writeSkill("deploying", "name: deploying\ndescription: When asked to ship\ntriggers: деплой, deploy, выкатить, выкати на прод");
writeSkill("quiet", "name: quiet\ndescription: Never fires by itself\ntriggers: деплой\nauto: off");
writeSkill("bodyless", "name: bodyless\ntriggers: nothing");
// A phrase trigger whose distinguishing half is path-shaped. Reducing it the
// way a request is reduced ate the "a/b" and left a bare "тест", which then
// matched — at full phrase score — every sentence that mentioned a test.
writeSkill("experiments", "name: experiments\ndescription: Split tests\ntriggers: a/b тест, сплит-тест");

{
  const skills = discoverSkills(WORK);
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  check("a skill without a description is skipped", !byName.bodyless);
  check("triggers parse into a list", byName.deploying?.triggers.length === 4, JSON.stringify(byName.deploying?.triggers));
  check("triggers are lowercased and trimmed", byName.deploying?.triggers.includes("выкати на прод"));
  check("auto is on unless switched off", byName.deploying?.auto === true);
  check("auto: off is respected", byName.quiet?.auto === false);
}

// ── matching ────────────────────────────────────────────────────────────────
{
  const skills = discoverSkills(WORK);
  const pick = (t) => pickSkill(skills, t)?.skill.name ?? null;

  check("a trigger word fires", pick("надо выкатить новую версию на прод") === "deploying");
  check("inflection still matches", pick("сделай деплоя нового билда сегодня") === "deploying");
  check("a short line cannot fire", pick("деплой") === null);
  check("a skill with auto: off never fires", pick("нужен деплой сервиса на прод") !== "quiet");
  check(
    "an already-loaded skill is not sent twice",
    pickSkill(skills, "надо выкатить новую версию на прод", { exclude: new Set(["deploying"]) }) === null,
  );
  check("no trigger, no pick", pick("посчитай сумму двух чисел в столбце") === null);
  check("a phrase trigger keeps the half that made it specific", pick("надо переписать тест на парсер конфига") === null);
  check("and still fires on the phrase itself", pick("давай запустим a/b тест лендинга на следующей неделе") === "experiments");
}

// ── the shipped library, in both directions ─────────────────────────────────
{
  const skills = discoverSkills(REPO);
  check(`the project library loads (${skills.length} skills)`, skills.length >= 13, String(skills.length));

  const fires = [
    ["почини баг: падает с TypeError при пустом конфиге", "debugging"],
    ["the parser crashes on an empty file, please fix", "debugging"],
    ["напиши тесты для parseFrontmatter", "writing-tests"],
    ["write unit tests for the config loader", "writing-tests"],
    ["отрефактори этот модуль, слишком много дублирования", "refactoring"],
    ["review these changes before I commit", "code-review"],
    ["обнови README и changelog под новую версию", "technical-writing"],
    ["свёрстай лендинг для нового продукта", "ui-design"],
    ["сделай ревью дизайна главного экрана", "design-critique"],
    ["напиши текст для лендинга", "marketing-copy"],
    ["подумай про позиционирование продукта и конкурентов", "positioning"],
    ["распиши план запуска новой фичи", "launch-plan"],
    ["сделай презентацию на 10 слайдов для команды", "presentation"],
    ["нужен питч дек для инвесторов на seed раунд", "pitch-deck"],
    ["составь спеку и разбей на задачи", "product-spec"],
    ["посмотри состояние моих серверов и дай сводку", "servers"],
    ["зайди на прод и проверь логи nginx", "servers"],
    ["сервер тормозит, посмотри что там с нагрузкой", "servers"],
    ["добавь нового провайдера, у него свой base url и api key", "models-providers"],
    ["какая модель дешевле для этой задачи и какое у неё окно контекста", "models-providers"],
  ];
  for (const [request, want] of fires) {
    const got = pickSkill(skills, request);
    check(`${want} ← "${request.slice(0, 42)}"`, got?.skill.name === want, `got ${got?.skill.name ?? "nothing"}`);
  }

  // Ordinary coding requests must stay untouched: the cost of a false fire is
  // a whole procedure riding along on every step of the turn.
  const quiet = [
    "запусти npm test и покажи вывод",
    "переименуй переменную foo в bar в src/index.ts",
    "добавь поле email в форму регистрации",
    "прочитай src/config.ts и объясни что там происходит",
    "продолжи",
    // Разговор о предмете — не заявка на работу с ним: процедура на три
    // тысячи токенов не нужна тому, кто просто рассуждает вслух.
    "давай обсудим продвижение продукта",
    "обсудим маркетинг и позиционирование",
    "как думаешь, стоит ли нам вкладываться в seo",
    "что думаешь про дизайн главной страницы",
  ];
  for (const request of quiet) {
    const got = pickSkill(skills, request);
    check(`stays quiet on "${request.slice(0, 42)}"`, got === null, `fired ${got?.skill.name}`);
  }

  // Descriptions feed the score, and `lang` decides which one is read — so the
  // same request has to route the same way in either language.
  {
    const ruHome = fs.mkdtempSync(path.join(os.tmpdir(), "trc-skill-ru-"));
    fs.writeFileSync(path.join(ruHome, "config.json"), JSON.stringify({ lang: "ru" }));
    const realHome = process.env.TRCODE_HOME;
    process.env.TRCODE_HOME = ruHome;
    // loadConfig caches, so this has to run in a process that has not read it.
    const { execFileSync } = await import("node:child_process");
    const probe = `
      const { discoverSkills } = await import(${JSON.stringify(new URL("../dist/skills/loader.js", import.meta.url).href)});
      const { pickSkill } = await import(${JSON.stringify(new URL("../dist/skills/match.js", import.meta.url).href)});
      const skills = discoverSkills(${JSON.stringify(REPO)});
      const cases = ${JSON.stringify([...fires, ...quiet.map((q) => [q, null])])};
      const bad = cases.filter(([t, want]) => (pickSkill(skills, t)?.skill.name ?? null) !== want);
      console.log(JSON.stringify(bad));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      env: { ...process.env, TRCODE_HOME: ruHome },
      encoding: "utf8",
    });
    const mismatches = JSON.parse(out.trim());
    check("routing is the same with lang: ru", mismatches.length === 0, JSON.stringify(mismatches));
    process.env.TRCODE_HOME = realHome;
    fs.rmSync(ruHome, { recursive: true, force: true });
  }

  // ── what actually gets injected ───────────────────────────────────────────
  const debugging = skills.find((s) => s.name === "debugging");
  const injected = skillInjection(debugging);
  check("the injection carries the body", injected.includes("## 1. Pin down the symptom"));
  check("it is tagged as automatic", /<skill name="debugging" loaded="automatically">/.test(injected));
  check("it tells the model not to load it again", /do not call the skill tool/i.test(injected));
}

// ── the turn wiring ─────────────────────────────────────────────────────────
{
  const { App } = await import("../dist/ui/repl.js");
  const { Session } = await import("../dist/session/session.js");

  // The injection prints a line of its own; silence only the call, or the
  // suite's own results would go into the same hole.
  const realWrite = process.stdout.write.bind(process.stdout);
  const quietly = (fn) => {
    process.stdout.write = () => true;
    try { fn(); } finally { process.stdout.write = realWrite; }
  };

  const app = Object.create(App.prototype);
  const session = new Session({ cwd: REPO, model: "m", title: "t" });
  Object.assign(app, {
    cwd: REPO,
    // skillsEnabled is off by default now, and this block is about what the
    // injection does when skills are in play at all.
    cfg: { skillAuto: true, skillsEnabled: true },
    session,
    skills: discoverSkills(REPO),
    loadedSkills: new Set(),
  });

  quietly(() => app.autoLoadSkill("почини баг: падает с TypeError при пустом конфиге"));
  const first = session.messages[session.messages.length - 1];
  check("the turn injects the skill", first?.meta?.skill === "debugging", JSON.stringify(first?.meta));
  check("the body is what got injected", String(first?.content).includes("Pin down the symptom"));
  check("the wire sees it (not marked hidden)", !first?.meta?.hidden);

  const after = session.messages.length;
  quietly(() => app.autoLoadSkill("ещё один баг: падает на пустом конфиге, почини"));
  check("the same skill is not injected twice", session.messages.length === after);

  app.cfg.skillAuto = false;
  app.loadedSkills.clear();
  quietly(() => app.autoLoadSkill("почини баг: падает с TypeError при пустом конфиге"));
  check("skillAuto: false switches it off", session.messages.length === after);

  // The step-boundary half of the same wiring.
  app.cfg.skillAuto = true;
  check("the turn hands the loop a step matcher", typeof app.stepSkills() === "function");
  app.cfg.skillAuto = false;
  check("skillAuto: false switches the step matcher off too", app.stepSkills() === undefined);
  app.cfg.skillAuto = true;
  app.cfg.skillsEnabled = false;
  check("skills off means no step matcher", app.stepSkills() === undefined);
}

// ── mid-turn: the same match, run at every step boundary ────────────────────
{
  const skills = discoverSkills(REPO);
  const said = (text) => ({ role: "assistant", content: text });
  const called = (name, args) => ({ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } });

  check("the digest carries what the model said", stepText(said("теперь напишу тесты"), []).includes("напишу"));
  check(
    "a plan-bearing call counts",
    stepText(said(null), [called("todo", { items: ["написать юнит-тесты"] })]).includes("юнит-тесты"),
  );
  check(
    "a file payload does not",
    !stepText(said(null), [called("write", { path: "a.md", content: "тесты тесты тесты" })]).includes("тесты"),
  );

  {
    const loaded = new Set();
    const seen = [];
    const next = skillInterjector(skills, { loaded, max: 2, onLoad: (s) => seen.push(s.name) });

    const plain = next(said("Прочитал файл, теперь посмотрю соседний модуль."), []);
    check("an ordinary step loads nothing", plain === null, JSON.stringify(plain?.meta));

    const turned = next(
      said("Фикс внёс. Теперь нужны тесты на него — покрою parseFrontmatter юнит-тестами и прогоню npm test."),
      [],
    );
    check("a step that turns towards tests loads the procedure", turned?.meta?.skill === "writing-tests", JSON.stringify(turned?.meta));
    check("it goes in as a user message", turned?.role === "user");
    check("the wording says it was matched to the work, not to a request", String(turned?.content).includes("matched to the work you just described"));
    check("the loaded set is shared with the session", loaded.has("writing-tests") && seen[0] === "writing-tests");

    const again = next(said("И ещё тесты, юнит-тесты на второй случай тоже нужны."), []);
    check("the same procedure is not sent twice", again === null, JSON.stringify(again?.meta));

    // A plan stated through the todo tool, with no text at all.
    const viaTodo = next(said(null), [called("todo", { items: ["провести аудит безопасности, проверить уязвимости"] })]);
    check("a plan stated in a tool call still matches", viaTodo?.meta?.skill === "security-review", JSON.stringify(viaTodo?.meta));

    const third = next(said("Теперь отрефакторю этот модуль, тут дублирование и рефакторинг напрашивается."), []);
    check("the per-turn cap holds", third === null, JSON.stringify(third?.meta));
  }

  {
    // One trigger word in passing is not a change of subject: mid-turn the bar
    // is higher than it is for a request.
    const loaded = new Set();
    const next = skillInterjector(skills, { loaded, max: 2 });
    const passing = next(said("Функция парсит конфиг; заодно правлю тест, который на неё ссылается."), []);
    check("one word in passing does not fire mid-turn", passing === null, JSON.stringify(passing?.meta));
  }
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
