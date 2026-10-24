/**
 * /brain's panel with checkboxes: Space marks rows on any tab and Enter applies
 * the whole set at once, so a panel is built or trimmed in one save instead of
 * one model at a time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-brain-panel-"));
process.env.TRCODE_HOME = path.join(HOME, ".trcode");

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const RIGHT = ESC + "[C";
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
const { brainModal, modelsAsRows } = await import("../dist/ui/commands/agents.js");

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
  { id: "mock-slow", modality: "text" },
  { id: "mock-mini", modality: "text" },
];
const rows = modelsAsRows(catalog).filter((r) => !r.header);
const firstTwo = rows.slice(0, 2).map((r) => r.value);

const app = {
  catalog,
  session: { model: "mock-fast", messages: [] },
  exclusiveInput: (fn) => Promise.resolve(fn()),
  runBrain: async () => {
    throw new Error("the panel must not run for an unanswered question");
  },
};

saveConfig({ brainModels: [], brainMainModel: "", favoriteModels: [] }, { replace: ["brainModels"] });

// ── adding in bulk from the catalogue ──────────────────────────────────────
let done = brainModal(app);
reset();
type(RIGHT); // panel → all models
check("the catalogue lists unchecked boxes", screen().includes("[ ]"), screen().slice(0, 400));
check("nothing is marked before the panel has members", !screen().includes("[x]"), screen().slice(0, 400));
check(
  "the footer teaches the keys",
  /Space mark/.test(screen()) || /Пробел отметить/.test(screen()),
  screen().slice(-300),
);

reset();
type(" ");
type(DOWN);
type(" ");
check("Space leaves marks on screen", /\[x\]/.test(screen()), screen().slice(0, 400));

reset();
type(CR);
await done;
const added = loadConfig().brainModels;
check(
  "Enter applies every mark in one save",
  JSON.stringify(added) === JSON.stringify(firstTwo),
  JSON.stringify(added) + " vs " + JSON.stringify(firstTwo),
);
check(
  "and says how many joined",
  /Panel \(2\)|Совет \(2\)/.test(screen()),
  screen().slice(-300),
);

// ── removing in bulk from the active panel ─────────────────────────────────
saveConfig({ brainMainModel: firstTwo[0] });
done = brainModal(app);
reset();
type(" "); // uncheck the row under the cursor on the panel tab
check("the panel tab carries the same boxes", /\[x\]/.test(screen()) && /\[ \]/.test(screen()), screen().slice(0, 400));

reset();
type(CR);
await done;
const kept = loadConfig().brainModels;
check(
  "an unchecked row leaves the panel",
  JSON.stringify(kept) === JSON.stringify([firstTwo[1]]),
  JSON.stringify(kept),
);
check(
  "the dropped model is no longer main",
  loadConfig().brainMainModel === "",
  loadConfig().brainMainModel,
);

// ── closing without changes ────────────────────────────────────────────────
done = brainModal(app);
reset();
type(CR);
await done;
check("Enter with the marks untouched changes nothing", JSON.stringify(loadConfig().brainModels) === JSON.stringify([firstTwo[1]]));
check("and prints no change line", !/added|Panel \(/.test(screen()), screen().slice(-200));

// ── the Clear button, then Esc ─────────────────────────────────────────────
done = brainModal(app);
type(ESC + "x");
// The button answers a promise: the save and the reopened panel land in the
// microtask that follows, not inside the keystroke.
await new Promise((r) => setTimeout(r, 0));
check("the Clear button empties the panel", loadConfig().brainModels.length === 0, JSON.stringify(loadConfig().brainModels));
type(ESC);
await done;
check("Esc closes the reopened panel", true);

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* temp dir is disposable */
}

say(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
