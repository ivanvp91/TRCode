/**
 * Compaction: a handoff summary, the ladder that schedules it, and its beacons.
 *
 * A compaction is a handoff summary plus the recent *user* messages, carried
 * over verbatim; assistant turns and tool traffic are what it drops. It also
 * runs mid-turn, between a tool round and the next request, because that is
 * where a long turn actually overflows. These tests pin both: what survives,
 * that the history is spliced in place (the agent loop holds that array), and
 * that a failing mid-turn compaction does not take the turn down with it.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-compact-"));
process.env.TRCODE_HOME = HOME;

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

// ── the history a compaction leaves behind ─────────────────────────────────
{
  const { compactSession } = await import("../dist/session/compact.js");
  const { Session } = await import("../dist/session/session.js");
  const { saveConfig } = await import("../dist/config.js");

  saveConfig({ apiKey: "sk-test", baseUrl: "https://mock.test/v1", model: "mock", smallModel: "" });

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "## Progress\nRebuilt the parser; tests pass." } }],
        usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const session = new Session({ cwd: process.cwd(), model: "mock", title: "compact" });
    session.messages = [
      { role: "user", content: "Fix the build — the parser refuses valid input." },
      { role: "assistant", content: "Reading the parser." },
      { role: "tool", tool_call_id: "c1", name: "shell", content: "npm test → 3 failing" },
      { role: "assistant", content: "Found the guard in parse()." },
      { role: "user", content: "No — do not touch CI, only the parser." },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "Carry on." },
    ];
    const sameArray = session.messages;
    const res = await compactSession(session, { catalog: [] });

    check("the history array is spliced, not replaced", session.messages === sameArray);
    check("a summary was produced", res.summary.startsWith("## Progress"), res.summary);
    check("dropped count is what was folded away", res.droppedMessages === 4, String(res.droppedMessages));
    check("kept count matches the new history", res.keptMessages === session.messages.length);
    check("all three user messages were carried over", res.retainedUserMessages === 3, String(res.retainedUserMessages));
    check(
      "only user messages survive, digest first",
      session.messages.every((m) => m.role === "user"),
      session.messages.map((m) => m.role).join(),
    );
    check("the digest leads the history", String(session.messages[0].content).startsWith("<compacted-context>"));
    check(
      "the digest carries the handoff sentence",
      /Another language model started this task/.test(String(session.messages[0].content)),
    );
    check(
      "user wording survives verbatim",
      session.messages[1].content === "Fix the build — the parser refuses valid input." &&
        session.messages[2].content === "No — do not touch CI, only the parser." &&
        session.messages[3].content === "Carry on.",
      JSON.stringify(session.messages.slice(1).map((m) => m.content)),
    );

    const ask = sent[0].body;
    const system = ask.messages.find((m) => m.role === "system")?.content ?? "";
    const transcript = ask.messages.find((m) => m.role === "user")?.content ?? "";
    check("summarised with the checkpoint prompt", /CONTEXT CHECKPOINT COMPACTION/.test(system), system.slice(0, 80));
    check("the transcript covers what is dropped", /\[assistant\]/.test(transcript) && /\[tool result shell\]/.test(transcript));

    // ── the budget on carried-over messages ─────────────────────────────────
    // A newest message larger than the whole budget is truncated, not dropped:
    // it is usually the task statement, and losing it is the worst outcome.
    const big = new Session({ cwd: process.cwd(), model: "mock", title: "big" });
    big.messages = [
      { role: "user", content: "old task" },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: "x".repeat(Math.round(30_000 * 3.6)),
        images: [{ mime: "image/png", data: "AAA" }],
      },
    ];
    const bigRes = await compactSession(big, { catalog: [] });
    const carried = big.messages[1];
    check("the oversized message is kept, truncated", bigRes.retainedUserMessages === 1);
    check("with a note saying it was cut", /truncated while compacting/.test(String(carried.content)));
    check("and without the pixels that no longer fit", carried.images === undefined);
    check("the digest is still there", String(big.messages[0].content).startsWith("<compacted-context>"));

    // ── nothing to summarise ────────────────────────────────────────────────
    const empty = new Session({ cwd: process.cwd(), model: "mock", title: "empty" });
    empty.messages = [{ role: "user", content: "<compacted-context>\nsummary\n</compacted-context>" }];
    const before = sent.length;
    const none = await compactSession(empty, { catalog: [] });
    check("a history of one digest compacts to nothing", none.summary === "" && sent.length === before);
    check("and is left as it was", empty.messages.length === 1);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── light: a trim that costs no model call ─────────────────────────────────
// A quarter of the window is far too early for a digest, but old tool output
// and old thinking are dead weight. The tail stays: that is what the next
// request is about.
{
  const { lightCompact } = await import("../dist/session/compact.js");
  const { Session } = await import("../dist/session/session.js");

  const s = new Session({ cwd: process.cwd(), model: "mock", title: "light" });
  const big = "x".repeat(5000);
  s.messages = [
    { role: "user", content: "read the log" },
    { role: "assistant", content: null, reasoning: "r".repeat(3000), tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", name: "shell", content: big, images: [{ mime: "image/png", data: "QUJD" }] },
    // The tail: left exactly as it is.
    { role: "user", content: "и что там?" },
    { role: "assistant", content: "вот", reasoning: "думал" },
    { role: "user", content: "продолжи" },
    { role: "assistant", content: "да" },
    { role: "user", content: "ещё" },
    { role: "assistant", content: "ок" },
    { role: "user", content: "и?" },
    { role: "assistant", content: "всё" },
    { role: "user", content: "спасибо" },
    { role: "assistant", content: "не за что" },
  ];
  const res = lightCompact(s);
  check("old tool output was trimmed", res.trimmedMessages > 0, String(res.trimmedMessages));
  check("its images came off", s.messages[2].images === undefined);
  check("and the body carries a note saying so", /old tool output trimmed/.test(String(s.messages[2].content)));
  check("old thinking was dropped", s.messages[1].reasoning === undefined);
  check("the tool call itself survived", s.messages[1].tool_calls?.length === 1);
  check("the recent tail is untouched", s.messages[12].content === "не за что" && s.messages[12].role === "assistant");
  check("nothing was summarised", s.messages.length === 13 && !String(s.messages[0].content).startsWith("<compacted-context>"));

  const again = lightCompact(s);
  check("a second pass has nothing left to do", again.trimmedMessages === 0, String(again.trimmedMessages));
}

// ── beacons: a rung cannot be repeated forever ─────────────────────────────
// Without caps, a history hovering just above a threshold is trimmed on every
// turn and never reaches the next rung. Three lights and two mediums per cycle
// is the ladder's ceiling; a full pass starts a new cycle.
{
  const { autoCompactLevel, lightCompact, compactSession, LIGHT_BUDGET, MEDIUM_BUDGET } = await import("../dist/session/compact.js");
  const { Session } = await import("../dist/session/session.js");
  const { saveConfig } = await import("../dist/config.js");

  saveConfig({ autoCompact: true, autoCompactLightAt: 0.25, autoCompactMediumAt: 0.5, autoCompactAt: 0.9 });
  const catalog = [{ id: "w", contextWindow: 1_000_000 }];
  const s = new Session({ cwd: process.cwd(), model: "w", title: "beacons" });
  const fill = (tokens) => {
    s.messages = [{ role: "user", content: "x".repeat(Math.round(tokens * 3.6)) }];
  };

  check("three lights is the budget on paper", LIGHT_BUDGET === 3 && MEDIUM_BUDGET === 2);

  fill(300_000);
  check("a fresh cycle starts on light", autoCompactLevel(s, catalog) === "light");
  s.autoCompacts.light = LIGHT_BUDGET;
  check("with the light budget spent the ladder waits", autoCompactLevel(s, catalog) === null);
  check("and it does not fall through to a digest at a quarter of the window", autoCompactLevel(s, catalog) !== "medium");

  fill(600_000);
  check("at half the window the digest is due", autoCompactLevel(s, catalog) === "medium");
  s.autoCompacts.medium = MEDIUM_BUDGET;
  check("with both medium chances spent it waits for the full pass", autoCompactLevel(s, catalog) === null);

  fill(920_000);
  check("the full pass is never rationed", autoCompactLevel(s, catalog) === "full");

  // A real light trim increments its own counter, and only when it worked.
  const real = new Session({ cwd: process.cwd(), model: "w", title: "count" });
  real.messages = [
    { role: "user", content: "read it" },
    { role: "tool", tool_call_id: "c1", name: "shell", content: "y".repeat(4000) },
    ...Array.from({ length: 9 }, (_, i) => ({ role: "user", content: `p${i}` })),
  ];
  lightCompact(real);
  check("a trim that shortened something counts", real.autoCompacts.light === 1, String(real.autoCompacts.light));
  lightCompact(real);
  check("a no-op trim does not", real.autoCompacts.light === 1, String(real.autoCompacts.light));

  // A full compaction resets the cycle; a medium one adds to its own count.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "## Progress\nok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const cyc = new Session({ cwd: process.cwd(), model: "w", title: "cycle" });
    cyc.autoCompacts = { light: 2, medium: 1 };
    cyc.messages = [
      { role: "user", content: "task" },
      { role: "assistant", content: "working" },
    ];
    await compactSession(cyc, { catalog: [], level: "medium" });
    check("a medium pass counts against its budget", cyc.autoCompacts.medium === 2, String(cyc.autoCompacts.medium));
    check("and leaves the light count alone", cyc.autoCompacts.light === 2, String(cyc.autoCompacts.light));

    cyc.messages = [
      { role: "user", content: "task" },
      { role: "assistant", content: "working" },
    ];
    await compactSession(cyc, { catalog: [], level: "full" });
    check("a full pass opens a new cycle", cyc.autoCompacts.light === 0 && cyc.autoCompacts.medium === 0);

    // The counters outlive the process: a session reopened at the top of a rung
    // must not start trimming all over again.
    cyc.autoCompacts = { light: 1, medium: 1 };
    cyc.save();
    const back = (await import("../dist/session/session.js")).Session.load(process.cwd(), cyc.id);
    check("the beacons survive a save and a reload", back?.autoCompacts.light === 1 && back?.autoCompacts.medium === 1);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── medium: a digest plus the working tail ─────────────────────────────────
{
  const { compactSession } = await import("../dist/session/compact.js");
  const { Session } = await import("../dist/session/session.js");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "## Progress\nHalfway through the parser fix." } }],
        usage: { prompt_tokens: 700, completion_tokens: 30, total_tokens: 730 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const s = new Session({ cwd: process.cwd(), model: "mock", title: "medium" });
    s.messages = [
      { role: "user", content: "Fix the parser." },
      { role: "assistant", content: "Reading it." },
      { role: "tool", tool_call_id: "c1", name: "shell", content: "y".repeat(4000) },
      { role: "assistant", content: "Found it." },
    ];
    // Twelve messages of working tail, each one its own turn.
    for (let i = 0; i < 12; i++) {
      s.messages.push({ role: "user", content: `step ${i}` });
      s.messages.push({ role: "assistant", content: `done ${i}` });
    }
    const res = await compactSession(s, { catalog: [], level: "medium" });
    check("the level is reported back", res.level === "medium", res.level);
    check("a digest opened the history", String(s.messages[0].content).startsWith("<compacted-context>"));
    const tail = s.messages.filter((m) => m.role === "assistant" && /^done \d+$/.test(String(m.content)));
    check("the working tail survived verbatim", tail.length >= 5, `kept ${tail.length}`);
    check("the last turn is still there", String(s.messages.at(-1).content).startsWith("done "), String(s.messages.at(-1).content));
    check("the old task statement was retained", s.messages.some((m) => m.content === "Fix the parser."));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── mid-turn: compaction between a tool round and the next request ──────────
{
  const port = Number(process.env.MOCK_PORT || 8948);
  const mock = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
    stdio: "ignore",
    env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: path.join(HOME, "mock.log") },
  });
  process.env.TOKENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.TOKENROUTER_API_KEY = "sk-test";
  await new Promise((r) => setTimeout(r, 1200));

  // Part A pointed the saved config at a host that does not exist; the loop
  // talks to the mock.
  const { saveConfig } = await import("../dist/config.js");
  saveConfig({ apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock-smart" });

  const { runAgent } = await import("../dist/agent/loop.js");
  const { UsageTracker } = await import("../dist/usage.js");

  const ctx = () => ({
    cwd: process.cwd(),
    depth: 0,
    signal: new AbortController().signal,
    readFiles: new Set(),
    emit() {},
    async confirm() {
      return true;
    },
  });
  const readTool = {
    name: "read",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    risk: "read",
    async run() {
      return { output: "package contents" };
    },
  };
  const base = {
    model: "mock-smart",
    systemPrompt: "sys",
    tools: [readTool],
    toolContext: ctx(),
    catalog: [{ id: "mock-smart", contextWindow: 200_000 }],
    usage: new UsageTracker(),
    maxSteps: 6,
    signal: new AbortController().signal,
    toolConcurrency: 1,
  };

  {
    const messages = [{ role: "user", content: "look at package.json" }];
    let calls = 0;
    let sawToolResult = false;
    let compactedEvent = false;
    const result = await runAgent({
      ...base,
      messages,
      events: { onCompacted: () => (compactedEvent = true) },
      midTurnCompact: async () => {
        calls++;
        sawToolResult = messages.some((m) => m.role === "tool");
        // Replace the prompt with a digest, leaving the round intact: this is
        // what a real compaction does to the live array.
        messages.splice(0, 1, { role: "user", content: "<compacted-context>\nsummary\n</compacted-context>" });
        return true;
      },
    });

    check("compaction ran once between the rounds", calls === 1, String(calls));
    check("after the tool result landed", sawToolResult);
    check("and the loop carried on to an answer", result.stoppedBecause === "stop", result.stoppedBecause);
    check("the compacted history is the one that continued", String(messages[0].content).startsWith("<compacted-context>"));
    check("the event told the UI", compactedEvent);
  }

  {
    const messages = [{ role: "user", content: "look again" }];
    let warned = "";
    const result = await runAgent({
      ...base,
      messages,
      events: { onCompactFailed: (reason) => (warned = reason) },
      midTurnCompact: async () => {
        throw new Error("summariser is down");
      },
    });
    check("a failed compaction does not end the turn", result.stoppedBecause === "stop", result.stoppedBecause);
    check("but it is reported", warned === "summariser is down", warned);
    check("and the turn still answers", result.finalText.length > 0, result.finalText.slice(0, 60));
  }

  mock.kill();
  await new Promise((r) => setTimeout(r, 200));
}

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* Windows may hold the directory briefly; the temp dir is disposable */
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
