/**
 * Occasional hints: one line at a time, never twice, and only when the
 * conversation has settled into a finished ordinary turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-tips-"));
process.env.TRCODE_HOME = HOME;
delete process.env.NO_COLOR;

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 110, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });

let painted = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { painted += String(chunk); return true; };
const say = (s = "") => realWrite(s + "\n");
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; say("  ok   " + name); }
  else { failed++; say("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const { TIPS, nextTip, allTipIds, TIP_EVERY } = await import("../dist/ui/tips.js");
const { loadConfig, saveConfig } = await import("../dist/config.js");

const base = {
  turns: 0, goal: false, subagents: false, uiLibrary: false,
  brain: false, shell: false, compacted: false, provider: "mock",
};

// ── the rhythm ─────────────────────────────────────────────────────────────
{
  check("never on the first turn", nextTip({ ...base, turns: 1 }, []) === null);
  check("never between the beats", nextTip({ ...base, turns: TIP_EVERY + 1 }, []) === null);
  const tip = nextTip({ ...base, turns: TIP_EVERY }, []);
  check("one arrives on the beat", Boolean(tip), String(tip));

  // Drawn at random, not in list order: every tip can come first.
  const firsts = new Set();
  for (let i = 0; i < TIPS.length; i++) {
    firsts.add(nextTip({ ...base, turns: TIP_EVERY }, [], () => (i + 0.5) / TIPS.length)?.id);
  }
  check("any tip can be the first one", firsts.size === TIPS.length, [...firsts].join(", "));
  const drawn = new Set();
  for (let i = 0; i < 400; i++) drawn.add(nextTip({ ...base, turns: TIP_EVERY }, [])?.id);
  check("and Math.random reaches all of them", drawn.size === TIPS.length, `${drawn.size} of ${TIPS.length}`);
  check("a draw of 1.0 stays inside the list", Boolean(nextTip({ ...base, turns: TIP_EVERY }, [], () => 1)));

  const allButLast = TIPS.slice(0, -1).map((t) => t.id);
  const rest = new Set();
  for (let i = 0; i < 50; i++) rest.add(nextTip({ ...base, turns: TIP_EVERY }, allButLast)?.id);
  check("a shown tip is never offered again", rest.size === 1 && rest.has(TIPS.at(-1).id), [...rest].join(", "));

  const every = allTipIds();
  check("when everything has been shown, silence", nextTip({ ...base, turns: TIP_EVERY }, every) === null);
  check("every id is unique", new Set(every).size === every.length);
}

// ── when it holds its tongue ───────────────────────────────────────────────
{
  check("not during a goal", nextTip({ ...base, turns: TIP_EVERY, goal: true }, []) === null);
}

// ── a tip about something already in use is skipped, not shown late ─────────
{
  const offered = (state) => {
    const ids = new Set();
    for (let i = 0; i < 400; i++) ids.add(nextTip(state, [])?.id);
    return ids;
  };
  const inUse = offered({ ...base, turns: TIP_EVERY, brain: true, shell: true, subagents: true });
  check("a used feature is never advertised", !inUse.has("brain") && !inUse.has("shell"), [...inUse].join(", "));
  check("both subagent tips retire with the first call", !inUse.has("swarm") && !inUse.has("subagents"), [...inUse].join(", "));
  check("the rest still come up", inUse.has("rewind") && inUse.has("stat"), [...inUse].join(", "));
}

// ── the tips themselves ────────────────────────────────────────────────────
{
  for (const tip of TIPS) {
    const text = tip.text();
    check(`${tip.id} has a line`, text.length > 20 && !/undefined/.test(text), text);
    check(`${tip.id} names its command`, /`\/\w|`!/.test(text), text);
  }
  const longest = Math.max(...TIPS.map((t) => t.text().length));
  check("every line fits a normal terminal", longest <= 105, String(longest));
}

// ── the switch ─────────────────────────────────────────────────────────────
{
  saveConfig({ tips: false });
  check("the switch is remembered", loadConfig().tips === false);
  saveConfig({ tips: true });
  check("and turns back on", loadConfig().tips === true);

  saveConfig({ tipsSeen: ["brain", "uilib"] }, { replace: ["tipsSeen"] });
  check("seen ids are stored", JSON.stringify(loadConfig().tipsSeen) === JSON.stringify(["brain", "uilib"]), JSON.stringify(loadConfig().tipsSeen));
  saveConfig({ tips: true });
  check("saving an unrelated key keeps the list", JSON.stringify(loadConfig().tipsSeen) === JSON.stringify(["brain", "uilib"]));
  saveConfig({ tipsSeen: [] }, { replace: ["tipsSeen"] });
  check("reset clears it", loadConfig().tipsSeen.length === 0);
}

// ── the line itself, through the app ───────────────────────────────────────
{
  const { App } = await import("../dist/ui/repl.js");
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-tips-work-"));
  const app = new App({ cwd: WORK, model: "mock-smart", autoApprove: true });
  await app.init();
  saveConfig({ tips: true, tipsSeen: [] });

  app.turnsDone = 1;
  const none = (painted = "", app.showTip(), strip(painted));
  check("nothing on an early turn", !/tip —/.test(none), none.slice(-200));

  // The beat is finished turns, not user messages: skill and design
  // injections, steered lines and /brain all add those, and used to make the
  // count jump over the beat.
  for (let i = 0; i < 5; i++) app.session.add({ role: "user", content: `injected ${i}`, meta: { skill: "x" } });
  app.turnsDone = 2;
  const notYet = (painted = "", app.showTip(), strip(painted));
  check("injected messages do not move the beat", !/tip —/.test(notYet), notYet.slice(-200));

  app.turnsDone = TIP_EVERY;
  painted = "";
  app.showTip();
  const shown = strip(painted);
  check("the hint appears on the beat", /tip —/.test(shown), shown.slice(-300));
  check("and it is stored as seen", loadConfig().tipsSeen.length === 1, JSON.stringify(loadConfig().tipsSeen));

  painted = "";
  app.showTip();
  check("the same turn does not get a second one", !/tip —/.test(strip(painted)), strip(painted).slice(-200));

  saveConfig({ tips: false });
  painted = "";
  app.turnsDone = TIP_EVERY * 2;
  app.showTip();
  check("off means nothing at all", !/tip —/.test(strip(painted)), strip(painted).slice(-200));
}

say(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
