/**
 * Runs every suite. The ones that talk to a model use the local mock server,
 * so `npm test` needs no API key and no network.
 */
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A port nobody holds right now. Fixed numbers collide the moment two
 * checkouts — or two sessions in one checkout — run the tests at once, and
 * the loser's suites each wait out their whole timeout against a mock that
 * is not theirs.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * SIGKILL the process and everything under it: a suite killed on its timeout
 * must take the mock server it spawned along, or the orphan keeps the port.
 */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    // Suites are spawned as group leaders; the negative pid takes the group.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : await freePort();

const SUITES = [
  "protocol-test.mjs",
  "provider-test.mjs",
  "mode-test.mjs",
  "lang-test.mjs",
  "i18n-test.mjs",
  "config-test.mjs",
  "diff-test.mjs",
  "thinking-test.mjs",
  "trim-test.mjs",
  "spill-test.mjs",
  "cache-test.mjs",
  "ratelimit-test.mjs",
  "interrupt-test.mjs",
  "reconnect-test.mjs",
  "toolpairs-test.mjs",
  "memory-test.mjs",
  "subagent-test.mjs",
  "brain-test.mjs",
  "brain-ui-test.mjs",
  "promptmode-test.mjs",
  "shell-output-test.mjs",
  "checkpoint-test.mjs",
  "prompt-test.mjs",
  "skill-test.mjs",
  "uilib-test.mjs",
  "mcp-test.mjs",
  "web-test.mjs",
  "orca-test.mjs",
  "editor-harness.mjs",
  "paste-test.mjs",
  "stash-test.mjs",
  "stat-test.mjs",
  "projection-test.mjs",
  "preset-test.mjs",
  "codemode-test.mjs",
  "fork-test.mjs",
  "edit-test.mjs",
  "newline-test.mjs",
  "history-test.mjs",
  "focus-test.mjs",
  "repaint-test.mjs",
  "menu-test.mjs",
  "picker-test.mjs",
  "choice-test.mjs",
  "indent-test.mjs",
  "resume-test.mjs",
  "turnbar-test.mjs",
  "turnbar-mode-test.mjs",
  "transcript-test.mjs",
  "keyscan-test.mjs",
  "shutdown-test.mjs",
  "update-test.mjs",
];

/** The suite now in flight, so an interrupt can take it down tree and all. */
let running = null;

function run(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
      cwd: path.join(here, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env,
      // Its own process group, so the timeout kill reaches the whole tree.
      detached: process.platform !== "win32",
    });
    running = child;
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const reaper = setTimeout(() => killTree(child), 120_000);
    child.on("exit", (code) => {
      clearTimeout(reaper);
      running = null;
      resolve({ code, out });
    });
  });
}

// Suites that assert on what actually reached the wire read this back.
const MOCK_LOG = path.join(os.tmpdir(), `trc-mock-${process.pid}.log`);
try {
  fs.rmSync(MOCK_LOG, { force: true });
} catch {
  /* nothing to clear */
}

const mock = spawn(process.execPath, [path.join(here, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(PORT), MOCK_LOG },
});

// An interrupted run must not leave the mock — or the suite in flight, with
// the mock of its own — holding ports for every run that comes after.
process.on("exit", () => {
  killTree(running);
  killTree(mock);
  try { fs.rmSync(MOCK_LOG, { force: true }); } catch {}
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => process.exit(130));
}

// Wait until the mock actually answers rather than napping a fixed spell: a
// busy machine outlives any constant, and a failed bind should say so now.
const ready = await (async () => {
  for (let i = 0; i < 50; i++) {
    if (mock.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})();
if (!ready) {
  console.error(`the mock server did not come up on port ${PORT}`);
  process.exit(1);
}

const env = {
  ...process.env,
  TRCODE_HOME: path.join(here, "..", ".test-home"),
  TOKENROUTER_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
  TOKENROUTER_API_KEY: "sk-test",
  TRCODE_MODEL: "mock-smart",
  MOCK_LOG,
};

let failed = 0;
for (const suite of SUITES) {
  // Suites that raise a mock of their own read MOCK_PORT before falling back
  // to a hardcoded default; a fresh free port per suite keeps two parallel
  // runs — and a stray MOCK_PORT in the caller's environment — off each
  // other's servers.
  const { code, out } = await run(suite, { ...env, MOCK_PORT: String(await freePort()) });
  const summary = out.split("\n").filter((l) => /passed|пройдено/.test(l)).pop() ?? "";
  if (code !== 0) failed++;
  console.log(`${code === 0 ? "PASS" : "FAIL"}  ${suite.padEnd(22)} ${summary.trim()}`);
  if (code !== 0) console.log(out.split("\n").filter((l) => /FAIL|ПРОВАЛ/.test(l)).join("\n"));
}

// The exit handler above takes the mock and the log down.
console.log(failed ? `\n${failed} suite(s) failed` : `\nall ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
