/**
 * Transcript layout: one marker per message, tool activity indented under the
 * answer it belongs to, and exactly one blank line opening a tool group.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Labels are language-dependent, and the language lives in the config: without
// a home of its own this suite reads the developer's and fails on their
// setting rather than on the code.
process.env.TRCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-transcript-"));

const ESC = String.fromCharCode(27);
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

let captured = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { captured += String(chunk); return true; };
const say = (s = "") => realWrite(s + "\n");

const { userEcho, toolStart, toolDone, assistantPrefix, responseDivider, ensureBlank, line, padded, MarkdownStream } =
  await import("../dist/ui/render.js");

const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");
const take = () => {
  const lines = strip(captured).split("\n");
  captured = "";
  // split() leaves an empty tail for the final newline — not a blank line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; say("  ok   " + name + (process.env.PREVIEW && detail ? "\n" + detail + "\n" : "")); }
  else { failed++; say("  FAIL " + name + "\n" + detail); }
}

// ── the › marks the message, not every line of it ───────────────────────────
{
  userEcho("first paragraph of the request\nsecond line after Ctrl+Enter");
  const lines = take();
  const marked = lines.filter((l) => l.includes("›"));
  check("only the first line carries the marker", marked.length === 1, lines.join("\n"));
  check(
    "continuation lines are indented to the marker",
    lines.some((l) => /^ {5}second line after/.test(l)),
    JSON.stringify(lines),
  );
}

{
  // A long single line wraps; the wrapped rows must not repeat the marker.
  userEcho("раз ".repeat(60).trim());
  const lines = take();
  check("a wrapped message keeps one marker", lines.filter((l) => l.includes("›")).length === 1, lines.join("\n"));
}

{
  // The band runs one cell short of the terminal edge, and the text stops two
  // cells before the band's end: a glyph sitting on the edge reads as clipped.
  // An unbroken run of letters fills every row to its limit, which is the case
  // a word-wrapped sentence can miss by a cell.
  userEcho("аб".repeat(300));
  const rows = take().filter((l) => l.trim() !== "");
  const widest = Math.max(...rows.map((l) => l.trimEnd().length));
  check("wrapped text keeps two clear cells at the band's edge", widest === 97, String(widest));
}

// ── a tool call reads as an action, its result hangs under it ───────────────
{
  assistantPrefix("moonshotai/kimi-k3");
  padded("Логика tap-tap теперь работает через pointerdown.");
  ensureBlank();
  toolStart("edit", '{"new_string":"// подсветка"}');
  toolDone(true, "3 lines changed");
  ensureBlank();
  toolStart("shell", '{"command":"node tests/ui.test.js"}');
  toolDone(true, "ok");
  const lines = take().filter((l) => l !== "");

  const answer = lines.find((l) => l.includes("Логика"));
  // The header names the tool: "Edit(…)", "Ran …" — the same word in every
  // language, because it stands for a tool and not for a verb.
  const tool = lines.find((l) => l.includes("Edit("));
  const detail = lines.find((l) => l.includes("└"));
  const answerIndent = answer.length - answer.trimStart().length;
  const toolIndent = tool.length - tool.trimStart().length;
  const detailIndent = detail.length - detail.trimStart().length;

  check("a tool call is named by its tool", /• Edit\(/.test(tool), JSON.stringify(tool));
  check("a command reads as Ran", lines.some((l) => /• Ran /.test(l)), JSON.stringify(lines));
  // Same margin as the answer: both are things the agent did this turn.
  check("tool calls sit at the answer's margin", toolIndent === answerIndent, JSON.stringify(lines));
  check("the result hangs under its call", detailIndent > toolIndent, JSON.stringify(lines));
}

// ── blank lines: one before the group, none inside it ───────────────────────
{
  captured = "";
  assistantPrefix("moonshotai/kimi-k3");
  padded("answer text");
  ensureBlank();
  toolStart("edit", "{}");
  toolStart("shell", "{}");
  toolStart("read", "{}");
  const lines = take();
  const isTool = (l) => /• (Edit|Ran|Read)/.test(l);
  const firstTool = lines.findIndex(isTool);
  check("a blank line opens the group", lines[firstTool - 1].trim() === "", JSON.stringify(lines));
  check(
    "no blank lines inside the group",
    lines.slice(firstTool, firstTool + 3).every(isTool),
    JSON.stringify(lines),
  );
}

{
  // ensureBlank() must not stack blank lines.
  captured = "";
  line("something");
  ensureBlank();
  ensureBlank();
  toolStart("read", "{}");
  const lines = take();
  check("ensureBlank never doubles up", lines.filter((l) => l === "").length === 1, JSON.stringify(lines));
}

// Providers sometimes put multiple blank chunks before the first answer line.
// Keep the transcript separator and one blank row under the labelled rule.
{
  captured = "";
  padded("reasoning finished");
  responseDivider();
  const md = new MarkdownStream();
  md.push("\n  \n");
  md.push("\n\nDone.\n\nSecond paragraph.");
  md.end();
  const lines = take();
  const divider = lines.findIndex((l) => /─+ Response ─+/.test(l));
  check("a labelled rule separates reasoning from the response", divider === 2, JSON.stringify(lines));
  check("exactly one blank row separates the rule from the answer", lines[divider + 1]?.trim() === "" && lines[divider + 2]?.trim() === "Done.", JSON.stringify(lines));
  check("blank lines inside the answer remain paragraphs", lines[divider + 3]?.trim() === "" && lines[divider + 4]?.trim() === "Second paragraph.", JSON.stringify(lines));
}

{
  const { saveConfig } = await import("../dist/config.js");
  saveConfig({ lang: "ru" });
  responseDivider();
  check("the response divider uses the UI language", take().some((l) => /─+ Ответ ─+/.test(l)));
  saveConfig({ lang: "en" });
  const md = new MarkdownStream();
  md.push("\n```text\n\n  indented\n```\n");
  md.end();
  const lines = take();
  check("leading whitespace cleanup preserves blank lines inside code", lines[0]?.includes("```text") && lines[1]?.trim() === "" && lines[2]?.includes("  indented"), JSON.stringify(lines));
}

// ── a streamed table is aligned, not left as raw pipes ─────────────────────
{
  captured = "";
  const text =
    "| Критерий | PowerDNS | Knot |\n" +
    "|---|---|---|\n" +
    "| SQL как source of truth | gpgsql нативно | нет |\n" +
    "| DNSSEC | зрело | зрело |\n" +
    "\nВывод: PowerDNS.\n";
  const md = new MarkdownStream();
  // Ragged chunks: a delta can split a row anywhere, including mid-cell.
  for (let i = 0; i < text.length; i += 7) md.push(text.slice(i, i + 7));
  md.end();
  const lines = take();
  check("the separator row is not printed", !lines.some((l) => /\|-+\|/.test(l)), JSON.stringify(lines));
  check("no raw pipe row survives", !lines.some((l) => /^\s*\|.*\|\s*$/.test(l)), JSON.stringify(lines));
  const bars = lines.filter((l) => l.includes("│")).map((l) => l.indexOf("│"));
  check("every row puts its first bar in the same column", bars.length >= 3 && new Set(bars).size === 1, JSON.stringify(lines));
  check("prose after the table still renders", lines.some((l) => l.includes("Вывод: PowerDNS.")), JSON.stringify(lines));
}

// ── a build log cannot colour the rows under it ────────────────────────────
{
  // rustc links every crate it names to docs.rs with an OSC 8 hyperlink. A row
  // cut to the terminal's width can lose the closer, and the terminal then
  // draws a link underline under every row that follows: dashed lines under the
  // whole screen, the composer included, that nothing printed afterwards
  // clears. Cursor control from a child is worse — it would erase the session.
  const link = (url, text) => `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
  const { width, hasColor } = await import("../dist/ui/ansi.js");
  const linked = link("https://docs.rs/serde/1.0.0/serde/", "serde::Deserialize");
  check("a link's URL is not counted as visible cells", width(linked) === width("serde::Deserialize"), String(width(linked)));

  captured = "";
  toolDone(
    true,
    [
      `warning: unused import ${linked}`,
      `${ESC}[4munderlined${ESC}[24m and ${ESC}[38;2;255;128;0morange${ESC}[0m`,
      `${ESC}[?25l${ESC}[2Jcleared${ESC}[1;1H`,
    ].join("\n"),
  );
  const raw = captured;
  const rows = take();
  check("no hyperlink reaches the terminal", !raw.includes("]8;"), JSON.stringify(raw));
  check("the linked text itself is kept", raw.includes("serde::Deserialize"), JSON.stringify(raw));
  check("an underline opened by the child is dropped", !raw.includes(`${ESC}[4m`), JSON.stringify(raw));
  check("cursor control from the child is dropped", !raw.includes("[2J") && !raw.includes("[?25l"), JSON.stringify(raw));
  if (hasColor) check("the child's colour survives", raw.includes("[38;2;255;128;0m"), JSON.stringify(raw));
  check("all three rows are printed", rows.filter((l) => l.trim()).length === 3, JSON.stringify(rows));
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
