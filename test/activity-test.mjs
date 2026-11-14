/**
 * Progress lines above the input.
 *
 * A command that prints nothing says so every ten seconds (the shell's
 * heartbeat). Each copy used to be appended, so a five-minute build left the
 * bar full of identical "Running…" rows and pushed the reasoning preview and
 * everything else out of it. The heartbeat is one line ageing: the newest
 * copy replaces the previous one, while real news — a tail line, a helper's
 * step — keeps stacking.
 */
import { EventEmitter } from "node:events";

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
stdin.resume = () => stdin;
stdin.pause = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

const { App } = await import("../dist/ui/repl.js");
const { HEARTBEAT_MARK } = await import("../dist/tools/shell.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

/** An App with nothing but the pieces progress() touches. */
function fakeApp() {
  const seen = [];
  const app = Object.create(App.prototype);
  Object.assign(app, {
    activityLines: [],
    bar: { setThinking: (lines) => seen.push([...lines]) },
  });
  return { app, seen, say: (text) => App.prototype.progress.call(app, text) };
}

const beat = (elapsed, quiet) => `${HEARTBEAT_MARK}${elapsed} · quiet ${quiet} of 10m 0s)`;

check("the mark is what a heartbeat line starts with", HEARTBEAT_MARK === "Running… (", HEARTBEAT_MARK);

{
  const { app, say, seen } = fakeApp();
  say(beat("1m 0s", "1m 0s"));
  say(beat("2m 0s", "2m 0s"));
  say(beat("3m 0s", "3m 0s"));
  check("three heartbeats leave one line", app.activityLines.length === 1, JSON.stringify(app.activityLines));
  check("and it is the newest one", app.activityLines[0].includes("3m 0s"), app.activityLines[0]);
  check("the bar was redrawn every time", seen.length === 3);
}

{
  const { app, say } = fakeApp();
  say(beat("1m 0s", "1m 0s"));
  say("> Task :app:compileDebugKotlin");
  say(beat("3m 0s", "5s"));
  // Tail lines are news and stay; only the stale heartbeat is dropped, so the
  // newest one sits at the bottom of the block.
  check("a tail line survives a heartbeat", app.activityLines.length === 2, JSON.stringify(app.activityLines));
  check("the tail line is the first of the two", app.activityLines[0].includes("compileDebugKotlin"), app.activityLines[0]);
  check("the heartbeat is the last", app.activityLines[1].startsWith(HEARTBEAT_MARK), app.activityLines[1]);
}

{
  const { app, say } = fakeApp();
  say("line one");
  say("line two");
  check("ordinary progress lines still stack", app.activityLines.length === 2, JSON.stringify(app.activityLines));
}

{
  const { app, say } = fakeApp();
  app.activityLines.push("planner · reading README.md");
  app.activityLines.push("build · running tests");
  say(beat("1m 0s", "1m 0s"));
  say(beat("2m 0s", "2m 0s"));
  check("a helper's steps are not mistaken for heartbeats", app.activityLines.length === 3, JSON.stringify(app.activityLines));
  check("and keep their order", app.activityLines[0].startsWith("planner"), app.activityLines.join(" / "));
}

{
  const { app, say } = fakeApp();
  for (let i = 0; i < 12; i++) say(`progress line ${i}`);
  check("the block still rolls at eight lines", app.activityLines.length === 8, String(app.activityLines.length));
  check("and keeps the newest", app.activityLines.at(-1) === "progress line 11", app.activityLines.at(-1));
}

{
  // A tail line is the child's own writing: rustc links every crate to docs.rs,
  // and a link or an underline left open would be drawn over the bar and stay
  // on after it — a screen of dashed underlines nobody can clear.
  const ESC = String.fromCharCode(27);
  const { app, say } = fakeApp();
  say(
    `${ESC}]8;;https://docs.rs/serde/1.0.0/serde/${ESC}\\serde${ESC}]8;;${ESC}\\ ${ESC}[4mwarning${ESC}[24m`,
  );
  const shown = app.activityLines[0] ?? "";
  check("a hyperlink never reaches the bar", !shown.includes("]8;"), JSON.stringify(shown));
  check(
    "the underlined word is kept, the underline is not",
    shown.includes("warning") && !shown.includes(`${ESC}[4m`),
    JSON.stringify(shown),
  );
}

{
  // The turn that owned the tail is over: with no bar there is nowhere to
  // put the line, and printing it would land on the composer.
  const app = Object.create(App.prototype);
  Object.assign(app, { activityLines: [], bar: null });
  App.prototype.progress.call(app, beat("1m 0s", "1m 0s"));
  App.prototype.progress.call(app, "1s · hello");
  check("nothing is recorded without a bar", app.activityLines.length === 0, JSON.stringify(app.activityLines));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
