/**
 * Input-token control. An agent loop re-sends the whole history every step, so
 * anything left in it is paid for again on every later step — which is why a
 * repeat that costs nothing to collapse is worth collapsing.
 */
import { trimForRequest, historySize } from "../dist/session/trim.js";
import { estimateTokens } from "../dist/usage.js";

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const dump = (n) => "строка вывода ".repeat(n);
const tool = (name, content, id) => ({ role: "tool", name, tool_call_id: id, content });
const talk = (content) => ({ role: "assistant", content });

// Four reads of the same unchanged file, then a tail of recent messages.
const file = dump(300);
const history = [
  { role: "user", content: "почини баг" },
  talk("читаю"),
  tool("read", file, "1"),
  talk("ещё раз"),
  tool("read", file, "2"),
  talk("и ещё"),
  tool("read", file, "3"),
  talk("и снова"),
  tool("read", file, "4"),
  ...Array.from({ length: 8 }, (_, i) => talk("хвост " + i)),
];

const opts = { budget: 1_000_000, keepRecent: 8, minTrimBytes: 400, maxResultBytes: 0 };
const r = trimForRequest(history, opts);

check("the first copy is left alone", r.messages[2].content === file, String(r.messages[2].content).slice(0, 40));
check("the repeats are collapsed", [4, 6, 8].every((i) => /identical to the earlier/.test(String(r.messages[i].content))), JSON.stringify(r.messages[4].content));
check("and it says which tool they repeat", /read/.test(String(r.messages[4].content)), String(r.messages[4].content));
check("the saving is most of the history", historySize(r.messages) < historySize(history) / 2, `${historySize(history)} → ${historySize(r.messages)}`);
check("nothing is dropped", r.messages.length === history.length);

// A history that fits the budget is still deduplicated: the point is what the
// *next* steps will pay, not this one.
check("a budget that fits does not stop it", r.trimmed >= 3, String(r.trimmed));

// Different content is not a repeat, however similar.
{
  const two = [
    { role: "user", content: "?" },
    tool("read", dump(300), "1"),
    talk("x"),
    tool("read", dump(301), "2"),
    ...Array.from({ length: 8 }, (_, i) => talk("хвост " + i)),
  ];
  const out = trimForRequest(two, opts);
  check("a changed file is not called unchanged", !/identical/.test(String(out.messages[3].content)), String(out.messages[3].content).slice(0, 60));
}

// The wire copy has to be byte-identical between steps, or a provider-side
// cache matches nothing and the saving is undone by a cold prefix.
{
  const a = trimForRequest(history, opts).messages.map((m) => String(m.content));
  const b = trimForRequest([...history, talk("следующий шаг")], opts).messages.slice(0, a.length).map((m) => String(m.content));
  check("the prefix stays stable between steps", JSON.stringify(a) === JSON.stringify(b));
}

// The recent tail is never touched: the model is still working from it.
{
  const recent = [
    { role: "user", content: "?" },
    tool("read", file, "1"),
    tool("read", file, "2"),
  ];
  const out = trimForRequest(recent, { ...opts, keepRecent: 8 });
  check("the tail keeps its repeats", out.messages.every((m) => !/identical/.test(String(m.content))), JSON.stringify(out.trimmed));
}

// The budget pass is the last thing that rewrites an already-sent history, so
// it has to fire rarely: crossing the budget costs a re-prefill of everything
// behind the oldest message it touches. Cutting to the line meant paying that
// price again a couple of steps later.
{
  const big = dump(2000);
  const many = [
    { role: "user", content: "аудит" },
    ...Array.from({ length: 20 }, (_, i) => [talk("шаг " + i), tool("read", big + i, String(i))]).flat(),
    ...Array.from({ length: 8 }, (_, i) => talk("хвост " + i)),
  ];
  const wire = { keepRecent: 8, minTrimBytes: 400, maxResultBytes: 0 };
  const budget = Math.floor(historySize(many) * 0.8);
  const cut = trimForRequest(many, { ...wire, budget });
  check("the budget pass cuts well under the budget, not to it", historySize(cut.messages) < budget * 0.75,
    `budget ${budget}, left ${historySize(cut.messages)}`);

  // Having cut, it stays quiet: touching the history again on the next step
  // spends the saving on a cold prefix.
  let msgs = cut.messages;
  let quiet = 0;
  for (let step = 0; step < 6; step++) {
    msgs = [...msgs, talk("следующий шаг " + step)];
    const again = trimForRequest(msgs, { ...wire, budget });
    if (again.trimmed === 0) quiet++;
    msgs = again.messages;
  }
  check("and then leaves the history alone for the steps after", quiet === 6, `quiet on ${quiet} of 6 steps`);

  const roomy = trimForRequest(many, { ...wire, budget: historySize(many) * 2 });
  check("a history inside the budget is left alone", historySize(roomy.messages) === historySize(many));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
