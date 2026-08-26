/** System prompt construction. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig, loadProjectInstructions, type Lang } from "../config.js";
import { skillsPromptSection, type Skill } from "../skills/loader.js";
import { memorySection } from "../tools/memory.js";

const BASE = `You are TRCode, a coding agent in the terminal. You work on a real filesystem and change real files.

# How you work
- Understand the code before changing it. Read files and search the project instead of guessing: follow the conventions this repository already has.
- Do not narrate what you are about to do — do it. Use tools rather than describing them.
- Make surgical changes with edit. Use write only for new files or a full replacement.
- Never invent APIs, flags, paths or names. When unsure, check with grep/read.
- Change files with edit and write, never through shell. Every edit and write is snapshotted first, so the user can undo a whole turn with /rewind; a shell redirect, sed -i or rm is only covered when it names the file outright, and not at all when the path comes from a glob or a script. If a shell command is genuinely the only way, say in the same turn which files it will change.
- Do not add comments that restate the obvious. Write code that matches its surroundings: the same comment density, the same naming, the same idioms.
- Do not create READMEs, docs or examples unless asked.

# Verifying your work
- After changing code, run the checks this project already has (tests, linter, build). Find the command in package.json / Makefile / README rather than inventing one.
- If a check fails, say so plainly and show the output. Never present unverified work as verified.

# Answering
- Be brief: this is a terminal, not a document. No preambles like "Sure!" and no retelling of what the transcript already shows.
- Refer to code as path:line — for example src/index.ts:42.
- If the task is done and verified, say so in one sentence, without hedging. If something is not done, say exactly what and why.

# Working in parallel
- Emit independent tool calls in a single turn — they run concurrently.

# Context is the budget
Every step re-sends the whole conversation, so what you pull in you pay for again on each step after it. Big tool output is what makes a session expensive.
- Answering one question needs more than about three files opened? Delegate it: task with read_only: true, one call per angle, several in the same turn. They read in their own context and hand you back the answer, not the files.
- grep for the line, then read around it with offset/limit. Read a whole large file only when you really need all of it, and never cat/type one through shell.
- Do not read a file you have already read in this session — it is still above you in the transcript. An old result that was shortened says so in its own text; only then read it again.
- Prefer edit over rewriting a file with write: a diff costs a fraction of a full copy.

# Images
A pasted screenshot arrives as "[Image #N]" and a temp-file path — call read_image on that path to see it; the read tool refuses binary. If the model has no vision, say so rather than guess what was on the screen.

# Memory
- A durable project fact goes to the memory tool the turn you learn it.`;

const SUBAGENT_BASE = `You are a TRCode subagent, launched by the lead agent for one specific subtask.

- Your final text is a RETURN VALUE, not a message to a person. No "Done!" and no "hope this helps" — just the result.
- Answer densely and concretely: facts, paths with line numbers, exact names. The lead agent cannot see your transcript, only this text.
- If the task was investigative, return the findings rather than a summary of your process.
- If you could not find or verify something, say so explicitly instead of filling the gap with a guess.
- grep first, then read around the hit with offset/limit. Reading whole files you do not need costs the same on every step of your own loop.`;

/**
 * The minimal preset has two tools and no safety net of snapshots around them:
 * no checkpoint previews for shell writes, no read-before-overwrite guard.
 * State that plainly — a model told what it does not have stops reaching for it.
 */
const MINIMAL_BASE = `You are TRCode in minimal mode: exactly two tools, shell and edit.

- Inspect with shell (dir/ls, type/cat, git log), change files with edit only.
- There is no read tool: to see a file before editing it, print it through shell.
- There is no write tool: edit replaces exact strings, so quote enough context to hit the right spot.
- Shell redirects and one-liners that write files are outside the snapshot undo — say so when you use them.
- Be brief and surgical: this mode exists for small, fast changes.`;

export interface PromptOptions {
  cwd: string;
  model: string;
  skills: Skill[];
  extraInstructions?: string;
  subagent?: boolean;
  /** "minimal" swaps the full base prompt for the two-tool one. */
  preset?: "standard" | "minimal";
}

/**
 * The listing is the one volatile part of the prompt: creating a single file
 * rewrites it, and since everything after a changed byte is a cache miss, one
 * `write` used to invalidate the cached prefix for the whole rest of the
 * session. Snapshot it per directory instead — the model can always `ls`.
 */
const listingSnapshots = new Map<string, string>();

/**
 * Project instructions are snapshotted for the third time for the same reason:
 * AGENTS.md is a file the agent is perfectly capable of editing, and the system
 * prompt sits in front of everything — rewrite one byte of it and not a single
 * token of the session is cached any more. Re-read on /new, /resume and
 * anything else that calls resetPromptSnapshots.
 */
const projectSnapshots = new Map<string, string>();

/**
 * The date, fixed when the session starts. It changes once a day, and when it
 * does it would otherwise void the cached prefix mid-session, at midnight, for
 * no benefit — nothing in a coding session turns on the date having rolled
 * over while it ran.
 */
let dateSnapshot = "";

/**
 * Git state is snapshotted for the same reason: every commit the agent makes
 * would otherwise rewrite the prefix and void the provider cache for the rest
 * of the session. The block says it is a snapshot; the live picture is one
 * `git status` away.
 */
const gitSnapshots = new Map<string, string>();

/**
 * Memory is snapshotted like everything else in front of the history: the
 * memory tool edits the very file this section is built from, and a section
 * that moved mid-session would void the cached prefix on every save.
 * Re-read on /new, /resume and anything else that calls resetPromptSnapshots.
 */
const memorySnapshots = new Map<string, string>();

export function resetPromptSnapshots(): void {
  listingSnapshots.clear();
  gitSnapshots.clear();
  projectSnapshots.clear();
  memorySnapshots.clear();
  dateSnapshot = "";
}

/**
 * What the model is told about the answer language. Code, identifiers, paths
 * and shell commands stay as they are in every language — translating them
 * would make the answer wrong, not localised.
 */
function languageDirective(lang: Lang): string {
  const rules = "Keep code, identifiers, file paths, commands and log output verbatim — never translate them.";
  if (lang === "ru") {
    return `Answer in Russian. Отвечай по-русски, включая заголовки, списки и объяснения. ${rules}`;
  }
  return `Answer in English. If the request or the conversation is written in another language, answer in that language instead — match the language of the question. ${rules}`;
}

/**
 * Notes addressed to one family of models rather than to all of them.
 *
 * Reasoning models differ in how they waste a budget. The long-thinking ones
 * — Kimi's K-line, Qwen's -max — restate the plan before every tool call and
 * re-derive what they settled three steps ago. That is paid for twice: in
 * output tokens now, and in input tokens on every later step, since it all
 * travels with the history. It is also the difference between a turn that
 * takes two minutes and one that takes twelve.
 *
 * Matched against the bare model name. Anything in config → "modelPrompts" is
 * added after; a key matching this model exactly replaces the built-in note,
 * so a note can be taken back and not only added to.
 */
/** Written this way so the source file stays plain text. */
const NL = String.fromCharCode(10);

const MODEL_NOTES: [RegExp, string][] = [
  [
    // Anchored at the start or just after the provider prefix: a subscription
    // host names its models itself, so Kimi serves a plain "k3".
    new RegExp("(^|/)(kimi|k\d|qwen|qwq|glm|minimax|deepseek)"),
    [
      "Thinking budget:",
      "- Decide and act; do not restate the plan before each step.",
      "- Never re-derive what this session settled, and never repeat a tool result back — both are already in the context.",
      "- Spend the reasoning on what is genuinely unresolved.",
    ].join(NL),
  ],
];

/** The note for a model: the built-in one, plus or replaced by the config's. */
export function modelNote(model: string): string {
  const bare = model.slice(model.lastIndexOf(":") + 1);
  // A subscription host names its own models: Kimi serves "k3" and
  // "kimi-for-coding", so the family cannot be read off the name alone. The
  // provider prefix is the other half of the answer.
  const provider = model.includes(":") ? model.slice(0, model.indexOf(":")).toLowerCase() : "";
  const name = (provider ? provider + "/" : "") + bare.slice(bare.lastIndexOf("/") + 1).toLowerCase();
  const custom = loadConfig().modelPrompts ?? {};
  const exact = custom[model] ?? custom[bare] ?? custom[name];
  if (exact !== undefined) return exact;
  const built = MODEL_NOTES.find(([re]) => re.test(name))?.[1] ?? "";
  const family = Object.entries(custom).find(
    ([k]) => k.endsWith("*") && name.startsWith(k.slice(0, -1).toLowerCase()),
  )?.[1];
  return [built, family].filter(Boolean).join(NL + NL);
}

/**
 * How many servers the user can reach, and where the list is.
 *
 * "Check my servers" has an answer on this machine — ~/.ssh/config is the list,
 * and the names in it are the names the user calls them by — but only if the
 * agent knows to look. One line is enough to stop it asking which servers are
 * meant; the `servers` skill carries the rest.
 */
let sshHosts: string | null = null;

function sshHostsLine(): string {
  if (sshHosts === null) {
    sshHosts = "";
    try {
      const cfg = fs.readFileSync(path.join(os.homedir(), ".ssh", "config"), "utf8");
      // A Host line can name several aliases for one server; wildcard-only
      // blocks are defaults, not machines.
      const hosts = new Set<string>();
      for (const l of cfg.split(NL)) {
        const m = /^\s*Host\s+(.+?)\s*$/i.exec(l);
        if (!m) continue;
        for (const name of m[1].split(/\s+/)) if (!name.includes("*") && !name.includes("?")) hosts.add(name);
      }
      if (hosts.size) sshHosts = NL + `SSH hosts configured: ${hosts.size} (~/.ssh/config)`;
    } catch {
      /* no config, or unreadable — say nothing rather than guess */
    }
  }
  return sshHosts;
}

export function buildSystemPrompt(opts: PromptOptions): string {
  if (opts.preset === "minimal") {
    // Minimal keeps only the base and the language directive: no listing, git,
    // skills, memory or model notes — the preset exists to shed exactly these.
    const parts = [MINIMAL_BASE, `<language>\n${languageDirective(loadConfig().lang)}\n</language>`];
    if (opts.extraInstructions) parts.push(`<session-instructions>\n${opts.extraInstructions}\n</session-instructions>`);
    return parts.join("\n\n");
  }
  const parts = [opts.subagent ? SUBAGENT_BASE : BASE];

  // Stated rather than inferred: "answer in the user's language" makes a model
  // switch tongue mid-session whenever a prompt happens to be in English —
  // pasted logs and error messages are enough to flip it.
  parts.push(`<language>\n${languageDirective(loadConfig().lang)}\n</language>`);

  parts.push(`<environment>
Working directory: ${opts.cwd}
Platform: ${process.platform} (${os.release()})
Shell: ${process.platform === "win32" ? "PowerShell" : "bash"}
Today: ${today()}
Model: ${opts.model}
Git repository: ${isGitRepo(opts.cwd) ? "yes" : "no"}${sshHostsLine()}
</environment>`);

  let tree = listingSnapshots.get(opts.cwd);
  if (tree === undefined) {
    tree = topLevelListing(opts.cwd);
    listingSnapshots.set(opts.cwd, tree);
  }
  if (tree) parts.push(`<workspace>\n${tree}\n</workspace>`);

  let git = gitSnapshots.get(opts.cwd);
  if (git === undefined) {
    git = gitContext(opts.cwd);
    gitSnapshots.set(opts.cwd, git);
  }
  if (git) parts.push(`<git>\n${git}\n</git>`);

  const skillsSection = skillsPromptSection(opts.skills);
  if (skillsSection) parts.push(skillsSection);

  let project = projectSnapshots.get(opts.cwd);
  if (project === undefined) {
    project = loadProjectInstructions(opts.cwd) ?? "";
    projectSnapshots.set(opts.cwd, project);
  }
  if (project) parts.push(project);

  let memory = memorySnapshots.get(opts.cwd);
  if (memory === undefined) {
    // Off means off for the section too: /memory should leave nothing of the
    // feature in the session, not just take the tool away.
    memory = loadConfig().memoryEnabled !== false ? memorySection(opts.cwd) : "";
    memorySnapshots.set(opts.cwd, memory);
  }
  if (memory) parts.push(memory);

  const note = modelNote(opts.model);
  if (note) parts.push("<model-notes>" + NL + note + NL + "</model-notes>");

  if (opts.extraInstructions) parts.push(`<session-instructions>\n${opts.extraInstructions}\n</session-instructions>`);

  return parts.join("\n\n");
}

function today(): string {
  if (!dateSnapshot) dateSnapshot = new Date().toISOString().slice(0, 10);
  return dateSnapshot;
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

/**
 * Branch, dirty files and recent commits, so the model does not burn a step on
 * `git status` at the start of every session. Capped: a big refactor in flight
 * should not swell a prompt that rides along on every request.
 */
function gitContext(cwd: string): string {
  if (!isGitRepo(cwd)) return "";
  const run = (...args: string[]): string => {
    try {
      const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2000, windowsHide: true });
      return r.status === 0 ? (r.stdout ?? "").trimEnd() : "";
    } catch {
      return "";
    }
  };
  const branch = run("rev-parse", "--abbrev-ref", "HEAD");
  if (!branch) return "";

  const MAX_STATUS = 15;
  const dirty = run("status", "--short").split("\n").filter(Boolean);
  const status = dirty.length
    ? dirty.slice(0, MAX_STATUS).join("\n") +
      (dirty.length > MAX_STATUS ? `\n… and ${dirty.length - MAX_STATUS} more` : "")
    : "clean";
  const log = run("log", "--oneline", "-5");

  const parts = [`Branch: ${branch}`, `Status (snapshot at session start; run git status for the live state):\n${status}`];
  if (log) parts.push(`Recent commits:\n${log}`);
  return parts.join("\n");
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
