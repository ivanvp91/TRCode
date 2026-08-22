/**
 * Snapshots around a shell command.
 *
 * The file tools hand their own before-and-after to the checkpoint store, so
 * `/rewind` can undo them exactly. A shell command cannot be read that way —
 * nothing short of running it says what it will touch. What it does say is
 * which files it *names*: `sed -i … src/app.ts`, `> config.json`, `mv a b`,
 * `rm old.txt`. Those are the ones this module reads before the command runs
 * and compares afterwards, recording the ones that actually changed.
 *
 * Deliberately partial, and the prompt says so: a recursive `find -delete` or a
 * path built inside a script is outside it. Better a narrow guarantee that
 * holds than a broad one that quietly does not.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { looksBinary } from "./fsutil.js";
import type { ToolContext } from "../types.js";

/** Above this a snapshot costs more than the undo is worth. */
const MAX_BYTES = 4_000_000;
/** A command naming more files than this is a sweep — out of scope by design. */
const MAX_FILES = 50;

/** What a watched file held before the command ran; null when it did not exist. */
export interface Watched {
  abs: string;
  before: string | null;
}

/**
 * Splits a command into candidate operands: quoted strings survive as one
 * token, redirection targets are pulled out of `>file` as well as `> file`.
 */
export function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  // Redirections often sit flush against their target; give it its own token.
  const spaced = command.replace(/([<>]{1,2})/g, " $1 ");
  const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(spaced))) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  return tokens.filter(Boolean);
}

/** Whether a token could be a path in this project rather than a flag or an expression. */
function looksLikePath(token: string): boolean {
  if (token.startsWith("-")) return false; // a flag
  if (/^[<>|&;()]+$/.test(token)) return false; // shell punctuation
  if (/[*?[\]{}$`]/.test(token)) return false; // a glob or an expansion: too wide to guess
  if (/^[a-z]+:\/\//i.test(token)) return false; // a URL
  // `s/old/new/` and friends read as paths otherwise.
  if (/^s\/.*\/.*\/[a-z]*$/i.test(token)) return false;
  return /[./\\]/.test(token) || token.includes("_");
}

/** Resolves a token to a path inside the project, or null when it escapes it. */
function inside(cwd: string, token: string): string | null {
  const abs = path.resolve(cwd, token);
  const rel = path.relative(cwd, abs);
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? abs : null;
}

/**
 * Reads the files a command names, before it runs. Files that are too big or
 * not text are skipped: they are recorded neither here nor after, so nothing
 * later claims they can be restored.
 */
export async function watchTargets(command: string, cwd: string): Promise<Watched[]> {
  const seen = new Set<string>();
  const watched: Watched[] = [];

  for (const token of commandTokens(command)) {
    if (watched.length >= MAX_FILES) break;
    if (!looksLikePath(token)) continue;
    const abs = inside(cwd, token);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);

    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(abs);
    } catch {
      // Not there yet: the command may be about to create it, and a rewind
      // then means deleting it again.
      watched.push({ abs, before: null });
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    try {
      const buf = await fsp.readFile(abs);
      if (looksBinary(buf)) continue;
      watched.push({ abs, before: buf.toString("utf8") });
    } catch {
      /* unreadable — leave it out rather than promise an undo */
    }
  }
  return watched;
}

/**
 * Records the watched files the command actually changed. Untouched files are
 * skipped, so a `grep` over a source tree adds nothing to the log.
 */
export async function recordChanges(ctx: ToolContext, watched: Watched[]): Promise<void> {
  if (!ctx.snapshot) return;
  for (const w of watched) {
    let after: string | null = null;
    try {
      const buf = await fsp.readFile(w.abs);
      // A command that turned a text file into a binary one is not something
      // this store can put back byte-for-byte; leave it alone.
      after = looksBinary(buf) ? null : buf.toString("utf8");
    } catch {
      after = null; // gone, or never created
    }
    if (after === w.before) continue;
    if (after === null && w.before === null) continue;
    // A deleted file has no "after"; the empty string is what the log stores,
    // and the restore path only ever reads `before`.
    ctx.snapshot({ path: w.abs, tool: "shell", before: w.before, after: after ?? "" });
  }
}
