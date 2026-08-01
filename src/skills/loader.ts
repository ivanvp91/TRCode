/**
 * Skills: folders containing a SKILL.md with YAML-ish frontmatter. Only the
 * name + description are loaded up front; the body is injected on demand when
 * the model calls the `skill` tool, so a large skill library costs ~nothing.
 *
 * Lookup order (later wins on name collision):
 *   ~/.trcode/skills/<name>/SKILL.md      — personal
 *   <project>/.trcode/skills/<name>/SKILL.md — project
 */
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  scope: "user" | "project";
  /** Extra files bundled next to SKILL.md, surfaced to the model as paths. */
  resources: string[];
}

/** Minimal frontmatter parser — enough for `key: value` and folded strings. */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  let key = "";
  for (const rawLine of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine);
    if (kv) {
      key = kv[1];
      data[key] = stripQuotes(kv[2].trim());
      continue;
    }
    // Continuation line of a folded value.
    if (key && /^\s+\S/.test(rawLine)) {
      data[key] = (data[key] ? data[key] + " " : "") + rawLine.trim();
    }
  }
  return { data, body: raw.slice(m[0].length) };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function loadFrom(root: string, scope: Skill["scope"]): Skill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const file = path.join(dir, "SKILL.md");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    const name = (data.name || e.name).trim();
    const description = (data.description || "").trim();
    if (!description) continue; // description is what makes a skill discoverable
    let resources: string[] = [];
    try {
      resources = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((r) => r.name !== "SKILL.md")
        .map((r) => (r.isDirectory() ? r.name + "/" : r.name))
        .slice(0, 40);
    } catch {
      /* optional */
    }
    skills.push({ name, description, body: body.trim(), dir, scope, resources });
  }
  return skills;
}

const TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

<!--
The body of a skill is an instruction for the model, loaded IN FULL when a task
matches the description above. Write the procedure, not the theory.

The description line decides everything: the model picks the skill from it.
Write WHEN to apply it ("when asked to review changes"), not what it is.
-->

## When to apply
Describe the situation in a sentence or two.

## Procedure
1. First step — what exactly to check or gather.
2. Second step.
3. How to finish.

## What not to do
List the mistakes people typically make on this task.

## Answer format
What the result should look like.
`;

/** Creates a skill folder with a starter SKILL.md. Returns the file path. */
export function createSkill(opts: {
  cwd: string;
  name: string;
  description?: string;
  scope?: Skill["scope"];
}): { file: string; existed: boolean } {
  const slug = opts.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-я_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Empty skill name.");

  const root =
    opts.scope === "user"
      ? path.join(configDir(), "skills")
      : path.join(opts.cwd, ".trcode", "skills");
  const dir = path.join(root, slug);
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) return { file, existed: true };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, TEMPLATE(slug, opts.description?.trim() || "WHEN to apply this skill — one sentence"));
  return { file, existed: false };
}

export function discoverSkills(cwd: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of loadFrom(path.join(configDir(), "skills"), "user")) byName.set(s.name, s);
  for (const s of loadFrom(path.join(cwd, ".trcode", "skills"), "project")) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The catalogue block appended to the system prompt. */
export function skillsPromptSection(skills: Skill[]): string {
  if (!skills.length) return "";
  const rows = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `<skills>
Skills are collapsed instructions for specific tasks. If a task matches a skill's description, CALL the skill tool with its name BEFORE starting work: the skill holds a proven procedure that outranks your default approach.

${rows}
</skills>`;
}
