/** Config, credentials and per-project state under ~/.trcode. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { McpServerConfig, ModelPricing } from "./types.js";

export const VERSION = "0.1.3";
export const DEFAULT_BASE_URL = "https://api.tokenrouter.com/v1";

export type PermissionMode = "ask" | "allow" | "deny";

/** Reasoning budget. "off" omits the parameter entirely. */
export type Effort = "off" | "minimal" | "low" | "medium" | "high";

/**
 * The language the agent answers in, and the one skill descriptions are shown
 * in. Adding one means a `LANGUAGES` entry and a `description_<code>` line in
 * whichever skills should speak it — nothing else is per-language.
 */
export type Lang = "en" | "ru";

export const LANGUAGES: { code: Lang; label: string; native: string }[] = [
  { code: "en", label: "English", native: "English" },
  { code: "ru", label: "Russian", native: "Русский" },
];

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
  /**
   * Per provider, the model that writes prompts for the big one. Per provider
   * because a key buys models at one host only: the cheap model that rewrites
   * a request has to be one this plan can actually call.
   */
  promptModels: Record<string, string>;
  /**
   * Models a subagent may be launched on, per provider. Empty means the model
   * chooses from everything the provider serves, which is the default; a list
   * narrows it to what you are willing to pay for in parallel.
   */
  subagentModels: Record<string, string[]>;
  /**
   * The panel /brain runs: model ids, across providers on purpose. Mixing
   * hosts is the point — two models from one vendor share their blind spots.
   */
  brainModels: string[];
  /**
   * The panel member that writes the final answer. Empty means the session's
   * model, which is how it worked before the choice existed.
   */
  brainMainModel: string;
  /**
   * Extra system-prompt notes per model. A key is a model id, a bare name, or
   * a family with a trailing "*"; an exact match replaces the built-in note
   * for that model, so a note can be taken back and not only added to.
   */
  modelPrompts: Record<string, string>;
  /**
   * "off" — never; "command" — only when /prompt asks for it; "auto" — a new
   * task is rewritten before it is sent, and a follow-up inside a task is not.
   */
  promptMode: "off" | "command" | "auto";
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
  /**
   * Ceiling for one tool result at the moment it is produced, in characters.
   * The head and the tail are kept, the middle is parked under
   * `.trcode/artifacts/` and named in the result, and the message is never
   * touched again — which is what keeps the history append-only and a
   * provider-side cache warm. 0 disables the bounding. See tools/spill.ts.
   */
  toolResultMaxBytes: number;
  /**
   * Reasoning lines shown live above the spinner while a model thinks. The
   * full text stays out of the transcript — one summary line replaces it, and
   * /reasoning prints it on demand. 0 streams it all into the transcript.
   */
  thinkingRows: number;
  /** Ceiling on tool-call rounds per user turn; 0 removes it. */
  maxSteps: number;
  /**
   * Tool calls from one assistant turn that may run at once. Subagents are
   * tool calls too, so on a host that meters requests this is also how many
   * of them race for the same slot.
   */
  toolConcurrency: number;
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
  /**
   * Per-provider overrides, keyed by provider id ("kimi"). `baseUrl` repoints
   * a host that moved; `headers` adds to — or replaces — the built-in ones;
   * `models` pins the list a host will not enumerate. All three exist because
   * third-party coding endpoints are undocumented and can change what they
   * serve, or expect, without warning.
   */
  providers?: Record<string, { baseUrl?: string; headers?: Record<string, string>; models?: string[] }>;
  /**
   * Provider a new session starts on. Without it the default model decides,
   * which is the same thing said less directly.
   */
  defaultProvider?: string;
  /**
   * Where each provider was left: model and reasoning budget. Providers differ
   * in what they charge and what they are good at, so coming back to one should
   * restore its settings rather than reset to its first model.
   */
  providerState: Record<string, { model?: string; effort?: Effort }>;
  /**
   * Where each project was left: model and reasoning budget, keyed by worktree
   * root. Which model a repository wants is a property of the work, not of the
   * last session anywhere on the machine — a checkout that runs on a cheap
   * model should not have to be told again at every start. Only the most
   * recent `PROJECT_MEMORY` projects are kept.
   */
  projectState: Record<string, { model?: string; effort?: Effort; ts?: number }>;
  /**
   * Language for answers and for skill descriptions. English by default, so an
   * install that never touches this reads exactly as it did before.
   */
  lang: Lang;
  /**
   * MCP servers launched over stdio, in Claude Code's config shape:
   * id → {command, args, env}. Their tools join the registry as
   * mcp__<id>__<tool> under the `network` permission. A project adds its own
   * in .trcode/mcp.json (same shape; wins on a shared id).
   */
  mcpServers: Record<string, McpServerConfig>;
  /** Extra system prompt appended for every session. */
  instructions?: string;
  /**
   * Load a matching skill by itself, without waiting for the model to call the
   * `skill` tool. Matching is on the `triggers` list in each SKILL.md, so a
   * skill without triggers is unaffected either way.
   */
  skillAuto: boolean;
  /**
   * Match a design request against the UI library and inject the saved mockup
   * as the visual reference without asking. Off turns every match into an
   * explicit /uilib pick.
   */
  uilibAuto: boolean;
  /**
   * Whether skills take part in requests at all. Off by default: the <skills>
   * block and the `skill` tool cost ~1-2k tokens on every request, and most
   * projects never use them. Turn on with `/skills on` when they earn it.
   */
  skillsEnabled: boolean;
  /**
   * Whether project memory takes part in sessions: the <project-memory> section
   * in the prompt and the `memory` tool. On by default — a fact costs nothing
   * while there are none, and most projects accumulate a few. Off with /memory.
   */
  memoryEnabled: boolean;
  /**
   * Tool preset for the session. "standard" is everything; "minimal" keeps
   * only shell and edit, with a short system prompt to match — for quick fixes
   * on cheap models and for measuring what the rest of the kit costs.
   */
  preset: "standard" | "minimal";
  /**
   * The run_code tool: a model-written program whose SDK calls (fs, shell, web)
   * run in a child process while only its return value enters the history.
   * Off by default — it earns its keep on models that write such programs
   * reliably; true forces it on for every model, "auto" keeps it off unless a
   * future release marks specific models as proven. A subagent inherits it.
   */
  codeMode: boolean | "auto";
  /** Ceiling for one run_code program, in ms of wall clock. */
  codeModeTimeoutMs: number;
  /**
   * What the one-line status under each turn shows. Everything is on by
   * default; /settings unticks the fields that are not worth their width.
   */
  statusFields: Record<StatusField, boolean>;
  /**
   * Whether the client looks for a newer GitHub release at startup (at most
   * once every six hours) and says so in the header. It never applies anything
   * by itself — /update does that on request.
   */
  updateCheck: boolean;
}

/** The pieces a turn status can carry, each independently optional. */
export type StatusField = "model" | "tokens" | "steps" | "time" | "speed";

/** The status fields in display order, with what each shows. */
export const STATUS_FIELDS: StatusField[] = ["model", "tokens", "steps", "time", "speed"];

const DEFAULTS: Config = {
  baseUrl: DEFAULT_BASE_URL,
  model: "moonshotai/kimi-k3",
  smallModel: "moonshotai/kimi-k3-free",
  promptModels: {},
  subagentModels: {},
  brainModels: [],
  brainMainModel: "",
  modelPrompts: {},
  // Off the automatic path by default: rewriting what someone typed is a
  // liberty, and it costs a call. /prompt asks for it explicitly.
  promptMode: "command",
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
  providerState: {},
  projectState: {},
  permissions: { read: "allow", write: "ask", shell: "ask", network: "ask", agent: "allow" },
  newlineKeys: [],
  shell: "auto",
  // Not a response deadline — a dead-connection guard: it only fires after
  // this long with not a single byte from the server. Free tiers queue for
  // minutes, and hosts that do not stream reasoning sit silent for the whole
  // thinking phase, so the guard errs long.
  requestTimeoutMs: 600_000,
  // Derived from the model's window rather than fixed: 40k was the same
  // number for a 128k model and a 1M one, and on the big one it meant the
  // trimmer rewrote history that had plenty of room — moving the prefix and
  // costing more in lost cache than it saved in tokens. 0 = half the window.
  maxRequestTokens: 0,
  // The economical profile: 8 kept only the last two exchanges intact, and the
  // third-back tool result still rode along whole on every step. The per-result
  // cap already bounds what is older still, so 4 is where the remaining ~20%
  // came from in the 12-round measurement. The regression to watch for is the
  // model re-reading a file it was working from — raise it back to 8 if a
  // session starts doing that.
  trimKeepRecent: 4,
  trimMinBytes: 400,
  // Off: the cap now applies where the result is produced (toolResultMaxBytes)
  // rather than on the wire. Capping here looked equivalent and was not — a
  // result only becomes eligible once it falls out of the recent tail, so the
  // cut landed in the middle of an already-sent history and everything after
  // it was re-prefilled on that step. One such cut per step is where a 76.7%
  // cache hit-rate came from against a 99% ceiling. Set a number to bring the
  // wire-side cap back.
  maxToolResultBytes: 0,
  // Generous on purpose: a cached token is nearly free, so a result that sits
  // in the history unchanged is paid for once, at prefill. What is expensive
  // is a result that gets rewritten later — and this one never is.
  toolResultMaxBytes: 16_000,
  thinkingRows: 10,
  // No ceiling by default. It was meant to catch runaway loops, but it fired
  // on real work far more often: an audit of a repository is a hundred reads,
  // and being stopped at forty to be told to say "continue" costs more than
  // the loop it guards against — which Esc, the live step counter and
  // auto-compaction already handle. Set a number to put a ceiling back.
  maxSteps: 0,
  toolConcurrency: 4,
  // Late on purpose: compaction loses detail, so it waits until the window is
  // nearly full rather than digesting a history the model can still hold.
  autoCompactAt: 0.9,
  promptCache: true,
  orca: true,
  orcaAgent: "opencode",
  lang: "en",
  skillAuto: true,
  uilibAuto: true,
  // Off, as the comment on the field says: the block and the tool cost tokens
  // on every request, and a project that never uses a skill pays them anyway.
  skillsEnabled: false,
  memoryEnabled: true,
  preset: "standard",
  // Off until a model proves it can write such programs; flip to true in the
  // config when yours does. The token saving is real only if the program works
  // on the first try — a broken one costs a step plus the error, every time.
  codeMode: false,
  codeModeTimeoutMs: 60_000,
  mcpServers: {},
  statusFields: { model: true, tokens: true, steps: true, time: true, speed: true },
  updateCheck: true,
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

/** The config exactly as it sits on disk: no defaults, no environment. */
function readConfigFile(): Partial<Config> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<Config>;
  } catch {
    return {}; // first run, or a file half-written by someone else right now
  }
}

export function loadConfig(): Config {
  if (cached) return cached;
  let file: Partial<Config> = {};
  file = readConfigFile();
  const merged: Config = {
    ...DEFAULTS,
    ...file,
    aliases: { ...DEFAULTS.aliases, ...(file.aliases || {}) },
    pricing: { ...DEFAULTS.pricing, ...(file.pricing || {}) },
    permissions: { ...DEFAULTS.permissions, ...(file.permissions || {}) },
    effortByModel: { ...DEFAULTS.effortByModel, ...(file.effortByModel || {}) },
    contextWindows: { ...DEFAULTS.contextWindows, ...(file.contextWindows || {}) },
    effortForm: { ...DEFAULTS.effortForm, ...(file.effortForm || {}) },
    promptModels: { ...DEFAULTS.promptModels, ...(file.promptModels || {}) },
    subagentModels: { ...DEFAULTS.subagentModels, ...(file.subagentModels || {}) },
    modelPrompts: { ...DEFAULTS.modelPrompts, ...(file.modelPrompts || {}) },
    providerState: { ...DEFAULTS.providerState, ...(file.providerState || {}) },
    projectState: { ...DEFAULTS.projectState, ...(file.projectState || {}) },
    mcpServers: { ...DEFAULTS.mcpServers, ...(file.mcpServers || {}) },
    statusFields: { ...DEFAULTS.statusFields, ...(file.statusFields || {}) },
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
  // The file as it is now, not the copy this process loaded at startup. A
  // session holds its snapshot for hours; saving anything from it — a learned
  // reasoning form, a remembered provider — used to write every other field
  // back with it, silently reverting whatever had changed on disk meanwhile,
  // by hand or by a second session. Only the keys in `patch` may move.
  //
  // It also keeps environment-only values out of the file: loadConfig folds
  // TOKENROUTER_API_KEY into what it returns, and an unrelated save has no
  // business persisting it.
  const current = readConfigFile();
  const replace = new Set(opts.replace ?? []);
  const merge = <T extends object>(key: keyof Config, base: T | undefined, incoming: T | undefined): T =>
    replace.has(key) && incoming !== undefined ? incoming : ({ ...(base ?? {}), ...(incoming ?? {}) } as T);
  const next = {
    ...current,
    ...patch,
    aliases: merge("aliases", current.aliases, patch.aliases),
    pricing: merge("pricing", current.pricing, patch.pricing),
    permissions: merge("permissions", current.permissions, patch.permissions),
    effortByModel: merge("effortByModel", current.effortByModel, patch.effortByModel),
    contextWindows: merge("contextWindows", current.contextWindows, patch.contextWindows),
    effortForm: merge("effortForm", current.effortForm, patch.effortForm),
    promptModels: merge("promptModels", current.promptModels, patch.promptModels),
    subagentModels: merge("subagentModels", current.subagentModels, patch.subagentModels),
    modelPrompts: merge("modelPrompts", current.modelPrompts, patch.modelPrompts),
    providerState: merge("providerState", current.providerState, patch.providerState),
    projectState: merge("projectState", current.projectState, patch.projectState),
    mcpServers: merge("mcpServers", current.mcpServers, patch.mcpServers),
    statusFields: merge("statusFields", current.statusFields, patch.statusFields),
  };
  ensureDir(configDir());
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  // Read back rather than trust what was just written: defaults and the
  // environment belong in what callers see, and in neither case in the file.
  cached = null;
  return loadConfig();
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
 * The worktree a directory belongs to: the nearest ancestor holding a `.git`
 * — a directory in a clone, a file in a linked worktree — else the directory
 * itself. Two worktrees of one repository are two projects, which is the
 * point: they are usually two different tasks.
 */
export function projectRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/** How many projects to remember; the least recently changed fall off. */
const PROJECT_MEMORY = 40;

/** Model and reasoning budget this project was last left on. */
export function projectState(cwd: string): { model?: string; effort?: Effort } {
  return loadConfig().projectState?.[projectKey(projectRoot(cwd))] ?? {};
}

export function rememberProjectState(cwd: string, patch: { model?: string; effort?: Effort }): void {
  const key = projectKey(projectRoot(cwd));
  const cfg = loadConfig();
  const current = cfg.projectState?.[key] ?? {};
  const next = { ...current, ...patch, ts: Date.now() };
  // Opening a project rewrites nothing: only a real change is worth the disk.
  if (current.model === next.model && current.effort === next.effort) return;
  const kept = Object.entries({ ...cfg.projectState, [key]: next })
    .sort((a, b) => (b[1].ts ?? 0) - (a[1].ts ?? 0))
    .slice(0, PROJECT_MEMORY);
  try {
    saveConfig({ projectState: Object.fromEntries(kept) }, { replace: ["projectState"] });
  } catch {
    /* remembering is a convenience, never a reason to fail a switch */
  }
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
