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

const { userEcho, toolStart, toolDone, assistantPrefix, ensureBlank, line, padded, MarkdownStream } =
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

// ── the ✦ marks the message, not every line of it ───────────────────────────
{
  userEcho("first paragraph of the request\nsecond line after Ctrl+Enter");
  const lines = take();
  const marked = lines.filter((l) => l.includes("✦"));
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
  check("a wrapped message keeps one marker", lines.filter((l) => l.includes("✦")).length === 1, lines.join("\n"));
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
  // The header names the tool: "Edit(…)", "Bash(…)" — the same word in every
  // language, because it stands for a tool and not for a verb.
  const tool = lines.find((l) => l.includes("Edit("));
  const detail = lines.find((l) => l.includes("└"));
  const answerIndent = answer.length - answer.trimStart().length;
  const toolIndent = tool.length - tool.trimStart().length;
  const detailIndent = detail.length - detail.trimStart().length;

  check("a tool call is named by its tool", /● Edit\(/.test(tool), JSON.stringify(tool));
  check("shell reads as Bash", lines.some((l) => /● Bash\(/.test(l)), JSON.stringify(lines));
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
  const isTool = (l) => /● (Edit|Bash|Read)\(/.test(l);
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

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
