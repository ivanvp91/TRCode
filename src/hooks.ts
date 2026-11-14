/**
 * Automated reactions to what the agent does: lifecycle hooks and the
 * turn-complete notification.
 *
 * Both are configured in two places that merge: the user config
 * (`~/.trcode/config.json`, keys `hooks` and `notify`) and a project file
 * (`.trcode/settings.json` at the repository root), so a team can commit the
 * hooks its project needs. A project file may only add hooks and override
 * `notify` — never permissions or a model.
 *
 * A hook is a shell command. It reads a JSON payload on stdin and speaks
 * through its exit code: 0 continues, 2 blocks what it was asked about and its
 * stderr becomes the reason the model (or the user) is told. Anything else is
 * ignored — a hook that crashed must not take the turn down with it.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir, configPath, loadConfig, projectKey, projectRoot, saveConfig } from "./config.js";
import { killTree, shellLauncher } from "./tools/shell.js";
import type { HookDef, HookEvent, HooksConfig } from "./types.js";

/** How long a hook may run before it is killed. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** What a hook's own output may add to the conversation. */
const OUTPUT_LIMIT = 8_000;

export interface HookPayload {
  cwd: string;
  sessionId?: string;
  model?: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** What the tool produced, for PostToolUse. */
  output?: string;
  /** Why the turn ended, for Stop. */
  stoppedBecause?: string;
  ok?: boolean;
}

export interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the blocking events hand back to their caller. */
export interface HookVerdict {
  blocked: boolean;
  /** Stderr of the hook that blocked — the reason, in the hook's own words. */
  reason: string;
  /** Stdout of every hook that ran, joined: extra context for the model. */
  stdout: string;
  /** True when at least one hook ran. */
  ran: boolean;
}

export interface HookSettings {
  hooks: HooksConfig;
  notify: string[];
  /** Files that contributed, for /hooks. */
  sources: string[];
  /**
   * The project file defines hooks nobody has approved yet. They are not part
   * of `hooks`: a repository that runs commands on this machine needs a yes
   * given for the exact contents of the file, as its MCP servers do.
   */
  pending: { file: string; fingerprint: string; count: number } | null;
}

const EMPTY: HookSettings = { hooks: {}, notify: [], sources: [], pending: null };

let cache: { key: string; value: HookSettings } | null = null;

/**
 * Hooks are off entirely with TRCODE_NO_HOOKS — a test run, or an environment
 * where spawning a shell per tool call is not wanted.
 */
export function hooksDisabled(): boolean {
  return Boolean(process.env.TRCODE_NO_HOOKS);
}

export function projectSettingsPath(cwd: string): string {
  return path.join(projectRoot(cwd), ".trcode", "settings.json");
}

export function resetHookSettings(): void {
  cache = null;
}

function readJson(p: string): Record<string, any> | null {
  try {
    const body = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, any>) : null;
  } catch {
    return null; // missing, or half-written by an editor right now
  }
}

/** A hook list may be written as plain commands or as objects with a matcher. */
function normalizeHooks(raw: unknown): HooksConfig {
  const out: HooksConfig = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [event, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHookEvent(event) || !Array.isArray(value)) continue;
    const defs: HookDef[] = [];
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        defs.push({ command: item });
      } else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const command = typeof o.command === "string" ? o.command.trim() : "";
        if (!command) continue;
        const def: HookDef = { command };
        if (typeof o.matcher === "string" && o.matcher.trim()) def.matcher = o.matcher.trim();
        if (typeof o.timeoutMs === "number" && o.timeoutMs > 0) def.timeoutMs = o.timeoutMs;
        defs.push(def);
      }
    }
    if (defs.length) out[event] = defs;
  }
  return out;
}

export function isHookEvent(name: string): name is HookEvent {
  return (["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact"] as string[]).includes(name);
}

/**
 * Hooks and notify for a project: user config first, then the project file on
 * top. Cached by config path and project-file timestamp — a tool call asks on
 * every hop, and re-reading two small files each time would be felt.
 */
export function hookSettings(cwd: string): HookSettings {
  if (hooksDisabled()) return EMPTY;
  const project = projectSettingsPath(cwd);
  let stamp = "none";
  try {
    const st = fs.statSync(project);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    /* no project settings */
  }
  const key = `${configPath()}|${project}|${stamp}`;
  if (cache?.key === key) return cache.value;

  const cfg = loadConfig();
  const hooks = normalizeHooks((cfg as { hooks?: unknown }).hooks);
  const notify = Array.isArray((cfg as { notify?: unknown }).notify)
    ? ((cfg as { notify: unknown[] }).notify as unknown[]).map(String).filter(Boolean)
    : [];
  const sources: string[] = [];
  if (Object.keys(hooks).length || notify.length) sources.push(configPath());

  const proj = readJson(project);
  let pending: HookSettings["pending"] = null;
  if (proj) {
    const extra = normalizeHooks(proj.hooks);
    const projectNotify = Array.isArray(proj.notify) ? proj.notify.map(String).filter(Boolean) : [];
    const count = Object.values(extra).reduce((n, defs) => n + (defs?.length ?? 0), 0) + (projectNotify.length ? 1 : 0);
    const fingerprint = settingsFingerprint(proj);
    if (count && !isTrusted(cwd, fingerprint)) {
      pending = { file: project, fingerprint, count };
    } else if (count) {
      let touched = false;
      for (const [event, defs] of Object.entries(extra)) {
        const k = event as HookEvent;
        hooks[k] = [...(hooks[k] ?? []), ...defs];
        touched = true;
      }
      if (projectNotify.length) {
        notify.splice(0, notify.length, ...projectNotify);
        touched = true;
      }
      if (touched) sources.push(project);
    }
  }

  const value: HookSettings = { hooks, notify, sources, pending };
  cache = { key, value };
  return value;
}

/** What exactly was agreed to: any edit to the file asks again. */
function settingsFingerprint(raw: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(raw ?? null)).digest("hex").slice(0, 16);
}

function trustKey(cwd: string): string {
  return projectKey(projectRoot(cwd));
}

function isTrusted(cwd: string, fingerprint: string): boolean {
  const prints = loadConfig().hooksTrusted?.[trustKey(cwd)];
  return Array.isArray(prints) && prints.includes(fingerprint);
}

/**
 * Approves this project's settings file exactly as it stands, so its hooks run.
 * `/hooks trust` is the only caller: a cloned repository does not get to run
 * commands here by itself.
 */
export function trustProjectHooks(cwd: string): { ok: boolean; count: number } {
  const proj = readJson(projectSettingsPath(cwd));
  if (!proj) return { ok: false, count: 0 };
  const hooks = normalizeHooks(proj.hooks);
  const count = Object.values(hooks).reduce((n, defs) => n + (defs?.length ?? 0), 0) + (Array.isArray(proj.notify) ? 1 : 0);
  if (!count) return { ok: false, count: 0 };
  const key = trustKey(cwd);
  const prints = loadConfig().hooksTrusted?.[key] ?? [];
  saveConfig({ hooksTrusted: { [key]: [...new Set([...prints, settingsFingerprint(proj)])] } });
  cache = null;
  return { ok: true, count };
}

/** Hooks of one event that apply to this tool (matcher is a regex on its name). */
export function hooksFor(event: HookEvent, cwd: string, tool?: string): HookDef[] {
  const defs = hookSettings(cwd).hooks[event] ?? [];
  const toolEvents = event === "PreToolUse" || event === "PostToolUse";
  return defs.filter((def) => {
    if (!def.matcher) return true;
    if (!toolEvents || !tool) return false;
    try {
      return new RegExp(def.matcher, "i").test(tool);
    } catch {
      return false; // a broken pattern matches nothing rather than everything
    }
  });
}

function clip(s: string): string {
  return s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n… [hook output truncated]` : s;
}

/**
 * A hook speaks through its exit code, and PowerShell does not pass one on: a
 * native command that exits 2 leaves the shell exiting 1, which would turn
 * every refusal into an unrelated failure. The code is handed over explicitly.
 */
function exitAware(command: string, shell: string): string {
  const name = path.basename(shell).toLowerCase();
  if (name === "cmd.exe") return `${command} & exit /b %errorlevel%`;
  if (name.startsWith("powershell") || name.startsWith("pwsh")) return `${command}\nexit $LASTEXITCODE`;
  return `${command}\nexit $?`;
}

/** Runs one hook command and waits for it. Never throws. */
export function runHook(def: HookDef, event: HookEvent, payload: HookPayload, signal?: AbortSignal): Promise<HookResult> {
  const { cmd, args } = shellLauncher();
  const json = JSON.stringify({ event, ...payload });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: clip(stdout), stderr: clip(stderr) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args(exitAware(def.command, cmd)), {
        cwd: payload.cwd,
        env: {
          ...process.env,
          TRCODE_EVENT: event,
          TRCODE_CWD: payload.cwd,
          TRCODE_TOOL: payload.tool ?? "",
          TRCODE_SESSION_ID: payload.sessionId ?? "",
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: (err as Error).message });
      return;
    }
    // A hook that outlives its welcome is killed, and the kill is not a block:
    // an event that must not stall a turn (PreToolUse) simply continues.
    timer = setTimeout(() => {
      killTree(child);
      finish(-1);
    }, def.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += (err as Error).message;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
    if (signal) {
      if (signal.aborted) return void (killTree(child), finish(-1));
      signal.addEventListener("abort", () => (killTree(child), finish(-1)), { once: true });
    }
    child.stdin?.end(json);
  });
}

/**
 * Runs every hook of an event in order and stops at the first block. Blocking
 * events (PreToolUse, UserPromptSubmit, PostToolUse) go through here.
 */
export async function runHookEvent(event: HookEvent, payload: HookPayload, signal?: AbortSignal): Promise<HookVerdict> {
  const defs = hooksFor(event, payload.cwd, payload.tool);
  const verdict: HookVerdict = { blocked: false, reason: "", stdout: "", ran: false };
  for (const def of defs) {
    if (signal?.aborted) break;
    const res = await runHook(def, event, payload, signal);
    verdict.ran = true;
    if (res.stdout.trim()) verdict.stdout = [verdict.stdout, res.stdout.trim()].filter(Boolean).join("\n");
    if (res.code === 2) {
      verdict.blocked = true;
      verdict.reason = (res.stderr.trim() || res.stdout.trim() || "blocked by a hook").slice(0, 2_000);
      return verdict;
    }
  }
  return verdict;
}

/**
 * Runs an event nobody waits for. The promise is dropped on purpose: a turn
 * that has just ended must not sit on a notification script, and a hook that
 * hangs must not hold the process open (the timeout still kills it).
 */
export function fireHookEvent(event: HookEvent, payload: HookPayload): void {
  const defs = hooksFor(event, payload.cwd, payload.tool);
  for (const def of defs) void runHook(def, event, payload).catch(() => undefined);
}

/**
 * The turn-complete notification: an external command given the payload as its
 * last argument, the way Codex does it — `notify = ["nircmd", "beep"]` or a
 * script that reads argv and pops a toast.
 */
export function fireNotify(payload: HookPayload & { ok: boolean; lastMessage?: string }): void {
  const settings = hookSettings(payload.cwd);
  if (!settings.notify.length) return;
  const [cmd, ...args] = settings.notify;
  if (!cmd) return;
  const json = JSON.stringify({
    type: "agent-turn-complete",
    cwd: payload.cwd,
    sessionId: payload.sessionId ?? null,
    model: payload.model ?? null,
    ok: payload.ok,
    stoppedBecause: payload.stoppedBecause ?? null,
    lastAssistantMessage: (payload.lastMessage ?? "").slice(0, 4_000),
  });
  try {
    const child = spawn(cmd, [...args, json], { cwd: payload.cwd, windowsHide: true, stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* a notification is never a reason to fail a turn */
  }
}
