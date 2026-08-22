/**
 * MCP (Model Context Protocol) client, stdio transport.
 *
 * Any server that Claude Code can launch — TradingView, MetaTrader, databases —
 * plugs in here with the same config shape: id → {command, args, env}. Each
 * server's tools join the registry as `mcp__<id>__<tool>` under the `network`
 * permission, so the existing broker asks before every call unless the user
 * has allowed it.
 *
 * Servers start in the background at session start; a slow `npx` install must
 * not hold the prompt hostage. Until one is ready its tools simply are not in
 * the registry, and the caller is told when to rebuild.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, VERSION } from "../config.js";
import type { McpServerConfig, ToolDef, ToolResult } from "../types.js";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type McpState = "starting" | "ready" | "failed" | "stopped";

/** `npx`/`uvx` may download the package on first run; a real minute happens. */
const INIT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 120_000;

export class McpClient {
  state: McpState = "starting";
  /** Server name when ready, the failure reason otherwise. */
  detail = "";
  tools: McpToolInfo[] = [];
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  /** Last stderr lines, for the failure message — servers log their crashes there. */
  private stderrTail: string[] = [];

  constructor(
    readonly id: string,
    readonly cfg: McpServerConfig,
  ) {}

  async start(): Promise<void> {
    try {
      const opts = {
        cwd: this.cfg.cwd,
        env: { ...process.env, ...(this.cfg.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
        windowsHide: true,
      };
      // npx, uvx and friends are .cmd shims on Windows, which only a shell can
      // start. Real executables spawn directly — going through cmd.exe would
      // break on the unquoted spaces of a path like "C:\Program Files\...".
      const viaShell = process.platform === "win32" && !isDirectlySpawnable(this.cfg.command);
      this.proc = viaShell
        ? spawn([quoteWin(this.cfg.command), ...(this.cfg.args ?? []).map(quoteWin)].join(" "), {
            ...opts,
            shell: true,
          })
        : spawn(this.cfg.command, this.cfg.args ?? [], opts);
    } catch (err) {
      this.fail((err as Error).message);
      return;
    }

    this.proc.stdout?.on("data", (b: Buffer) => this.onData(b.toString("utf8")));
    this.proc.stderr?.on("data", (b: Buffer) => {
      for (const l of b.toString("utf8").split("\n")) {
        if (!l.trim()) continue;
        this.stderrTail.push(l.trim());
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });
    this.proc.on("error", (err) => this.fail(err.message));
    this.proc.on("exit", (code) => {
      if (this.state === "ready" || this.state === "starting") {
        const hint = this.stderrTail.slice(-2).join(" · ");
        this.fail(`exited (code ${code ?? "?"})${hint ? ` — ${hint}` : ""}`);
      }
    });

    try {
      const init = await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "trcode", version: VERSION },
        },
        INIT_TIMEOUT_MS,
      );
      this.notify("notifications/initialized", {});
      const listed = await this.request("tools/list", {}, INIT_TIMEOUT_MS);
      let tools: McpToolInfo[] = Array.isArray(listed?.tools) ? listed.tools : [];
      if (this.cfg.tools?.length) {
        const allow = new Set(this.cfg.tools);
        tools = tools.filter((t) => allow.has(t.name));
      }
      this.tools = tools;
      this.detail = String(init?.serverInfo?.name ?? "");
      this.state = "ready";
    } catch (err) {
      this.fail((err as Error).message);
      this.stop();
    }
  }

  private fail(detail: string): void {
    if (this.state === "failed") return;
    this.state = "failed";
    this.detail = detail;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(detail));
    }
    this.pending.clear();
  }

  /** Newline-delimited JSON-RPC; anything unparseable is a server's stray log. */
  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const raw = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!raw) continue;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error.message ?? "MCP error")));
        else p.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        // A server-initiated request (sampling, roots): refused, not ignored —
        // leaving it unanswered would hang the server's own loop.
        this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by trcode" } });
      }
    }
  }

  private send(msg: unknown): void {
    try {
      this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
    } catch {
      /* a dead pipe surfaces through the exit handler */
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.state === "failed" || this.state === "stopped") {
      return Promise.reject(new Error(this.detail || "server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.state !== "ready") {
      return {
        output: `MCP server "${this.id}" is ${this.state}${this.detail ? `: ${this.detail}` : ""}.`,
        isError: true,
      };
    }
    const call = this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS);
    let result: any;
    try {
      result = signal ? await Promise.race([call, abortPromise(signal)]) : await call;
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      return { output: `MCP call failed: ${(err as Error).message}`, isError: true };
    }
    const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
    const text = blocks
      .map((b) => (b?.type === "text" ? String(b.text ?? "") : `[${String(b?.type ?? "unknown")} content omitted]`))
      .join("\n")
      .trim();
    return { output: text || "(empty result)", isError: Boolean(result?.isError) };
  }

  stop(): void {
    if (this.state !== "failed") {
      this.state = "stopped";
      if (!this.detail) this.detail = "stopped";
    }
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.proc = null;
  }
}

// ── registry ─────────────────────────────────────────────────────────────────

const clients = new Map<string, McpClient>();
let exitHook = false;

/**
 * Global config plus the project's `.trcode/mcp.json` (either Claude Code's
 * `{"mcpServers": {...}}` wrapper or the bare map); the project wins on a
 * shared id.
 */
export function mcpServerConfigs(cwd: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = { ...(loadConfig().mcpServers ?? {}) };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, ".trcode", "mcp.json"), "utf8"));
    const map = raw && typeof raw === "object" ? (raw.mcpServers ?? raw) : null;
    if (map && typeof map === "object") Object.assign(out, map);
  } catch {
    /* optional file */
  }
  return out;
}

/**
 * Launches every configured server that is not already running. `onSettled`
 * fires once per server when it becomes ready or fails — rebuild the tool
 * registry there.
 */
/**
 * Connections still coming up. The tool block sits in front of the whole
 * history, so a server that joins the registry *after* a request has gone out
 * rewrites the prefix of every later one — the cache for the session is gone
 * for the sake of a server that was ten seconds late. Waited out once, before
 * the first request; see mcpSettled.
 */
const pending = new Set<Promise<unknown>>();

export function mcpPendingCount(): number {
  return pending.size;
}

/**
 * Resolves when every server that is starting has either come up or failed —
 * or when the wait has gone on long enough that a cold `npx` is no longer
 * worth holding the turn for. Resolves immediately when nothing is pending,
 * which is every turn after the first.
 */
export function mcpSettled(timeoutMs = 15_000): Promise<void> {
  if (!pending.size) return Promise.resolve();
  return Promise.race([
    Promise.allSettled([...pending]).then(() => undefined),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}

export function connectMcpServers(cwd: string, onSettled: (client: McpClient) => void): void {
  for (const [id, cfg] of Object.entries(mcpServerConfigs(cwd))) {
    if (clients.has(id) || !cfg?.command) continue;
    const client = new McpClient(id, cfg);
    clients.set(id, client);
    if (!exitHook) {
      exitHook = true;
      process.on("exit", () => {
        for (const c of clients.values()) c.stop();
      });
    }
    const started = client.start().then(() => onSettled(client));
    pending.add(started);
    void started.finally(() => pending.delete(started));
  }
}

export function mcpClients(): McpClient[] {
  return [...clients.values()];
}

export function stopMcpServers(): void {
  for (const c of clients.values()) c.stop();
  clients.clear();
}

/** Tool defs for every ready server, for the registry. */
export function mcpToolDefs(): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const client of clients.values()) {
    if (client.state !== "ready") continue;
    for (const t of client.tools) defs.push(toToolDef(client, t));
  }
  return defs;
}

/** Provider APIs allow [a-zA-Z0-9_-] in tool names, 64 chars at most. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toToolDef(client: McpClient, t: McpToolInfo): ToolDef {
  const def: ToolDef = {
    name: `mcp__${sanitize(client.id)}__${sanitize(t.name)}`.slice(0, 64),
    description: String(t.description ?? "").trim() || `${t.name} on the "${client.id}" MCP server`,
    parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    risk: "network",
    summarize: (args) => {
      const s = JSON.stringify(args ?? {});
      return s === "{}" ? client.id : s.length > 60 ? s.slice(0, 59) + "…" : s;
    },
    async run(args, ctx) {
      const ok = await ctx.confirm(def, args);
      if (!ok) return { output: "The user rejected the call.", isError: true };
      return client.callTool(t.name, args, ctx.signal);
    },
  };
  return def;
}

/** True when Windows can start it without a shell: a real executable, not a .cmd shim. */
function isDirectlySpawnable(command: string): boolean {
  if (/\.(exe|com)$/i.test(command)) return true;
  if (/\.(cmd|bat)$/i.test(command)) return false;
  // A bare name ("npx", "python"): only a shell resolves the .cmd variants,
  // and it handles the .exe ones too, so the shell is the safe route. An
  // extensionless absolute path is a script by convention — shell as well.
  return false;
}

/** cmd.exe quoting for the one shape that breaks in practice: embedded spaces. */
function quoteWin(s: string): string {
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}
