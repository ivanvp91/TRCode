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
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*[A-Za-z]", "g"), "");
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

say("");
say(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
