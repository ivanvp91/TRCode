/**
 * Prompt caching end to end against the mock: breakpoints reach the wire, the
 * cached count comes back, and a host that rejects cache_control degrades to
 * an uncached request instead of a failed turn.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-cache-"));
process.env.TRCODE_HOME = HOME;

let mock = null;
const LOG = process.env.MOCK_LOG || path.join(HOME, "mock.log");
const mockOut = () => { try { return fs.readFileSync(LOG, "utf8"); } catch { return ""; } };
if (!process.env.TOKENROUTER_BASE_URL) {
  const port = Number(process.env.MOCK_PORT || 8901);
  mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
    stdio: "ignore",
    env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: LOG },
  });
  process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
  await new Promise((r) => setTimeout(r, 1200));
}
process.env.TOKENROUTER_API_KEY = "sk-test";

const { fetchModels } = await import("../dist/provider/models.js");
const { complete, modelRejectsCache, modelRejectsLongCacheTtl } = await import("../dist/provider/client.js");

await fetchModels(); // registers protocols, so mock-claude routes to /messages

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

/** A history big enough to be worth caching. */
const history = [
  { role: "system", content: "СИСТЕМА " + "и".repeat(5000) },
  { role: "user", content: "привет " + "x".repeat(4000) },
];

async function ask(model) {
  const res = await complete({
    model,
    messages: history,
    tools: [{ name: "read", description: "d", parameters: {} }],
  });
  return { res };
}

{
  const { res } = await ask("mock-claude");
  check("the anthropic path answers", res.content.includes("Готово"), res.content);
  check("cached tokens come back", res.usage?.cached_tokens === 900, JSON.stringify(res.usage));
  check("the request carried breakpoints", /ANTHROPIC model=mock-claude cache=yes/.test(mockOut()), mockOut());
  // An agent turn outlives five minutes many times over, and so does the pause
  // while the user reads a diff.
  check("and asked for the hour, not the five minutes", /model=mock-claude cache=yes ttl=1h/.test(mockOut()), mockOut());
  // System prompt, tool block, and the tail of the history. The anchor at the
  // start of the turn coincides with the tail on a first request, and one mark
  // is not spent twice on the same block.
  check("three blocks are marked on a first request", /model=mock-claude cache=yes ttl=1h marks=3/.test(mockOut()), mockOut());
}

{
  // A host that takes breakpoints but not the hour loses the lifetime, not the
  // caching: the cheaper loss is given up first.
  const { res } = await ask("mock-nottl");
  check("a host without the hour still answers", res.content.includes("Готово"), res.content);
  check("it was asked for the hour once", (mockOut().match(/model=mock-nottl cache=yes ttl=1h/g) ?? []).length === 1, mockOut());
  check("and then retried at five minutes", /model=mock-nottl cache=yes ttl=5m/.test(mockOut()), mockOut());
  check("the shorter lifetime is remembered", modelRejectsLongCacheTtl("mock-nottl"));
  check("and caching itself was never given up", !modelRejectsCache("mock-nottl"));

  const before = (mockOut().match(/model=mock-nottl/g) ?? []).length;
  await ask("mock-nottl");
  check("no second probe for the hour", (mockOut().match(/model=mock-nottl/g) ?? []).length - before === 1, mockOut());
}

{
  // The host 400s on cache_control: one retry without it, then normal service.
  const { res } = await ask("mock-nocache");
  check("a rejecting host still answers", res.content.includes("Готово"), res.content);
  check("the retry dropped the breakpoints", /ANTHROPIC model=mock-nocache cache=no/.test(mockOut()), mockOut());
  check("the rejection is remembered", modelRejectsCache("mock-nocache"));

  const before = (mockOut().match(/model=mock-nocache/g) ?? []).length;
  await ask("mock-nocache");
  const after = (mockOut().match(/model=mock-nocache/g) ?? []).length;
  check("no second probe after learning", after - before === 1, `${before} → ${after}`);
  // Two probes carried breakpoints — one per rung of the ladder, the hour and
  // then the default lifetime — and nothing after that.
  check(
    "breakpoints are not tried again",
    (mockOut().match(/model=mock-nocache cache=yes/g) ?? []).length === 2,
    mockOut(),
  );
}

{
  // Whether the cache read is counted inside the prompt or beside it is a
  // per-host decision; the counts are reconciled on the way in, or the status
  // line divides 6300 by 800 and reports "793% cached".
  const res = await complete({ model: "mock-cache-split", messages: [{ role: "user", content: "привет" }], stream: false });
  check("cache reported beside the prompt is folded in", res.usage?.prompt_tokens === 7100, JSON.stringify(res.usage));
  check("the cached share stays a share", (res.usage?.cached_tokens ?? 0) <= (res.usage?.prompt_tokens ?? 0), JSON.stringify(res.usage));
}

{
  // OpenRouter reports detailed usage — the cached count included — only when
  // the body asks for it. Without the ask the tracker books the whole prompt as
  // fresh input, whether or not the provider cached it.
  const { writeCredentials } = await import("../dist/provider/credentials.js");
  const { saveConfig } = await import("../dist/config.js");
  writeCredentials("openrouter", { mode: "apikey", accessToken: "sk-or-test" });
  saveConfig({ providers: { openrouter: { baseUrl: process.env.TOKENROUTER_BASE_URL } } });
  const { res } = await ask("openrouter:mock-fast");
  check("an openrouter model answers", res.content.includes("СЖАТАЯ ВЫЖИМКА"), res.content);
  const line = mockOut().split("\n").filter((l) => l.includes("REQ model=mock-fast")).pop() ?? "";
  check("openrouter is asked for detailed usage", /usage_asked=\{"include":true\}/.test(line), line);

  await ask("mock-claude");
  const plain = mockOut().split("\n").filter((l) => l.includes("ANTHROPIC model=mock-claude")).pop() ?? "";
  check("the anthropic path is not asked in openai's dialect", !/"usage"/.test(plain), plain);
}

{
  // A host that takes only the older thinking shape says so in its own words:
  // "adaptive thinking is not supported on this model" names neither
  // "reasoning" nor "effort". Read literally, that reads as a bad request and
  // the turn dies — and a subagent with it. It has to step down the ladder.
  const res = await complete({
    model: "mock-oldthinking",
    messages: [{ role: "user", content: "привет" }],
    effort: "high",
    stream: false,
  });
  check("a host that rejects adaptive thinking still answers", res.content.includes("Готово"), res.content);
  check(
    "the older shape is what it was asked with",
    /model=mock-oldthinking thinking=enabled/.test(mockOut()),
    mockOut().split("\n").filter((l) => l.includes("oldthinking")).join(" · "),
  );

  const again = await complete({
    model: "mock-oldthinking",
    messages: [{ role: "user", content: "ещё" }],
    effort: "high",
    stream: false,
  });
  check("and the refusal is not repeated", again.content.includes("Готово"), again.content);
  check(
    "the working shape was remembered",
    (mockOut().match(/rejected=adaptive/g) ?? []).length === 1,
    mockOut().split("\n").filter((l) => l.includes("oldthinking")).join(" · "),
  );
}

// fetch keeps sockets alive; killing the server underneath them and exiting in
// the same tick trips a libuv assertion on Windows. Let the handles close.
mock?.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
