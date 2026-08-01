/**
 * Runs every suite. The ones that talk to a model use the local mock server,
 * so `npm test` needs no API key and no network.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT || 8877);

const SUITES = [
  "protocol-test.mjs",
  "editor-harness.mjs",
  "paste-test.mjs",
  "newline-test.mjs",
  "history-test.mjs",
  "focus-test.mjs",
  "repaint-test.mjs",
  "menu-test.mjs",
  "keyscan-test.mjs",
  "shutdown-test.mjs",
];

function run(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
      cwd: path.join(here, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
    setTimeout(() => child.kill("SIGKILL"), 120_000);
  });
}

const mock = spawn(process.execPath, [path.join(here, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(PORT) },
});
await new Promise((r) => setTimeout(r, 1200));

const env = {
  ...process.env,
  TRCODE_HOME: path.join(here, "..", ".test-home"),
  TOKENROUTER_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
  TOKENROUTER_API_KEY: "sk-test",
  TRCODE_MODEL: "mock-smart",
};

let failed = 0;
for (const suite of SUITES) {
  const { code, out } = await run(suite, env);
  const summary = out.split("\n").filter((l) => /passed|пройдено/.test(l)).pop() ?? "";
  if (code !== 0) failed++;
  console.log(`${code === 0 ? "PASS" : "FAIL"}  ${suite.padEnd(22)} ${summary.trim()}`);
  if (code !== 0) console.log(out.split("\n").filter((l) => /FAIL|ПРОВАЛ/.test(l)).join("\n"));
}

mock.kill("SIGKILL");
console.log(failed ? `\n${failed} suite(s) failed` : `\nall ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
