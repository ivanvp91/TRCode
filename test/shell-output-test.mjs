/**
 * Shell output capture: a long run keeps its beginning *and* its end. Cutting
 * at the head alone loses the summary line a test run exists for, and the
 * model then reruns the command to see it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-shell-"));
process.env.TRCODE_HOME = HOME;

const { shellTool } = await import("../dist/tools/shell.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const ctx = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  depth: 0,
  confirm: async () => true,
  emit: () => {},
  readFiles: new Set(),
};

/** Prints 60k lines, then a final line that is the whole point of the run. */
const script =
  "let i=0; while(i<60000){ console.log('line '+i); i++ } console.log('SUMMARY: 3 failed, 41 passed')";
const res = await shellTool.run({ command: `node -e "${script}"` }, ctx);

check("the command ran", !res.isError, res.output.slice(0, 200));
check("the beginning is kept", /line 0\b/.test(res.output), res.output.slice(0, 120));
check("the end is kept", /SUMMARY: 3 failed, 41 passed/.test(res.output), res.output.slice(-200));
check("the middle is marked as dropped", /characters omitted from the middle/.test(res.output));
check("the whole thing stays bounded", res.output.length < 60_000, String(res.output.length));

// Short output must come through untouched, with no markers.
const small = await shellTool.run({ command: `node -e "console.log('just this')"` }, ctx);
check("short output is verbatim", /just this/.test(small.output) && !/omitted/.test(small.output), small.output);

// The limit is on silence, not on duration: a build that prints for minutes is
// working, and killing it at the two-minute mark is how `gradle
// compileDebugKotlin` came back as a timeout while it was still compiling.
{
  const lines = [];
  const chatty = { ...ctx, emit: (l) => lines.push(l) };
  // A file rather than -e: the quoting of an inline script has to survive two
  // shells on the way in, and a test that fails on that tests the wrong thing.
  const talker = path.join(HOME, "talker.js");
  fs.writeFileSync(
    talker,
    [
      "let i = 0;",
      "console.log('step 0');",          // at once: a slow shell start is not what this measures
      "const t = setInterval(() => {",
      "  console.log('step ' + ++i);",
      "  if (i > 7) clearInterval(t);",
      "}, 500);",
    ].join(String.fromCharCode(10)),
  );
  const at0 = Date.now();
  const res = await shellTool.run({ command: `node "${talker}"`, timeout_ms: 2000 }, chatty);
  const secs = (Date.now() - at0) / 1000;
  check("a command that keeps printing is not killed", !res.isError, res.output.slice(-120));
  check("even well past the idle limit", secs > 2.5, secs.toFixed(1) + "s");
  check("and its output is tailed live", lines.length > 1, JSON.stringify(lines.slice(0, 3)));
}

// Silence is still a reason to stop.
{
  const at0 = Date.now();
  const res = await shellTool.run({ command: `node -e "setTimeout(()=>{},30000)"`, timeout_ms: 1200 }, ctx);
  check("a silent command is killed on the idle limit", res.isError === true, res.output.slice(-120));
  check("and it says silence was the reason", /no output for/.test(res.output), res.output.slice(-120));
  check("without waiting out the whole command", (Date.now() - at0) / 1000 < 5, ((Date.now() - at0) / 1000).toFixed(1) + "s");
}

// What the user sees of a failure. A build opens with pages of warnings and
// says what actually went wrong in its last lines, so the first eight showed
// the noise and hid the reason.
{
  const script = path.join(HOME, "fake-build.js");
  fs.writeFileSync(
    script,
    [
      "for (let i = 1; i <= 12; i++) console.log('WARNING ' + i);",
      "console.log('> Task :app:compileDebugKotlin');",
      "console.log('FAILURE: Build failed with an exception.');",
      "console.log('* What went wrong:');",
      "console.log(\"Execution failed for task ':app:compileDebugKotlin'.\");",
      "process.exit(1);",
    ].join(String.fromCharCode(10)),
  );
  const failed = await shellTool.run({ command: `node "${script}"` }, ctx);
  check("a failure shows its ending", /What went wrong/.test(failed.display), failed.display);
  check("and says how much is above", /lines above/.test(failed.display), failed.display);
  check("the model still gets all of it", failed.output.includes("WARNING 1"), failed.output.slice(0, 80));

  const fine = await shellTool.run({ command: `node -e "console.log('первая');console.log('вторая')"` }, ctx);
  check("a successful command shows its beginning", fine.display.startsWith("первая"), fine.display);
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
