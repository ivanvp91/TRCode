/**
 * A subagent list outlives the catalogue that produced it: hosts retire models,
 * and a saved id that is no longer served used to stay marked in the panel, be
 * counted in its subtitle, and come back in the "Subagents on …" line as if it
 * could still run. The list is now read through the catalogue.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-subagent-stale-"));
process.env.TRCODE_HOME = path.join(HOME, ".trcode");

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const DOWN = ESC + "[B";

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => {
  stdin.isRaw = v;
  return stdin;
};
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });

let painted = "";
const realWrite = process.stdout.write.bind(process.stdout);
const say = (line) => realWrite(line + "\n");
process.stdout.write = (chunk) => {
  painted += String(chunk);
  return true;
};
const strip = (s) => s.replace(new RegExp(ESC + "\\[\\??[0-9;]*[A-Za-z]", "g"), "");
const screen = () => strip(painted);
const reset = () => {
  painted = "";
};
const type = (s) => stdin.emit("data", Buffer.from(s, "utf8"));

const { loadConfig, saveConfig } = await import("../dist/config.js");
const { setSubagentMode, subagentsModal, liveSubagentModels } = await import("../dist/ui/commands/agents.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    say("  ok   " + name);
  } else {
    failed++;
    say("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
};

const catalog = [
  { id: "mock-fast", modality: "text" },
  { id: "mock-smart", modality: "text" },
];
const app = {
  catalog,
  session: { model: "mock-fast", messages: [] },
  exclusiveInput: (fn) => Promise.resolve(fn()),
  rebuildTools() {},
  get cfg() {
    return loadConfig();
  },
  set cfg(_v) {},
};

const stale = ["mock-fast", "mock-smart", "gone-model"];
saveConfig({ subagentModels: stale, subagentMode: "list" });

// ── the list as it is read ─────────────────────────────────────────────────
check(
  "a retired model is not part of the list",
  JSON.stringify(liveSubagentModels(app)) === JSON.stringify(["mock-fast", "mock-smart"]),
  JSON.stringify(liveSubagentModels(app)),
);
check(
  "an empty catalogue judges nothing",
  JSON.stringify(liveSubagentModels({ catalog: [], session: app.session })) === JSON.stringify(stale),
  JSON.stringify(liveSubagentModels({ catalog: [], session: app.session })),
);
// A helper's pool spans providers: a marked model of another host is not a
// retired one and must survive the read the session's own models go through.
{
  const mixed = { catalog: [...catalog, { id: "kimi:k3", modality: "text" }], session: app.session };
  saveConfig({ subagentModels: ["mock-fast", "kimi:k3"], subagentMode: "list" });
  check(
    "a marked model of another host survives",
    JSON.stringify(liveSubagentModels(mixed)) === JSON.stringify(["mock-fast", "kimi:k3"]),
    JSON.stringify(liveSubagentModels(mixed)),
  );
  saveConfig({ subagentModels: stale, subagentMode: "list" });
}

// ── the line /subagents lists prints ───────────────────────────────────────
reset();
setSubagentMode(app, "list");
const lines = screen().split("\n").map((l) => l.trim()).filter(Boolean);
check(
  "the printed list is the live one",
  /Subagents: mock-fast, mock-smart$/.test(lines[lines.length - 1]),
  JSON.stringify(lines),
);
check("and the retired model is not in that line", !/gone-model/.test(lines[lines.length - 1]), lines[lines.length - 1]);
check(
  "the drop is reported",
  /dropped from the subagent list \(1\)|убрано из списка субагентов \(1\)/i.test(screen()),
  screen().slice(-300),
);
check(
  "the config no longer carries it",
  JSON.stringify(loadConfig().subagentModels) === JSON.stringify(["mock-fast", "mock-smart"]),
  JSON.stringify(loadConfig().subagentModels),
);
check("the mode stays on the list", loadConfig().subagentMode === "list");

// ── the panel: one mark, one counted model ─────────────────────────────────
saveConfig({ subagentModels: stale, subagentMode: "list" });
reset();
let done = subagentsModal(app);
check("the drop is reported before the panel draws", /gone-model/.test(screen()), screen().slice(0, 600));
reset();
await new Promise((r) => setTimeout(r, 20));
type(DOWN); // any key makes the panel repaint
await new Promise((r) => setTimeout(r, 20));
check(
  "the subtitle counts only models on screen",
  /2 marked below|2 отмеченных ниже/.test(screen()),
  screen().slice(0, 800),
);
reset();
type(CR);
await done;
check(
  "Enter saves the live list, not the stale mark",
  JSON.stringify(loadConfig().subagentModels) === JSON.stringify(["mock-fast", "mock-smart"]),
  JSON.stringify(loadConfig().subagentModels),
);
check(
  "and the line says the same",
  /Subagents: mock-fast, mock-smart$/.test(screen().trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? ""),
  screen().slice(-300),
);

// ── every model gone: the list empties, the mode goes with it ──────────────
saveConfig({ subagentModels: ["gone-model"], subagentMode: "list" });
reset();
setSubagentMode(app, "list");
check(
  "an emptied list cannot mean 'run on the list'",
  loadConfig().subagentMode === "session",
  String(loadConfig().subagentMode),
);
check("and the command says there is no list", /no subagent list yet|ещё нет списка/.test(screen()), screen().slice(-300));

saveConfig({ subagentModels: [], subagentMode: undefined });
fs.rmSync(HOME, { recursive: true, force: true });

say("");
say(failed ? `${failed} failed, ${passed} passed` : `${passed} passed`);
process.exit(failed ? 1 : 0);
