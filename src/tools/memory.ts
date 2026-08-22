/**
 * Project memory: durable facts the agent decides to keep across sessions.
 * One file per project — .trcode/memory.md — plain markdown the user can read
 * and edit. Facts are lines, so add/remove is a line operation, never a rewrite
 * of someone else's text.
 */
import fs from "node:fs";
import path from "node:path";
import type { ToolDef } from "../types.js";

export const MEMORY_FILE = path.join(".trcode", "memory.md");
const MAX_FACTS = 200;

export function memoryPath(cwd: string): string {
  return path.join(cwd, MEMORY_FILE);
}

/** The file as lines, without the blank ones; missing or unreadable → empty. */
function loadLines(p: string): string[] {
  try {
    return fs
      .readFileSync(p, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** How many facts are stored; for the /memory screen. */
export function memoryCount(cwd: string): number {
  return loadLines(memoryPath(cwd)).length;
}

/** What goes into the system prompt: a short header plus the facts, if any. */
export function memorySection(cwd: string): string {
  const lines = loadLines(memoryPath(cwd));
  if (!lines.length) return "";
  const body = lines.slice(0, MAX_FACTS).join("\n");
  const extra = lines.length > MAX_FACTS ? `\n… and ${lines.length - MAX_FACTS} more in ${MEMORY_FILE}` : "";
  return (
    `<project-memory path="${MEMORY_FILE}">` +
    "\n" +
    "Facts remembered from earlier sessions about this project. Update them with the memory tool rather than editing blindly.\n" +
    body +
    extra +
    "\n</project-memory>"
  );
}

export function makeMemoryTool(cwd: string, onWrite?: () => void): ToolDef {
  const p = memoryPath(cwd);
  const readAll = (): string[] => loadLines(p);

  const save = (lines: string[]): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, (lines.length ? lines.join("\n") + "\n" : "") );
    onWrite?.();
  };

  return {
    name: "memory",
    risk: "write",
    description:
      "Remembers a durable fact about this project for future sessions — conventions, decisions, gotchas, user preferences for this repo. " +
      "Not for session state or anything already derivable from the code: a fact that grep answers in a minute does not belong here. " +
      "Actions: add (new facts), remove (by exact line), list.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "list"], description: "What to do" },
        facts: {
          type: "array",
          items: { type: "string" },
          description:
            "For add: one fact per item, a self-contained sentence with paths/names spelled out. For remove: the exact current lines to delete.",
        },
      },
      required: ["action"],
    },
    summarize: (a) => `${String(a.action ?? "")}${Array.isArray(a.facts) ? " ×" + a.facts.length : ""}`,
    async run(args) {
      const action = String(args.action ?? "");
      const facts = (Array.isArray(args.facts) ? args.facts : []).map((f: any) => String(f).trim()).filter(Boolean);
      const lines = readAll();

      if (action === "list") {
        return { output: lines.length ? lines.join("\n") : "Memory is empty.", display: `memory: ${lines.length}` };
      }

      if (action === "add") {
        if (!facts.length) return { output: "No facts given.", isError: true };
        const known = new Set(lines.map((l) => l.toLowerCase()));
        const fresh = facts.filter((f: string) => !known.has(f.toLowerCase()));
        if (!fresh.length) return { output: "Already remembered:\n" + facts.join("\n"), display: "memory: no change" };
        save([...lines, ...fresh].slice(-MAX_FACTS));
        return {
          output: `Remembered (${fresh.length}):\n${fresh.join("\n")}\nStored in ${MEMORY_FILE}.`,
          display: `memory: +${fresh.length}`,
        };
      }

      // remove: match loosely on trimmed equality; report what was not found.
      if (action === "remove") {
        if (!facts.length) return { output: "No facts given.", isError: true };
        const drop = new Set(facts.map((f: string) => f.toLowerCase()));
        const kept = lines.filter((l) => !drop.has(l.toLowerCase()));
        const gone = lines.length - kept.length;
        save(kept);
        const missed = facts.filter((f: string) => !lines.some((l) => l.toLowerCase() === f.toLowerCase()));
        const note = missed.length ? `\nNot found (unchanged): ${missed.length}` : "";
        return {
          output: `Removed ${gone} of ${facts.length}.${note}\n${kept.length ? "Remaining:\n" + kept.join("\n") : "Memory is empty."}`,
          display: `memory: -${gone}`,
        };
      }

      return { output: `Unknown action: ${action}`, isError: true };
    },
  };
}
