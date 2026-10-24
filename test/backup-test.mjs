/**
 * Plain copies of everything the agent overwrites, kept in the project's own
 * .tmp/ and dropped with the session. The parts that matter are the ones that
 * lose a file when they are wrong: the copy must hold the *old* bytes, it must
 * survive a failed write attempt, and it must go away exactly when the session
 * it belongs to is deleted — not earlier (a resumed session still needs it) and
 * not later (nothing else would ever claim it).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-backup-home-"));
process.env.TRCODE_HOME = HOME;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "trc-backup-work-"));

const { Session } = await import("../dist/session/session.js");
const { recordWrite, markTurn } = await import("../dist/session/checkpoint.js");
const { backupBefore, backupDir, backupRoot, dropSessionBackups, pruneOrphanBackups } = await import("../dist/session/backups.js");
const { writeTool, editTool } = await import("../dist/tools/files.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const file = (...parts) => path.join(WORK, ...parts);
const session = new Session({ cwd: WORK, model: "m", title: "t" });
const dir = backupDir(WORK, session.id);
const copies = () => {
  const out = [];
  const walk = (from) => {
    let entries = [];
    try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(from, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
};
const ctx = {
  cwd: WORK,
  signal: new AbortController().signal,
  depth: 0,
  confirm: async () => true,
  snapshot: (opts) => recordWrite(session, opts),
  emit: () => {},
  readFiles: new Set(),
};

// ── an edit leaves the bytes it replaced, in the project's own .tmp/ ─────────
fs.writeFileSync(file("kept.txt"), "original\n");
ctx.readFiles.add(file("kept.txt"));
markTurn(session, "change it");
await editTool.run({ path: file("kept.txt"), old_string: "original", new_string: "changed" }, ctx);

check("the edit landed", fs.readFileSync(file("kept.txt"), "utf8") === "changed\n");
check("the copy lives in the project's .tmp", dir === file(".tmp", "agent-backups", session.id), dir);
let list = copies();
check("one copy per edit", list.length === 1, JSON.stringify(list));
check("the copy keeps the file's own path", list[0].startsWith("kept.txt."), list[0]);
check("the copy holds the old bytes, not the new", fs.readFileSync(path.join(dir, list[0]), "utf8") === "original\n");

// ── a nested path keeps its shape, and a repeat is not duplicated ───────────
fs.mkdirSync(file("src", "deep"), { recursive: true });
fs.writeFileSync(file("src", "deep", "mod.ts"), "export const a = 1;\n");
ctx.readFiles.add(file("src", "deep", "mod.ts"));
await writeTool.run({ path: file("src", "deep", "mod.ts"), content: "export const a = 2;\n" }, ctx);
list = copies();
check("a nested file keeps its directory", list.some((p) => p.startsWith("src/deep/mod.ts.")), JSON.stringify(list));

// The same bytes seen twice should cost one copy: an editor that rewrites the
// file it just read must not fill .tmp with identical versions.
const before = fs.readFileSync(file("src", "deep", "mod.ts"), "utf8");
const counted = copies().length;
backupBefore(session, file("src", "deep", "mod.ts"), before);
const afterFirst = copies().length;
backupBefore(session, file("src", "deep", "mod.ts"), before);
check("a new version is copied once", afterFirst === counted + 1, JSON.stringify(copies()));
check("identical bytes are not copied twice", copies().length === afterFirst, JSON.stringify(copies()));

// ── nothing worth keeping ──────────────────────────────────────────────────
await writeTool.run({ path: file("fresh.txt"), content: "brand new\n" }, ctx);
check("a created file leaves no copy", !copies().some((p) => p.startsWith("fresh.txt.")));

fs.writeFileSync(file("empty.txt"), "");
ctx.readFiles.add(file("empty.txt"));
backupBefore(session, file("empty.txt"), "");
check("an empty file leaves no copy", !copies().some((p) => p.startsWith("empty.txt.")));

fs.writeFileSync(path.join(WORK, "..", "outside.txt"), "outside\n");
check("a file outside the project is skipped", backupBefore(session, path.resolve(WORK, "..", "outside.txt"), "outside\n") === null);

fs.writeFileSync(file(".tmp", "scratch.txt"), "scratch\n");
check("editing scratch leaves no scratch of scratch", backupBefore(session, file(".tmp", "scratch.txt"), "scratch\n") === null, JSON.stringify(copies()));

check("an oversized file is skipped", backupBefore(session, file("big.txt"), "x".repeat(4_000_001)) === null);

// ── two copies inside the same second ───────────────────────────────────────
{
  const at = Date.now();
  const first = backupBefore(session, file("rapid.txt"), "one\n", at);
  let second = backupBefore(session, file("rapid.txt"), "two\n", at);
  // backupBefore skips only when the bytes match the newest copy; "two" differs
  // from "one", so a second name has to be invented rather than overwriting it.
  check("same-second copies do not overwrite each other", Boolean(first && second && first !== second), `${first} / ${second}`);
  check("the second copy keeps its own bytes", fs.readFileSync(second, "utf8") === "two\n");
}

// ── a failed backup never refuses the write the user agreed to ──────────────
{
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), "trc-backup-blocked-"));
  fs.writeFileSync(path.join(blocked, ".tmp"), "not a directory\n");
  const s2 = new Session({ cwd: blocked, model: "m", title: "blocked" });
  let refused = null;
  try { recordWrite(s2, { path: path.join(blocked, "a.txt"), tool: "write", before: "old\n", after: "new\n" }); }
  catch (err) { refused = err; }
  check("a blocked .tmp does not refuse the write", refused === null, String(refused));
}

// ── the copies die with the session ─────────────────────────────────────────
{
  // A session of its own: the sweep counts what it removed, so nothing else may
  // be sitting in the same .tmp/agent-backups.
  const pruned = fs.mkdtempSync(path.join(os.tmpdir(), "trc-backup-prune-"));
  const alive = new Session({ cwd: pruned, model: "m", title: "alive" });
  alive.messages.push({ role: "user", content: "hello" });
  alive.save();
  const gone = new Session({ cwd: pruned, model: "m", title: "gone" });
  const kept = backupBefore(alive, path.join(pruned, "alive.txt"), "alive\n");
  const lost = backupBefore(gone, path.join(pruned, "orphan.txt"), "orphan\n");
  check("both sessions got copies", Boolean(kept && lost && fs.existsSync(backupDir(pruned, alive.id)) && fs.existsSync(backupDir(pruned, gone.id))));

  check("a session with no file is swept", pruneOrphanBackups(pruned) === 1 && !fs.existsSync(backupDir(pruned, gone.id)));
  check("a live session keeps its copies", fs.existsSync(backupDir(pruned, alive.id)));

  dropSessionBackups(pruned, alive.id);
  check("deleting the session deletes its copies", !fs.existsSync(backupDir(pruned, alive.id)));
}

// ── deleting a session in the project that still has other copies ───────────
{
  const live = Session.list(WORK).map((m) => m.id);
  const unknown = "00000000-0000-4000-8000-000000000000";
  backupBefore(session, file("mine.txt"), "mine\n");
  dropSessionBackups(WORK, unknown);
  check("deleting an unknown session leaves the rest alone", fs.existsSync(dir), String(live.length) + " sessions");
  dropSessionBackups(WORK, session.id);
  check("the last copy takes the empty root with it", !fs.existsSync(dir), dir);
  check("the scratch itself stays", fs.existsSync(file(".tmp")));
}

console.log(failed ? `\n${failed} failed, ${passed} passed` : `${passed} passed, 0 failed`);
process.exit(failed ? 1 : 0);
