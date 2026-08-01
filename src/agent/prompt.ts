/** System prompt construction. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadProjectInstructions } from "../config.js";
import { skillsPromptSection, type Skill } from "../skills/loader.js";

const BASE = `You are TokenRouter Code, a coding agent in the terminal. You work on a real filesystem and change real files.

# How you work
- Understand the code before changing it. Read files and search the project instead of guessing: follow the conventions this repository already has.
- Do not narrate what you are about to do — do it. Use tools rather than describing them.
- Make surgical changes with edit. Use write only for new files or a full replacement.
- Never invent APIs, flags, paths or names. When unsure, check with grep/read.
- Do not add comments that restate the obvious. Write code that matches its surroundings: the same comment density, the same naming, the same idioms.
- Do not create READMEs, docs or examples unless asked.

# Verifying your work
- After changing code, run the checks this project already has (tests, linter, build). Find the command in package.json / Makefile / README rather than inventing one.
- If a check fails, say so plainly and show the output. Never present unverified work as verified.

# Answering
- Be brief: this is a terminal, not a document. No preambles like "Sure!" and no retelling of what the transcript already shows.
- Refer to code as path:line — for example src/index.ts:42.
- If the task is done and verified, say so in one sentence, without hedging. If something is not done, say exactly what and why.
- Answer in the user's language.

# Working in parallel
- Emit independent tool calls in a single turn — they run concurrently.
- For broad investigation (many files to cover, approaches to compare, a hypothesis to test from several angles) spawn subagents with the task tool. Several task calls in one turn run at once — cheaper and faster than reading everything yourself, and it keeps your own context clean.`;

const SUBAGENT_BASE = `You are a TokenRouter Code subagent, launched by the lead agent for one specific subtask.

- Your final text is a RETURN VALUE, not a message to a person. No "Done!" and no "hope this helps" — just the result.
- Answer densely and concretely: facts, paths with line numbers, exact names. The lead agent cannot see your transcript, only this text.
- If the task was investigative, return the findings rather than a summary of your process.
- If you could not find or verify something, say so explicitly instead of filling the gap with a guess.`;

export interface PromptOptions {
  cwd: string;
  model: string;
  skills: Skill[];
  extraInstructions?: string;
  subagent?: boolean;
}

export function buildSystemPrompt(opts: PromptOptions): string {
  const parts = [opts.subagent ? SUBAGENT_BASE : BASE];

  parts.push(`<environment>
Working directory: ${opts.cwd}
Platform: ${process.platform} (${os.release()})
Shell: ${process.platform === "win32" ? "PowerShell" : "bash"}
Today: ${new Date().toISOString().slice(0, 10)}
Model: ${opts.model}
Git repository: ${isGitRepo(opts.cwd) ? "yes" : "no"}
</environment>`);

  const tree = topLevelListing(opts.cwd);
  if (tree) parts.push(`<workspace>\n${tree}\n</workspace>`);

  const skillsSection = skillsPromptSection(opts.skills);
  if (skillsSection) parts.push(skillsSection);

  const project = loadProjectInstructions(opts.cwd);
  if (project) parts.push(project);

  if (opts.extraInstructions) parts.push(`<session-instructions>\n${opts.extraInstructions}\n</session-instructions>`);

  return parts.join("\n\n");
}

function isGitRepo(cwd: string): boolean {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** A shallow listing so the model does not burn a turn on `ls` at startup. */
function topLevelListing(cwd: string): string {
  try {
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") || [".github", ".trcode"].includes(e.name))
      .filter((e) => !["node_modules", "dist", "build", "target", "vendor"].includes(e.name))
      .slice(0, 60)
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
      .sort();
    return entries.join("  ");
  } catch {
    return "";
  }
}
