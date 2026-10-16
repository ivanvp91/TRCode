/**
 * Subagent roles: a named preset the lead passes as `role` instead of
 * re-describing the helper in every brief. A role may narrow a subagent —
 * read-only, fewer steps — and give it standing instructions, a preferred
 * model and a reasoning budget. It never widens what the session allows: the
 * model still has to pass the /subagents allowlist, and a role cannot turn
 * read_only back off.
 */
import { loadConfig, type Effort } from "../config.js";

export interface SubagentRole {
  /** One line for the task schema: when the lead should pick this role. */
  description: string;
  /** Standing instructions appended to the subagent's system prompt. */
  prompt?: string;
  /** Preferred model; an explicit `model` in the call wins over it. */
  model?: string;
  effort?: Effort;
  /** true forces read and search tools only. */
  readOnly?: boolean;
  /** Step budget; lowers the session's ceiling, never raises it. */
  maxSteps?: number;
}

const EFFORTS = new Set<Effort>(["off", "minimal", "low", "medium", "high"]);

/**
 * The review contract is what makes a delegated review usable: the lead gets
 * findings it can act on line by line, and "No findings." when there are
 * none, instead of an essay it has to re-read the diff to check.
 */
const REVIEW_PROMPT = `# Role: review
You review a change for defects. Read the diff (git diff, or the files named in the assignment) and the code around each hunk before judging it.

Flag an issue only when all of these hold:
- it affects correctness, security, data integrity or a clear maintainability hazard;
- it is introduced by this change — not pre-existing code the change merely touches;
- it is discrete and actionable: you can name the line and the fix;
- the author would fix it if they saw it. No style nits, no "consider", no speculation about code you did not read.

Return exactly this, most severe first:
[P0|P1|P2|P3] Short title — path/to/file.ext:line
One paragraph at most: the concrete input or state, and what goes wrong.

P0 — breaks the build, loses data or opens a security hole; P1 — wrong behaviour on a normal path; P2 — wrong on an edge case; P3 — a real but minor defect.
If nothing qualifies, return exactly: No findings.`;

const EXPLORE_PROMPT = `# Role: explore
You map code for the lead: where things live and how they connect. Return paths with line numbers, symbol names and the call chain that answers the question — not file dumps and not advice. Say what you could not locate.`;

export const BUILTIN_ROLES: Record<string, SubagentRole> = {
  explore: {
    description: "read-only: where code lives and how it connects",
    prompt: EXPLORE_PROMPT,
    readOnly: true,
  },
  review: {
    description: "read-only defect review of a change: [P0–P3] path:line findings",
    prompt: REVIEW_PROMPT,
    readOnly: true,
  },
};

/** A config entry shaped badly is dropped, not trusted half-way. */
function sanitize(raw: unknown): SubagentRole | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const description = text(r.description) ?? text(r.prompt)?.split("\n")[0];
  if (!description) return null;
  const steps = Number(r.maxSteps);
  return {
    description,
    prompt: text(r.prompt),
    model: text(r.model),
    effort: EFFORTS.has(r.effort as Effort) ? (r.effort as Effort) : undefined,
    readOnly: r.readOnly === true ? true : undefined,
    maxSteps: Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : undefined,
  };
}

/** Built-in roles with the config's on top; a config entry of the same name replaces the built-in. */
export function subagentRoles(): Record<string, SubagentRole> {
  const out: Record<string, SubagentRole> = { ...BUILTIN_ROLES };
  for (const [name, raw] of Object.entries(loadConfig().subagentRoles ?? {})) {
    const key = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) continue;
    // null switches a built-in off.
    if (raw === null) { delete out[key]; continue; }
    const role = sanitize(raw);
    if (role) out[key] = role;
  }
  return out;
}

/** The session's ceiling, lowered by the role's when it has one. 0 means no ceiling. */
export function roleSteps(session: number, role: SubagentRole | undefined): number {
  if (!role?.maxSteps) return session;
  return session > 0 ? Math.min(session, role.maxSteps) : role.maxSteps;
}
