/**
 * Bounding tool output where it is produced, so the history stays append-only.
 *
 * The point is not the saving on one result — it is that the message is never
 * rewritten afterwards. A provider-side cache matches a prefix byte for byte,
 * so a single edit in the middle of an already-sent history costs a full
 * re-prefill of everything behind it, on that step and on every step after.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundToolOutput, createSpillStore, forkSpillStore } from "../dist/tools/spill.js";
import { trimForRequest } from "../dist/session/trim.js";

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-spill-"));
const store = createSpillStore(cwd, "s1");
const opts = { tool: "read", limit: 2000, dedupeMin: 400 };

// A result that fits is not touched at all.
{
  const small = "x".repeat(300);
  check("a short result is passed through", boundToolOutput(store, small, opts).content === small);
  const fits = "y".repeat(1500);
  check("a result inside the limit is passed through", boundToolOutput(store, fits, opts).content === fits);
}

// A big one keeps both ends and parks the rest.
{
  const body = "HEAD-MARKER\n" + "строка вывода\n".repeat(4000) + "TAIL-MARKER";
  const r = boundToolOutput(store, body, opts);
  check("the result is bounded", r.content.length < opts.limit * 1.4, String(r.content.length));
  check("the head survives", r.content.startsWith("HEAD-MARKER"));
  check("the tail survives", r.content.trimEnd().endsWith("TAIL-MARKER"));
  check("it says where the rest is", /\.trcode\/artifacts\/s1\//.test(r.content), r.content.slice(0, 200));
  check("and the rest is actually there", r.path && fs.readFileSync(path.join(cwd, r.path), "utf8") === body);
  check("it names the tool that can page through it", /read tool/.test(r.content));
}

// A repeat collapses to a pointer instead of a second copy.
{
  const file = "содержимое файла\n".repeat(500);
  const first = boundToolOutput(store, file, opts);
  const second = boundToolOutput(store, file, opts);
  check("the first copy is bounded but real", first.content.includes("содержимое файла"));
  check("the repeat collapses", second.repeat === true && /identical to the read result/.test(second.content), second.content.slice(0, 120));
  check("the repeat is one line, not a copy", second.content.length < 300, String(second.content.length));
  check("and it points at the parked full copy", /\.trcode\/artifacts\//.test(second.content), second.content);
}

// Logs keep their end: that is where a build says whether it worked.
{
  const log = "начало\n" + "шаг сборки\n".repeat(4000) + "BUILD FAILED: 3 errors";
  const head = boundToolOutput(store, log, { ...opts, tool: "shell" });
  const tail = boundToolOutput(store, log + " ", { ...opts, tool: "shell", bias: "tail" });
  const endOf = (s) => s.slice(s.lastIndexOf("] …") + 3);
  check("tail bias keeps more of the end", endOf(tail.content).length > endOf(head.content).length,
    `${endOf(tail.content).length} vs ${endOf(head.content).length}`);
  check("the failure line survives either way", /BUILD FAILED/.test(tail.content) && /BUILD FAILED/.test(head.content));
}

// Without a store there is nowhere to park anything, and the result still has
// to be bounded — a one-shot run must not send a 400KB dump on every step.
{
  const r = boundToolOutput(undefined, "z".repeat(50_000), opts);
  check("no store still bounds the result", r.content.length < opts.limit * 1.4, String(r.content.length));
  check("and says the rest is gone rather than where it is", /was not kept/.test(r.content));
}

// The regression this exists for: with the wire-side cap off (the default), a
// big tool result crossing the recent-tail boundary no longer rewrites the
// history under an already-sent prefix.
{
  const tool = (content, id) => ({ role: "tool", name: "read", tool_call_id: id, content });
  const talk = (content) => ({ role: "assistant", content });
  const big = "строка\n".repeat(3000);
  const base = [{ role: "user", content: "почини баг" }, talk("читаю"), tool(big, "1")];
  const grow = (n) => [...base, ...Array.from({ length: n }, (_, i) => talk("шаг " + i))];
  const wire = { budget: 1_000_000, keepRecent: 8, minTrimBytes: 400, maxResultBytes: 0 };

  const at = (n) => trimForRequest(grow(n), wire).messages.slice(0, 3).map((m) => String(m.content));
  const before = at(4);   // the big result is still inside the recent tail
  const after = at(12);   // and now it is well outside it
  check("the prefix survives the result leaving the recent tail", JSON.stringify(before) === JSON.stringify(after),
    `${before[2].length} → ${after[2].length}`);

  // Same history with the old default: this is what the fix removed.
  const legacy = trimForRequest(grow(12), { ...wire, maxResultBytes: 4000 }).messages[2];
  check("with the old wire cap it did not (this is the bug)", String(legacy.content).length < big.length);
}

// A subagent shares the artifact directory but not the record of repeats: it
// cannot see the lead's transcript, so "identical to the result above" would
// be pointing at nothing.
{
  const lead = createSpillStore(cwd, "s2");
  const file = "общий файл текста ".repeat(500);
  boundToolOutput(lead, file, opts);
  const sub = forkSpillStore(lead);
  const inSub = boundToolOutput(sub, file, opts);
  check("a subagent gets the content, not a pointer at a transcript it lacks", !inSub.repeat, inSub.content.slice(0, 80));
  check("but the second time inside that subagent it does collapse", boundToolOutput(sub, file, opts).repeat === true);
  check("and the numbering does not collide", lead.counter === sub.counter);
}

fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
