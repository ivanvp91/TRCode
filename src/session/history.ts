/**
 * Input history that survives a restart, per project — the same scoping as
 * sessions, because prompts from one repository are noise in another.
 */
import fs from "node:fs";
import path from "node:path";
import { configDir, ensureDir, projectKey } from "../config.js";

const MAX_ENTRIES = 500;

function historyFile(cwd: string): string {
  return path.join(ensureDir(path.join(configDir(), "history")), `${projectKey(cwd)}.json`);
}

export function loadInputHistory(cwd: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(cwd), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveInputHistory(cwd: string, items: string[]): void {
  try {
    fs.writeFileSync(historyFile(cwd), JSON.stringify(items.slice(-MAX_ENTRIES)));
  } catch {
    /* history is a convenience; never fail a turn over it */
  }
}
