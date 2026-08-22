/**
 * File checkpoints: what a turn did to the working tree, and how to put it back.
 *
 * The agent edits files in place — there is no staging area between it and the
 * user's work. A turn that misread the task can rewrite half a dozen files
 * before anyone notices, and without git (or with the changes not yet staged)
 * the previous content is simply gone. So every write goes through here first:
 * the old bytes are stored, keyed by content hash, and the log records which
 * turn touched what.
 *
 * Deliberately not git: it must work in a directory that is not a repository,
 * and it must not touch the user's index, branches or stash — those are theirs.
 *
 * The store lives beside the session file and dies with it. It only sees writes
 * made through the file tools; something the model does with `shell` is outside
 * it, the same way it is outside the diff preview.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../config.js";
import type { Session } from "./session.js";

/** Beyond this a snapshot costs more disk than the undo is worth. */
const MAX_SNAPSHOT_BYTES = 4_000_000;

/** A turn boundary: everything logged after it belongs to that turn. */
interface TurnEntry {
  kind: "turn";
  turn: number;
  ts: number;
  /** Messages in the session when the turn began — where a rewind cuts. */
  at: number;
  /** What the user asked, for the picker. */
  prompt: string;
}

/** One write, with the file's content before and after it. */
interface EditEntry {
  kind: "edit";
  turn: number;
  ts: number;
  /** Relative to the session's cwd, so a moved project still reads. */
  path: string;
  tool: string;
  /** Hash of the content before the write; null when the file did not exist. */
  before: string | null;
  /** Hash of the content written, to notice later edits made outside us. */
  after: string;
  /** Set when the file was too big to store: the entry is a record, not an undo. */
  oversize?: boolean;
}

type Entry = TurnEntry | EditEntry;

export interface Checkpoint {
  turn: number;
  ts: number;
  at: number;
  prompt: string;
  /** Files this turn and every later one touched — what a rewind would restore. */
  files: string[];
}

export interface RewindResult {
  restored: string[];
  deleted: string[];
  /** Files whose current content is not what we wrote — changed behind our back. */
  diverged: string[];
  failed: string[];
}

function storeDir(session: Session): string {
  return path.join(sessionsDir(session.cwd), `${session.id}.files`);
}

function logFile(session: Session): string {
  return path.join(storeDir(session), "log.jsonl");
}

function blobFile(session: Session, hash: string): string {
  return path.join(storeDir(session), "blobs", hash);
}

function hashOf(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function append(session: Session, entry: Entry): void {
  try {
    fs.mkdirSync(path.join(storeDir(session), "blobs"), { recursive: true });
    fs.appendFileSync(logFile(session), JSON.stringify(entry) + "\n");
  } catch {
    /* a checkpoint is insurance, never a reason to fail the write */
  }
}

function readLog(session: Session): Entry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logFile(session), "utf8");
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch {
      /* a half-written last line after a hard kill */
    }
  }
  return out;
}

/** The turn a write belongs to: the last one opened, or 0 before any. */
function currentTurn(session: Session): number {
  const log = readLog(session);
  for (let i = log.length - 1; i >= 0; i--) if (log[i].kind === "turn") return (log[i] as TurnEntry).turn;
  return 0;
}

/**
 * Opens a checkpoint. Called as a turn starts, before the prompt is added to
 * the history, so `at` is exactly where a rewind of the conversation cuts.
 */
export function markTurn(session: Session, prompt: string): void {
  append(session, {
    kind: "turn",
    turn: currentTurn(session) + 1,
    ts: Date.now(),
    at: session.messages.length,
    prompt: prompt.replace(/\s+/g, " ").trim().slice(0, 200),
  });
}

/**
 * Records a write. `before` is null for a file being created; the content is
 * stored by hash, so rewriting the same file ten times costs one copy per
 * distinct version.
 */
export function recordWrite(
  session: Session,
  opts: { path: string; tool: string; before: string | null; after: string },
): void {
  const beforeBuf = opts.before === null ? null : Buffer.from(opts.before, "utf8");
  const afterBuf = Buffer.from(opts.after, "utf8");
  const oversize = (beforeBuf?.length ?? 0) > MAX_SNAPSHOT_BYTES;

  let beforeHash: string | null = null;
  if (beforeBuf && !oversize) {
    beforeHash = hashOf(beforeBuf);
    const dest = blobFile(session, beforeHash);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Content-addressed: the same bytes are only ever stored once.
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, beforeBuf);
    } catch {
      beforeHash = null;
    }
  }

  append(session, {
    kind: "edit",
    turn: currentTurn(session),
    ts: Date.now(),
    path: relPath(session, opts.path),
    tool: opts.tool,
    before: beforeHash,
    after: hashOf(afterBuf),
    ...(oversize ? { oversize: true } : {}),
  });
}

function relPath(session: Session, abs: string): string {
  const r = path.relative(session.cwd, abs);
  return r && !r.startsWith("..") ? r.split(path.sep).join("/") : abs;
}

function absPath(session: Session, p: string): string {
  return path.isAbsolute(p) ? p : path.join(session.cwd, p.split("/").join(path.sep));
}

/**
 * Turns that changed files, newest first. A turn that only talked has nothing
 * to restore and is left out — offering it would be offering a no-op.
 */
export function listCheckpoints(session: Session): Checkpoint[] {
  const log = readLog(session);
  const turns: Checkpoint[] = [];
  for (const e of log) {
    if (e.kind === "turn") turns.push({ turn: e.turn, ts: e.ts, at: e.at, prompt: e.prompt, files: [] });
  }
  // A rewind to turn N undoes N and everything after it, so the file list of a
  // checkpoint is cumulative from it onwards.
  for (const e of log) {
    if (e.kind !== "edit") continue;
    for (const t of turns) {
      if (e.turn >= t.turn && !t.files.includes(e.path)) t.files.push(e.path);
    }
  }
  return turns.filter((t) => t.files.length).reverse();
}

/** Whether this session has anything to rewind to. */
export function hasCheckpoints(session: Session): boolean {
  return listCheckpoints(session).length > 0;
}

/**
 * Puts every file back to how it was before `turn` ran. The earliest snapshot
 * at or after that turn is the one to restore: later ones are states the turn
 * itself produced.
 */
export function rewindFiles(session: Session, turn: number): RewindResult {
  const log = readLog(session);
  const result: RewindResult = { restored: [], deleted: [], diverged: [], failed: [] };
  const first = new Map<string, EditEntry>();
  const last = new Map<string, EditEntry>();
  for (const e of log) {
    if (e.kind !== "edit" || e.turn < turn) continue;
    if (!first.has(e.path)) first.set(e.path, e);
    last.set(e.path, e);
  }

  for (const [rel, entry] of first) {
    const abs = absPath(session, rel);
    // What we last wrote there. If the file no longer matches it, someone else
    // has edited it since — restoring still happens, but it is worth saying.
    const latest = last.get(rel);
    try {
      const now = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
      if (now && latest && hashOf(now) !== latest.after) result.diverged.push(rel);
    } catch {
      /* unreadable now, still worth trying to restore */
    }

    if (entry.oversize) {
      result.failed.push(rel);
      continue;
    }
    try {
      if (entry.before === null) {
        // The turn created it; going back means it should not exist.
        if (fs.existsSync(abs)) fs.rmSync(abs);
        result.deleted.push(rel);
        continue;
      }
      const blob = fs.readFileSync(blobFile(session, entry.before));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, blob);
      result.restored.push(rel);
    } catch {
      result.failed.push(rel);
    }
  }
  return result;
}

/**
 * Drops the log entries a rewind undid, so the next one does not offer the
 * same turns again. Their blobs stay: they are shared by hash and go with the
 * session.
 */
export function forgetFrom(session: Session, turn: number): void {
  const kept = readLog(session).filter((e) => e.turn < turn);
  try {
    fs.writeFileSync(logFile(session), kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
  } catch {
    /* leaving the log alone only means an extra entry in the picker */
  }
}

/** Removes a session's snapshots. Called when the session itself is deleted. */
export function dropStore(cwd: string, sessionId: string): void {
  try {
    fs.rmSync(path.join(sessionsDir(cwd), `${sessionId}.files`), { recursive: true, force: true });
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Drops snapshot stores whose session file is gone — sessions deleted by an
 * older build, or by hand. Without this the blobs would sit there forever with
 * nothing able to reach them.
 */
export function pruneOrphanStores(cwd: string): number {
  const dir = sessionsDir(cwd);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".files"));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const n of names) {
    const id = n.slice(0, -".files".length);
    if (fs.existsSync(path.join(dir, `${id}.json`))) continue;
    try {
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      removed++;
    } catch {
      /* leave anything locked alone */
    }
  }
  return removed;
}
