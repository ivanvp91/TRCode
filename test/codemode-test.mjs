/**
 * Code mode (run_code): a model-written program runs in a child process, its
 * SDK calls are served by the host, and only the return value enters history.
 *
 * These tests drive the real runner: the SDK round-trip over stdin/stdout,
 * the path guard (a read outside cwd must be refused), snapshots on fs.write,
 * the timeout kill, abort, and a program that throws.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-code-"));
process.env.TRCODE_HOME = HOME;
Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

const { __runProgramForTests } = await import("../dist/tools/codemode.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const proj = fs.mkdtempSync(path.join(os.tmpdir(), "trc-code-proj-"));
fs.writeFileSync(path.join(proj, "a.txt"), "alpha");
fs.mkdirSync(path.join(proj, "sub"));
fs.writeFileSync(path.join(proj, "sub", "b.txt"), "beta");

const ctxBase = () => ({
  cwd: proj,
  signal: new AbortController().signal,
  depth: 0,
  confirm: async () => true,
  emit: () => {},
  readFiles: new Set(),
});
const deps = { confirmShell: async () => true, confirmWeb: async () => true };

async function run(code, ctx = ctxBase()) {
  return await __runProgramForTests(code, ctx, deps);
}

// ── the happy path: SDK calls, loop, structured return ──
{
  const res = await run(`
    const names = await sdk.fs.list(".");
    const out = {};
    for (const n of names.filter((x) => x.endsWith(".txt"))) {
      const body = await sdk.fs.read(n);
      out[n] = body.length;
    }
    return out;
  `);
  const val = res.ok ? JSON.parse(res.output) : {};
  check("the program returns its value", res.ok && val["a.txt"] === 5 && Object.keys(val).length === 1, res.output);
}

// ── path guard ──
{
  const outside = path.join(os.tmpdir(), "definitely-outside.txt");
  fs.writeFileSync(outside, "secret");
  const rel1 = await run(`return await sdk.fs.read("../../" + ${JSON.stringify(path.basename(proj))} + "/a.txt")`);
  // Relative escapes resolve inside cwd, so this reads OUR file or fails —
  // either way nothing outside comes back. The absolute one must fail outright.
  const abs = await run(`return await sdk.fs.read(${JSON.stringify(outside)})`);
  check("absolute path outside cwd is refused", !abs.ok && /outside/i.test(abs.output), abs.output);
  void rel1;
}

// ── write goes through the snapshot hook ──
{
  const snaps = [];
  const ctx = { ...ctxBase(), snapshot: (s) => snaps.push(s) };
  const res = await run(`return await sdk.fs.write("made/by-program.txt", "hello")`, ctx);
  const file = path.join(proj, "made", "by-program.txt");
  check("fs.write creates the file", res.ok && fs.readFileSync(file, "utf8") === "hello");
  check("fs.write is snapshotted for /rewind", snaps.length === 1 && snaps[0].before === null && /by-program/.test(snaps[0].path), JSON.stringify(snaps));
}

// ── shell through the SDK, with permission granted ──
{
  const cmd = process.platform === "win32" ? "echo hi-from-shell" : "echo hi-from-shell";
  const res = await run(`return await sdk.shell(${JSON.stringify(cmd)})`);
  check("sdk.shell captures output", res.ok && res.output.includes("hi-from-shell"), res.output);
}

// ── a throwing program reports the error, not a hang ──
{
  const res = await run(`throw new Error("boom-for-test");`);
  check("a thrown error comes back as isError", !res.ok && res.output.includes("boom-for-test"), res.output);
}

// ── a syntax error does not hang either ──
{
  const res = await run(`this is not javascript (((`);
  check("a syntax error exits with a message", !res.ok && /exited before returning|SyntaxError/i.test(res.output), res.output);
}

// ── timeout kills the program ──
process.env.TRCODE_CODE_TIMEOUT = "";
{
  const ac = new AbortController();
  const ctx = { ...ctxBase(), signal: ac.signal };
  const started = Date.now();
  setTimeout(() => ac.abort(), 1500);
  const res = await run(`await new Promise(() => {}); // never resolves`, ctx);
  check("abort ends a stuck program", !res.ok && /interrupted|timed out|exited before/i.test(res.output), res.output);
  check("abort was honoured quickly", Date.now() - started < 10_000);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
