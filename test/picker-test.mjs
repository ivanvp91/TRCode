/**
 * The list picker's search: the field is on screen above the list, every typed
 * word has to match, and the counter says how much of the catalogue is left.
 * With hundreds of models a list you cannot search is a list you cannot use.
 */
import { EventEmitter } from "node:events";

const ESC = String.fromCharCode(27);
const CTRL_U = String.fromCharCode(21);
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

/** Everything drawn since the last reset, ANSI stripped. */
let painted = "";
const realWrite = process.stdout.write.bind(process.stdout);
const say = (line) => realWrite(line + "\n");
process.stdout.write = (chunk) => {
  painted += String(chunk);
  return true;
};
// Private modes (cursor hide/show) too: left in, they pad the row they sit on
// and the frame looks ragged when it is not.
const strip = (s) => s.replace(new RegExp(ESC + "\\[\\??[0-9;]*[A-Za-z]", "g"), "");
const screen = () => strip(painted);
const reset = () => {
  painted = "";
};

const { pick } = await import("../dist/ui/picker.js");

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

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const type = (s) => stdin.emit("data", Buffer.from(s, "utf8"));

const items = [
  { value: "__Qwen", label: "", header: "Qwen" },
  { value: "alibabacloud:qwen3.8-max", label: "qwen3.8-max" },
  { value: "alibabacloud:qwen3.7-max", label: "qwen3.7-max" },
  { value: "alibabacloud:qwen3-coder-plus", label: "qwen3-coder-plus" },
  { value: "__MoonShot", label: "", header: "MoonShot" },
  { value: "moonshotai/kimi-k3", label: "moonshotai/kimi-k3" },
  { value: "openrouter:moonshotai/kimi-k3", label: "moonshotai/kimi-k3" },
];

const chosen = pick({ title: "Models", items });

check("the search field is drawn above the list", /⌕/.test(screen()), screen().split("\n").slice(0, 4).join(" | "));
check("it says what it is before anything is typed", /поиск|search/i.test(screen()), screen().split("\n")[1]);
check("the count of what is listed is shown", /\b5\b/.test(screen()), screen().split("\n").slice(0, 3).join(" | "));

reset();
type("qwen");
check("typing filters the list", !screen().includes("kimi-k3"), screen());
check("and shows the query in the field", /⌕ qwen/.test(screen()), screen().split("\n").slice(0, 3).join(" | "));
check("with a matched/total counter", /3\/5/.test(screen()), screen().split("\n").slice(0, 3).join(" | "));

reset();
type(" max");
check("every word has to match, in any order", /2\/5/.test(screen()), screen().split("\n").slice(0, 3).join(" | "));
check("so the coder model is gone", !screen().includes("coder"), screen());
check("and the two max models stay", screen().includes("qwen3.8-max") && screen().includes("qwen3.7-max"), screen());

reset();
type(CTRL_U);
check("^U clears the search", screen().includes("kimi-k3"), screen());

reset();
type("k3");
type("\r");
const value = await chosen;
check("Enter returns the full id, prefix and all", value === "moonshotai/kimi-k3", String(value));

// A model that answers in text and can also return an image belongs under both
// types. Filed under one only, a provider whose image models all speak text too
// — OpenRouter — shows no Images section at all.
{
  const { groupByModality, servesModality } = await import("../dist/provider/models.js");
  const cat = [
    { id: "a/chat", modality: "text", modalities: ["text"] },
    { id: "a/pic-and-chat", modality: "text", modalities: ["image", "text"] },
    { id: "a/pic-only", modality: "image", modalities: ["image"] },
    { id: "a/legacy", modality: "audio" },
  ];
  const by = Object.fromEntries(groupByModality(cat).map((g) => [g.key, g.models.map((m) => m.id)]));
  check("a chat model stays in text", by.text.includes("a/chat"), JSON.stringify(by));
  check("a text+image model is in both", by.text.includes("a/pic-and-chat") && by.image.includes("a/pic-and-chat"), JSON.stringify(by));
  check("an image-only model is only there", !by.text.includes("a/pic-only") && by.image.includes("a/pic-only"), JSON.stringify(by));
  check("a model with no list keeps its one type", by.audio.includes("a/legacy"), JSON.stringify(by));
  check("servesModality agrees", servesModality(cat[1], "image") && !servesModality(cat[0], "image"));
}

// Choosing several: Space marks, Enter confirms. With nothing marked, Enter
// still answers with the row under the cursor — one list, both jobs.
{
  const { pickMulti } = await import("../dist/ui/picker.js");
  reset();
  const many = pickMulti({ title: "Models", items, selected: [] });
  type("qwen");
  type(" ");            // mark the row under the cursor
  type(ESC + "[B");     // down
  type(" ");            // and the next one
  check("marked rows show a box", screen().includes("[x]"), screen().split(NL).slice(0, 8).join(" | "));
  type(CR);
  const picked = await many;
  check("Enter returns everything marked", Array.isArray(picked) && picked.length === 2, JSON.stringify(picked));
  check("and returns full ids", Array.isArray(picked) && picked.every((id) => id.startsWith("alibabacloud:")), JSON.stringify(picked));
}

{
  const { pickMulti } = await import("../dist/ui/picker.js");
  reset();
  const one = pickMulti({ title: "Models", items });
  type("kimi");
  type(CR);
  const picked = await one;
  check("nothing marked — the cursor row answers", JSON.stringify(picked) === JSON.stringify(["moonshotai/kimi-k3"]), JSON.stringify(picked));
}

// ── the panel: a frame, buttons, and the keys that reach them ──────────────

const { openModal } = await import("../dist/ui/picker.js");
const TAB = String.fromCharCode(9);
const SHIFT_TAB = ESC + "[Z";
const ACTIONS = [
  { id: "refresh", label: "Refresh" },
  { id: "scope", label: "All providers" },
  { id: "wipe", label: "Delete", tone: "danger", disabled: true },
];

// The chrome: a titled frame around everything, and the buttons inside it.
{
  reset();
  const m = openModal({ title: "Models", subtitle: "one line about it", items, actions: ACTIONS });
  const s = screen();
  check("the panel is a bordered frame", /╭─/.test(s) && /╰/.test(s), s.split(NL)[0]);
  check("the title sits in the border", /╭─ Models/.test(s), s.split(NL)[0]);
  check("the subtitle is under it", s.includes("one line about it"));
  check("the buttons are drawn", s.includes("Refresh") && s.includes("All providers"), s);
  check("and are numbered, so alt+№ is visible", /1 Refresh/.test(s) && /2 All providers/.test(s), s);
  type(ESC);
  await m;
}

// Every row of the frame is the same width — an off-by-one shows as a ragged
// right edge, which is exactly what a border is for.
{
  reset();
  const m = openModal({ title: "Models", items, actions: ACTIONS });
  const rows = screen().split(NL).filter((l) => /[╭│├╰]/.test(l));
  const widths = new Set(rows.map((l) => [...l.trimEnd()].length));
  check("every frame row is the same width", widths.size === 1, JSON.stringify([...widths]));
  type(ESC);
  await m;
}

// Tab hands the keyboard to the buttons; Enter there runs one.
{
  reset();
  const m = openModal({ title: "Models", items, actions: ACTIONS });
  type(TAB);
  check("Tab moves the focus to the buttons", /Enter run|Enter выполнить/.test(screen()), screen().split(NL).slice(-3).join(" | "));
  type(CR);
  const res = await m;
  check("Enter on a button returns that action", res?.kind === "action" && res.id === "refresh", JSON.stringify(res));
  check("and carries the row under the cursor", res?.value === "alibabacloud:qwen3.8-max", JSON.stringify(res));
}

// Alt+number reaches a button from the list, where typing is search.
{
  reset();
  const m = openModal({ title: "Models", items, actions: ACTIONS });
  type("qwen");
  type(ESC + "2");
  const res = await m;
  check("alt+2 runs the second button", res?.kind === "action" && res.id === "scope", JSON.stringify(res));
}

// A disabled button is shown but never reached.
{
  reset();
  const m = openModal({ title: "Models", items, actions: ACTIONS });
  type(ESC + "3");
  let settled = false;
  m.then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  check("a disabled button does not fire", !settled);
  type(TAB);
  type(TAB);
  type(TAB);
  check("and Tab skips past it back to the list", /Enter select|Enter выбрать/.test(screen()), screen().split(NL).slice(-3).join(" | "));
  type(ESC);
  await m;
}

// Shift+Tab walks the buttons the other way.
{
  reset();
  const m = openModal({ title: "Models", items, actions: ACTIONS });
  type(SHIFT_TAB);
  type(CR);
  const res = await m;
  check("shift+Tab lands on the last usable button", res?.kind === "action" && res.id === "scope", JSON.stringify(res));
}

// A read-only panel reports: no cursor on the rows, Enter closes it.
{
  reset();
  const m = openModal({ title: "Usage", items, readOnly: true, notes: ["totals go here"], search: false });
  const s = screen();
  check("notes are drawn above the list", s.includes("totals go here"), s);
  check("a read-only panel shows no cursor", !s.includes("❯"), s);
  check("and says the arrows scroll", /scroll|прокрутка/.test(s), s.split(NL).slice(-3).join(" | "));
  type(CR);
  const res = await m;
  check("Enter closes it rather than answering", res === null, JSON.stringify(res));
}

// "Nothing marked" is a real answer where the caller says it is.
{
  const { pickMulti } = await import("../dist/ui/picker.js");
  reset();
  const m = pickMulti({ title: "Models", items, selected: ["alibabacloud:qwen3.8-max"], allowEmpty: true });
  type(" ");             // unmark the one that was marked
  type(CR);
  const picked = await m;
  check("allowEmpty returns an empty set, not the cursor row", JSON.stringify(picked) === "[]", JSON.stringify(picked));
}

// ── the page window: walk rows inside it, slide only at an edge ────────────
// Long list (two sections), more rows than a default 14-row page.
const longItems = [];
for (let v = 0; v < 3; v++) {
  longItems.push({ value: `__V${v}`, label: "", header: `Vendor ${v}` });
  for (let n = 0; n < 8; n++) longItems.push({ value: `v${v}:m${n}`, label: `m${v}-${n}` });
}

{
  const DOWN2 = ESC + "[B";
  // The picker repaints by clearing down and redrawing, so the visible frame
  // is what follows the last clear. screen() has already stripped the escape
  // letters, and every redraw begins with the bare ESC byte + "[19A"-style
  // moves; split on "❯ m" is unreliable, so track the first drawn LIST line —
  // a section heading or a model row — of the LAST frame via the footer-less
  // tail: everything from the last "── Vendor"/model line that sits above
  // the cursor row.
  const frames = (s) => s.split(NL);
  const body = (s) => {
    const lines = frames(s);
    const at = lines.map((l, i) => (l.includes("╭─") ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
    return lines.slice(at).filter((l) => /│\s+(❯|\s*m\d|──)/.test(l));
  };
  const firstRow = () => body(screen())[0] ?? "";

  reset();
  const m = openModal({ title: "Models", items: longItems, search: false });
  const topAtStart = firstRow();
  type(DOWN2); type(DOWN2);
  check("walking down keeps the top row fixed", firstRow() === topAtStart,
    `${JSON.stringify(topAtStart)} -> ${JSON.stringify(firstRow())}`);
  // Walk to the bottom of the list and back: the page slides off its initial
  // section heading long before row 27 is under the cursor.
  for (let i = 0; i < 26; i++) type(DOWN2);
  const topAtBottom = firstRow();
  check("past the bottom edge the window slides", topAtBottom !== topAtStart,
    `top still ${JSON.stringify(topAtBottom)}`);
  // And walking back up must land exactly on the first row again.
  const UP2 = ESC + "[A";
  for (let i = 0; i < 26; i++) type(UP2);
  check("walking back up restores the cursor row", screen().includes("❯ m0-0"));
  type(ESC);
  await m;

  // Cursor stays put when a repaint happens with the same items.
  reset();
  const m2 = openModal({ title: "Models", items: longItems, search: false });
  type(DOWN2); type(DOWN2);
  const cursorBefore = body(screen()).findIndex((l) => l.includes("❯"));
  type("\x0c"); // any unknown control — no movement
  check("a repaint without changes keeps the cursor line", body(screen()).findIndex((l) => l.includes("❯")) === cursorBefore);
  type(ESC);
  await m2;
}

say("");
say(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
