/**
 * A plain copy of every file the agent is about to overwrite, kept in the
 * project's own `.tmp/` until the session that made it is deleted.
 *
 * The checkpoint store (checkpoint.ts) is the authority for `/rewind`: content
 * addressed, beside the session file, restored by hash. These copies are the
 * readable counterpart — someone who wants a file back by hand should not have
 * to know where the hashes live, and `.tmp/` is scratch that no project tracks.
 * Like the store, they only see writes made through the file tools; a shell
 * redirect is outside both.
 */
import fs from "node:fs";
import path from "node:path";
import { sessionsDir } from "../config.js";
import type { Session } from "./session.js";

/** Beyond this a copy costs more disk than the rescue is worth. */
const MAX_BACKUP_BYTES = 4_000_000;
/** One name per edit: `logo.ts.20261024-143355`, then `-2` in the same second. */
const SUFFIX = /^\d{8}-\d{6}(-\d+)?$/;

export function backupRoot(cwd: string): string {
  return path.join(cwd, ".tmp", "agent-backups");
}

export function backupDir(cwd: string, sessionId: string): string {
  return path.join(backupRoot(cwd), sessionId);
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function within(cwd: string, abs: string): string | null {
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

function copiesOf(dir: string, name: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.startsWith(name + ".") && SUFFIX.test(file.slice(name.length + 1)))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Copies what the file held before a write. Returns the copy, or null when
 * there is nothing worth keeping — a new file, an empty one, one outside the
 * project, one too large to duplicate, or content already saved as the newest
 * copy. Never throws: a failed backup must not refuse a write the user agreed to.
 */
export function backupBefore(
  session: Session,
  absPath: string,
  before: string | null,
  now = Date.now(),
): string | null {
  if (before === null) return null;
  const bytes = Buffer.from(before, "utf8");
  if (!bytes.length || bytes.length > MAX_BACKUP_BYTES) return null;
  const rel = within(session.cwd, absPath);
  // Editing scratch is not worth scratch of scratch.
  if (!rel || rel.split(path.sep)[0] === ".tmp") return null;
  const target = path.join(backupDir(session.cwd, session.id), rel);
  const dir = path.dirname(target);
  const name = path.basename(target);
  try {
    const existing = copiesOf(dir, name);
    const newest = existing.at(-1);
    if (newest && fs.readFileSync(path.join(dir, newest)).equals(bytes)) return path.join(dir, newest);
    fs.mkdirSync(dir, { recursive: true });
    const taken = stamp(now);
    let copy = path.join(dir, `${name}.${taken}`);
    for (let n = 2; fs.existsSync(copy); n++) copy = path.join(dir, `${name}.${taken}-${n}`);
    fs.writeFileSync(copy, bytes);
    return copy;
  } catch {
    return null;
  }
}

/** Removes a session's copies. Called when the session itself is deleted. */
export function dropSessionBackups(cwd: string, sessionId: string): void {
  try {
    fs.rmSync(backupDir(cwd, sessionId), { recursive: true, force: true });
    // The root is noise in `git status` of a project that does not ignore .tmp.
    if (fs.readdirSync(backupRoot(cwd)).length === 0) fs.rmdirSync(backupRoot(cwd));
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Drops copies whose session file is gone — sessions deleted by an older build
 * or by hand. Without this the copies would sit in the project forever with
 * nothing able to claim them.
 */
export function pruneOrphanBackups(cwd: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(backupRoot(cwd));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const id of names) {
    if (fs.existsSync(path.join(sessionsDir(cwd), `${id}.json`))) continue;
    try {
      fs.rmSync(backupDir(cwd, id), { recursive: true, force: true });
      removed++;
    } catch {
      /* keep going: one stuck directory must not stop the sweep */
    }
  }
  return removed;
}
