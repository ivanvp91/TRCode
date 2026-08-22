/**
 * The model thinking out loud. It streams in fragments, so the block has to be
 * line-buffered, muted, kept inside the margins, and closed before anything
 * else — the answer or a tool call — is printed under it.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Labels follow the interface language, which lives in the config: without a
// home of its own this suite would read the developer's.
process.env.TRCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-think-"));

// This suite asserts on the dim escape, so colour has to be on. The gate in
// ansi.ts has three ways to switch it off; close all of them, or the result
// depends on whatever the runner put in the environment.
delete process.env.NO_COLOR;
if (process.env.TERM === "dumb") delete process.env.TERM;
process.env.FORCE_COLOR = "1";

const ESC = String.fromCharCode(27);
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });

let captured = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  captured += String(chunk);
  return true;
};

const { ThinkingStream, assistantPrefix, padded } = await import("../dist/ui/render.js");
const { saveConfig } = await import("../dist/config.js");

const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
const take = () => {
  const out = captured;
  captured = "";
  return out;
};

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

// ── a fragment is not a line ──────────────────────────────────────────────
{
  const th = new ThinkingStream();
  th.push("Надо посмотреть, как счит");
  const midway = strip(take());
  // The tail is held back: emitting it would wrap the same line twice.
  ok("незавершённая строка не печатается", !midway.includes("как счит"), JSON.stringify(midway));
  ok("но заголовок уже нет", midway === "", JSON.stringify(midway));

  th.push("ается Base.\n");
  const done = strip(take());
  ok("строка печатается целиком по \\n", done.includes("Надо посмотреть, как считается Base."), JSON.stringify(done));
  ok("блок открывается заголовком", /● thinking/.test(done), JSON.stringify(done));

  th.push("хвост без перевода строки");
  th.end();
  ok("end() досылает хвост", strip(take()).includes("хвост без перевода строки"));
}

// ── muted, indented, inside the margins ───────────────────────────────────
{
  const th = new ThinkingStream();
  const long = "рассуждение ".repeat(30).trim();
  th.push(long + "\n");
  th.end();
  const raw = take();
  const lines = strip(raw).split("\n").filter((l) => l.trim() && !l.includes("thinking"));

  ok("мысли приглушены", raw.includes(ESC + "[2m"), "нет кода dim");
  ok("каждая строка в пределах ширины", lines.every((l) => l.length <= 80), String(Math.max(...lines.map((l) => l.length))));
  ok("длинный текст переносится, а не обрезается", lines.length > 1, String(lines.length));
  ok("ничего не потерялось при переносе", strip(raw).replace(/\s+/g, " ").includes("рассуждение рассуждение"));
  // Subordinate to the header, like a hint under a message.
  const indents = new Set(lines.map((l) => l.length - l.trimStart().length));
  ok("одинаковый отступ у всех строк", indents.size === 1, [...indents].join(","));
  ok("отступ глубже полей", [...indents][0] > 3, [...indents].join(","));
}

// ── the block closes before the answer ────────────────────────────────────
{
  const th = new ThinkingStream();
  th.push("прикидываю варианты\n");
  th.end();
  assistantPrefix("moonshotai/kimi-k3");
  padded("Готово.");
  const out = strip(take());
  const thinkAt = out.indexOf("прикидываю варианты");
  const answerAt = out.indexOf("moonshotai/kimi-k3");
  ok("мысли идут до ответа", thinkAt !== -1 && answerAt > thinkAt, `${thinkAt} / ${answerAt}`);
  // A blank line separates the two, or the answer reads as more thinking.
  ok("между ними пустая строка", /\n\s*\n\s*● moonshotai/.test(out), JSON.stringify(out.slice(-80)));
}

// ── nothing printed when the model does not think ─────────────────────────
{
  const th = new ThinkingStream();
  th.end();
  ok("пустой поток ничего не печатает", take() === "");
}

// ── translated ────────────────────────────────────────────────────────────
saveConfig({ lang: "ru" });
{
  const th = new ThinkingStream();
  th.push("шаг\n");
  th.end();
  ok("заголовок переведён", /● размышления/.test(strip(take())));
}
saveConfig({ lang: "en" });

process.stdout.write = realWrite;

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok || !t.detail ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
