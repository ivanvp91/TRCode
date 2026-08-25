/**
 * The minimal preset: two tools (shell, edit) and a short system prompt.
 *
 * It exists to shed tokens — the tool schemas, the skills/memory sections and
 * the workspace listing all ride along on every request — and to give cheap
 * models a smaller surface to fumble in. These tests pin the two halves of the
 * deal: the registry really shrinks to two tools, the prompt really shrinks,
 * and neither leaks standard-mode pieces.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-preset-"));
process.env.TRCODE_HOME = HOME;
process.env.TRCODE_MODEL = "mock:m";
Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

const { buildTools, TodoStore } = await import("../dist/tools/index.js");
const { buildSystemPrompt } = await import("../dist/agent/prompt.js");
const { loadConfig } = await import("../dist/config.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const base = {
  skills: [],
  todo: new TodoStore(),
  onTodoChange: () => {},
};

// ── the registry ──
{
  const std = buildTools({ ...base });
  const min = buildTools({ ...base, preset: "minimal" });
  const names = min.map((t) => t.name).sort();
  check("standard keeps more tools than minimal", std.length > min.length);
  check("minimal is exactly shell + edit", JSON.stringify(names) === JSON.stringify(["edit", "shell"]), names.join(","));
}

// ── the prompt ──
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trc-preset-proj-"));
  const opts = { cwd, model: "mock:m", skills: [] };
  const std = buildSystemPrompt(opts);
  const min = buildSystemPrompt({ ...opts, preset: "minimal" });

  check("minimal prompt is much shorter", min.length < std.length / 3, `min=${min.length} std=${std.length}`);
  check("minimal names both tools", min.includes("shell") && min.includes("edit"));
  check("no workspace listing in minimal", !min.includes("<workspace>"));
  check("no git section in minimal", !min.includes("<git>"));
  check("no memory section in minimal", !min.includes("<project-memory>"));
  check("language directive survives", min.includes("<language>"));
}

// ── config default ──
check("default preset is standard", loadConfig().preset === "standard");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
