/**
 * Switching models inside a session. The regression this pins: at startup the
 * catalog can lack a connected provider's models (a listing that failed or a
 * merge that has not landed yet), and reconcileModel() used to swap the
 * session's model for another host's on that silence — the turn then went to
 * a host with no channel for it (a 503) and looked like the chosen model
 * "does not work". A missing provider's listing says nothing about the model
 * itself, so the session keeps it.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mswitch-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mswitch-cwd-"));
process.env.TRCODE_HOME = HOME;

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

// ── scenario server: one host, two models, any id answers ──────────────────
let models = ["a-m", "b-m"];
const calls = [];
const server = http.createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, owned_by: "mock", context_window: 128000 })) }));
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const payload = JSON.parse(body);
    calls.push({ model: payload.model });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const sse = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
    const chunk = (delta) => ({
      id: "x", object: "chat.completion.chunk", model: payload.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    sse(chunk({ role: "assistant", content: "" }));
    sse(chunk({ content: "готово" }));
    sse({
      id: "x", object: "chat.completion.chunk", model: payload.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";

// Prime the provider catalog cache: without it init() opens on the built-in
// seed catalog, which has none of the scenario models, and the first
// reconcile would not be the one under test.
fs.writeFileSync(
  path.join(HOME, "models.cache.json"),
  JSON.stringify({
    tokenrouter: {
      fetchedAt: Date.now(),
      baseUrl: process.env.TOKENROUTER_BASE_URL,
      models: [{ id: "a-m" }, { id: "b-m" }],
    },
  }),
);

// ── fake terminal ──────────────────────────────────────────────────────────
const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 110, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });

let painted = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { painted += String(chunk); return true; };
const say = (s = "") => realWrite(s + "\n");
const type = (s) => stdin.emit("data", Buffer.from(s, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; say("  ok   " + name); }
  else { failed++; say("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const { App } = await import("../dist/ui/repl.js");
const { runCommand } = await import("../dist/ui/commands.js");

// ── 1. A model from a provider the catalog cannot see survives init ────────
// The isolated home has no credentials for opencode-go, so its listing never
// joins the merged catalog — exactly the silent-swap trigger.
{
  const app = new App({ cwd: WORK, model: "opencode-go:glm-5.3-flash", autoApprove: true });
  await app.init();
  check(
    "a model whose provider listing is absent is kept, not swapped",
    app.session.model === "opencode-go:glm-5.3-flash",
    `session=${app.session.model}`,
  );
  // The background fetch must not swap it either, once it lands.
  await sleep(700);
  check(
    "the background catalog refresh does not swap it either",
    app.session.model === "opencode-go:glm-5.3-flash",
    `session=${app.session.model}`,
  );
}

// ── 2. Mid-session switching: both directions, real turns ──────────────────
{
  const app = new App({ cwd: WORK, model: "a-m", autoApprove: true });
  await app.init();
  // The scenario server replaces SEED's seed models; the requested one is in.
  check("starting model from the live catalog sticks", app.session.model === "a-m", app.session.model);

  painted = "";
  await app.turn("проба раз");
  check("the turn went to the starting model", calls.some((c) => c.model === "a-m"), JSON.stringify(calls));

  await runCommand(app, "/model b-m");
  check("/model switches the session model", app.session.model === "b-m", app.session.model);

  const before = app.session.messages.length;
  await app.turn("проба два");
  const answeredBy = [...app.session.messages.slice(before)].reverse().find((m) => m.role === "assistant")?.meta?.model;
  check("the next turn goes to the new model", answeredBy === "b-m" && calls.some((c) => c.model === "b-m"), `answered=${answeredBy}`);

  await runCommand(app, "/model a-m");
  check("/model back switches again", app.session.model === "a-m", app.session.model);
  const before2 = app.session.messages.length;
  await app.turn("проба три");
  const answeredBy2 = [...app.session.messages.slice(before2)].reverse().find((m) => m.role === "assistant")?.meta?.model;
  check("and answers on the first model again", answeredBy2 === "a-m", `answered=${answeredBy2}`);
}

// ── 3. The picker path carries qualified ids ───────────────────────────────
{
  const app = new App({ cwd: WORK, model: "a-m", autoApprove: true });
  await app.init();
  painted = "";
  const p = runCommand(app, "/model");
  await sleep(450);
  type("b-m");
  await sleep(250);
  type(CR);
  await p;
  check("picking from the panel switches the session", app.session.model === "b-m", app.session.model);
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
