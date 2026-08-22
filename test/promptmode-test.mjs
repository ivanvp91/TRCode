/**
 * The prompt writer: a small model turns a short ask into a brief, and the
 * choice of that model follows the provider whose key is paying.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-prompt-"));
process.env.TRCODE_HOME = HOME;
delete process.env.TRCODE_MODEL;

const port = Number(process.env.MOCK_PORT || 8919);
const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
});
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENROUTER_API_KEY = "sk-test";
await new Promise((r) => setTimeout(r, 1200));

const { saveConfig } = await import("../dist/config.js");
const { composePrompt, promptModelFor } = await import("../dist/agent/promptwriter.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const catalog = [
  { id: "mock-smart", modality: "text", chatCapable: true },
  { id: "mock-fast", modality: "text", chatCapable: true },
  { id: "kimi:k3", modality: "text", chatCapable: true },
  { id: "wan-image", modality: "image", chatCapable: false },
];

// ── which model writes ──────────────────────────────────────────────────────
saveConfig({ smallModel: "mock-fast", promptModels: {} });
check("without a pin it falls back to the small model", promptModelFor("mock-smart", catalog) === "mock-fast", promptModelFor("mock-smart", catalog));

saveConfig({ promptModels: { tokenrouter: "mock-smart" } });
check("a pinned writer wins", promptModelFor("mock-fast", catalog) === "mock-smart", promptModelFor("mock-fast", catalog));

// The small model belongs to the router; a session on another provider must
// not spend it — that key cannot call it.
check("another provider gets its own model, not the router's", promptModelFor("kimi:k3", catalog) === "kimi:k3", promptModelFor("kimi:k3", catalog));

saveConfig({ promptModels: { tokenrouter: "gone-from-catalog" } });
check("a pin at a model that is gone is ignored", promptModelFor("mock-smart", catalog) === "mock-fast", promptModelFor("mock-smart", catalog));

saveConfig({ promptModels: { tokenrouter: "wan-image" } });
check("and so is one at a model that cannot chat", promptModelFor("mock-smart", catalog) === "mock-fast", promptModelFor("mock-smart", catalog));

// ── writing ─────────────────────────────────────────────────────────────────
{
  const usage = new (await import("../dist/usage.js")).UsageTracker();
  const written = await composePrompt({
    task: "нарисуй интерфейс",
    model: "mock-fast",
    cwd: process.cwd(),
    skills: [{ name: "ui-design", description: "макеты и интерфейсы" }],
    catalog,
    usage,
  });
  check("it returns something to send", typeof written === "string" && written.length > 0, written);
  check("the call is counted against the session", usage.totals().input > 0, JSON.stringify(usage.totals()));
}

// The spelling nobody gets right the first time reaches the command anyway.
{
  const { commandNames } = await import("../dist/ui/commands.js");
  const names = commandNames();
  check("the typo is an alias too", names.includes("/promt") && names.includes("/promt_model"), names.filter((n) => n.includes("prom")).join(" "));
}

// A brief is a paragraph; printed raw it wraps at column zero and every line
// but the first falls outside the margin the transcript keeps.
{
  const { wrapText } = await import("../dist/ui/render.js");
  const long = "слово ".repeat(60).trim();
  const lines = wrapText(long, 40);
  check("the brief is wrapped, not left to the terminal", lines.length > 1 && lines.every((l) => l.length <= 40), lines.length + " lines, max " + Math.max(...lines.map((l) => l.length)));
}

// "the default one" is an answer, and has to be remembered as one — otherwise
// the first-run question comes back on every /prompt.
{
  const { AUTO } = await import("../dist/agent/promptwriter.js");
  saveConfig({ promptModels: { tokenrouter: AUTO }, smallModel: "mock-fast" });
  check("auto is not taken for a model id", promptModelFor("mock-smart", catalog) === "mock-fast", promptModelFor("mock-smart", catalog));
  const { loadConfig } = await import("../dist/config.js");
  check("but it counts as an answer given", Boolean(loadConfig().promptModels.tokenrouter), JSON.stringify(loadConfig().promptModels));
}

mock.kill();
await new Promise((r) => setTimeout(r, 200));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
