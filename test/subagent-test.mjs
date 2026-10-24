/**
 * Which models a subagent may be launched on. The catalogue also holds image
 * and speech models; offered one, a model looking for "a cheap one for
 * mechanical work" picks it, and the subtask dies on the first request with
 * `Input should be 'user': input.messages.0.role`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-sub-"));
process.env.TRCODE_HOME = HOME;

const port = Number(process.env.MOCK_PORT || 8917);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { makeTaskTool } = await import("../dist/agent/subagent.js");
const { UsageTracker } = await import("../dist/usage.js");

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

const catalog = [
  { id: "mock-fast", modality: "text", chatCapable: true },
  { id: "mock-smart", modality: "text", chatCapable: true },
  { id: "wan2.7-image", modality: "image", chatCapable: false },
  { id: "qwen-audio-3.0-tts-plus", modality: "audio", chatCapable: false },
  { id: "text-embedding-v4", modality: "text", chatCapable: false },
];

const tool = makeTaskTool({
  cwd: process.cwd(),
  catalog,
  skills: [],
  tools: () => [],
  defaultModel: "mock-fast",
  effortFor: () => "off",
  maxSteps: 3,
  usage: new UsageTracker(),
});

const models = tool.parameters.properties.model.enum;
// The default allowlist is the session's own model: a subagent runs on what the
// session runs on unless /subagents says otherwise.
check("the session's model is offered", models.includes("mock-fast"), String(models));
// A subagent is paid for by the key this session is using, so nothing outside
// the allowlist — another provider included — is ever suggested.
check("another model of the provider is not offered by default", !models.includes("mock-smart"), String(models));
check("another provider is not offered", !models.includes("kimi:k3"), String(models));
check("image models are not", !models.includes("wan2.7-image"), String(models));
check("nor speech models", !models.includes("qwen-audio-3.0-tts-plus"), String(models));
check("nor embeddings", !models.includes("text-embedding-v4"), String(models));
check("a multi-part request reads as a fan-out", /is a fan-out: launch one subagent per part/i.test(tool.description), tool.description);

// The enum is a suggestion to a model, not a constraint the API enforces, so
// asking for one of the excluded ids has to land somewhere that works.
{
  const res = await tool.run(
    { description: "проверка", prompt: "скажи ok", model: "wan2.7-image" },
    { cwd: process.cwd(), signal: new AbortController().signal, broker: { ask: async () => true } },
  );
  check("a subagent asked for an image model still runs", !res.isError, res.output?.slice(0, 200));
  check("and it ran on the parent's model", !/wan2\.7-image/.test(res.output ?? ""), res.output?.slice(0, 200));
}


// Asked for a model from another provider, a subagent runs on the parent's
// rather than 401-ing at a host this key has never seen.
{
  const res = await tool.run(
    { description: "чужой хост", prompt: "скажи ok", model: "kimi:k3" },
    { cwd: process.cwd(), signal: new AbortController().signal, broker: { ask: async () => true } },
  );
  check("a model from another provider falls back", !res.isError, res.output?.slice(0, 120));
}

// The allowlist is enforced, not just suggested: asked for a runnable model the
// user never allowed, the subagent runs on the session's own.
{
  const { ApiError } = await import("../dist/provider/client.js");
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (/\/chat\/completions$/.test(String(url))) seen.push(body.model);
    return original(url, init);
  };
  await tool.run(
    { description: "не разрешено", prompt: "скажи ok", model: "mock-smart" },
    { cwd: process.cwd(), signal: new AbortController().signal, broker: { ask: async () => true } },
  );
  globalThis.fetch = original;
  check("a disallowed model is not what ran", !seen.includes("mock-smart"), JSON.stringify(seen));
  check("the session's model ran instead", seen.every((m) => m === "mock-fast"), JSON.stringify(seen));
}

// A shortlist, when one was chosen: /subagents widens what may be launched.
{
  const { saveConfig, loadConfig } = await import("../dist/config.js");
  saveConfig({ subagentModels: { tokenrouter: ["mock-fast", "mock-smart"] } });
  const widened = makeTaskTool({
    cwd: process.cwd(), catalog, skills: [], tools: () => [],
    defaultModel: "mock-fast", effortFor: () => "off", maxSteps: 3, usage: new UsageTracker(),
  });
  const offered = widened.parameters.properties.model.enum;
  check("the shortlist is offered", JSON.stringify(offered) === JSON.stringify(["mock-fast", "mock-smart"]), String(offered));

  // A list naming a model this provider no longer serves must not empty the
  // allowlist — an empty enum reads as "any string will do".
  saveConfig({ subagentModels: { tokenrouter: ["gone-from-catalog"] } }, { replace: ["subagentModels"] });
  const stale = makeTaskTool({
    cwd: process.cwd(), catalog, skills: [], tools: () => [],
    defaultModel: "mock-fast", effortFor: () => "off", maxSteps: 3, usage: new UsageTracker(),
  });
  check("a stale shortlist falls back to the session's model", JSON.stringify(stale.parameters.properties.model.enum) === JSON.stringify(["mock-fast"]), String(stale.parameters.properties.model.enum));

  saveConfig({ subagentModels: {} }, { replace: ["subagentModels"] });
  check("cleared, the session's model only", JSON.stringify(makeTaskTool({
    cwd: process.cwd(), catalog, skills: [], tools: () => [],
    defaultModel: "mock-fast", effortFor: () => "off", maxSteps: 3, usage: new UsageTracker(),
  }).parameters.properties.model.enum) === JSON.stringify(["mock-fast"]), JSON.stringify(loadConfig().subagentModels));
}

// The two modes: a saved list is used or it is not, and switching between them
// never costs the list itself — that was a wipe, and re-picking five models to
// get back was the whole reason the choice had to become explicit.
{
  const { saveConfig, loadConfig } = await import("../dist/config.js");
  const { subagentMode } = await import("../dist/agent/subagent.js");
  const enumOf = () => makeTaskTool({
    cwd: process.cwd(), catalog, skills: [], tools: () => [],
    defaultModel: "mock-fast", effortFor: () => "off", maxSteps: 3, usage: new UsageTracker(),
  }).parameters.properties.model.enum;

  saveConfig({ subagentModels: { tokenrouter: ["mock-fast", "mock-smart"] } }, { replace: ["subagentModels"] });
  check("a saved list reads as the list mode", subagentMode("tokenrouter") === "list");
  check("and it is what gets offered", JSON.stringify(enumOf()) === JSON.stringify(["mock-fast", "mock-smart"]), String(enumOf()));

  saveConfig({ subagentMode: { tokenrouter: "session" } });
  check("switched to the session's model, only that is offered", JSON.stringify(enumOf()) === JSON.stringify(["mock-fast"]), String(enumOf()));
  check(
    "and the list is still in the config, untouched",
    JSON.stringify(loadConfig().subagentModels.tokenrouter) === JSON.stringify(["mock-fast", "mock-smart"]),
    JSON.stringify(loadConfig().subagentModels.tokenrouter),
  );

  saveConfig({ subagentMode: { tokenrouter: "list" } });
  check("switched back, the same list is offered again", JSON.stringify(enumOf()) === JSON.stringify(["mock-fast", "mock-smart"]), String(enumOf()));

  // A provider with no mode saved behaves the way it did before the choice.
  saveConfig({ subagentMode: {} }, { replace: ["subagentMode"] });
  check("no mode saved, a list still means the list", subagentMode("tokenrouter") === "list");
  saveConfig({ subagentModels: {} }, { replace: ["subagentModels"] });
  check("no mode and no list means the session's model", subagentMode("tokenrouter") === "session");
}

// A refusal has to tell the model what to do differently, or it relaunches the
// same fan-out at the same metered host and gets refused four more times.
{
  const { ApiError } = await import("../dist/provider/client.js");
  const boom = makeTaskTool({
    cwd: process.cwd(), catalog, skills: [], tools: () => [],
    defaultModel: "mock-fast", effortFor: () => "off", maxSteps: 3, usage: new UsageTracker(),
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new ApiError("429 — rate limit exceeded (Maximum 1 requests within 1 minutes)", 429, "");
  };
  const res = await boom.run(
    { description: "лимит", prompt: "скажи ok" },
    { cwd: process.cwd(), signal: new AbortController().signal, broker: { ask: async () => true } },
  );
  globalThis.fetch = original;
  check("a rate-limited subagent is an error", res.isError === true, JSON.stringify(res).slice(0, 120));
  check("and the message says not to fan out again", /one subtask at a time|do the work in this turn/i.test(res.output), res.output);
}

// 0 means "no ceiling", not "zero steps": read the other way round, every turn
// would end before its first request.
{
  const { runAgent } = await import("../dist/agent/loop.js");
  const messages = [{ role: "user", content: "скажи ok" }];
  const res = await runAgent({
    model: "mock-fast",
    systemPrompt: "s",
    messages,
    tools: [],
    toolContext: { cwd: process.cwd(), signal: new AbortController().signal, depth: 0 },
    catalog,
    usage: new UsageTracker(),
    maxSteps: 0,
    signal: new AbortController().signal,
  });
  check("maxSteps 0 runs the turn", res.steps > 0, JSON.stringify(res));
  check("and stops when the model does", res.stoppedBecause === "stop", res.stoppedBecause);
}

// The live list in the turn bar: who is running, how far into their step
// budget, and what they have cost. The lead's context never sees any of it.
{
  const events = [];
  const traced = makeTaskTool({
    cwd: process.cwd(),
    catalog,
    skills: [],
    tools: () => [],
    defaultModel: "mock-fast",
    effortFor: () => "off",
    maxSteps: 6,
    usage: new UsageTracker(),
    activity: {
      begin: (info) => events.push(["begin", info]),
      update: (info) => events.push(["update", info]),
      end: (id) => events.push(["end", id]),
    },
  });
  await traced.run(
    { description: "статус", prompt: "скажи ok" },
    { cwd: process.cwd(), signal: new AbortController().signal, broker: { ask: async () => true } },
  );
  const began = events.find(([kind]) => kind === "begin")?.[1];
  const updated = events.filter(([kind]) => kind === "update").map(([, info]) => info);
  const ended = events.find(([kind]) => kind === "end")?.[1];
  check("a helper is listed the moment it starts", began?.model === "mock-fast" && began?.maxSteps === 6, JSON.stringify(began));
  check("its steps are reported as it goes", updated.some((i) => i.steps > 0), JSON.stringify(updated.map((i) => i.steps)));
  check("and so is what it has spent", updated.some((i) => i.tokens > 0), JSON.stringify(updated.map((i) => i.tokens)));
  check("it leaves the list when it is done", ended === began?.id, String(ended));
}

// The row itself: `1. model 70% · 25k tok`.
{
  const { subagentRow } = await import("../dist/ui/render.js");
  const { stripAnsi } = await import("../dist/ui/ansi.js");
  const row = stripAnsi(subagentRow({ id: 1, label: "a", model: "deepseek-v4.1-flash", steps: 7, maxSteps: 10, tokens: 25000 }));
  check("a row carries the model, the budget share and the tokens", row === "1. deepseek-v4.1-flash 70% · 25k tok", row);
  const busy = stripAnsi(subagentRow({ id: 2, label: "b", model: "glm-5.3-flash", steps: 3, maxSteps: 3, tokens: 1200, line: "read src/a.ts" }));
  check("a spent budget never reads 100% while it runs", busy.includes("99%"), busy);
  check("and its latest action rides along", busy.endsWith("· read src/a.ts"), busy);
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* Windows may hold the directory briefly; the temp dir is disposable */
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
