/**
 * Permission rules: a pattern that names a tool, and sometimes the one thing it
 * is about to do — a command, a path, a domain — with the answer to give.
 *
 *     shell(git status:*)     every git status, with any arguments
 *     shell(rm -rf:*)         refused before it is ever shown
 *     edit(src/**)            edits under src/
 *     read(./.env)            one file, by path
 *     fetch(domain:github.com) requests to one host
 *
 * Rules are checked in three passes — deny, ask, allow — and the first rule that
 * matches in a pass decides. That order is the point: a broad "allow shell" can
 * never outvote a specific refusal, which is what makes a policy safe to write.
 */
import path from "node:path";
import type { PermissionMode } from "./config.js";
import type { ToolDef } from "./types.js";

export interface PermissionRule {
  action: PermissionMode;
  /** The rule text: `shell(git status:*)`, `edit(src/**)`, `web_search`. */
  rule: string;
}

export interface ParsedRule {
  action: PermissionMode;
  /** Tool name the rule applies to; `*` for every tool. */
  tool: string;
  /** What the tool is about to act on: a command, a path, a domain. */
  specifier?: string;
  raw: string;
}

/** Splits `tool(specifier)`; a bare name matches the whole tool. */
export function parseRule(text: string): ParsedRule | { error: string } {
  const raw = String(text ?? "").trim();
  if (!raw) return { error: "empty rule" };
  const open = raw.indexOf("(");
  if (open === -1) {
    if (!/^[\w*.:-]+$/.test(raw)) return { error: `not a tool name: ${raw}` };
    return { action: "ask", tool: raw, raw };
  }
  if (!raw.endsWith(")")) return { error: `missing ")" in ${raw}` };
  const tool = raw.slice(0, open).trim();
  const specifier = raw.slice(open + 1, -1).trim();
  if (!tool) return { error: "no tool name before the bracket" };
  if (!specifier) return { error: "empty specifier" };
  return { action: "ask", tool, specifier, raw };
}

/** The text form, for listing and for /permissions. */
export function ruleText(rule: PermissionRule): string {
  return String(rule.rule ?? "").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `*` stays inside a path segment, `**` crosses them. */
function pathGlob(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

/** In a command, `*` is "anything at all" — arguments included. */
function commandRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`, "s");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Does a path specifier match the file the tool is about to touch? */
function pathMatches(specifier: string, target: string, cwd?: string): boolean {
  const raw = String(target ?? "");
  if (!raw) return false;
  const forms = new Set<string>();
  const asIs = normalizePath(raw);
  forms.add(asIs);
  if (cwd) {
    const abs = normalizePath(path.resolve(cwd, raw));
    forms.add(abs);
    const rel = normalizePath(path.relative(cwd, path.resolve(cwd, raw)));
    forms.add(rel);
    const spec = normalizePath(specifier);
    if (spec.startsWith("/") || /^[a-z]:\//i.test(spec)) return pathGlob(spec).test(abs) || pathGlob(spec).test(asIs);
    return [...forms].some((f) => pathGlob(spec).test(f));
  }
  return pathGlob(normalizePath(specifier)).test(asIs);
}

/** The part of a call a specifier is compared against, if it has one. */
function subjectOf(tool: ToolDef, args: Record<string, any>): { kind: "command" | "path" | "domain"; value: string } | null {
  const command = typeof args?.command === "string" ? args.command : "";
  if (command) return { kind: "command", value: command };
  const p = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
  if (p) return { kind: "path", value: p };
  const url = typeof args?.url === "string" ? args.url : "";
  if (url) {
    try {
      return { kind: "domain", value: new URL(url).host };
    } catch {
      return { kind: "domain", value: url };
    }
  }
  if (tool.name === "read_mcp_resource" || tool.name === "list_mcp_resources") return null;
  return null;
}

function matches(parsed: ParsedRule, tool: ToolDef, args: Record<string, any>, cwd?: string): boolean {
  if (parsed.tool !== "*" && parsed.tool !== tool.name) return false;
  if (!parsed.specifier) return true;
  const subject = subjectOf(tool, args);
  if (!subject) return false;
  const spec = parsed.specifier.trim();
  // `domain:` names a host explicitly, so it does not depend on guessing the
  // kind of argument a tool has.
  if (spec.toLowerCase().startsWith("domain:")) {
    const host = spec.slice("domain:".length).trim().toLowerCase();
    return subject.kind === "domain" && (subject.value.toLowerCase() === host || subject.value.toLowerCase().endsWith(`.${host}`));
  }
  if (subject.kind === "domain") {
    return pathGlob(spec.toLowerCase()).test(subject.value.toLowerCase());
  }
  if (subject.kind === "path") return pathMatches(spec, subject.value, cwd);
  // A command: `git status:*` is a prefix, anything else is a glob.
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2).trim();
    return subject.value.trim() === prefix || subject.value.trim().startsWith(`${prefix} `);
  }
  if (spec.includes("*")) return commandRegex(spec).test(subject.value.trim());
  return subject.value.trim() === spec;
}

export interface RuleVerdict {
  /** What the matching rule says. */
  action: PermissionMode;
  /** The rule text, for the prompt or the log. */
  rule: string;
}

/**
 * The first rule that matches, in priority order: a refusal is found before a
 * question, and a question before a permission.
 */
export function evaluateRules(
  rules: PermissionRule[] | undefined,
  tool: ToolDef,
  args: Record<string, any>,
  cwd?: string,
): RuleVerdict | null {
  if (!Array.isArray(rules) || !rules.length) return null;
  for (const action of ["deny", "ask", "allow"] as PermissionMode[]) {
    for (const entry of rules) {
      if (!entry || entry.action !== action) continue;
      const text = ruleText(entry);
      if (!text) continue;
      const parsed = parseRule(text);
      if ("error" in parsed) continue;
      if (matches(parsed, tool, args, cwd)) return { action, rule: text };
    }
  }
  return null;
}

/** Keeps malformed entries out of the list and out of every prompt. */
export function validateRuleText(text: string): string | null {
  const parsed = parseRule(text);
  return "error" in parsed ? parsed.error : null;
}
