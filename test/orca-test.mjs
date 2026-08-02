/**
 * Status reporting to Orca, against a stand-in for its loopback server:
 * the envelope shape, the busy/waiting/idle sequence, the coalescing of
 * streamed text, and — most important — that none of it can break a turn.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-orca-"));
process.env.TRCODE_HOME = HOME;

let received = [];
let failNext = 0;
let hangNext = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (hangNext > 0) {
      hangNext--;
      return; // never answers: the reporter must not wait forever
    }
    if (failNext > 0) {
      failNext--;
      res.writeHead(500).end();
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
    received.push({ url: req.url, token: req.headers["x-orca-agent-hook-token"], body: parsed });
    res.writeHead(204).end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// Orca hands these to the agent through the environment plus a file it
// rewrites on every start; the file wins, because env goes stale.
const endpoint = path.join(HOME, "endpoint.cmd");
fs.writeFileSync(endpoint, `set ORCA_AGENT_HOOK_PORT=${port}\nset ORCA_AGENT_HOOK_TOKEN=tok-from-file\nset ORCA_AGENT_HOOK_ENV=test\nset ORCA_AGENT_HOOK_VERSION=1\n`);
process.env.ORCA_AGENT_HOOK_ENDPOINT = endpoint;
process.env.ORCA_AGENT_HOOK_PORT = "1";          // stale on purpose
process.env.ORCA_AGENT_HOOK_TOKEN = "tok-stale"; // stale on purpose
process.env.ORCA_PANE_KEY = "pane-1";
process.env.ORCA_TAB_ID = "tab-1";
process.env.ORCA_WORKTREE_ID = "wt-1";

const { OrcaReporter } = await import("../dist/ui/orca.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = () => received.map((r) => r.body?.payload?.hook_event_name);

// ── detection ───────────────────────────────────────────────────────────────
const reporter = OrcaReporter.detect();
check("detected inside an Orca pane", Boolean(reporter));

{
  const paneKey = process.env.ORCA_PANE_KEY;
  delete process.env.ORCA_PANE_KEY;
  check("silent outside Orca", OrcaReporter.detect() === null);
  process.env.ORCA_PANE_KEY = paneKey;
}

// ── the envelope ────────────────────────────────────────────────────────────
reporter.busy("s1");
reporter.userPrompt("почини сборку", "s1");
await sleep(120);
{
  const first = received[0];
  check("posts to a route Orca knows", first?.url === "/hook/opencode", String(first?.url));
  check("reads the token from the endpoint file, not stale env", first?.token === "tok-from-file", String(first?.token));
  check("carries the pane coordinates", first?.body?.paneKey === "pane-1" && first?.body?.tabId === "tab-1" && first?.body?.worktreeId === "wt-1", JSON.stringify(first?.body));
  check("busy first, then the prompt", events()[0] === "SessionBusy" && events()[1] === "MessagePart", events().join(","));
  check("the prompt text is forwarded", received[1]?.body?.payload?.text === "почини сборку" && received[1]?.body?.payload?.role === "user");
}

// ── a repeated status is not re-sent ────────────────────────────────────────
received = [];
reporter.busy("s1");
await sleep(80);
check("busy twice posts once", received.length === 0, JSON.stringify(events()));

// ── streamed text is coalesced ──────────────────────────────────────────────
received = [];
for (let i = 1; i <= 40; i++) reporter.assistantText("часть ".repeat(i), "s1");
await sleep(500);
{
  const parts = received.filter((r) => r.body?.payload?.hook_event_name === "MessagePart");
  check(`40 deltas become a few posts (${parts.length})`, parts.length > 0 && parts.length <= 4, String(parts.length));
  check("the last post carries the newest text", parts.at(-1)?.body?.payload?.text.startsWith("часть часть"), parts.at(-1)?.body?.payload?.text?.slice(0, 40));
}

// ── a permission prompt is "needs attention", not a status flip ─────────────
received = [];
reporter.waiting("shell", "rm -rf build");
await sleep(80);
check("permission asks are forwarded", events()[0] === "PermissionRequest", events().join(","));
check("the tool is named", received[0]?.body?.payload?.toolName === "shell");
received = [];
reporter.busy("s1");
await sleep(80);
check("busy still fires after a permission ask", events()[0] === "SessionBusy", events().join(","));

// ── idle flushes the preview and waits for delivery ─────────────────────────
received = [];
reporter.assistantText("итоговый ответ", "s1");
await reporter.idle("s1");
{
  const names = events();
  check("idle flushes the pending preview first", names[0] === "MessagePart" && names.includes("SessionIdle"), names.join(","));
  check("idle has already been delivered when it resolves", received.some((r) => r.body?.payload?.hook_event_name === "SessionIdle"), names.join(","));
}

// ── it must never break a turn ──────────────────────────────────────────────
{
  received = [];
  failNext = 2;
  reporter.busy("s2");
  reporter.waiting("write", "src/index.ts");
  await reporter.idle("s2");
  check("a failing server is survivable", true);

  hangNext = 1;
  const started = Date.now();
  reporter.busy("s3");
  await reporter.idle("s3");
  check(`a hanging server does not stall the turn (${Date.now() - started}ms)`, Date.now() - started < 3000, String(Date.now() - started));

  // A closed Orca is the normal case for most users.
  await new Promise((r) => server.close(r));
  const t0 = Date.now();
  reporter.busy("s4");
  await reporter.idle("s4");
  check(`a closed server costs nothing (${Date.now() - t0}ms)`, Date.now() - t0 < 2000, String(Date.now() - t0));
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
