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

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
