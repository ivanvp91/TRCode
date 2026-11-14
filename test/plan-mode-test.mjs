/**
 * Plan mode: the tools that could change anything are absent, not merely
 * discouraged, and the prompt says why in one small section.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-plan-"));
process.env.TRCODE_HOME = HOME;

const { buildTools, TodoStore } = await import("../dist/tools/index.js");
const { buildSystemPrompt } = await import("../dist/agent/prompt.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trc-plan-proj-"));
fs.writeFileSync(path.join(cwd, "README.md"), "# demo\n");
const todo = new TodoStore();

const build = (planMode) =>
  buildTools({
    skills: [],
    todo,
    onTodoChange: () => {},
    cwd,
    planMode,
  }).map((t) => t.name);

const normal = build(false);
const plan = build(true);
check("the ordinary list has the tools that write", ["edit", "write", "shell"].every((n) => normal.includes(n)), normal.join(","));
check("plan mode has no editor", !plan.includes("edit") && !plan.includes("write") && !plan.includes("multi_edit"), plan.join(","));
check("plan mode has no shell", !plan.includes("shell") && !plan.includes("shell_io"), plan.join(","));
check("plan mode has no run_code", !plan.includes("run_code"), plan.join(","));
check("plan mode has no subagents to launch", !plan.includes("task"), plan.join(","));
check("…and no paid generation", !plan.some((n) => n.startsWith("generate_")), plan.join(","));
check("reading and searching stay", ["read", "ls", "glob", "grep"].every((n) => plan.includes(n)), plan.join(","));
check("so does asking the user", plan.includes("ask_user_question"), plan.join(","));
check("the todo list stays", plan.includes("todo"), plan.join(","));
check("minimal preset ignores the filter as it has nothing to filter", buildTools({ skills: [], todo, onTodoChange: () => {}, preset: "minimal", planMode: true }).length === 2);

const base = { cwd, model: "m", skills: [] };
const plainPrompt = buildSystemPrompt(base);
const plannedPrompt = buildSystemPrompt({ ...base, planMode: true });
check("the ordinary prompt says nothing about plans", !plainPrompt.includes("<plan-mode>"));
check("plan mode adds its section", plannedPrompt.includes("<plan-mode>"), plannedPrompt.slice(-120));
check("the plan is described as read-only", /read-only/i.test(plannedPrompt));
check("the rest of the prompt is identical", plannedPrompt.startsWith(plainPrompt.slice(0, plainPrompt.lastIndexOf("<"))));
check("minimal preset carries it too", buildSystemPrompt({ ...base, preset: "minimal", planMode: true }).includes("<plan-mode>"));

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
