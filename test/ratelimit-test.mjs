/**
 * Rate limits: a 429 is waited out and retried, and nothing else is ever held
 * back. The client used to keep the window a host named and pace later sends
 * by it — which turned one refusal into a minute of dead time before every
 * later step, on models that were never metered. These tests pin the rule:
 * a wait only ever follows a refusal that actually came back.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-rate-"));
process.env.TRCODE_HOME = HOME;

const LOG = path.join(HOME, "mock.log");
const port = Number(process.env.MOCK_PORT || 8907);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: LOG },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { complete } = await import("../dist/provider/client.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
};

const attempts = (model) =>
  (fs.readFileSync(LOG, "utf8").match(new RegExp(`RATE model=${model} status=\\d+`, "g")) ?? []);
const ask = (model) => complete({ model, messages: [{ role: "user", content: "привет" }], stream: false });
const timed = async (fn) => {
  const at = Date.now();
  await fn();
  return Date.now() - at;
};
const waits = [];

// The mock allows one request per 1.5s and phrases its 429 the way Model
// Studio does, naming the window in the message rather than in Retry-After.
{
  await ask("mock-limited"); // the first one is always allowed
  const waited = await timed(() => ask("mock-limited"));
  const log = attempts("mock-limited");
  check("the 429 is absorbed, not raised", log.length >= 3, log.join(" · "));
  check("the retry waits out the window the host named", waited >= 1500, `${waited}ms`);
}

// The rule. mock-burst refuses once and then accepts everything, so every send
// after the first is proof that nothing is being held back in advance.
{
  await ask("mock-burst"); // refused once, waited, accepted
  const second = await timed(() => ask("mock-burst"));
  const third = await timed(() => ask("mock-burst"));
  check("a send after a 429 is not delayed", second < 500, `${second}ms`);
  check("and neither is the one after that", third < 500, `${third}ms`);
  check("the burst was refused exactly once", attempts("mock-burst").filter((l) => l.endsWith("429")).length === 1, attempts("mock-burst").join(" · "));
}

// Nothing learned from one model reaches another, because nothing is learned.
{
  const waited = await timed(() => ask("mock-fast"));
  check("another model is untouched", waited < 500, `${waited}ms`);
}

// The wait is announced with the model it belongs to: a limit hit by a
// subagent or the small model must not read as the session's own.
{
  await complete({
    model: "mock-limited",
    messages: [{ role: "user", content: "привет" }],
    stream: false,
    onRateWait: (ms, model) => waits.push({ ms, model }),
  });
  await complete({
    model: "mock-limited",
    messages: [{ role: "user", content: "привет" }],
    stream: false,
    onRateWait: (ms, model) => waits.push({ ms, model }),
  });
  check("the wait names its model", waits.length > 0 && waits.every((w) => w.model === "mock-limited"), JSON.stringify(waits));
}

// Four subagents launched at once at a host that serves one request at a time.
// Three of them are refused on arrival; none of them may die of it.
{
  const t0 = Date.now();
  const results = await Promise.all(
    [1, 2, 3, 4].map((i) =>
      complete({ model: "mock-limited", messages: [{ role: "user", content: "hi " + i }], stream: false })
        .then(() => "ok")
        .catch((e) => "упал: " + e.message.slice(0, 40)),
    ),
  );
  check("a burst of parallel calls all get through", results.every((r) => r === "ok"), results.join(" · "));
  check("and they are spread out, not stormed", Date.now() - t0 > 3000, Date.now() - t0 + "ms");
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
