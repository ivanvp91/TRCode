/** Config, credentials and per-project state under ~/.trcode. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ModelPricing } from "./types.js";

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://api.tokenrouter.com/v1";

export type PermissionMode = "ask" | "allow" | "deny";

/** Reasoning budget. "off" omits the parameter entirely. */
export type Effort = "off" | "minimal" | "low" | "medium" | "high";

export const EFFORT_LEVELS: Effort[] = ["off", "minimal", "low", "medium", "high"];

export interface Config {
  baseUrl: string;
  apiKey?: string;
  /** Primary model id. */
  model: string;
  /**
   * Hide models this client cannot drive. The catalog also carries native
   * Anthropic/Gemini, Responses-only, image, video and audio models, none of
   * which work through /v1/chat/completions.
   */
  hideIncompatibleModels: boolean;
  /** Cheap model used for /compact, titles and swarm bookkeeping. */
  smallModel: string;
  /** Short aliases resolved by /model and --model. */
  aliases: Record<string, string>;
  /** Reasoning budget applied when a model does not have its own override. */
  effort: Effort;
  /** Per-model reasoning budget, keyed by model id. Wins over `effort`. */
  effortByModel: Record<string, Effort>;
  /**
   * Wire shape for the reasoning budget. TokenRouter documents the nested
   * `reasoning: {effort}` form; most OpenAI-compatible hosts take the flat
   * `reasoning_effort`. "both" sends each, which every host we have seen
   * tolerates, and is the safest default.
   */
  effortParam: "reasoning_effort" | "reasoning" | "both";
  /** USD per 1M tokens, keyed by model id. Merged over the built-in table. */
  pricing: Record<string, ModelPricing>;
  /** Context window per model id, when the API does not report it. */
  contextWindows: Record<string, number>;
  /** Models known to reject the reasoning parameter; learned at runtime. */
  effortUnsupported: string[];
  /**
   * Which wire shape each model accepts for the reasoning budget, learned by
   * probing. Values are protocol-specific: "reasoning_effort" / "reasoning"
   * for OpenAI dialects, "adaptive" / "budget" for Anthropic, "none" when the
   * model takes no reasoning parameter at all.
   */
  effortForm: Record<string, string>;
  permissions: {
    read: PermissionMode;
    write: PermissionMode;
    shell: PermissionMode;
    network: PermissionMode;
    agent: PermissionMode;
  };
  /**
   * Extra key sequences that insert a newline instead of sending. Only needed
   * for terminals whose Ctrl/Shift+Enter is not one of the standard forms —
   * find yours with /keys and paste the escape sequence here.
   */
  newlineKeys: string[];
  /** Shell used by the shell tool. */
  shell: "powershell" | "bash" | "cmd" | "auto";
  temperature?: number;
  maxTokens?: number;
  /** Abort a request after this long without any data from the server. */
  requestTimeoutMs: number;
  /**
   * Cap on the history sent with each request. The loop resends everything on
   * every step, so without a cap a long session bills quadratically. Old tool
   * output is shortened once this is exceeded; 0 disables the cap.
   *
   * Measured on a 12-round tool-heavy session: 120k saved nothing (the cap was
   * never reached), 60k saved 11%, 40k saved 32%, 25k saved 41%. 40k keeps a
   * lot of live context while actually engaging.
   */
  maxRequestTokens: number;
  /** Trailing messages that are never shortened, counted in messages. */
  trimKeepRecent: number;
  /** Tool results below this size are left alone. */
  trimMinBytes: number;
  /**
   * Ceiling for one old tool result, applied even when the request is inside
   * the budget: a single 400KB read would otherwise ride along on every step
   * until the whole history finally crossed the threshold. 0 disables it.
   */
  maxToolResultBytes: number;
  /** Hard stop on tool-call rounds per user turn. */
  maxSteps: number;
  /** Auto-compact once the context passes this fraction of the window. */
  autoCompactAt: number;
  /**
   * Ask the provider to cache the prompt prefix. On the OpenAI path caching is
   * automatic and this changes nothing; on the Anthropic path nothing is
   * cached without explicit breakpoints, so a long turn pays full price for
   * the same history on every step. Set false if a host mishandles the field.
   */
  promptCache: boolean;
  /**
   * Report turn status to Orca when running inside one of its panes. Detected
   * from the environment; set false to stay silent.
   */
  orca: boolean;
  /**
   * Which of Orca's known agent routes to speak. It answers 404 to an id it
   * does not know, and "trcode" is not one of them.
   */
  orcaAgent: string;
  /** Extra system prompt appended for every session. */
  instructions?: string;
}

const DEFAULTS: Config = {
  baseUrl: DEFAULT_BASE_URL,
  model: "moonshotai/kimi-k3",
  smallModel: "moonshotai/kimi-k3-free",
  hideIncompatibleModels: true,
  aliases: {
    k3: "moonshotai/kimi-k3",
    free: "moonshotai/kimi-k3-free",
    smart: "moonshotai/kimi-k3",
    code: "moonshotai/kimi-k2.7-code",
    fast: "z-ai/glm-5-turbo",
    deep: "deepseek/deepseek-v4-pro",
    cheap: "deepseek/deepseek-v4-flash",
    qwen: "qwen/qwen3.7-max",
    glm: "z-ai/glm-5.2",
    grok: "x-ai/grok-4.5",
    sol: "openai/gpt-5.6-sol",
    terra: "openai/gpt-5.6-terra",
    luna: "openai/gpt-5.6-luna",
    opus: "anthropic/claude-opus-5",
    fable: "anthropic/claude-fable-5",
    sonnet: "anthropic/claude-sonnet-5",
    gpt: "openai/gpt-5.2",
    oss: "openai/gpt-oss-120b",
    mini: "minimax/minimax-m2.7",
  },
  effort: "high",
  effortByModel: {},
  effortParam: "both",
  pricing: {},
  contextWindows: {},
  effortUnsupported: [],
  effortForm: {},
  permissions: { read: "allow", write: "ask", shell: "ask", network: "ask", agent: "allow" },
  newlineKeys: [],
  shell: "auto",
  // Free tiers can queue for minutes before the first byte arrives.
  requestTimeoutMs: 300_000,
  maxRequestTokens: 40_000,
  trimKeepRecent: 8,
  trimMinBytes: 400,
  maxToolResultBytes: 12_000,
  maxSteps: 60,
  autoCompactAt: 0.82,
  promptCache: true,
  orca: true,
  orcaAgent: "opencode",
};

export function configDir(): string {
  return process.env.TRCODE_HOME || path.join(os.homedir(), ".trcode");
}
export function configPath(): string {
  return path.join(configDir(), "config.json");
}
export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  let file: Partial<Config> = {};
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    file = JSON.parse(raw) as Partial<Config>;
  } catch {
    /* first run — defaults are fine */
  }
  const merged: Config = {
    ...DEFAULTS,
    ...file,
    aliases: { ...DEFAULTS.aliases, ...(file.aliases || {}) },
    pricing: { ...DEFAULTS.pricing, ...(file.pricing || {}) },
    permissions: { ...DEFAULTS.permissions, ...(file.permissions || {}) },
    effortByModel: { ...DEFAULTS.effortByModel, ...(file.effortByModel || {}) },
    contextWindows: { ...DEFAULTS.contextWindows, ...(file.contextWindows || {}) },
    effortForm: { ...DEFAULTS.effortForm, ...(file.effortForm || {}) },
  };
  const envKey = process.env.TOKENROUTER_API_KEY || process.env.TR_API_KEY;
  if (envKey) merged.apiKey = envKey;
  if (process.env.TOKENROUTER_BASE_URL) merged.baseUrl = process.env.TOKENROUTER_BASE_URL;
  if (process.env.TRCODE_MODEL) merged.model = process.env.TRCODE_MODEL;
  merged.baseUrl = merged.baseUrl.replace(/\/+$/, "");
  cached = merged;
  return merged;
}

/**
 * Merges `patch` into the stored config. Map-valued keys merge by default;
 * list them in `opts.replace` to overwrite instead — deleting an entry is
 * impossible otherwise.
 */
export function saveConfig(patch: Partial<Config>, opts: { replace?: (keyof Config)[] } = {}): Config {
  const current = loadConfig();
  const replace = new Set(opts.replace ?? []);
  const merge = <T extends object>(key: keyof Config, base: T, incoming: T | undefined): T =>
    replace.has(key) && incoming !== undefined ? incoming : ({ ...base, ...(incoming ?? {}) } as T);
  const next: Config = {
    ...current,
    ...patch,
    aliases: merge("aliases", current.aliases, patch.aliases),
    pricing: merge("pricing", current.pricing, patch.pricing),
    permissions: merge("permissions", current.permissions, patch.permissions),
    effortByModel: merge("effortByModel", current.effortByModel, patch.effortByModel),
    contextWindows: merge("contextWindows", current.contextWindows, patch.contextWindows),
    effortForm: merge("effortForm", current.effortForm, patch.effortForm),
  };
  ensureDir(configDir());
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  cached = next;
  return next;
}

/** Stable per-project key so sessions from different repos never collide. */
export function projectKey(cwd: string): string {
  const norm = path.resolve(cwd).toLowerCase();
  const hash = crypto.createHash("sha256").update(norm).digest("hex").slice(0, 12);
  const base = path.basename(norm).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 24) || "root";
  return `${base}-${hash}`;
}

export function sessionsDir(cwd: string): string {
  return ensureDir(path.join(configDir(), "sessions", projectKey(cwd)));
}

/**
 * Project instructions, Claude Code style: the first file found wins per
 * directory, walking up from cwd so monorepo subpackages inherit the root.
 */
export function loadProjectInstructions(cwd: string): string {
  const names = ["AGENTS.md", "TRCODE.md", "CLAUDE.md", ".trcode/instructions.md"];
  const chunks: string[] = [];
  let dir = path.resolve(cwd);
  const seen = new Set<string>();
  for (;;) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const body = fs.readFileSync(p, "utf8").trim();
        if (body) {
          chunks.push(`<project-instructions path="${path.relative(cwd, p) || n}">\n${body}\n</project-instructions>`);
          break;
        }
      } catch {
        /* not there */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const global = path.join(configDir(), "instructions.md");
  try {
    const body = fs.readFileSync(global, "utf8").trim();
    if (body) chunks.push(`<user-instructions>\n${body}\n</user-instructions>`);
  } catch {
    /* optional */
  }
  return chunks.reverse().join("\n\n");
}
