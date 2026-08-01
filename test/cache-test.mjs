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
const { complete, modelRejectsCache } = await import("../dist/provider/client.js");

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
  // Exactly one request carried breakpoints: the probe that taught us.
  check(
    "breakpoints are not tried again",
    (mockOut().match(/model=mock-nocache cache=yes/g) ?? []).length === 1,
    mockOut,
  );
}

// fetch keeps sockets alive; killing the server underneath them and exiting in
// the same tick trips a libuv assertion on Windows. Let the handles close.
mock?.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
