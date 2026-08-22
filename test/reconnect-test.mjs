/**
 * A connection that dies mid-answer.
 *
 * Node reports it as `TypeError: terminated` and puts the real cause one level
 * down, so a turn that had run for ten minutes ended with one word that said
 * nothing about what happened. The host never refused anything — the request is
 * still valid — so the step goes out again, and only a host that keeps hanging
 * up reaches the user, with a sentence that names the cause.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-reconnect-"));
process.env.TRCODE_HOME = HOME;

const port = Number(process.env.MOCK_PORT || 8939);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { runAgent } = await import("../dist/agent/loop.js");
const { UsageTracker } = await import("../dist/usage.js");
const { ApiError, causeChain, describeConnectionDrop, isConnectionDrop } = await import("../dist/provider/client.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// ── telling a dead socket from an answer ────────────────────────────────────
{
  const terminated = new TypeError("terminated");
  terminated.cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  check("a dropped connection is recognised", isConnectionDrop(terminated));
  check("the cause is read, not just the message", causeChain(terminated).join(" ").includes("other side closed"));
  check("and named in words", /closed the connection mid-answer/.test(describeConnectionDrop(terminated)));

  const bodyTimeout = new TypeError("terminated");
  bodyTimeout.cause = Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" });
  check(
    "Node's own five-minute limit is called what it is",
    /5 minutes with no data/.test(describeConnectionDrop(bodyTimeout)),
    describeConnectionDrop(bodyTimeout),
  );

  const dns = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example"), { code: "ENOTFOUND" }) });
  check("a name that does not resolve is not a host problem", /could not be resolved/.test(describeConnectionDrop(dns)));

  // What the host actually said is an answer, not a broken pipe: retrying it
  // resends the same history for the same refusal.
  check("a refusal is not a dropped connection", !isConnectionDrop(new ApiError("429 — rate limited", 429)));
  const aborted = new DOMException("Aborted", "AbortError");
  check("an interrupt is not a dropped connection", !isConnectionDrop(aborted));

  // A router whose upstream went quiet answers inside the still-open stream
  // with words instead of a hang-up. It never judged the request, so the step
  // has to be resent, not reported as a refusal.
  check(
    "a router's upstream timeout is a dropped connection",
    isConnectionDrop(new ApiError("500 — Upstream idle timeout exceeded", 500)),
  );
  check(
    "a router's other 500 is still an answer",
    !isConnectionDrop(new ApiError("500 — internal error", 500)),
  );
  check(
    "an upstream timeout is named in words",
    /upstream sat silent/.test(describeConnectionDrop(new ApiError("500 — Upstream idle timeout exceeded", 500))),
    describeConnectionDrop(new ApiError("500 — Upstream idle timeout exceeded", 500)),
  );
}

// ── the loop resends the step ───────────────────────────────────────────────
{
  const reconnects = [];
  const usage = new UsageTracker();
  const res = await runAgent({
    model: "mock-drop",
    systemPrompt: "ты агент",
    messages: [{ role: "user", content: "привет" }],
    tools: [],
    toolContext: { cwd: process.cwd(), depth: 0, signal: new AbortController().signal },
    catalog: [{ id: "mock-drop" }],
    usage,
    maxSteps: 4,
    signal: new AbortController().signal,
    effort: "off",
    toolConcurrency: 1,
    events: { onReconnect: (reason, attempt, of) => reconnects.push({ reason, attempt, of }) },
  });

  check("the turn survives the drop", res.finalText.includes("ПОСЛЕ ОБРЫВА"), JSON.stringify(res.finalText));
  check("the resend was announced once", reconnects.length === 1, JSON.stringify(reconnects));
  check("the announcement says why", /closed|dropped|5 minutes/.test(reconnects[0]?.reason ?? ""), reconnects[0]?.reason);
  check("it is counted against a budget", reconnects[0]?.attempt === 1 && reconnects[0]?.of >= 2, JSON.stringify(reconnects[0]));
  // The step was re-sent, not skipped: one step, two requests.
  check("the same step went out again", res.steps === 1, String(res.steps));
}

// ── the same drop in a router's words, inside the stream ────────────────────
{
  const reconnects = [];
  const usage = new UsageTracker();
  const res = await runAgent({
    model: "mock-upstream-timeout",
    systemPrompt: "ты агент",
    messages: [{ role: "user", content: "привет" }],
    tools: [],
    toolContext: { cwd: process.cwd(), depth: 0, signal: new AbortController().signal },
    catalog: [{ id: "mock-upstream-timeout" }],
    usage,
    maxSteps: 4,
    signal: new AbortController().signal,
    effort: "off",
    toolConcurrency: 1,
    events: { onReconnect: (reason, attempt, of) => reconnects.push({ reason, attempt, of }) },
  });

  check("the turn survives the router's words too", res.finalText.includes("ПОСЛЕ ОБРЫВА"), JSON.stringify(res.finalText));
  check("the resend was announced once", reconnects.length === 1, JSON.stringify(reconnects));
  check(
    "the announcement names the upstream",
    /upstream sat silent/.test(reconnects[0]?.reason ?? ""),
    reconnects[0]?.reason,
  );
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
