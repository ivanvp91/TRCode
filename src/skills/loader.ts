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
import { configDir, loadConfig } from "../config.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  scope: "user" | "project";
  /** Extra files bundled next to SKILL.md, surfaced to the model as paths. */
  resources: string[];
  /**
   * Words and phrases that make the skill fire without the model choosing it.
   * The description is written for the model and is in English; a request is
   * not, so auto-selection needs the words the user actually types.
   */
  triggers: string[];
  /** `auto: off` in the frontmatter leaves this skill to the model alone. */
  auto: boolean;
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
    // `description_ru` and friends are optional: a skill that has none still
    // works, it just describes itself in English wherever it appears.
    const lang = loadConfig().lang;
    const description = (data[`description_${lang}`] || data.description || "").trim();
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
    const triggers = (data.triggers || "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const auto = !/^(off|false|no|manual)$/i.test((data.auto || "").trim());

    skills.push({ name, description, body: body.trim(), dir, scope, resources, triggers, auto });
  }
  return skills;
}

const TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
triggers:
---

# ${name}

<!--
The body of a skill is an instruction for the model, loaded IN FULL when a task
matches the description above. Write the procedure, not the theory.

The description line decides everything: the model picks the skill from it.
Write WHEN to apply it ("when asked to review changes"), not what it is.

"triggers" is a comma-separated list of words the user would actually type, in
every language you work in. A request that hits one loads this skill by itself,
with no tool call. Leave it empty to let the model do the choosing, and add
"auto: off" to keep this skill out of auto-selection entirely.

Bundled files live next to this one and are read only when the body points at
them: references/ — material read on demand; scripts/ — code to run rather
than retype; assets/ — templates and files copied into the output. Name each
one here, with when to open it. /skills check reports what is left to fill in.
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

/** Text the starter template ships with; still present means never filled in. */
const PLACEHOLDERS = [
  "WHEN to apply this skill — one sentence",
  "Describe the situation in a sentence or two.",
  "First step — what exactly to check or gather.",
  "List the mistakes people typically make on this task.",
];

/**
 * What would keep a skill from working: the model picks a skill by its
 * description and auto-selection by its triggers, so a vague, duplicated or
 * unfilled one is a skill that never fires — or fires for the wrong task.
 * Each entry is one problem, worded as what to fix.
 */
export function validateSkill(skill: Skill, all: Skill[] = []): string[] {
  const out: string[] = [];
  const raw = (() => {
    try { return fs.readFileSync(path.join(skill.dir, "SKILL.md"), "utf8"); } catch { return ""; }
  })();
  if (skill.name.length > 64) out.push(`name is ${skill.name.length} characters — keep it under 64`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name)) out.push("name should be lowercase letters, digits and hyphens");
  if (path.basename(skill.dir) !== skill.name) out.push(`name "${skill.name}" differs from its folder "${path.basename(skill.dir)}"`);
  const d = skill.description;
  if (d.length < 40) out.push("description is too short to choose by — say WHEN to apply it, in a full sentence");
  if (d.length > 500) out.push(`description is ${d.length} characters — every request carries it; cut it under 500`);
  const twin = all.find((s) => s !== skill && s.description.trim().toLowerCase() === d.trim().toLowerCase());
  if (twin) out.push(`description is identical to "${twin.name}" — the model cannot tell them apart`);
  for (const p of PLACEHOLDERS) if (raw.includes(p)) out.push(`template text left in: "${p}"`);
  if (/<!--[\s\S]*The body of a skill is an instruction/.test(raw)) out.push("the template's guidance comment is still in the body — remove it");
  const body = skill.body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (body.split("\n").filter((l) => l.trim()).length < 5) out.push("the body is almost empty — write the procedure");
  const lines = skill.body.split("\n").length;
  if (lines > 500) out.push(`the body is ${lines} lines — it is loaded whole; move detail to references/`);
  if (skill.auto && !skill.triggers.length) out.push("no triggers — it loads only when the model chooses it (add triggers, or auto: off to say that is intended)");
  for (const r of skill.resources) {
    const stem = r.replace(/\/$/, "");
    if (!skill.body.includes(stem)) out.push(`bundled ${r} is never mentioned in the body — the model will not know to open it`);
  }
  return out;
}

/** The catalogue block appended to the system prompt. */
export function skillsPromptSection(skills: Skill[]): string {
  if (!skills.length) return "";
  const rows = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `<skills>
Skills are collapsed instructions for specific tasks. If a task matches a skill's description, CALL the skill tool with its name BEFORE starting work: the skill holds a proven procedure that outranks your default approach.
- The user names a skill → load it, no judgement call. Several match → load each.
- A skill serves the request it was loaded for; do not carry it into later, unrelated requests.
- Load and read a skill yourself — do not delegate its instructions to a subagent.
- Open a skill's bundled files only when its instructions point you to them.

${rows}
</skills>`;
}
