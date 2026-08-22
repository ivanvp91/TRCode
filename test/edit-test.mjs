/**
 * Going back to your own message.
 *
 * A conversation that went the wrong way carries the wrong way into every
 * later request, and the only way to stop paying for it is to cut the history
 * at the question and ask it differently. /edit drops everything after the
 * chosen message and puts its text back in the input frame; the files it wrote
 * are /rewind's business, not this one's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-edit-home-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-edit-cwd-"));
process.env.TRCODE_HOME = HOME;

const { runCommand } = await import("../dist/ui/commands.js");
const { Session } = await import("../dist/session/session.js");
const paste = await import("../dist/ui/paste.js");
const render = await import("../dist/ui/render.js");

let passed = 0;
let failed = 0;
const realWrite = process.stdout.write.bind(process.stdout);
const check = (name, cond, detail = "") => {
  if (cond) { passed++; realWrite("  ok   " + name + "\n"); }
  else { failed++; realWrite("  FAIL " + name + (detail ? "\n       " + detail : "") + "\n"); }
};
const quiet = async (fn) => {
  let out = "";
  process.stdout.write = (chunk) => { out += String(chunk); return true; };
  try { await fn(); } finally { process.stdout.write = realWrite; }
  return out;
};

function fixture() {
  const session = new Session({ cwd: WORK, model: "mock-fast", title: "edit" });
  session.messages = [
    { role: "user", content: "первый вопрос", meta: { ts: Date.now() - 60_000 } },
    { role: "assistant", content: "первый ответ", meta: { model: "mock-fast" } },
    { role: "user", content: "второй вопрос, с опечаткай", meta: { ts: Date.now() - 30_000 } },
    { role: "assistant", content: "второй ответ", meta: { model: "mock-fast" } },
    { role: "user", content: "<skill>", meta: { skill: "debugging" } },
  ];
  const prefilled = [];
  const app = {
    cwd: WORK,
    session,
    editor: { prefill: (t) => prefilled.push(t) },
    exclusiveInput: (fn) => fn(),
  };
  return { app, session, prefilled };
}

// ── /edit last ──────────────────────────────────────────────────────────────
{
  const { app, session, prefilled } = fixture();
  const out = await quiet(() => runCommand(app, "/edit last"));

  check("the history is cut at the message", session.messages.length === 2, String(session.messages.length));
  check("what is left ends before it", session.messages[1]?.content === "первый ответ", session.messages[1]?.content);
  check("the text goes back into the frame", prefilled[0] === "второй вопрос, с опечаткай", JSON.stringify(prefilled));
  check("it says how much was dropped", /3/.test(out), out.trim().split("\n").pop());
  check("and that files are a separate matter", /rewind/.test(out));
}

// ── an injected skill is not one of your messages ───────────────────────────
{
  const { app, session } = fixture();
  session.messages = [
    { role: "user", content: "вопрос", meta: { ts: Date.now() } },
    { role: "user", content: "<skill>", meta: { skill: "debugging" } },
    { role: "assistant", content: "ответ", meta: { model: "mock-fast" } },
  ];
  await quiet(() => runCommand(app, "/edit last"));
  check("a skill injection is skipped", session.messages.length === 0, JSON.stringify(session.messages.map((m) => m.content)));
}

// ── nothing to edit ─────────────────────────────────────────────────────────
{
  const { app, session } = fixture();
  session.messages = [{ role: "assistant", content: "привет", meta: { model: "mock-fast" } }];
  const out = await quiet(() => runCommand(app, "/edit last"));
  check("an empty conversation says so", /Nothing to edit|Править нечего/.test(out), out.trim());
  check("and is left alone", session.messages.length === 1);
}

// ── /expand ─────────────────────────────────────────────────────────────────
{
  paste.resetStash();
  const BIG = Array.from({ length: 30 }, (_, i) => `строка ${i + 1}`).join("\n");
  await quiet(async () => render.userEcho(BIG));

  const { app } = fixture();
  const shown = await quiet(() => runCommand(app, "/expand 1"));
  check("/expand prints the whole thing", shown.includes("строка 30"), shown.slice(0, 120));

  const bad = await quiet(() => runCommand(app, "/expand 7"));
  check("a number nobody has says so", /No such block|Нет такого блока/.test(bad), bad.trim());

  paste.resetStash();
  const none = await quiet(() => runCommand(app, "/expand"));
  check("nothing shortened, nothing to show", /Nothing has been shortened|ничего не сокращалось/.test(none), none.trim());
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
realWrite(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
