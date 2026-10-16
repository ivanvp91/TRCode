/** Question wizard and real chat loop, using a virtual TTY and local SSE server. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-questions-"));
process.env.TRCODE_HOME = HOME;
process.env.TOKENROUTER_API_KEY = "sk-test";
const stdin = new EventEmitter();
Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin });
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
for (const [key, value] of Object.entries({ isTTY: true, columns: 100, rows: 32 })) {
  Object.defineProperty(process.stdout, key, { value, configurable: true });
}
const originalWrite = process.stdout.write.bind(process.stdout);
let painted = "";
process.stdout.write = (chunk) => { painted += String(chunk); return true; };
const key = (text) => stdin.emit("data", Buffer.from(text));
const screen = () => painted.replace(/\x1b\[[?0-9;]*[A-Za-z]/g, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < end, "scenario timed out"); await sleep(10); }
}
let requests = [];
let reply = () => ({ text: "ok" });
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", async () => {
    const payload = JSON.parse(body); requests.push(payload);
    const result = reply(payload);
    if (result.delay) await sleep(result.delay);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null, usage) => res.write("data: " + JSON.stringify({
      id: "x", model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], usage,
    }) + "\n\n");
    if (result.text) send({ content: result.text });
    if (result.tools) send({ tool_calls: result.tools.map((call, index) => ({ index, ...call })) });
    send({}, result.tools ? "tool_calls" : "stop", { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
const { questionModal } = await import("../dist/ui/questions.js");
const { askUserQuestionTool, parseQuestions } = await import("../dist/tools/questions.js");
const { width } = await import("../dist/ui/ansi.js");
const { line } = await import("../dist/ui/render.js");
const { releaseStdin, hasConsumer } = await import("../dist/ui/stdin.js");
const { App } = await import("../dist/ui/repl.js");
const { Session } = await import("../dist/session/session.js");
const { saveConfig } = await import("../dist/config.js");
saveConfig({ maxSteps: 5, skillsEnabled: false, autoCompact: false, permissions: { read: "allow", write: "ask" } });
const qs = parseQuestions([
  { question: "Where should settings live?", header: "Storage", options: [{ label: "Project", description: "Shared with the project" }, { label: "User", description: "Personal settings" }] },
  { question: "Which formats?", options: [{ label: "JSON" }, { label: "YAML" }], multiSelect: true },
]);
function modal(questions = qs) {
  const controller = new AbortController();
  let cancelled = false;
  const result = questionModal(questions, { signal: controller.signal, onCancel: () => { cancelled = true; controller.abort(); } });
  return { controller, result, cancelled: () => cancelled };
}
function appFor() {
  const app = new App({ cwd: HOME, model: "mock-a", autoApprove: false });
  app.catalog = [{ id: "mock-a", modality: "text" }];
  app.rebuildTools();
  app.editor = { prefill: (text) => app.draft = text };
  return app;
}
const call = (id, questions = [qs[0]]) => ({ id, type: "function", function: { name: "ask_user_question", arguments: JSON.stringify({ questions }) } });
let passed = 0;
async function test(name, fn) {
  painted = ""; requests = [];
  await fn();
  assert.equal(hasConsumer(), false, "stdin ownership must be released");
  passed++;
  originalWrite("  ok   " + name + "\n");
}

try {
  await test("shared frame, descriptions, progress; no result until review Submit", async () => {
    const m = modal(); let settled = false; m.result.then(() => settled = true);
    assert.match(screen(), /╭─/); assert.match(screen(), /Where should settings/);
    assert.match(screen(), /Shared with the project/); assert.match(screen(), /1.*2/);
    key("\r");
    assert.match(screen(), /Which formats/);
    key(" "); key("\x1b[B"); key(" "); key("\r");
    assert.match(screen(), /Review answers|Проверка ответов/);
    await sleep(10); assert.equal(settled, false);
    key("\r");
    const answers = await m.result;
    assert.deepEqual(answers, [{ question: qs[0].question, selected: ["Project"] }, { question: qs[1].question, selected: ["JSON", "YAML"] }]);
  });
  await test("own answer, Unicode cursor editing, back and replacement before Submit", async () => {
    const m = modal([qs[0]]);
    key("своё🙂"); key("\x1b[D"); key("\x7f"); key("й"); key("\x1b[F"); key("\r");
    key("\x1bb"); // back from review, answer must survive
    assert.match(screen(), /свой🙂/);
    key("\x1b[A"); key("\x1b[A"); key("\r"); // choose Project instead
    key("\r");
    assert.deepEqual((await m.result)[0], { question: qs[0].question, selected: ["Project"] });
  });
  await test("multi-select combines chosen options and custom input", async () => {
    const m = modal([qs[1]]);
    key(" "); key("TOML"); key("\r"); key("\x1bs");
    assert.deepEqual((await m.result)[0], { question: qs[1].question, selected: ["JSON"], custom: "TOML" });
  });
  await test("free text cannot advance empty; Enter saves without prematurely submitting", async () => {
    const m = modal(parseQuestions([{ question: "Anything else?" }]));
    key("\r"); assert(!/Review answers|Проверка ответов/.test(screen()));
    key("My constraints"); key("\r"); key("\r");
    assert.equal((await m.result)[0].custom, "My constraints");
  });
  await test("CRLF from one Enter never submits the review or answers the next question", async () => {
    const m = modal();
    key("\r\n");
    assert.match(screen(), /Which formats/);
    key(" "); key("\r"); key("\n");
    assert.match(screen(), /Review answers|Проверка ответов/);
    assert(hasConsumer(), "review still waits for an explicit Submit");
    key("\n"); await m.result;
  });
  await test("background transcript output leaves the active question form visible", async () => {
    const m = modal([qs[0]]);
    painted = "";
    line("Background worker finished reading files.");
    assert.match(screen(), /Background worker finished/);
    assert.match(screen(), /Where should settings live/);
    key("\r"); key("\r"); await m.result;
  });
  await test("review allows editing an earlier answer and retains later choices", async () => {
    const m = modal();
    key("\r"); key(" "); key("\r");
    key("\t"); key("\r"); // review list -> edit question 1
    key("\x1b[B"); key("\r"); // User
    key("\r"); key("\r");
    const answers = await m.result;
    assert.deepEqual(answers.map((a) => a.selected), [["User"], ["JSON"]]);
  });
  await test("split cursor escape sequence and split UTF-8 input are not lost", async () => {
    const m = modal([qs[0]]);
    key("\x1b"); key("[B"); // selects User, not cancellation
    const bytes = Buffer.from("ёж"); stdin.emit("data", bytes.subarray(0, 1)); stdin.emit("data", bytes.subarray(1));
    key("\r"); key("\r");
    assert.equal((await m.result)[0].custom, "ёж");
  });
  await test("bracketed paste treats newline and hotkey bytes as answer text", async () => {
    const m = modal([qs[0]]);
    key("\x1b[200~A\nB\x1bs"); key("\x1b[20"); key("1~");
    key("\r"); key("\r");
    assert.equal((await m.result)[0].custom, "A B s");
  });
  await test("Esc cancels the whole form without selecting a highlighted default", async () => {
    const m = modal(); key("\r"); key("\x1b");
    assert.equal(await m.result, null); assert(m.cancelled());
  });
  await test("Ctrl+C and external abort both release the modal immediately", async () => {
    const m = modal(); key("\x03"); assert.equal(await m.result, null); assert(m.cancelled());
    const next = modal(); next.controller.abort(); assert.equal(await next.result, null); assert(!next.cancelled());
  });
  await test("long text fits the terminal, scrolls and repaints on resize", async () => {
    Object.defineProperty(process.stdout, "columns", { value: 55, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 20, configurable: true });
    const m = modal(parseQuestions([{ question: "Long question ".repeat(25), options: [{ label: "界".repeat(60), description: "description ".repeat(40) }] }]));
    const rows = screen().trimEnd().split("\n");
    const lengths = rows.map(width);
    assert(lengths.every((n) => n === lengths[0]), "frame widths must match");
    assert(rows.length <= 18, "frame must fit the terminal height");
    key("\x1b[5~"); process.stdout.emit("resize");
    m.controller.abort(); await m.result;
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 32, configurable: true });
  });
  await test("invalid questions never open a modal or call the question host", async () => {
    let asked = 0;
    const ctx = { signal: new AbortController().signal, askUser: async () => { asked++; return []; } };
    for (const questions of [[], Array(5).fill(qs[0]), [{ question: "" }], [{ question: "x", options: [{ label: "same" }, { label: "same" }] }], [{ question: "x", multiSelect: "yes" }], [{ question: "\x1b[2J" }]]) {
      assert((await askUserQuestionTool.run({ questions }, ctx)).isError);
    }
    assert.equal(asked, 0);
  });
  await test("headless returns unavailable without consuming piped stdin", async () => {
    stdin.isTTY = false;
    const app = appFor();
    const res = await askUserQuestionTool.run({ questions: [qs[0]] }, app.toolContext());
    assert.equal(JSON.parse(res.output).status, "unavailable");
    assert.equal(painted, ""); stdin.isTTY = true;
  });
  await test("real chat waits for Submit, resumes with structured answers, and persists them", async () => {
    const app = appFor();
    reply = (p) => p.messages.at(-1).role === "tool" ? { text: "Using your choice." } : { tools: [call("q")] };
    const turn = app.turn("Choose where settings should live");
    await until(() => screen().includes(qs[0].question));
    assert.equal(requests.length, 1);
    key("\r"); await sleep(20); assert.equal(requests.length, 1);
    key("\r"); await turn;
    assert.equal(requests.length, 2);
    const answer = JSON.parse(requests[1].messages.at(-1).content);
    assert.equal(answer.status, "answered"); assert.deepEqual(answer.answers[0].selected, ["Project"]);
    assert.equal(app.bar, null); assert.equal(app.abort, null);
    const saved = Session.load(HOME, app.session.id);
    assert.equal(JSON.parse(saved.messages.find((m) => m.role === "tool" && m.name === "ask_user_question").content).status, "answered");
  });
  await test("parallel question calls are serial; only submitted answers reach the next request", async () => {
    const app = appFor();
    const second = [{ question: "Second worker question?", options: [{ label: "B" }] }];
    reply = (p) => p.messages.at(-1).role === "tool" ? { text: "Both choices received." } : { tools: [call("first"), call("second", second)] };
    const turn = app.turn("Resolve two choices");
    await until(() => screen().includes(qs[0].question));
    assert(!screen().includes("Second worker question?"));
    key("\r"); key("\r");
    await until(() => screen().includes("Second worker question?"));
    key("\r"); key("\r"); await turn;
    const results = requests.at(-1).messages.filter((m) => m.role === "tool");
    assert.equal(results.length, 2); assert(results.every((r) => JSON.parse(r.content).status === "answered"));
  });
  await test("cancel restores queued draft and does not open the next pending question", async () => {
    const app = appFor();
    reply = () => ({ tools: [call("first"), call("second", [{ question: "Never shown" }])], delay: 100 });
    const turn = app.turn("Task with pending clarification");
    await until(() => requests.length === 1); // turn bar still owns input before the call arrives
    key("queued message"); key("\r"); key("draft");
    await until(() => screen().includes(qs[0].question));
    key("\x1b"); await turn; await sleep(100);
    assert(app.lastAborted); assert.equal(requests.length, 1); assert(!screen().includes("Never shown"));
    assert.equal(app.draft, "queued message\ndraft"); assert.equal(app.pendingCount, 0);
    assert.equal(app.abort, null); assert.equal(app.bar, null);
  });
  await test("permission rendering waits behind questions; nested exclusive callbacks work", async () => {
    const app = appFor();
    const ctx = app.toolContext();
    const first = ctx.askUser([qs[0]]);
    await until(() => screen().includes(qs[0].question));
    const gate = app.broker.confirm({ name: "write", risk: "write" }, { path: "example.txt" });
    await sleep(10); assert(!/permission required|нужно подтверждение/.test(screen()));
    key("\r"); key("\r"); await first;
    await until(() => /permission required|нужно подтверждение/.test(screen()));
    key("\r"); assert.equal(await gate, true);
    assert.equal(await app.exclusiveInput(() => app.exclusiveInput(async () => 42)), 42);
  });
  await test("cancelled queued permissions are refused before rendering", async () => {
    const app = appFor(); const controller = new AbortController();
    const first = app.toolContext().askUser([qs[0]]);
    await until(() => screen().includes(qs[0].question));
    const gate = app.broker.confirm({ name: "write", risk: "write" }, {}, undefined, controller.signal);
    controller.abort(); key("\r"); key("\r"); await first;
    assert.equal(await gate, false); assert(!/permission required|нужно подтверждение/.test(screen()));
  });
} finally {
  releaseStdin(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  const resolved = path.resolve(HOME);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
originalWrite(`\n${passed} passed, 0 failed\n`);
