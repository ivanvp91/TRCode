/**
 * How an edit is shown: a numbered diff with a marker per line, a coloured band
 * across the changed ones, and the code itself syntax-coloured.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-diff-"));
process.env.TRCODE_HOME = HOME;
// This suite asserts on colour, so every switch that turns colour off has to be
// closed: no TTY under the runner, and whatever the surrounding tooling puts in
// the environment. All three are read once, when ansi.ts is first imported.
delete process.env.NO_COLOR;
if (process.env.TERM === "dumb") delete process.env.TERM;
process.env.FORCE_COLOR = "1";
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

const ESC = String.fromCharCode(27);
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
const ADD_BAND = ESC + "[48;5;22m";
const DEL_BAND = ESC + "[48;5;52m";

const { saveConfig } = await import("../dist/config.js");
const { renderDiff, toolStart, toolDone } = await import("../dist/ui/render.js");
const { highlight } = await import("../dist/ui/highlight.js");

const before = ["import fs from \"node:fs\";", "", "const MAX = 10;", "", "function seed() {", "  return [];", "}"].join("\n");
const after = ["import fs from \"node:fs\";", "", "const MAX = 20;", "", "function seed() {", "  // a note", "  return [1];", "}"].join("\n");

const out = renderDiff(before, after, { path: "x.ts" });
const lines = out.split("\n");
const plain = lines.map(strip);

// ── the summary ───────────────────────────────────────────────────────────
ok("первая строка — сводка", plain[0].startsWith("└ "), plain[0]);
ok("сводка считает добавленные", /Added 3 lines/.test(plain[0]), plain[0]);
ok("сводка считает удалённые", /removed 2 lines/.test(plain[0]), plain[0]);

// ── numbering and markers ─────────────────────────────────────────────────
const changed = plain.filter((l) => / [-+] /.test(l));
ok("изменённых строк пять", changed.length === 5, String(changed.length));
ok("удаление помечено минусом", changed.some((l) => /3 - const MAX = 10;/.test(l)), changed.join(" | "));
ok("добавление помечено плюсом", changed.some((l) => /3 \+ const MAX = 20;/.test(l)), changed.join(" | "));
ok("номера растут по новому файлу", changed.some((l) => /7 \+ {3}return \[1\];/.test(l)), changed.join(" | "));
ok("контекст без маркера", plain.some((l) => /^\s*5\s{3}function seed\(\) \{/.test(l)), plain.join(" | "));

// ── the bands ─────────────────────────────────────────────────────────────
const band = lines.filter((l) => l.includes(ADD_BAND) || l.includes(DEL_BAND));
ok("полосой покрыты только изменения", band.length === 5, String(band.length));
ok("добавления зелёные", lines.some((l) => l.includes(ADD_BAND) && strip(l).includes("+ const MAX = 20;")));
ok("удаления красные", lines.some((l) => l.includes(DEL_BAND) && strip(l).includes("- const MAX = 10;")));
{
  // The band must reach the right edge, or it reads as a highlight on the text.
  const widths = new Set(band.map((l) => strip(l).length));
  ok("полоса одной ширины до края", widths.size === 1, [...widths].join(","));
}

// ── the gap ───────────────────────────────────────────────────────────────
{
  // Two changes far apart: the gap belongs between them, and the run of lines
  // before the first change is skipped too.
  const src = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const dst = src.map((l, i) => (i === 2 || i === 25 ? "changed " + i : l));
  const long = renderDiff(src.join("\n"), dst.join("\n"), { path: "x.ts" }).split("\n").map(strip);
  const gaps = long.map((l, i) => (l.includes("⋮") ? i : -1)).filter((i) => i !== -1);
  ok("пропуск отмечен ⋮", gaps.length === 1, String(gaps.length));

  const firstChange = long.findIndex((l) => / [-+] /.test(l));
  const lastChange = long.map((l) => / [-+] /.test(l)).lastIndexOf(true);
  ok("пропуск между изменениями, а не сверху", gaps[0] > firstChange && gaps[0] < lastChange, `${firstChange} < ${gaps[0]} < ${lastChange}`);
  ok("длинный дифф не печатается целиком", long.length < 20, String(long.length));
}

// ── nothing may escape the margins ────────────────────────────────────────
{
  const long = "Сводный анализ модулей EA Ranking и EA Score: ".repeat(12).trim();
  const rows = renderDiff("a", `a\n${long}`, { path: "x.md" }).split("\n").slice(1);
  const widths = rows.map((l) => strip(l).length);
  // The band is padded to exactly the room a row has; nothing may exceed it.
  ok("длинная строка обрезана по ширине", Math.max(...widths) <= 100, String(Math.max(...widths)));
  ok("обрезка помечена многоточием", rows.some((l) => strip(l).includes("…")));
  // Clipping after highlighting would cut an escape sequence in half.
  ok(
    "экранированные последовательности целы",
    rows.every((l) => !/\x1b\[[0-9;]*$/.test(l) && !/\x1b$/.test(l)),
  );
}

// A file created from nothing is a diff against nothing, not against one blank line.
{
  const fresh = renderDiff("", "# title\n\nbody\n", { path: "x.md" }).split("\n").map(strip);
  ok("новый файл — только добавления", !fresh.slice(1).some((l) => / - /.test(l)), fresh.join(" | "));
  ok("и пустая строка внутри тоже добавлена", /Added 4 lines/.test(fresh[0]), fresh[0]);
}

// ── the cap: a runaway generation must not freeze the renderer ────────────
{
  // A looping model once handed write megabytes of repeated CSS; at ~0.5ms a
  // rendered row that meant hours inside renderDiff with the event loop dead.
  const huge = Array.from({ length: 5000 }, (_, i) => `@keyframes p${i}{0%{opacity:1}50%{opacity:.35}}`).join("\n");
  const t0 = Date.now();
  const capped = renderDiff("", huge, { path: "x.css" }).split("\n").map(strip);
  const took = Date.now() - t0;
  ok("большой дифф обрезан по строкам", capped.length <= 402, String(capped.length));
  ok("хвост говорит, сколько скрыто", /not shown|не показано/.test(capped[capped.length - 1]), capped[capped.length - 1]);
  ok("сводка считает всё, а не показанное", /Added 5000 lines/.test(capped[0]), capped[0]);
  ok("рендер укладывается в секунду", took < 1000, took + "ms");

  const small = renderDiff("a", "b", { path: "x.ts" }).split("\n").map(strip);
  ok("маленький дифф без маркера обрезки", !small.some((l) => /not shown|не показано/.test(l)), small.join(" | "));
}

// ── the same guard one level up: tool-call arguments ──────────────────────
{
  const { parseArgs } = await import("../dist/agent/loop.js");
  const bloated = '{"content":"' + "x".repeat(2_100_000) + '"}';
  const r = parseArgs(bloated);
  ok("гигантские аргументы отклонены до парсинга", r.ok === false && /MB/.test(r.error), r.ok ? "ok" : r.error);
  const fine = parseArgs('{"a":1}');
  ok("обычные аргументы проходят", fine.ok === true && fine.args.a === 1);
}

// ── highlighting ──────────────────────────────────────────────────────────
ok("ключевое слово подсвечено", highlight('const x = 1;', "ts") !== "const x = 1;");
ok("строка подсвечена", /\x1b\[33m/.test(highlight('const s = "hi";', "ts")));
ok("комментарий подсвечен", /\x1b\[90m/.test(highlight("// note", "ts")));
// '@' opens a word without being a word character; the scanner once produced a
// zero-length word here and never advanced — @keyframes froze the process.
ok(
  "@-строка не зацикливает подсветку",
  strip(highlight("@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}", "html")) ===
    "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}",
);
// An unterminated quote must not swallow anything beyond its own line.
ok("незакрытая кавычка не ломает строку", strip(highlight('const s = "oops', "ts")) === 'const s = "oops');
ok("подсветка не меняет текст", strip(highlight('const s = "hi"; // x', "ts")) === 'const s = "hi"; // x');

// ── the header ────────────────────────────────────────────────────────────
{
  let printed = "";
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    printed += String(s);
    return true;
  };
  toolStart("edit", "src/a.ts");
  toolDone(true, out, "diff");
  process.stdout.write = real;
  const p = strip(printed);
  ok("заголовок — имя инструмента", /● Edit\(src\/a\.ts\)/.test(p), p.split("\n")[0]);
  // Printing a diff through the plain path would dim and clip it.
  ok("дифф напечатан как есть", printed.includes(ADD_BAND), "полоса потерялась");
}

// ── Russian ───────────────────────────────────────────────────────────────
saveConfig({ lang: "ru" });
{
  const ru = strip(renderDiff(before, after, { path: "x.ts" }).split("\n")[0]);
  ok("сводка переведена", /Добавлено: 3 строки/.test(ru) && /удалено: 2 строки/.test(ru), ru);
  // The colon keeps it impersonal, so one line reads as correctly as three.
  const one = strip(renderDiff("a\nb", "a\nb\nc", { path: "x.ts" }).split("\n")[0]);
  ok("одна строка склоняется верно", /Добавлено: 1 строка/.test(one), one);
  const five = strip(renderDiff("a", "a\nb\nc\nd\ne\nf", { path: "x.ts" }).split("\n")[0]);
  ok("пять строк склоняются верно", /Добавлено: 5 строк$/.test(five), five);
}
saveConfig({ lang: "en" });

// ── a diff the prompt showed is not printed again by the result ───────────
{
  const { editTool } = await import("../dist/tools/files.js");
  const { PermissionBroker } = await import("../dist/ui/permissions.js");

  const file = path.join(HOME, "edit-me.txt");
  const ctxFor = (broker) => ({
    cwd: HOME,
    signal: new AbortController().signal,
    depth: 0,
    confirm: async (tool, args, preview) => {
      // Stands in for the prompt: what the user would have been shown.
      if (preview) broker.noteShown(preview);
      return true;
    },
    previewShown: (preview) => broker.previewShown(preview),
    emit: () => {},
    readFiles: new Set([file]),
  });
  const args = { path: file, old_string: "one", new_string: "ONE" };

  const asked = new PermissionBroker();
  fs.writeFileSync(file, "one\ntwo\n");
  const afterPrompt = await editTool.run(args, ctxFor(asked));
  ok("a prompted edit reports the change without repeating the diff",
    afterPrompt.display === undefined && afterPrompt.displayKind === "text" && /1 replacement/.test(afterPrompt.output),
    JSON.stringify(afterPrompt));

  // Nothing was prompted (session-allowed, or --yolo): the diff is the only
  // record of the change, so the result still carries it.
  const silent = new PermissionBroker();
  fs.writeFileSync(file, "one\ntwo\n");
  const noPrompt = await editTool.run(args, {
    ...ctxFor(silent),
    confirm: async () => true,
  });
  ok("an auto-approved edit still shows its diff",
    noPrompt.displayKind === "diff" && /ONE/.test(strip(noPrompt.display ?? "")),
    JSON.stringify(noPrompt.displayKind));

  // One claim per prompt: a second, identical diff is a second change.
  const twice = new PermissionBroker();
  twice.noteShown("body");
  ok("a preview is claimed only once",
    twice.previewShown("body") === true && twice.previewShown("body") === false);
}

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
