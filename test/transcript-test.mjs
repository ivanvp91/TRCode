/**
 * Transcript layout: one marker per message, tool activity indented under the
 * answer it belongs to, and exactly one blank line opening a tool group.
 */
const ESC = String.fromCharCode(27);
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

let captured = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { captured += String(chunk); return true; };
const say = (s = "") => realWrite(s + "\n");

const { userEcho, toolStart, toolDone, assistantPrefix, ensureBlank, line, padded } = await import(
  "../dist/ui/render.js"
);

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

// ── tool lines sit deeper than the answer ───────────────────────────────────
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
  const tool = lines.find((l) => l.includes("⏺"));
  const detail = lines.find((l) => l.includes("└"));
  const answerIndent = answer.length - answer.trimStart().length;
  const toolIndent = tool.length - tool.trimStart().length;
  const detailIndent = detail.length - detail.trimStart().length;

  check("tool calls are indented past the answer", toolIndent > answerIndent, JSON.stringify(lines));
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
  const firstTool = lines.findIndex((l) => l.includes("⏺"));
  check("a blank line opens the group", lines[firstTool - 1].trim() === "", JSON.stringify(lines));
  check(
    "no blank lines inside the group",
    lines.slice(firstTool, firstTool + 3).every((l) => l.includes("⏺")),
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

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
