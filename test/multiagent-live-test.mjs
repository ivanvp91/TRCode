/** Real command/REPL wiring with a local SSE provider and a virtual terminal. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-multi-live-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-multi-work-"));
process.env.TRCODE_HOME = HOME;
process.env.TOKENROUTER_API_KEY = "sk-test";
const stdin = new EventEmitter();
Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin });
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
for (const [key, value] of Object.entries({ isTTY: true, columns: 100, rows: 40 })) {
  Object.defineProperty(process.stdout, key, { value, configurable: true });
}
const originalWrite = process.stdout.write.bind(process.stdout);
let painted = "";
process.stdout.write = (chunk) => { painted += String(chunk); return true; };
const say = (text) => originalWrite(text + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < end, "scenario timed out"); await sleep(10); }
}
let handle = () => ({ text: "ok" });
let calls = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", async () => {
    const payload = JSON.parse(body);
    calls.push(payload);
    const reply = await handle(payload);
    if (res.destroyed) return;
    if (reply.error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: reply.error } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null, usage) => res.write("data: " + JSON.stringify({
      id: "x", model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], usage,
    }) + "\n\n");
    if (reply.text) send({ content: reply.text });
    if (reply.hang) {
      const tick = setInterval(() => send({ reasoning_content: "working" }), 20);
      res.on("close", () => clearInterval(tick));
      return;
    }
    if (reply.delay) await sleep(reply.delay);
    if (res.destroyed) return;
    if (reply.tools) send({ tool_calls: reply.tools.map((call, index) => ({ index, ...call })) });
    send({}, reply.tools ? "tool_calls" : reply.finish ?? "stop", { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
const { App } = await import("../dist/ui/repl.js");
const { Session } = await import("../dist/session/session.js");
const { saveConfig, loadConfig } = await import("../dist/config.js");
const { delegationPreference } = await import("../dist/agent/delegation.js");
const { runCommand } = await import("../dist/ui/commands.js");
const { runPool, runWorker } = await import("../dist/agent/worker.js");
const { normalizePlan } = await import("../dist/agent/orchestrator.js");
const { releaseStdin, hasConsumer } = await import("../dist/ui/stdin.js");
const { createSpillStore } = await import("../dist/tools/spill.js");
const { UsageTracker } = await import("../dist/usage.js");
saveConfig({ toolConcurrency: 2, maxSteps: 5, skillsEnabled: false, autoCompact: false, subagentMode: { tokenrouter: "session" } });
let edits = 0;
const toolCall = (name, id = name) => ({ id, type: "function", function: { name, arguments: "{}" } });
const tools = [
  { name: "read", description: "read", risk: "read", parameters: {}, run: async () => ({ output: "project facts" }) },
  { name: "write", description: "write", risk: "write", parameters: {}, run: async () => { edits++; return { output: "written" }; } },
  { name: "task", description: "task", risk: "agent", parameters: {}, run: async () => { throw Error("nested agents must be excluded"); } },
];
function appFor(session) {
  const app = new App({ cwd: WORK, model: "mock-a", autoApprove: true, session });
  app.catalog = [{ id: "mock-a", modality: "text" }, { id: "mock-b", modality: "text" }];
  app.tools = tools;
  app.draft = "";
  app.editor = { prefill: (text) => app.draft = text };
  return app;
}
const isPlan = (p) => p.messages[0].content.includes("You are the planner");
const isSynth = (p) => p.messages[0].content.includes("You are given the results") || p.messages[0].content.includes("You are given independent answers");
const assignment = (p) => p.messages.find((m) => m.role === "user")?.content ?? "";
const workerCalls = () => calls.filter((p) => !isPlan(p) && !isSynth(p));
const step = (id, deps = [], writes = false) => ({ id, title: id, prompt: id, deps, writes });
const plan = (steps) => ({ text: JSON.stringify({ steps }) });
const key = (text) => stdin.emit("data", Buffer.from(text));
function clean() { painted = ""; calls = []; edits = 0; }
function finished(app) {
  assert.equal(app.bar, null);
  assert.equal(app.abort, null);
  assert.equal(hasConsumer(), false);
}
const isHelper = (p) => p.messages[0].content.includes("You are a TRCode subagent");
const approvalVisible = () => /Allow the agent to launch subagents\?|Разрешить запуск субагентов\?/.test(painted);
const pickerVisible = () => /Choose models to launch subagents|Выберите модели для запуска субагентов/.test(painted);
function delegationProvider(batch = 1) {
  return (p) => {
    if (isHelper(p)) return { text: "helper complete" };
    if (p.messages.at(-1).role === "tool") return { text: "lead complete" };
    return { tools: Array.from({ length: batch }, (_, i) => ({ id: `task-${i}`, type: "function",
      function: { name: "task", arguments: JSON.stringify({ description: `helper ${i}`, prompt: `helper ${i}` }) } })) };
  };
}
function delegationApp() {
  const app = appFor();
  app.rebuildTools();
  return app;
}
function manualSubagents() {
  saveConfig({ subagentAuto: { tokenrouter: false }, subagentMode: { tokenrouter: "session" }, subagentModels: {} },
    { replace: ["subagentAuto", "subagentMode", "subagentModels"] });
}
let passed = 0;
async function test(name, work) {
  clean();
  await work();
  passed++;
  say("  ok   " + name);
}

try {
  await test("Esc during planning preserves input, request and paused state", async () => {
    const app = appFor();
    handle = () => ({ text: "partial plan", hang: true });
    const running = runCommand(app, "/orchestrate investigate");
    await until(() => calls.length === 1);
    assert(app.bar && hasConsumer());
    assert(painted.includes("planning the breakdown") && painted.includes("enter to queue"));
    key("next message"); key("\r"); key("draft"); key("\x1b");
    await running;
    finished(app);
    assert(app.lastAborted);
    assert.equal(app.pendingCount, 0);
    assert.equal(app.draft, "next message\ndraft");
    assert.equal(calls.length, 1);
    const saved = Session.load(WORK, app.session.id);
    assert.equal(saved.orchestration.status, "paused");
    assert.equal(saved.orchestration.phase, "planning");
    assert.equal(saved.messages.length, 1);
  });

  await test("planning reads files and history; readers are bounded and writes run alone", async () => {
    const app = appFor();
    app.session.add({ role: "user", content: "Discuss the widget in src/widget.ts" });
    let active = 0, maximum = 0;
    handle = (p) => {
      if (isPlan(p)) {
        assert(assignment(p).includes("src/widget.ts"));
        assert.deepEqual(p.tools.map((t) => t.function.name), ["read"]);
        return p.messages.at(-1).role === "tool" ? plan([step("reader1"), step("reader2"), step("reader3"), step("writer", ["reader1", "reader2", "reader3"], true)]) : { tools: [toolCall("read")] };
      }
      if (isSynth(p)) return { text: "All changes verified." };
      if (assignment(p).startsWith("writer")) {
        assert.equal(active, 0);
        assert(!p.tools.some((t) => t.function.name === "task"));
        return p.messages.at(-1).role === "tool" ? { text: "write complete" } : { tools: [toolCall("write")] };
      }
      assert.deepEqual(p.tools.map((t) => t.function.name), ["read"]);
      active++; maximum = Math.max(maximum, active);
      return sleep(70).then(() => { active--; return { text: "facts established" }; });
    };
    await runCommand(app, "/orchestrate implement widget");
    finished(app);
    assert.equal(maximum, 2);
    assert.equal(edits, 1);
    assert.equal(app.session.orchestration.status, "complete");
    assert.equal(app.session.orchestration.statuses.writer, "done");
    assert(app.usage.turnTotals().requests >= 8);
  });

  await test("Ctrl+C during workers stops queued work; resume retains completed workers and their contexts", async () => {
    saveConfig({ toolConcurrency: 1 });
    const app = appFor();
    handle = (p) => isPlan(p) ? plan([step("reader1"), step("reader2"), step("writer", ["reader2"], true)]) :
      assignment(p).startsWith("reader1") ? { text: "completed facts" } : { text: "partial worker", hang: true };
    const running = runCommand(app, "/orch fix it");
    await until(() => workerCalls().length === 2);
    key("queued follow-up"); key("\r"); key("unsent draft"); key("\x03");
    await running;
    finished(app);
    assert.equal(app.session.orchestration.statuses.reader1, "done");
    assert.equal(edits, 0);
    assert.equal(calls.filter(isSynth).length, 0);
    assert.equal(app.draft, "queued follow-up\nunsent draft");
    const loaded = Session.load(WORK, app.session.id);
    const resumed = appFor(loaded);
    let reused = false;
    handle = (p) => {
      assert(!isPlan(p), "resume must reuse the plan");
      if (isSynth(p)) return { text: "finished" };
      if (assignment(p).startsWith("reader2")) {
        reused = p.messages.some((m) => m.content === "partial worker");
        return { text: "reader2 complete", delay: 60 };
      }
      return p.messages.at(-1).role === "tool" ? { text: "writer complete" } : { tools: [toolCall("write")] };
    };
    const continuation = runCommand(resumed, "/orchestrate resume");
    await until(() => workerCalls().length === 3);
    key("follow-up"); key("\r"); key("next draft");
    await continuation;
    finished(resumed);
    assert(reused);
    assert.equal(workerCalls().filter((p) => assignment(p).startsWith("reader1")).length, 1);
    assert.equal(resumed.session.orchestration.status, "complete");
    assert.equal(resumed.pendingCount, 1);
    assert.equal(resumed.draft, "next draft");
    assert.equal(edits, 1);
    assert.equal(resumed.session.messages.filter((m) => m.role === "user" && m.content.includes("[orchestration]")).length, 1);
  });

  await test("cancelled synthesis is resumable without repeating completed steps", async () => {
    const app = appFor();
    handle = (p) => isPlan(p) ? plan([step("reader")]) : isSynth(p) ? { text: "partial synthesis", hang: true } : { text: "facts" };
    const running = runCommand(app, "/orchestrate inspect");
    await until(() => calls.some(isSynth));
    key("\x1b"); await running;
    assert.equal(app.session.orchestration.phase, "synthesis");
    assert.equal(app.session.orchestration.status, "paused");
    assert.equal(app.session.messages.filter((m) => m.role === "assistant").length, 0);
    handle = (p) => { assert(isSynth(p)); return { text: "complete synthesis" }; };
    await runCommand(app, "/orchestrate resume");
    finished(app);
    assert.equal(workerCalls().length, 1);
    assert.equal(app.session.orchestration.status, "complete");
  });

  await test("planning resume returns a fresh complete plan instead of extending partial JSON", async () => {
    const app = appFor();
    handle = () => ({ text: '{"steps": [', hang: true });
    const running = runCommand(app, "/orchestrate inspect");
    await until(() => calls.length === 1);
    key("\x1b"); await running;
    handle = (p) => {
      if (isPlan(p)) {
        assert(p.messages.at(-1).content.includes("do not continue a partial JSON fragment"));
        return plan([step("reader")]);
      }
      return { text: "complete" };
    };
    await runCommand(app, "/orchestrate resume");
    finished(app);
    assert.equal(app.session.orchestration.status, "complete");
  });

  await test("interrupting a writing tool preserves valid tool-call history for resume", async () => {
    const app = appFor();
    let writing = false;
    app.tools = [tools[0], { ...tools[1], run: async (_args, ctx) => {
      writing = true;
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
      return { output: "write cancelled", isError: true };
    } }];
    handle = (p) => isPlan(p) ? plan([step("writer", [], true)]) : { tools: [toolCall("write", "write-id")] };
    const running = runCommand(app, "/orchestrate write");
    await until(() => writing);
    key("\x1b"); await running;
    finished(app);
    const history = app.session.orchestration.messages.writer;
    assert(history.some((m) => m.tool_calls?.some((call) => call.id === "write-id")));
    assert(history.some((m) => m.role === "tool" && m.tool_call_id === "write-id"));
    assert.equal(edits, 0);
    handle = () => ({ text: "verified and complete" });
    await runCommand(app, "/orchestrate resume");
    assert.equal(app.session.orchestration.status, "complete");
    assert.equal(edits, 0);
  });

  await test("Esc at a permission prompt stops orchestration and keeps queued input", async () => {
    saveConfig({ permissions: { write: "ask" } });
    const app = appFor();
    app.broker.autoApprove = false;
    let waiting = false;
    app.broker.onWaiting = () => waiting = true;
    const write = { ...tools[1], run: async (args, ctx) => {
      if (!await ctx.confirm(write, args)) return { output: "denied", isError: true };
      edits++; return { output: "written" };
    } };
    app.tools = [write];
    handle = (p) => isPlan(p) ? plan([step("writer", [], true)]) : { tools: [toolCall("write")] };
    const running = runCommand(app, "/orchestrate write");
    key("queued before permission"); key("\r");
    await until(() => waiting && hasConsumer());
    key("\x1b"); await running;
    finished(app);
    assert(app.lastAborted);
    assert.equal(edits, 0);
    assert.equal(app.draft, "queued before permission");
    assert.equal(app.session.orchestration.status, "paused");
  });

  await test("failed dependencies are skipped; replanning preserves completed work", async () => {
    const app = appFor();
    handle = (p) => isPlan(p) ? plan([step("reader1"), step("reader2"), step("writer", ["reader2"], true)]) :
      isSynth(p) ? { text: "Partly done; reader2 and writer incomplete." } :
      assignment(p).startsWith("reader1") ? { text: "facts" } : { error: "deliberate failure" };
    await runCommand(app, "/orchestrate inspect");
    assert.equal(app.session.orchestration.status, "failed");
    assert.equal(app.session.orchestration.statuses.writer, "skipped");
    handle = (p) => {
      if (isPlan(p)) {
        assert(assignment(p).includes("use a different approach"));
        assert(assignment(p).includes("reader1: reader1\nfacts"));
        return plan([step("alternative", ["reader1"])]);
      }
      return { text: "complete" };
    };
    await runCommand(app, "/orchestrate replan use a different approach");
    finished(app);
    assert.equal(app.session.orchestration.status, "complete");
    assert.equal(workerCalls().filter((p) => assignment(p).startsWith("reader1")).length, 1);
    assert.deepEqual(app.session.orchestration.steps.map((s) => s.id), ["reader1", "alternative"]);
    const count = calls.length;
    await runCommand(app, "/orchestrate status");
    assert.equal(calls.length, count);
  });

  await test("invalid dependency graphs cannot execute tools", async () => {
    const app = appFor();
    handle = () => plan([step("a", ["b"], true), step("b", ["a"], true)]);
    await runCommand(app, "/orchestrate cycle");
    finished(app);
    assert.equal(app.session.orchestration.status, "failed");
    assert.equal(workerCalls().length, 0);
    assert.equal(edits, 0);
    for (const id of ["__proto__", "constructor", "toString"]) assert.throws(() => normalizePlan({ steps: [step(id)] }));
  });

  await test("swarm shares footer/history and aborts before starting queued models or synthesis", async () => {
    saveConfig({ swarmModels: ["mock-a", "mock-b"], toolConcurrency: 1 });
    const app = appFor();
    app.session.add({ role: "user", content: "earlier requirement" });
    handle = (p) => {
      assert(assignment(p).includes("earlier requirement"));
      assert.deepEqual(p.tools.map((t) => t.function.name), ["read"]);
      return { text: "partial result", hang: true };
    };
    const running = runCommand(app, "/swarm inspect");
    await until(() => calls.length === 1);
    assert(app.bar);
    key("keep this"); key("\r"); key("\x1b"); await running;
    finished(app);
    assert(app.lastAborted);
    assert.equal(calls.length, 1);
    assert.equal(app.draft, "keep this");
    assert(app.session.messages.at(-1).content.includes("Swarm interrupted"));
  });

  await test("swarm success queues the next turn and counts usage once", async () => {
    const app = appFor();
    handle = (p) => ({ text: isSynth(p) ? "synthesized answer" : "independent answer", delay: 50 });
    const running = runCommand(app, "/swarm inspect");
    await until(() => calls.length === 1);
    key("next"); key("\r"); key("draft"); await running;
    finished(app);
    assert.equal(app.pendingCount, 1);
    assert.equal(app.draft, "draft");
    assert.equal(app.usage.turnTotals().requests, 3);
    assert.equal(app.usage.turnTotals().input, 120);
    assert.equal(app.session.messages.at(-1).content, "synthesized answer");
  });

  await test("swarm synthesis abort keeps worker results without claiming completion", async () => {
    const app = appFor();
    handle = (p) => isSynth(p) ? { text: "partial synthesis", hang: true } : { text: "completed worker" };
    const running = runCommand(app, "/swarm inspect");
    await until(() => calls.some(isSynth));
    key("\x1b"); await running;
    finished(app);
    assert(app.lastAborted);
    assert(app.session.messages.at(-1).content.includes("completed worker"));
    assert(app.session.messages.at(-1).content.includes("have not been synthesized"));
  });

  await test("capped swarm workers are incomplete and never enter synthesis", async () => {
    saveConfig({ maxSteps: 1 });
    const app = appFor();
    handle = () => ({ text: "unfinished analysis", tools: [toolCall("read")] });
    await runCommand(app, "/swarm inspect");
    finished(app);
    assert(app.lastTurnFailed);
    assert.equal(calls.filter(isSynth).length, 0);
    assert.equal(app.session.messages.filter((m) => m.role === "assistant").length, 0);
    saveConfig({ maxSteps: 5 });
  });

  await test("worker contexts isolate spill dedupe and usage survives a later failure", async () => {
    const spill = createSpillStore(WORK, "shared");
    const usage = new UsageTracker();
    const seen = [];
    const read = { ...tools[0], run: async (_args, ctx) => { seen.push(ctx.spill); return { output: "a".repeat(1000) }; } };
    handle = (p) => p.messages.at(-1).role === "tool" ? { error: "failed after reading" } : { tools: [toolCall("read")] };
    const run = () => runWorker({ model: "mock-a", prompt: "inspect", context: { cwd: WORK, depth: 0, spill, signal: new AbortController().signal },
      tools: [read], readOnly: true, skills: [], catalog: [], effort: "off", maxSteps: 3, ceiling: 3, usage });
    await assert.rejects(run);
    await assert.rejects(run);
    assert.notEqual(seen[0], seen[1]);
    assert.notEqual(seen[0].seen, seen[1].seen);
    assert.equal(usage.totals().requests, 2);
  });

  await test("a pool failure drains active workers and prevents new starts", async () => {
    let drained = false;
    const started = [];
    await assert.rejects(() => runPool([0, 1, 2], 2, new AbortController().signal, async (item) => {
      started.push(item);
      if (item === 0) { await sleep(5); throw Error("worker failure"); }
      await sleep(30); drained = true;
    }));
    assert(drained);
    assert.deepEqual(started, [0, 1]);
  });

  await test("ordinary chat releases its footer even when preparation throws", async () => {
    const app = appFor();
    app.maybeAutoCompact = async () => { throw Error("preparation failed"); };
    await app.turn("inspect");
    finished(app);
    assert(app.lastTurnFailed);
    assert.equal(calls.length, 0);
  });

  await test("ordinary chat interruption during prompt rewrite retains the original input", async () => {
    const app = appFor();
    app.maybeAutoCompact = async () => {};
    app.maybeRewrite = async (text) => {
      await new Promise((resolve) => app.abort.signal.addEventListener("abort", resolve, { once: true }));
      return text;
    };
    const running = app.turn("original request");
    await until(() => Boolean(app.bar));
    key("\x1b"); await running;
    finished(app);
    assert(app.lastAborted);
    assert.equal(app.draft, "original request");
    assert.equal(calls.length, 0);
    assert.equal(app.session.messages.length, 0);
  });

  await test("noninteractive swarm finishes without installing a terminal consumer", async () => {
    const app = appFor();
    handle = () => ({ text: "answer" });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      await runCommand(app, "/swarm inspect");
      finished(app);
      assert.equal(app.session.messages.at(-1).content, "answer");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    }
  });

  await test("crash recovery changes running state to paused and retains worker histories", async () => {
    const app = appFor();
    app.session.add({ role: "user", content: "recover" });
    app.session.orchestration = { task: "recover", model: "mock-a", context: "", status: "running", phase: "execution",
      steps: [step("writer", [], true)], statuses: { writer: "running" }, results: {},
      messages: { writer: [{ role: "user", content: "recover" }] }, startedAt: 1, updatedAt: 2 };
    app.session.save();
    const recovered = Session.load(WORK, app.session.id);
    assert.equal(recovered.orchestration.status, "paused");
    assert.equal(recovered.orchestration.statuses.writer, "interrupted");
    assert.equal(recovered.orchestration.messages.writer.length, 1);
  });

  await test("auto off asks once for a parallel batch; No keeps work in the lead", async () => {
    manualSubagents();
    const app = delegationApp();
    handle = delegationProvider(2);
    const running = app.turn("inspect the project");
    await until(approvalVisible);
    key("n"); await running;
    finished(app);
    assert.equal(calls.filter(isHelper).length, 0);
    assert.equal((painted.match(/Allow the agent to launch subagents\?/g) ?? []).length, 1);
    assert.equal(loadConfig().subagentAuto.tokenrouter, false);
    assert.equal(app.session.messages.at(-1).content, "lead complete");
  });

  await test("Yes approves the batch for this turn and asks again on the next turn", async () => {
    manualSubagents();
    const app = delegationApp();
    handle = delegationProvider(2);
    const first = app.turn("inspect");
    await until(approvalVisible);
    key("y"); await first;
    finished(app);
    assert.equal(calls.filter(isHelper).length, 2);
    assert.equal(loadConfig().subagentAuto.tokenrouter, false);
    painted = "";
    const second = app.turn("inspect again");
    await until(approvalVisible);
    key("n"); await second;
    assert.equal(calls.filter(isHelper).length, 2);
  });

  await test("Enable auto persists for this provider and removes subsequent approvals", async () => {
    manualSubagents();
    const app = delegationApp();
    handle = delegationProvider();
    const first = app.turn("inspect");
    await until(approvalVisible);
    key("a"); await first;
    assert.equal(loadConfig().subagentAuto.tokenrouter, true);
    painted = "";
    await app.turn("inspect again");
    finished(app);
    assert(!approvalVisible());
    assert.equal(calls.filter(isHelper).length, 2);
    app.session.model = "kimi:k3";
    await runCommand(app, "/subagents auto off");
    assert.equal(loadConfig().subagentAuto.kimi, false);
    assert.equal(loadConfig().subagentAuto.tokenrouter, true);
  });

  await test("explicit delegation authorizes one turn without changing auto off", async () => {
    manualSubagents();
    const app = delegationApp();
    handle = delegationProvider();
    await app.turn("Запусти субаггентов и исследуй проект");
    finished(app);
    assert(!approvalVisible());
    assert.equal(calls.filter(isHelper).length, 1);
    assert.equal(loadConfig().subagentAuto.tokenrouter, false);
    painted = "";
    const again = app.turn("inspect again");
    await until(approvalVisible);
    key("n"); await again;
  });

  await test("approval precedes missing-model selection; the selected helper model actually runs", async () => {
    saveConfig({ subagentAuto: { tokenrouter: false }, subagentMode: {}, subagentModels: {} },
      { replace: ["subagentAuto", "subagentMode", "subagentModels"] });
    const app = delegationApp();
    handle = delegationProvider();
    const running = app.turn("inspect");
    await until(approvalVisible);
    assert(!pickerVisible());
    key("y");
    await until(pickerVisible);
    key("\x1b[B"); key(" "); key("\r");
    await running;
    finished(app);
    assert.deepEqual(loadConfig().subagentModels.tokenrouter, ["mock-b"]);
    assert.equal(calls.filter(isHelper)[0].model, "mock-b");
    const nextLead = calls.filter((p) => !isHelper(p)).at(-1);
    assert.deepEqual(nextLead.tools.find((t) => t.function.name === "task").function.parameters.properties.model.enum, ["mock-b"]);
    assert.equal(loadConfig().subagentAuto.tokenrouter, false);
  });

  await test("explicit delegation opens missing-model selection without an extra approval", async () => {
    saveConfig({ subagentAuto: { tokenrouter: false }, subagentMode: {}, subagentModels: {} },
      { replace: ["subagentAuto", "subagentMode", "subagentModels"] });
    const app = delegationApp();
    handle = delegationProvider();
    const running = app.turn("Use subagents to inspect the project");
    await until(pickerVisible);
    assert(!approvalVisible());
    key("\r"); await running;
    finished(app);
    assert.equal(loadConfig().subagentMode.tokenrouter, "session");
    assert.equal(calls.filter(isHelper)[0].model, "mock-a");
  });

  await test("cancelling the launch dialog stops the turn and restores queued input", async () => {
    manualSubagents();
    const app = delegationApp();
    handle = delegationProvider();
    const running = app.turn("inspect");
    key("keep this draft"); key("\r");
    await until(approvalVisible);
    key("\x1b"); await running;
    finished(app);
    assert(app.lastAborted);
    assert.equal(calls.filter(isHelper).length, 0);
    assert.equal(app.draft, "keep this draft");
  });

  await test("cancelling required model selection launches no helper", async () => {
    saveConfig({ subagentAuto: { tokenrouter: true }, subagentMode: {}, subagentModels: {} },
      { replace: ["subagentAuto", "subagentMode", "subagentModels"] });
    const app = delegationApp();
    handle = delegationProvider();
    const running = app.turn("inspect");
    await until(pickerVisible);
    key("\x1b"); await running;
    finished(app);
    assert(app.lastAborted);
    assert.equal(calls.filter(isHelper).length, 0);
  });

  await test("explicit prohibition overrides auto; settings panel can toggle auto", async () => {
    manualSubagents();
    saveConfig({ subagentAuto: { tokenrouter: true } });
    const app = delegationApp();
    handle = delegationProvider();
    await app.turn("Не запускай субагентов, исследуй самостоятельно");
    finished(app);
    assert(!approvalVisible());
    assert.equal(calls.filter(isHelper).length, 0);
    assert.equal(delegationPreference("Do not use subagents"), "deny");
    assert.equal(delegationPreference("```\nlaunch subagents\n```\ninspect"), "unspecified");
    assert.equal(delegationPreference("Use no subagents"), "deny");
    painted = "";
    const panel = runCommand(app, "/subagents");
    await until(() => /Models for subagents|Модели для субагентов/.test(painted));
    key("\x1bu");
    await until(() => loadConfig().subagentAuto.tokenrouter === false);
    key("\x1b"); await panel;
    assert.equal(loadConfig().subagentAuto.tokenrouter, false);
  });
  say(`${passed} scenarios passed`);
} finally {
  releaseStdin();
  process.stdout.write = originalWrite;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const dir of [HOME, WORK]) {
    assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
