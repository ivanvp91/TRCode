#!/usr/bin/env node
/**
 * browser-batch-smoke.mjs - permanent regression test for `browser.mjs batch`.
 *
 *   node .trcode/skills/desktop-control/tests/browser-batch-smoke.mjs
 *
 * Headless and self-contained: it writes its own form page and scenarios into a
 * temp dir, picks a free port (so a browser the user owns is never touched) and
 * drives browser.mjs through exactly two `batch` runs - one that must succeed and
 * one that must stop on a failing selector. The browser it starts is always quit
 * and its temp profile/state file are always checked gone. No npm dependencies,
 * no headed windows, no OS input.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/browser.mjs", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-batch-smoke-"));
const stateFileOf = (port) => path.join(os.tmpdir(), `trcode-browser-${port}.json`);
const checks = [];
const check = (pass, label, detail) => {
  checks.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"} ${label}${pass || !detail ? "" : ` -- ${detail}`}`);
};

const FORM = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>batch smoke</title></head>
  <body>
    <h1>batch smoke</h1>
    <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent ' + document.getElementById('name').value; return false;">
      <input id="name" type="text" />
      <button id="go" type="button" onclick="document.getElementById('out').textContent = 'hello ' + document.getElementById('name').value">Go</button>
      <button id="submit" type="submit">Send</button>
    </form>
    <div id="out">idle</div>
  </body>
</html>
`;

/** open -> waitfor -> type -> click -> text (no quit: the failure run reuses this browser). */
const OK_STEPS = [
  { open: "form.html" },
  { waitfor: { selector: "#go", timeoutMs: 5000 } },
  { type: { selector: "#name", text: "smoke" } },
  { click: "#go" },
  { text: "#out" },
];
/** nav -> text -> click a selector that does not exist -> text (must never run). */
const FAIL_STEPS = [{ nav: "form.html" }, { text: "h1" }, { click: "#nope" }, { text: "#out" }];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(port, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    env: { ...process.env, TRCODE_CDP_PORT: String(port) },
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
}

/** The report is the single stdout line that starts with a brace. */
function reportOf(res) {
  const line = String(res.stdout ?? "")
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const port = await freePort();
const stateFile = stateFileOf(port);
let profile = null;
try {
  fs.writeFileSync(path.join(dir, "form.html"), FORM, "utf8");
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ steps: OK_STEPS }, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "fail.json"), JSON.stringify({ steps: FAIL_STEPS }, null, 2), "utf8");

  const good = run(port, ["batch", "ok.json"]);
  const report = reportOf(good);
  check(good.status === 0, "a passing scenario exits 0", `exit ${good.status}: ${good.stdout || good.stderr}`);
  check(report?.ok === true, "its report says ok:true", JSON.stringify(report));
  check(report?.completed === OK_STEPS.length, `it completed all ${OK_STEPS.length} steps`, `completed ${report?.completed}`);
  const textStep = report?.results?.find((r) => r.action === "text");
  check(textStep?.text === "hello smoke", "the form produced the expected text", `got ${JSON.stringify(textStep?.text)}`);

  if (fs.existsSync(stateFile)) {
    profile = JSON.parse(fs.readFileSync(stateFile, "utf8")).profile ?? null;
  }
  check(Boolean(profile) && fs.existsSync(profile), "the browser and its temp profile are recorded", stateFile);

  const bad = run(port, ["batch", "fail.json"]);
  const failed = reportOf(bad);
  check(bad.status !== 0, "a failing scenario exits non-zero", `exit ${bad.status}`);
  check(failed?.ok === false, "its report says ok:false", JSON.stringify(failed));
  check(failed?.failedStep === 3 && failed?.action === "click", "the report names the step and the action", JSON.stringify(failed));
  check(failed?.completed === 2 && failed?.results?.length === 2, "it stopped there instead of continuing", `completed ${failed?.completed}`);
  check(/#nope/.test(failed?.error ?? ""), "the error quotes the selector that failed", failed?.error);

  const quit = run(port, ["quit"]);
  check(quit.status === 0 && /browser closed/.test(quit.stdout ?? ""), "quit stops the owned browser", quit.stdout?.trim());
} finally {
  // Whatever happened above, no browser of ours may survive the test.
  if (fs.existsSync(stateFile)) run(port, ["quit"]);
  check(!fs.existsSync(stateFile), "the state file is gone", stateFile);
  check(!profile || !fs.existsSync(profile), "the temp profile is gone", profile ?? "");
  fs.rmSync(dir, { recursive: true, force: true });
  check(!fs.existsSync(dir), "the scenario dir is gone", dir);
}

const failures = checks.filter((pass) => !pass).length;
console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
process.exitCode = failures ? 1 : 0;
