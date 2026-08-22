/**
 * The memory tool: facts survive in .trcode/memory.md, dedupe keeps the file
 * clean, remove matches loosely, and the prompt section is empty while there
 * is nothing to remember.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mem-"));
const cwd = path.join(HOME, "proj");
fs.mkdirSync(cwd);

const { makeMemoryTool, memorySection, MEMORY_FILE } = await import("../dist/tools/memory.js");

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
const onDisk = () => fs.readFileSync(path.join(cwd, MEMORY_FILE), "utf8");

check("prompt section is empty with no file", memorySection(cwd) === "");

const mem = makeMemoryTool(cwd);
const run = async (args) => (await mem.run(args)).output;

await mem.run({ action: "add", facts: ["Builds with npm run build", "Tests need no network"] });
check("add writes the file", fs.existsSync(path.join(cwd, MEMORY_FILE)));
check("file holds the facts", onDisk().includes("Builds with npm run build") && onDisk().includes("Tests need no network"));
check("section appears after the first fact", memorySection(cwd).includes("<project-memory") && memorySection(cwd).includes("npm run build"));

const again = await mem.run({ action: "add", facts: ["builds with npm run build", "A new fact"] });
check("duplicate (case-insensitive) skipped", !onDisk().includes("builds with"));
check("new fact still added", onDisk().includes("A new fact"));

await mem.run({ action: "remove", facts: ["tests need no network", "never was there"] });
const afterRemove = onDisk();
check("remove drops the line", !afterRemove.includes("Tests need no network"));
check("unknown fact reported, not fatal", !afterRemove.includes("never was there"));

await mem.run({ action: "remove", facts: ["A new fact", "Builds with npm run build"] });
check("removing the last facts empties the file", onDisk().trim() === "");
check("section hides an empty memory", !memorySection(cwd).includes("<project-memory"));

// list works without touching the disk
await mem.run({ action: "add", facts: ["one"] });
check("list echoes the lines", (await run({ action: "list" })).includes("one"));

const bad = await mem.run({ action: "add", facts: [] });
check("empty add is an error", bad.isError === true);
const unknown = await mem.run({ action: "nonsense" });
check("unknown action is an error", unknown.isError === true);

// ── the on/off switch ──────────────────────────────────────────────────────
process.env.TRCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-mem-cfg-"));
const { loadConfig, saveConfig } = await import("../dist/config.js");
saveConfig({ memoryEnabled: false });
const { buildSystemPrompt } = await import("../dist/agent/prompt.js");
const { resetPromptSnapshots } = await import("../dist/agent/prompt.js");
await mem.run({ action: "add", facts: ["a fact while off"] });
const promptOff = buildSystemPrompt({ cwd, model: "m", skills: [] });
check("memoryEnabled off keeps the section out", !promptOff.includes("<project-memory"));
resetPromptSnapshots();
saveConfig({ memoryEnabled: true });
const promptOn = buildSystemPrompt({ cwd, model: "m", skills: [] });
check("memoryEnabled on puts it back", promptOn.includes("<project-memory"));
// buildTools honours the same flag through a missing cwd
const { buildTools } = await import("../dist/tools/index.js");
const toolsOff = buildTools({ skills: [], todo: { replace() {}, render() {}, plain() {} }, onTodoChange: () => {}, cwd: undefined });
check("no memory tool without a cwd", !toolsOff.some((x) => x.name === "memory"));
const toolsOn = buildTools({ skills: [], todo: { replace() {}, render() {}, plain() {} }, onTodoChange: () => {}, cwd });
check("memory tool with a cwd", toolsOn.some((x) => x.name === "memory"));

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
