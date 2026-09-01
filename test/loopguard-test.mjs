/**
 * A turn that goes nowhere.
 *
 * A model without vision was given a screenshot: read_image said "the image
 * itself follows above", the host quietly refused the pixels one layer down,
 * and the model — seeing nothing — asked again. 158 identical calls later the
 * history held 29 MB of base64 and the turn had produced no text at all.
 *
 * Two things have to hold now: the same call, repeated with nothing in
 * between, stops being run; and a host that strips images says so in the
 * result, where the model reads what a call produced.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-loopguard-"));
process.env.TRCODE_HOME = HOME;

const port = Number(process.env.MOCK_PORT || 8947);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { runAgent } = await import("../dist/agent/loop.js");
const { UsageTracker } = await import("../dist/usage.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const ctx = () => ({
  cwd: process.cwd(),
  depth: 0,
  signal: new AbortController().signal,
  readFiles: new Set(),
  emit() {},
  async confirm() { return true; },
});

// ── the same call, over and over ────────────────────────────────────────────
{
  let runs = 0;
  const read = {
    name: "read",
    description: "d",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    risk: "read",
    async run() { runs++; return { output: "то же самое, что и в прошлый раз" }; },
  };
  const messages = [{ role: "user", content: "посмотри" }];
  const res = await runAgent({
    model: "mock-loop",
    systemPrompt: "ты агент",
    messages,
    tools: [read],
    toolContext: ctx(),
    catalog: [{ id: "mock-loop" }],
    usage: new UsageTracker(),
    maxSteps: 40,
    signal: new AbortController().signal,
    effort: "off",
    toolConcurrency: 1,
  });

  check("the turn is given up on rather than run forever", res.stoppedBecause === "looping", res.stoppedBecause);
  check("well short of the step ceiling", res.steps < 12, String(res.steps));
  check("the tool stopped being run", runs === 3, `ran ${runs} times`);

  const refusals = messages.filter((m) => m.role === "tool" && String(m.content).startsWith("Not run."));
  check("the model was told, in the tool's own voice", refusals.length >= 1, String(refusals.length));
  check("and told how many times it had asked", /call #4 of an identical "read"/.test(refusals[0]?.content ?? ""), refusals[0]?.content);
  check("with something else to do", /Stop calling it/.test(refusals[0]?.content ?? ""));
}

// ── pixels the host will not carry ──────────────────────────────────────────
{
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");
  const read = {
    name: "read",
    description: "d",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    risk: "read",
    async run() {
      return { output: "preview.png — PNG, 1×1. The image itself follows above.", images: [{ data: png, mime: "image/png" }] };
    },
  };
  const messages = [{ role: "user", content: "посмотри картинку" }];
  const res = await runAgent({
    model: "mock-novision",
    systemPrompt: "ты агент",
    messages,
    tools: [read],
    toolContext: ctx(),
    catalog: [{ id: "mock-novision" }],
    usage: new UsageTracker(),
    maxSteps: 6,
    signal: new AbortController().signal,
    effort: "off",
    toolConcurrency: 1,
  });

  check("the turn still finishes", res.stoppedBecause === "stop", res.stoppedBecause);
  const result = messages.find((m) => m.role === "tool");
  check("the base64 is gone from the history", !result?.images?.length);
  check(
    "and the model is told the pixels never arrived",
    /pixels were NOT sent/.test(String(result?.content ?? "")),
    String(result?.content ?? ""),
  );
  check(
    "including that asking again will not help",
    /Calling this tool again will not change that/.test(String(result?.content ?? "")),
  );
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
