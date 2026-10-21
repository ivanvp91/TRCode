/**
 * Harness features held to what they promise: subagent roles that
 * narrow and never widen, a subagent that takes a follow-up with its own
 * history, helper spend marked as such, skill rules and the skill check,
 * all-or-nothing multi_edit, and background processes driven through
 * shell_io.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-harness-home-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-harness-cwd-"));
process.env.TRCODE_HOME = HOME;
process.env.TOKENROUTER_BASE_URL = "http://127.0.0.1:9/v1";
process.env.TOKENROUTER_API_KEY = "sk-test";

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// Every chat request is answered with one line of text, and its body kept.
const bodies = [];
let reply = "ГОТОВО";
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  bodies.push(body);
  const sse = [
    { choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
  ].map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const { makeTaskTool, SubagentRegistry } = await import("../dist/agent/subagent.js");
const { subagentRoles, roleSteps, BUILTIN_ROLES } = await import("../dist/agent/roles.js");
const { UsageTracker } = await import("../dist/usage.js");
const { saveConfig } = await import("../dist/config.js");

const catalog = [
  { id: "mock-fast", modality: "text", chatCapable: true, pricing: { input: 1, output: 2 } },
  { id: "mock-smart", modality: "text", chatCapable: true },
];
const ctx = () => ({ cwd: WORK, signal: new AbortController().signal, readFiles: new Set(), confirm: async () => true });
const readTool = { name: "read", risk: "read", description: "", parameters: { type: "object", properties: {} }, run: async () => ({ output: "" }) };
const writeTool = { name: "write", risk: "write", description: "", parameters: { type: "object", properties: {} }, run: async () => ({ output: "" }) };
const sysOf = (b) => String(b.messages.find((m) => m.role === "system")?.content ?? "");
const toolNames = (b) => (b.tools ?? []).map((t) => t.function?.name ?? t.name);

// ── roles ─────────────────────────────────────────────────────────────────
{
  const roles = subagentRoles();
  check("explore and review are built in", roles.explore && roles.review);
  check("both are read-only", roles.explore.readOnly && roles.review.readOnly);
  check("review carries the findings contract", /\[P0\|P1\|P2\|P3\]/.test(roles.review.prompt) && /No findings\./.test(roles.review.prompt));

  saveConfig({ subagentRoles: {
    tester: { description: "writes tests for one module", prompt: "# Role: tester\nWrite tests.", maxSteps: 5, effort: "low" },
    explore: null,
    broken: { model: "x" },
    "Bad Name!": { description: "skipped" },
  } });
  const mine = subagentRoles();
  check("a configured role is added", mine.tester?.maxSteps === 5 && mine.tester.effort === "low");
  check("null switches a built-in off", !mine.explore && mine.review);
  check("an entry with no description is dropped", !mine.broken);
  check("an invalid name is dropped", !Object.keys(mine).some((k) => /bad/i.test(k)));
  check("a role lowers the step ceiling", roleSteps(30, mine.tester) === 5 && roleSteps(3, mine.tester) === 3);
  check("and sets one where there was none", roleSteps(0, mine.tester) === 5);
  check("no role leaves it alone", roleSteps(30, undefined) === 30);
  saveConfig({ subagentRoles: {} }, { replace: ["subagentRoles"] });
  check("built-ins are untouched by the config", Object.keys(BUILTIN_ROLES).join() === "explore,review");
}

// ── task: role, follow-up, delegated spend ────────────────────────────────
{
  const parent = new UsageTracker();
  const registry = new SubagentRegistry();
  const tool = makeTaskTool({
    cwd: WORK, catalog, skills: [], tools: () => [readTool, writeTool],
    defaultModel: "mock-fast", effortFor: () => "off", maxSteps: 10, usage: parent, registry,
  });
  check("the schema offers role", tool.parameters.properties.role.enum.includes("review"));
  check("and agent_id", tool.parameters.properties.agent_id?.type === "integer");

  bodies.length = 0;
  const first = await tool.run({ description: "ревью", prompt: "проверь дифф", role: "review" }, ctx());
  check("a review subagent runs", !first.isError, first.output);
  const sent = bodies[0];
  check("the role's instructions are in its system prompt", /# Role: review/.test(sysOf(sent)), sysOf(sent).slice(-300));
  check("the shared working directory is spelled out", /shared with the lead and with other subagents/.test(sysOf(sent)));
  check("the role made it read-only", toolNames(sent).includes("read") && !toolNames(sent).includes("write"), JSON.stringify(toolNames(sent)));
  const id = Number(/agent_id: (\d+)/.exec(first.output)?.[1]);
  check("the result names an agent_id", id > 0, first.output);

  bodies.length = 0;
  reply = "ИСПРАВЛЕНО";
  const next = await tool.run({ description: "ещё", prompt: "а теперь подробнее про второй пункт", agent_id: id, read_only: false, model: "mock-smart" }, ctx());
  check("a follow-up runs", !next.isError, next.output);
  const msgs = bodies[0].messages.filter((m) => m.role !== "system");
  check("it carries the earlier exchange", msgs.some((m) => m.content === "проверь дифф") && msgs.some((m) => m.role === "assistant" && /ГОТОВО/.test(String(m.content))), JSON.stringify(msgs).slice(0, 300));
  check("and ends on the new instruction", msgs.at(-1).content === "а теперь подробнее про второй пункт");
  check("the model does not change mid-conversation", bodies[0].model === "mock-fast", bodies[0].model);
  check("read-only cannot be lifted on a follow-up", !toolNames(bodies[0]).includes("write"));
  check("it keeps the same id", new RegExp(`agent_id: ${id}\\b`).test(next.output));

  const ghost = await tool.run({ description: "x", prompt: "y", agent_id: 999 }, ctx());
  check("an unknown agent_id is an error that names the live ones", ghost.isError && new RegExp(`\\b${id}\\b`).test(ghost.output), ghost.output);
  const bad = await tool.run({ description: "x", prompt: "y", role: "nope" }, ctx());
  check("an unknown role is refused", bad.isError && /review/.test(bad.output), bad.output);

  const row = parent.all().find((u) => u.model === "mock-fast");
  check("subagent requests reach the parent tracker", row?.requests === 2, JSON.stringify(row));
  check("marked as delegated to task", row?.delegated?.task?.requests === 2, JSON.stringify(row?.delegated));
  check("in the daily bucket too", Object.values(row?.daily ?? {})[0]?.delegated?.task?.requests === 2);
  check("the turn's bill includes them", parent.turnTotals().requests === 2);
  check("the lead's context gauge is untouched", parent.lastTurn.input === 0, JSON.stringify(parent.lastTurn));

  registry.bind("session-a");
  check("a new session empties the registry", registry.ids().length === 0);
}

// ── registry cap ──────────────────────────────────────────────────────────
{
  const r = new SubagentRegistry();
  for (let i = 1; i <= SubagentRegistry.MAX + 3; i++) r.park({ id: i, label: "", model: "m", readOnly: true, messages: [], at: i, busy: false });
  check("the registry keeps at most MAX", r.ids().length === SubagentRegistry.MAX, String(r.ids()));
  check("and drops the oldest", !r.ids().includes(1) && r.ids().includes(SubagentRegistry.MAX + 3));
}

// ── /stat: the helpers' share ─────────────────────────────────────────────
{
  const { foldUsage, periodSlice } = await import("../dist/ui/commands.js");
  const { delegatedNote } = await import("../dist/ui/commands/stat.js");
  const t = new UsageTracker();
  t.record("mock-fast", { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }, catalog);
  t.child("swarm").record("mock-fast", { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200 }, catalog);
  const folded = foldUsage(t.all().map((u) => periodSlice(u, "today")).filter(Boolean));
  const u = folded.get("mock-fast");
  check("the row holds both", u.requests === 2, JSON.stringify(u));
  check("the share survives period slicing and folding", u.delegated?.swarm?.requests === 1 && u.delegated.swarm.input === 2000, JSON.stringify(u.delegated));
  const note = delegatedNote(folded).replace(/\x1b\[[0-9;]*m/g, "");
  check("/stat names it", /swarm \$0\.00/.test(note) && /1 /.test(note), note);
  check("and says nothing when nothing was delegated", delegatedNote(foldUsage([{ ...t.all()[0], delegated: undefined }])) === "");
}

// ── skills ────────────────────────────────────────────────────────────────
{
  const { createSkill, discoverSkills, validateSkill, skillsPromptSection } = await import("../dist/skills/loader.js");
  createSkill({ cwd: WORK, name: "fresh" });
  const dir = path.join(WORK, ".trcode", "skills", "good");
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "references", "rules.md"), "x");
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---
name: good
description: When asked to bump the project version and write release notes for it, in English or Russian.
triggers: release, релиз
---

# Releasing
1. Read package.json.
2. Bump the version.
3. Write the notes; the house rules are in references/rules.md.
4. Run the tests.
5. Commit.
`);
  const dup = path.join(WORK, ".trcode", "skills", "twin");
  fs.mkdirSync(dup, { recursive: true });
  fs.writeFileSync(path.join(dup, "SKILL.md"), fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").replace("name: good", "name: twin").replace("references/rules.md", "the wiki"));
  fs.writeFileSync(path.join(dup, "unused.py"), "");

  const skills = discoverSkills(WORK);
  const by = (n) => skills.find((s) => s.name === n);
  const fresh = validateSkill(by("fresh"), skills);
  check("an unfilled template is reported", fresh.some((p) => /template text left in/.test(p)), fresh.join(" | "));
  check("so is its guidance comment", fresh.some((p) => /guidance comment/.test(p)));
  const good = validateSkill(by("good"), skills.filter((s) => s.name !== "twin"));
  check("a filled-in skill passes", good.length === 0, good.join(" | "));
  const twin = validateSkill(by("twin"), skills);
  check("a duplicated description is reported", twin.some((p) => /identical to "good"/.test(p)), twin.join(" | "));
  check("an unmentioned bundled file is reported", twin.some((p) => /unused\.py/.test(p)), twin.join(" | "));

  const block = skillsPromptSection(skills);
  check("the catalog states the apply rules", /names a skill → load it/.test(block) && /do not delegate its instructions/.test(block));
}

// ── multi_edit ────────────────────────────────────────────────────────────
{
  const { multiEditTool } = await import("../dist/tools/files.js");
  const file = path.join(WORK, "m.txt");
  fs.writeFileSync(file, "alpha\r\nbeta\r\ngamma\r\n");
  const c = { ...ctx(), readFiles: new Set([file]), snapshot: undefined };

  const unread = await multiEditTool.run({ path: "m.txt", edits: [{ old_string: "alpha", new_string: "A" }] }, ctx());
  check("multi_edit needs a read first", unread.isError && /Read m\.txt first/.test(unread.output));

  const ok = await multiEditTool.run({ path: "m.txt", edits: [
    { old_string: "alpha", new_string: "ALPHA" },
    { old_string: "ALPHA\nbeta", new_string: "ALPHA\nBETA" },
    { old_string: "a", new_string: "4", replace_all: true },
  ] }, c);
  check("edits apply in order, each on the previous result", !ok.isError && fs.readFileSync(file, "utf8") === "ALPHA\r\nBETA\r\ng4mm4\r\n", JSON.stringify(fs.readFileSync(file, "utf8")) + " " + ok.output);

  const before = fs.readFileSync(file, "utf8");
  const miss = await multiEditTool.run({ path: "m.txt", edits: [
    { old_string: "BETA", new_string: "beta" },
    { old_string: "nowhere", new_string: "x" },
  ] }, c);
  check("a miss is an error naming the edit", miss.isError && /Edit 2 of 2 failed/.test(miss.output), miss.output);
  check("and nothing was written", fs.readFileSync(file, "utf8") === before);
}

// ── background processes ──────────────────────────────────────────────────
{
  const { shellTool } = await import("../dist/tools/shell.js");
  const { shellIoTool, stopAllProcesses } = await import("../dist/tools/procs.js");
  const script = path.join(WORK, "echo.js");
  fs.writeFileSync(script, `
    process.stdout.write("ready\\n");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => process.stdout.write("got " + d.trim() + "\\n"));
    setInterval(() => {}, 1000);
  `);
  const node = JSON.stringify(process.execPath);
  const cmd = process.platform === "win32" ? `& ${node} echo.js` : `${node} echo.js`;
  const started = await shellTool.run({ command: cmd, background: true }, ctx());
  const pid = Number(/process (\d+) running/.exec(started.output)?.[1]);
  check("a background start returns at once with an id", pid > 0 && !started.isError, started.output);
  check("with the first output", /ready/.test(started.output), started.output);

  const typed = await shellIoTool.run({ process_id: pid, input: "hello\n", wait_ms: 5000 }, ctx());
  check("input reaches its stdin and the answer comes back", /got hello/.test(typed.output), typed.output);
  check("output is not repeated once read", !/ready/.test(typed.output), typed.output);

  const list = await shellIoTool.run({}, ctx());
  check("without an id the processes are listed", new RegExp(`^${pid}\\s+running`, "m").test(list.output), list.output);

  const killed = await shellIoTool.run({ process_id: pid, kill: true }, ctx());
  check("kill stops it", /exited/.test(killed.output), killed.output);
  const gone = await shellIoTool.run({ process_id: pid }, ctx());
  check("and it is forgotten", gone.isError, gone.output);

  const quick = await shellTool.run({ command: "echo done", background: true }, ctx());
  check("a command that exits during the start wait reports its exit", /exited \(exit=0\)/.test(quick.output) && /done/.test(quick.output), quick.output);

  const { buildTools } = await import("../dist/tools/index.js");
  const minimal = buildTools({ preset: "minimal", skills: [], loadedSkills: new Set(), todo: null, onTodoChange: () => {} });
  check("the minimal preset's shell has no background mode", !("background" in minimal[0].parameters.properties));
  check("while the standard shell keeps it", "background" in shellTool.parameters.properties);
  stopAllProcesses();
}

try { fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* Windows may hold it briefly */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
