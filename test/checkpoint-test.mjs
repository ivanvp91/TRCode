/**
 * File checkpoints: the agent's writes are snapshotted before they land, and a
 * turn can be put back. The parts that matter are the ones that lose work when
 * they are wrong — restoring the *earliest* state at or after the chosen turn,
 * deleting files the turn created, and noticing content changed behind our back.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-ckpt-home-"));
process.env.TRCODE_HOME = HOME;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-ckpt-work-"));

const { Session } = await import("../dist/session/session.js");
const {
  markTurn,
  recordWrite,
  listCheckpoints,
  rewindFiles,
  forgetFrom,
  dropStore,
  pruneOrphanStores,
} = await import("../dist/session/checkpoint.js");
const { writeTool, editTool } = await import("../dist/tools/files.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const file = (name) => path.join(WORK, name);
const read = (name) => fs.readFileSync(file(name), "utf8");
const session = new Session({ cwd: WORK, model: "m", title: "t" });

// A write goes through the tool, so the wiring is exercised, not just the store.
const ctx = {
  cwd: WORK,
  signal: new AbortController().signal,
  depth: 0,
  confirm: async () => true,
  snapshot: (opts) => recordWrite(session, opts),
  emit: () => {},
  readFiles: new Set(),
};

// ── turn 1: create one file, change another ─────────────────────────────────
fs.writeFileSync(file("kept.txt"), "original\n");
ctx.readFiles.add(file("kept.txt"));

session.messages.push({ role: "user", content: "first" });
markTurn(session, "add a greeting");
await writeTool.run({ path: file("new.txt"), content: "created by turn 1\n" }, ctx);
await editTool.run({ path: file("kept.txt"), old_string: "original", new_string: "turn 1" }, ctx);

check("the write landed", read("new.txt") === "created by turn 1\n");
check("the edit landed", read("kept.txt") === "turn 1\n");

// ── turn 2: change the same file again ──────────────────────────────────────
session.messages.push({ role: "assistant", content: "done" }, { role: "user", content: "second" });
markTurn(session, "change it again");
await editTool.run({ path: file("kept.txt"), old_string: "turn 1", new_string: "turn 2" }, ctx);

{
  const points = listCheckpoints(session);
  check("both turns are offered, newest first", points.length === 2 && points[0].turn === 2, JSON.stringify(points.map((p) => p.turn)));
  check("the newest turn lists what it touched", points[0].files.join() === "kept.txt", JSON.stringify(points[0].files));
  // A rewind to turn 1 undoes turn 2 as well, so its file list is cumulative.
  check(
    "an earlier turn lists everything from it onwards",
    points[1].files.slice().sort().join() === "kept.txt,new.txt",
    JSON.stringify(points[1].files),
  );
  check("a checkpoint remembers where the history was", points[1].at === 1, String(points[1].at));
}

// ── rewinding the last turn only ────────────────────────────────────────────
{
  const res = rewindFiles(session, 2);
  check("the second turn's edit is undone", read("kept.txt") === "turn 1\n", read("kept.txt"));
  check("the first turn's file is left alone", fs.existsSync(file("new.txt")));
  check("the report names what came back", res.restored.join() === "kept.txt", JSON.stringify(res));
  forgetFrom(session, 2);
  check("an undone turn is not offered again", listCheckpoints(session).length === 1, JSON.stringify(listCheckpoints(session)));
}

// ── rewinding to the first turn: back to before anything ────────────────────
{
  const res = rewindFiles(session, 1);
  check("the file is back to its pre-session content", read("kept.txt") === "original\n", read("kept.txt"));
  check("a file the turn created is removed", !fs.existsSync(file("new.txt")));
  check("the report separates removals from restores", res.deleted.join() === "new.txt" && res.restored.join() === "kept.txt", JSON.stringify(res));
}

// ── content changed outside the session ─────────────────────────────────────
{
  const s2 = new Session({ cwd: WORK, model: "m", title: "t2" });
  const ctx2 = { ...ctx, snapshot: (o) => recordWrite(s2, o) };
  fs.writeFileSync(file("hand.txt"), "before\n");
  ctx2.readFiles.add(file("hand.txt"));
  markTurn(s2, "touch it");
  await editTool.run({ path: file("hand.txt"), old_string: "before", new_string: "by agent" }, ctx2);
  // The user edits it themselves afterwards.
  fs.writeFileSync(file("hand.txt"), "by hand\n");

  const res = rewindFiles(s2, 1);
  check("a file changed since is flagged", res.diverged.join() === "hand.txt", JSON.stringify(res));
  check("it is still restored", read("hand.txt") === "before\n", read("hand.txt"));
  dropStore(WORK, s2.id);
}

// ── a turn that only talked is not offered ──────────────────────────────────
{
  const s3 = new Session({ cwd: WORK, model: "m", title: "t3" });
  markTurn(s3, "just a question");
  check("a turn with no writes has nothing to rewind to", listCheckpoints(s3).length === 0);
  dropStore(WORK, s3.id);
}

// ── shell: what the command names is snapshotted ────────────────────────────
{
  const { commandTokens } = await import("../dist/tools/shellsnap.js");
  const { shellTool } = await import("../dist/tools/shell.js");

  check(
    "a redirect target is its own token",
    commandTokens("echo hi >out.txt").includes("out.txt"),
    JSON.stringify(commandTokens("echo hi >out.txt")),
  );
  check(
    "quoted paths survive as one token",
    commandTokens(`sed -i "" 'my file.txt'`).includes("my file.txt"),
    JSON.stringify(commandTokens(`sed -i "" 'my file.txt'`)),
  );

  const s4 = new Session({ cwd: WORK, model: "m", title: "t4" });
  const ctx4 = { ...ctx, readFiles: new Set(), snapshot: (o) => recordWrite(s4, o) };
  fs.writeFileSync(file("script.txt"), "keep me\n");
  markTurn(s4, "run a command");

  // A helper script rather than `node -e`: quoting a one-liner differs between
  // PowerShell and bash, and this suite runs on both.
  fs.writeFileSync(
    file("writer.mjs"),
    'import fs from "node:fs";\nfs.writeFileSync(process.argv[2], process.argv[3] + "\\n");\n',
  );
  const q = (s) => JSON.stringify(s);
  const run = (target, text) =>
    shellTool.run({ command: `node ${q(file("writer.mjs"))} ${q(target)} ${text}` }, ctx4);

  const first = await run(file("script.txt"), "clobbered");
  await run(file("born.txt"), "new");

  check("shell overwrote the file", read("script.txt") === "clobbered\n", first.output);
  const points = listCheckpoints(s4);
  check(
    "both files are in the checkpoint",
    points.length === 1 && points[0].files.slice().sort().join() === "born.txt,script.txt",
    JSON.stringify(points),
  );

  rewindFiles(s4, 1);
  check("a shell overwrite is undone", read("script.txt") === "keep me\n", read("script.txt"));
  check("a file shell created is removed", !fs.existsSync(file("born.txt")));
  dropStore(WORK, s4.id);
}

// ── a read-only command logs nothing ────────────────────────────────────────
{
  const { shellTool } = await import("../dist/tools/shell.js");
  const s5 = new Session({ cwd: WORK, model: "m", title: "t5" });
  const ctx5 = { ...ctx, readFiles: new Set(), snapshot: (o) => recordWrite(s5, o) };
  fs.writeFileSync(file("quiet.txt"), "untouched\n");
  markTurn(s5, "look at it");
  const q = (s) => JSON.stringify(s);
  fs.writeFileSync(file("reader.mjs"), 'import fs from "node:fs";\nfs.readFileSync(process.argv[2]);\n');
  await shellTool.run(
    { command: `node ${q(file("reader.mjs"))} ${q(file("quiet.txt"))}` },
    ctx5,
  );
  check("reading a file through shell records nothing", listCheckpoints(s5).length === 0, JSON.stringify(listCheckpoints(s5)));
  dropStore(WORK, s5.id);
}

// ── housekeeping ────────────────────────────────────────────────────────────
{
  const { sessionsDir } = await import("../dist/config.js");
  const dir = sessionsDir(WORK);
  check("the store sits beside the session file", fs.existsSync(path.join(dir, `${session.id}.files`)));
  // The session was never saved, so its store is an orphan.
  check("orphaned stores are cleaned up", pruneOrphanStores(WORK) >= 1);
  check("nothing is left behind", !fs.existsSync(path.join(dir, `${session.id}.files`)));
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
