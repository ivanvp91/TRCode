/**
 * Input history that survives a restart, per project and per session — the
 * same scoping as sessions themselves, because prompts from one repository
 * are noise in another, and prompts from another session are noise here.
 */
import fs from "node:fs";
import path from "node:path";
import { configDir, ensureDir, projectKey } from "../config.js";

const MAX_ENTRIES = 500;

function historyFile(cwd: string): string {
  return path.join(ensureDir(path.join(configDir(), "history")), `${projectKey(cwd)}.json`);
}

/** The stored shape: one list per session id, newest entries last. */
type StoredHistory = Record<string, string[]>;

export function loadInputHistory(cwd: string, sessionId?: string): string[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(historyFile(cwd), "utf8"));
    const all = Array.isArray(raw)
      ? ({ "*": raw.filter((x) => typeof x === "string") } as StoredHistory) // the old flat format
      : (raw ?? {}) as StoredHistory;
    if (!sessionId) return Object.values(all).flat().slice(-MAX_ENTRIES);
    const clean = (xs: string[] | undefined): string[] =>
      (xs ?? []).filter((x) => typeof x === "string" && x.trim().length > 0).slice(-MAX_ENTRIES);
    const own = clean(all[sessionId]);
    if (own.length) return own;
    // A session with no prompts of its own yet recalls the project's most
    // recent conversation: a fresh start with nothing behind ↑ feels broken.
    const keys = Object.keys(all).filter((k) => k !== sessionId && k !== "*" && clean(all[k]).length);
    return clean(all[keys[keys.length - 1]]);
  } catch {
    return [];
  }
}

export function saveInputHistory(cwd: string, items: string[], sessionId = "*"): void {
  let all: StoredHistory = {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(historyFile(cwd), "utf8"));
    if (raw && !Array.isArray(raw)) all = raw as StoredHistory;
  } catch {
    /* first write starts a fresh file */
  }
  all[sessionId] = items.slice(-MAX_ENTRIES);
  try {
    fs.writeFileSync(historyFile(cwd), JSON.stringify(all));
  } catch {
    /* history is a convenience; never fail a turn over it */
  }
}

/** Drops everything recorded for a deleted session. */
export function dropSessionHistory(cwd: string, sessionId: string): void {
  try {
    const f = historyFile(cwd);
    const raw: unknown = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!raw || Array.isArray(raw)) return;
    delete (raw as StoredHistory)[sessionId];
    fs.writeFileSync(f, JSON.stringify(raw));
  } catch {
    /* nothing to clean */
  }
}
