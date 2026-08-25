/**
 * Session fork (/fork, "Fork here" on rewind): a branch at a past turn while
 * the original stays untouched. The dangerous part is the cut — a history that
 * ends in a dangling tool result or an assistant tool_calls with no answers is
 * refused by most hosts, so the cut walks back to a turn boundary the same way
 * trim's keepRecent never splits pairs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-fork-"));
process.env.TRCODE_HOME = HOME;

const { Session } = await import("../dist/session/session.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const cwd = process.cwd();
const s = new Session({ cwd, model: "mock:m", title: "base session" });
s.add({ role: "user", content: "первый вопрос" });
s.add({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] });
s.add({ role: "tool", tool_call_id: "c1", name: "read", content: "file body" });
s.add({ role: "assistant", content: "готово" });
s.add({ role: "user", content: "второй вопрос" });
s.add({ role: "assistant", content: "ответ два" });

// ── fork from a clean boundary ──
{
  // Cut after index 3 (the "готово" assistant): everything before stays.
  const f1 = Session.forkFrom(s, 4);
  check("fork keeps messages up to the cut", f1?.messages.length === 4);
  check("fork gets its own id", Boolean(f1) && f1.id !== s.id);
  check("fork title carries the fork mark", /fork/.test(f1.title), f1.title);
  check("original keeps all six messages", s.messages.length === 6);

  // The original must be unaffected on disk too.
  s.save();
  const reloaded = Session.load(cwd, s.id);
  check("original session file intact after forking", reloaded?.messages.length === 6);
}

// ── the cut never leaves a dangling tool pair ──
{
  // Cutting mid-pair: slice lands right after the assistant with tool_calls.
  const f2 = Session.forkFrom(s, 2); // user, assistant(tool_calls) — trailing call
  check("a trailing tool_calls message is dropped", f2.messages.length === 1 && f2.messages[0].role === "user", JSON.stringify(f2.messages.map((m) => m.role)));

  const f3 = Session.forkFrom(s, 3); // ends exactly on a tool result
  check("trailing tool results are walked back", !f3.messages.some((m) => m.role === "tool"), JSON.stringify(f3.messages.map((m) => m.role)));
  check("the walk-back keeps a valid ending", f3.messages.length >= 1 && ["user", "assistant"].includes(f3.messages[f3.messages.length - 1].role));
}

// ── deep copies: mutating the fork cannot reach back into the original ──
{
  const f4 = Session.forkFrom(s, 6);
  f4.messages[0].content = "изменённый вопрос";
  check("messages are copied, not referenced", s.messages[0].content === "первый вопрос");
  void f4;
}

// ── an empty cut is refused by the caller, but forkFrom survives it ──
{
  const f5 = Session.forkFrom(s, 0);
  check("fork from zero carries nothing", f5?.messages.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
