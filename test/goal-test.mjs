/**
 * Session goal (/goal): a persistent objective the agent keeps working toward
 * between the user's own inputs. The state machine lives in session/goal.ts,
 * the storage in the session meta, and the loop hook in repl.ts's run(); these
 * tests pin the state machine and the round-trip through the session file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-goal-"));
process.env.TRCODE_HOME = HOME;

const { Session } = await import("../dist/session/session.js");
const goalMod = await import("../dist/session/goal.js");
const { newGoal, turnGate, spendTurn, completeGoal, goalLine, goalPrompt, DEFAULT_MAX_TURNS } = goalMod;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// ── state machine ──
{
  const g = newGoal("make tests green");
  check("new goal is active with zero turns", g.status === "active" && g.turnsUsed === 0);
  check("gate lets an active goal run", turnGate(g) === "ok");
  check("goal line shows the objective", goalLine(g).includes("make tests green"));

  spendTurn(g);
  spendTurn(g);
  check("spendTurn counts turns", g.turnsUsed === 2);
  check("gate still ok within budget", turnGate(g) === "ok");

  g.status = "paused";
  check("paused goal blocks the gate", turnGate(g) === "paused");
  g.status = "active";
  g.status = "complete";
  check("complete goal blocks the gate", turnGate(g) === "complete");
}

// ── turn budget ──
{
  const g = newGoal("ship it", 3);
  spendTurn(g); spendTurn(g); spendTurn(g);
  check("budget of 3 pauses after 3 turns", g.status === "paused" && g.turnsUsed === 3);
  check("exhausted gate says so", turnGate(g) === "exhausted");
  // Resuming grants a fresh budget: the counter resets (the /goal command
  // does this) and the gate opens.
  g.status = "active";
  g.turnsUsed = 0;
  check("gate ok again after resume", turnGate(g) === "ok");
}

{
  const g = newGoal("no limit", 0);
  check("zero / invalid turns means no budget", g.maxTurns === undefined);
  for (let i = 0; i < DEFAULT_MAX_TURNS + 3; i++) spendTurn(g);
  check("no budget keeps the goal running", g.status === "active");
  // …the REPL's built-in cap handles it; the state machine alone does not stop.
}

{
  const g = newGoal("halfway", 2);
  spendTurn(g);
  completeGoal(g);
  check("completeGoal marks complete", g.status === "complete" && typeof g.completedAt === "number");
  check("complete beats spend", turnGate(g) === "complete");
}

// ── prompts and status text ──
{
  const g = newGoal("fix all tests", 5);
  spendTurn(g);
  const p = goalPrompt(g);
  check("prompt carries the objective", p.includes("fix all tests"));
  check("prompt carries the completion tag", p.includes("<goal-complete>"));
  check("prompt carries the turn count", p.includes("1 of 5"), p.slice(-120));

  const none = goalPrompt(newGoal("just this"));
  check("prompt without budget omits turns", !/of\s+\d+/.test(none.replace(/<goal-complete>/g, "")));
  check("goal line marks paused", goalLine({ ...newGoal("x"), status: "paused" }).includes("◎"));
}

// ── round-trip through the session file ──
{
  const cwd = process.cwd();
  const s = new Session({ cwd, model: "mock:m", title: "goal session" });
  s.add({ role: "user", content: "начни" });
  s.add({ role: "assistant", content: "ок" });
  s.goal = newGoal("задача цели", 7);
  spendTurn(s.goal);
  s.save();

  const back = Session.load(cwd, s.id);
  check("goal survives save/load", Boolean(back?.goal));
  check("objective round-trips", back?.goal?.objective === "задача цели");
  check("turn counter round-trips", back?.goal?.turnsUsed === 1 && back?.goal?.maxTurns === 7);
  check("status round-trips", back?.goal?.status === "active");

  // A session without a goal reads back with none.
  const plain = new Session({ cwd, model: "mock:m", title: "plain" });
  plain.add({ role: "user", content: "hi" });
  plain.add({ role: "assistant", content: "hello" });
  plain.save();
  const plainBack = Session.load(cwd, plain.id);
  check("no goal reads back as null", plainBack?.goal === null || plainBack?.goal === undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
