/**
 * The margins.
 *
 * Everything the chat prints lives between a left margin and a right gutter,
 * and a line that does not fit has to be wrapped by us. Left to the terminal,
 * the continuation starts in column 1 — outside the margin, under the glyph of
 * the message it belongs to — and the break lands wherever the edge happens to
 * be, mid-word. This suite prints through every helper at several widths and
 * asserts that nothing escapes the margins and no word is cut in half.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-indent-"));
process.env.TRCODE_HOME = HOME;

const render = await import("../dist/ui/render.js");
const { PAD_LEFT, contentWidth } = await import("../dist/ui/layout.js");
const { c, width, stripAnsi, wrapAnsi } = await import("../dist/ui/ansi.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const setWidth = (cols) => Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });

const real = process.stdout.write.bind(process.stdout);
function capture(fn) {
  let buf = "";
  process.stdout.write = (chunk) => { buf += String(chunk); return true; };
  try { fn(); } finally { process.stdout.write = real; }
  return buf.split("\n").filter((l) => l.trim());
}

// Long enough to wrap at any terminal width, in a language whose words are not
// two letters long — the break has to fall on a space either way.
const LONG_RU =
  "Продолжение после паузы ~1h 05m — кэш провайдера истёк, и первый запрос заново оплатит все ~71k токенов истории. " +
  "Если старый контекст уже не нужен, /compact или /new выйдет дешевле.";
const LONG_EN =
  "Resuming after a long pause: the provider cache has expired, so the next request pays for the whole history again, " +
  "and neither /compact nor /new can help once it has been sent.";

const ESC = String.fromCharCode(27);
const words = (s) => stripAnsi(s).split(/\s+/).filter(Boolean);

for (const cols of [60, 100, 200]) {
  setWidth(cols);
  const cases = {
    "padded": () => render.padded(c.gray(LONG_RU)),
    "info": () => render.info(LONG_RU),
    "warn": () => render.warn(LONG_EN),
    "error": () => render.error(LONG_RU),
    "success": () => render.success(LONG_EN),
    "hint": () => render.hint(LONG_RU),
    "toolStart": () => render.toolStart("shell", LONG_EN),
    "markdown": () => {
      for (const l of render.renderMarkdownBlock(`## ${LONG_EN}\n\n- ${LONG_RU}\n\n| ключ | значение |\n| --- | --- |\n| скорость | вдвое |\n`)) render.padded(l);
    },
  };

  for (const [name, fn] of Object.entries(cases)) {
    const lines = capture(fn);
    const over = lines.filter((l) => width(l) > cols);
    check(`${cols}: ${name} stays inside the terminal`, over.length === 0, over[0]);
    const unindented = lines.filter((l) => !l.startsWith(" ".repeat(PAD_LEFT)));
    check(`${cols}: ${name} keeps the left margin on every line`, unindented.length === 0, JSON.stringify(unindented[0]));
  }

  // The words have to survive the wrap: "уже н / е нужен" is what the terminal
  // does when nobody wraps for it.
  const wrapped = capture(() => render.padded(c.gray(LONG_RU)));
  check(`${cols}: no word is broken by the wrap`, words(wrapped.join(" ")).join(" ") === words(LONG_RU).join(" "), wrapped.join("\n"));
  check(`${cols}: it actually wrapped`, cols >= 200 || wrapped.length > 1, String(wrapped.length));

  // An indented line stays indented all the way down — a wrapped sub-line that
  // returns to the margin reads as a new message.
  const sub = capture(() => render.padded("    " + LONG_RU));
  check(`${cols}: an indented line keeps its indent`, sub.every((l) => l.startsWith(" ".repeat(PAD_LEFT + 4))), JSON.stringify(sub[1] ?? ""));
}

// ── colours survive the wrap ────────────────────────────────────────────────
setWidth(100);
{
  // Colour is off without a tty, so this half runs in a child process with
  // FORCE_COLOR set — otherwise c.gray() returns plain text and the check
  // would be asserting on nothing.
  const { execFileSync } = await import("node:child_process");
  const probe = `
    const { c, wrapAnsi } = await import(${JSON.stringify(new URL("../dist/ui/ansi.js", import.meta.url).href)});
    console.log(JSON.stringify(wrapAnsi(c.gray(${JSON.stringify(LONG_RU)}), 40)));
  `;
  // NO_COLOR has to win over FORCE_COLOR in the library, so a machine that
  // sets it globally would silence the probe — drop it here.
  const { NO_COLOR: _drop, ...colorEnv } = process.env;
  const painted = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      env: { ...colorEnv, FORCE_COLOR: "1", TERM: "xterm" },
      encoding: "utf8",
    }).trim(),
  );
  check("a wrapped colour is reopened on the next line", painted.length > 1 && painted.slice(1).every((l) => l.includes(ESC)), JSON.stringify(painted[1] ?? ""));
  check("every wrapped line closes its colour", painted.every((l) => l.endsWith(ESC + "[0m")), JSON.stringify(painted[0] ?? ""));
  check("the text itself is untouched", words(painted.join(" ")).join(" ") === words(LONG_RU).join(" "));

  const plain = wrapAnsi("одно слово", 40);
  check("a short line is returned as it is", plain.length === 1 && plain[0] === "одно слово");

  const hash = "a".repeat(120);
  const cut = wrapAnsi(hash, 30);
  check("an unbreakable run is cut to width", cut.every((l) => width(l) <= 30) && cut.join("") === hash, JSON.stringify(cut.map((l) => l.length)));

  check("wrapping fits the content width", wrapAnsi(LONG_EN, contentWidth()).every((l) => width(l) <= contentWidth()));
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
