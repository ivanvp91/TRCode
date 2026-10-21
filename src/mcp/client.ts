/**
 * MCP (Model Context Protocol) client: stdio and Streamable HTTP.
 *
 * Any server that Claude Code can launch plugs in with the same config shape
 * (`id → {command, args, env}` or `{url, headers}`), and its tools join the
 * registry as `mcp__<id>__<tool>`. Servers start in the background at session
 * start; a slow `npx` install must not hold the prompt hostage.
 *
 * What this client gets right, because each of these was a bug we had: process
 * trees are killed through `killTree`, tool schemas
 * are compacted to a byte budget, `tools/list_changed` re-lists the catalog
 * instead of waiting for `/mcp reload`, lists are paginated, a session the
 * HTTP server forgot is re-established and the call replayed, and results
 * carry images and structured content instead of dropping them.
 *
 * Protocol denominations: "legacy" (default) speaks `initialize`; "auto"
 * probes `server/discover` first and falls back; "2026-07-28" insists on the
 * stateless revision, where every request carries `_meta`.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, VERSION } from "../config.js";
import type { ImageAttachment, McpServerConfig, ToolDef, ToolResult } from "../types.js";
import { compactSchema, DEFAULT_SCHEMA_MAX_BYTES } from "./schema.js";
import { StdioTransport, expandEnv, type McpTransport, delay } from "./transport.js";
import { HttpTransport, SessionExpiredError } from "./http.js";

export interface McpToolInfo {
  name: string;
  description?: string;
  /** Already compacted to the server's byte budget. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateInfo {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export type McpState = "starting" | "ready" | "failed" | "stopped";

const LEGACY_VERSION = "2025-06-18";
const MODERN_VERSION = "2026-07-28";
const CLIENT_CAPABILITIES = { roots: { listChanged: false } };
const CLIENT_INFO = { name: "trcode", version: VERSION };

/** A cold `npx` may download the package; a real minute happens. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
/** A build, a scrape, a scan: long, but not endless. */
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_LIMIT = 100_000;
const MAX_DESCRIPTION_CHARS = 2_000;
/** ~1.5 MB of base64; larger images are described rather than attached. */
const MAX_IMAGE_CHARS = 2_000_000;
/** Retry shape for handshake and catalog calls. */
const RETRY_DELAYS = [250, 1_000];
const MAX_PAGES = 100;
const CATALOG_REFRESH_DEBOUNCE_MS = 300;
const STDERR_TAIL = 200;

export type McpProgress = { progress: number; total?: number; message?: string };

export class McpClient {
  state: McpState = "starting";
  /** Server name when ready, the failure reason otherwise. */
  detail = "";
  tools: McpToolInfo[] = [];
  resources: McpResourceInfo[] = [];
  resourceTemplates: McpResourceTemplateInfo[] = [];
  /** What the server said it can do, from `initialize` / `server/discover`. */
  capabilities: Record<string, any> = {};
  protocolVersion = "";

  /** Set by the registry: the catalog changed and the tool list must be rebuilt. */
  onCatalogChanged?: (client: McpClient) => void;
  /** Set by the registry: the transport died on its own. */
  onCrash?: (client: McpClient) => void;

  private transport: McpTransport | null = null;
  private nextId = 1;
  private modern = false;
  private closing = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private progress = new Map<string, (p: McpProgress) => void>();
  private logRing: string[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;

  constructor(
    readonly id: string,
    readonly cfg: McpServerConfig,
  ) {}

  get startupTimeout(): number {
    return (this.cfg.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_MS / 1000) * 1000;
  }

  get toolTimeout(): number {
    return (this.cfg.toolTimeoutSec ?? DEFAULT_TOOL_TIMEOUT_MS / 1000) * 1000;
  }

  get supportsResources(): boolean {
    return Boolean(this.capabilities.resources) || this.resources.length > 0;
  }

  /** Last lines the server logged or wrote to stderr, newest last. */
  logTail(limit = 20): string[] {
    return this.logRing.slice(-limit);
  }

  async start(): Promise<void> {
    if (this.cfg.enabled === false) {
      this.state = "stopped";
      this.detail = "disabled";
      return;
    }
    try {
      this.transport = this.makeTransport();
      this.transport.onMessage = (msg) => this.onMessage(msg);
      this.transport.onExit = (detail) => this.onTransportExit(detail);
      this.transport.onStderr = (line) => this.pushLog(line);
      await this.transport.start();
      await this.handshake();
      await this.loadCatalog();
      this.state = "ready";
      this.detail = this.serverName || this.id;
    } catch (err) {
      this.fail((err as Error).message);
      await this.close();
    }
  }

  /** Re-run the handshake and the catalog against a live transport. */
  async reconnect(): Promise<void> {
    this.rejectPending("reconnecting");
    await this.handshake();
    await this.loadCatalog();
    this.state = "ready";
  }

  private makeTransport(): McpTransport {
    const cfg = this.cfg;
    if (cfg.url) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(cfg.headers ?? {})) headers[key] = expandEnv(value);
      let token = cfg.bearerToken ? expandEnv(cfg.bearerToken) : undefined;
      if (!token && cfg.bearerTokenEnvVar) {
        token = process.env[cfg.bearerTokenEnvVar];
        if (!token) throw new Error(`environment variable ${cfg.bearerTokenEnvVar} is not set`);
      }
      const transport = new HttpTransport(expandEnv(cfg.url), headers, token);
      transport.protocolVersion = this.protocolVersion;
      return transport;
    }
    if (!cfg.command) throw new Error("either command (stdio) or url (Streamable HTTP) is required");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(cfg.env ?? {})) env[key] = expandEnv(value);
    return new StdioTransport(expandEnv(cfg.command), (cfg.args ?? []).map((arg) => expandEnv(arg)), {
      env,
      cwd: cfg.cwd,
    });
  }

  private get serverName(): string {
    return this.detailFromHandshake;
  }
  private detailFromHandshake = "";

  private async handshake(): Promise<void> {
    const mode = this.cfg.protocol ?? "legacy";
    this.modern = false;
    if (mode !== "legacy") {
      try {
        await this.discover();
        return;
      } catch (err) {
        this.pushLog(`server/discover failed: ${(err as Error).message}`);
        if (mode === MODERN_VERSION) throw new Error(`server/discover failed: ${(err as Error).message}`);
        // "auto": an old server is the expected case, not a failure.
      }
    }
    const init = await this.request("initialize", {
      protocolVersion: LEGACY_VERSION,
      capabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    }, this.startupTimeout);
    this.capabilities = init?.capabilities && typeof init.capabilities === "object" ? init.capabilities : {};
    this.detailFromHandshake = String(init?.serverInfo?.name ?? "");
    this.protocolVersion = String(init?.protocolVersion ?? LEGACY_VERSION);
    this.syncTransportVersion();
    this.notify("notifications/initialized", {});
  }

  private async discover(): Promise<void> {
    this.modern = true;
    try {
      const res = await this.request("server/discover", {}, this.startupTimeout);
      const versions: string[] = Array.isArray(res?.supportedVersions) ? res.supportedVersions.map(String) : [];
      if (versions.length && !versions.includes(MODERN_VERSION)) {
        throw new Error(`server supports ${versions.join(", ")}`);
      }
      this.capabilities = res?.capabilities && typeof res.capabilities === "object" ? res.capabilities : {};
      this.detailFromHandshake = String(res?.serverInfo?.name ?? "");
      this.protocolVersion = MODERN_VERSION;
      this.syncTransportVersion();
    } catch (err) {
      this.modern = false;
      throw err;
    }
  }

  private syncTransportVersion(): void {
    if (this.transport) this.transport.protocolVersion = this.protocolVersion;
  }

  // ── catalog ────────────────────────────────────────────────────────────────

  private async loadCatalog(): Promise<void> {
    await this.loadTools();
    try {
      await this.loadResources();
    } catch (err) {
      // A tool-only server that still advertises resources is common enough;
      // losing the startup over it would be worse than an empty list.
      this.pushLog(`resources/list failed: ${(err as Error).message}`);
      this.resources = [];
      this.resourceTemplates = [];
    }
  }

  private async loadTools(): Promise<void> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request("tools/list", cursor ? { cursor } : {}, this.startupTimeout, { retries: true });
      const listed: any[] = Array.isArray(res?.tools) ? res.tools : [];
      for (const raw of listed) {
        const tool = this.mapTool(raw);
        if (tool) tools.push(tool);
      }
      cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    this.tools = tools;
  }

  private async loadResources(): Promise<void> {
    if (!this.capabilities.resources) {
      this.resources = [];
      this.resourceTemplates = [];
      return;
    }
    const resources: McpResourceInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request("resources/list", cursor ? { cursor } : {}, this.startupTimeout);
      for (const raw of Array.isArray(res?.resources) ? res.resources : []) {
        if (!raw?.uri) continue;
        resources.push({
          uri: String(raw.uri),
          name: raw.name ? String(raw.name) : undefined,
          description: raw.description ? String(raw.description) : undefined,
          mimeType: raw.mimeType ? String(raw.mimeType) : undefined,
        });
      }
      cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    this.resources = resources;

    const templates: McpResourceTemplateInfo[] = [];
    try {
      cursor = undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await this.request("resources/templates/list", cursor ? { cursor } : {}, this.startupTimeout);
        for (const raw of Array.isArray(res?.resourceTemplates) ? res.resourceTemplates : []) {
          if (!raw?.uriTemplate) continue;
          templates.push({
            uriTemplate: String(raw.uriTemplate),
            name: raw.name ? String(raw.name) : undefined,
            description: raw.description ? String(raw.description) : undefined,
            mimeType: raw.mimeType ? String(raw.mimeType) : undefined,
          });
        }
        cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
        if (!cursor) break;
      }
    } catch {
      /* templates are optional */
    }
    this.resourceTemplates = templates;
  }

  private mapTool(raw: any): McpToolInfo | null {
    if (!raw || typeof raw.name !== "string" || !raw.name) return null;
    if (this.cfg.tools?.length && !this.cfg.tools.includes(raw.name)) return null;
    if (this.cfg.enabledTools?.length && !this.cfg.enabledTools.includes(raw.name)) return null;
    if (this.cfg.disabledTools?.includes(raw.name)) return null;
    const budget = this.cfg.toolInputSchemaMaxBytes ?? DEFAULT_SCHEMA_MAX_BYTES;
    return {
      name: raw.name,
      description: truncate(String(raw.description ?? "").trim(), MAX_DESCRIPTION_CHARS),
      inputSchema: compactSchema(raw.inputSchema, budget),
      outputSchema: raw.outputSchema && typeof raw.outputSchema === "object" ? raw.outputSchema : undefined,
      annotations: raw.annotations && typeof raw.annotations === "object" ? raw.annotations : undefined,
    };
  }

  /** Re-list after `tools/list_changed`; the previous catalog survives a failure. */
  private scheduleCatalogRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshCatalog();
    }, CATALOG_REFRESH_DEBOUNCE_MS);
    this.refreshTimer.unref?.();
  }

  private async refreshCatalog(): Promise<void> {
    if (this.refreshing || this.state !== "ready") return;
    this.refreshing = true;
    try {
      await this.loadTools();
      try {
        await this.loadResources();
      } catch (err) {
        this.pushLog(`resources/list failed: ${(err as Error).message}`);
      }
      this.onCatalogChanged?.(this);
    } catch (err) {
      this.pushLog(`catalog refresh failed, keeping the old one: ${(err as Error).message}`);
    } finally {
      this.refreshing = false;
    }
  }

  // ── calls ──────────────────────────────────────────────────────────────────

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: AbortSignal | { signal?: AbortSignal; onProgress?: (p: McpProgress) => void; timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    if (this.state !== "ready") {
      return {
        output: `MCP server "${this.id}" is ${this.state}${this.detail ? `: ${this.detail}` : ""}.`,
        isError: true,
      };
    }
    const opts = isAbortSignal(options) ? { signal: options } : options;
    try {
      return await this.performCall(name, args, opts);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // The server forgot the session (restart, load balancer, GC). One
        // re-initialisation and a replay; without that the rest of the
        // session is a string of mysterious 404s.
        try {
          await this.reconnect();
          return await this.performCall(name, args, opts);
        } catch (again) {
          return { output: `MCP call failed: ${(again as Error).message}`, isError: true };
        }
      }
      if ((err as Error)?.name === "AbortError") throw err;
      return { output: `MCP call failed: ${(err as Error).message}`, isError: true };
    }
  }

  private async performCall(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; onProgress?: (p: McpProgress) => void; timeoutMs?: number },
  ): Promise<ToolResult> {
    const signal = opts.signal;
    signal?.throwIfAborted();
    const progressToken = opts.onProgress ? `progress-${this.nextId}` : undefined;
    if (progressToken && opts.onProgress) this.progress.set(progressToken, opts.onProgress);

    const timeoutMs = opts.timeoutMs ?? this.toolTimeout;
    const { id, promise } = this.begin(
      "tools/call",
      { name, arguments: args ?? {}, ...(progressToken ? { _meta: { progressToken } } : {}) },
      timeoutMs,
    );
    const onAbort = () => {
      this.notify("notifications/cancelled", { requestId: id, reason: "aborted by the user" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let result: any;
    try {
      result = signal ? await Promise.race([promise, abortPromise(signal)]) : await promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (progressToken) this.progress.delete(progressToken);
    }
    return this.toToolResult(result);
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<ToolResult> {
    if (this.state !== "ready") {
      return { output: `MCP server "${this.id}" is ${this.state}${this.detail ? `: ${this.detail}` : ""}.`, isError: true };
    }
    try {
      const { promise } = this.begin("resources/read", { uri }, this.toolTimeout);
      const result: any = signal ? await Promise.race([promise, abortPromise(signal)]) : await promise;
      const blocks: any[] = Array.isArray(result?.contents) ? result.contents : [];
      const text = blocks
        .map((b) => {
          if (typeof b?.text === "string") return b.text;
          if (typeof b?.blob === "string") return `[binary ${String(b?.mimeType ?? "content")}, ${b.blob.length} base64 chars]`;
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      return { output: this.limit(text || "(empty resource)"), isError: false };
    } catch (err) {
      return { output: `MCP resource read failed: ${(err as Error).message}`, isError: true };
    }
  }

  private toToolResult(result: any): ToolResult {
    const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
    const parts: string[] = [];
    const images: ImageAttachment[] = [];
    for (const block of blocks) {
      switch (block?.type) {
        case "text":
          parts.push(String(block.text ?? ""));
          break;
        case "image": {
          const data = typeof block.data === "string" ? block.data : "";
          const mime = String(block.mimeType ?? "image/png");
          if (data && data.length <= MAX_IMAGE_CHARS && /^image\//.test(mime)) images.push({ data, mime });
          else parts.push(`[image ${mime}${data ? `, ${data.length} base64 chars` : ""} omitted]`);
          break;
        }
        case "audio":
          parts.push(`[audio ${String(block.mimeType ?? "audio")} omitted — this client reads images, not sound]`);
          break;
        case "resource": {
          const res = block.resource ?? {};
          const body = typeof res.text === "string" ? res.text : `[binary ${String(res.mimeType ?? "resource")}]`;
          parts.push(`${String(res.uri ?? "resource")}\n${body}`);
          break;
        }
        case "resource_link":
          parts.push(`[resource ${String(block.name ?? "")} → ${String(block.uri ?? "")}]`);
          break;
        default:
          parts.push(`[${String(block?.type ?? "unknown")} content omitted]`);
      }
    }
    if (result?.structuredContent !== undefined) {
      try {
        parts.push("```json\n" + JSON.stringify(result.structuredContent, null, 2) + "\n```");
      } catch {
        /* unrepresentable structured content is not worth failing over */
      }
    }
    const output = this.limit(parts.join("\n").trim() || "(empty result)");
    const res: ToolResult = { output, isError: Boolean(result?.isError) };
    if (images.length) res.images = images;
    return res;
  }

  async listResources(): Promise<McpResourceInfo[]> {
    if (this.state === "ready" && !this.resources.length && this.supportsResources) {
      try {
        await this.loadResources();
      } catch {
        /* keep the empty list */
      }
    }
    return this.resources;
  }

  readOnly(): boolean {
    return this.state === "ready";
  }

  // ── transport plumbing ─────────────────────────────────────────────────────

  private notify(method: string, params: unknown): void {
    const body = this.withMeta(params);
    void this.transport?.send({ jsonrpc: "2.0", method, params: body }, this.startupTimeout).catch(() => {});
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts: { retries?: boolean } = {},
  ): Promise<any> {
    const attempts = opts.retries ? RETRY_DELAYS.length + 1 : 1;
    return (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.begin(method, params, timeoutMs).promise;
        } catch (err) {
          const retryable = isRetryable(err) && !(err instanceof SessionExpiredError);
          if (!opts.retries || !retryable || attempt >= attempts - 1) throw err;
          await delay(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]);
        }
      }
    })();
  }

  private begin(method: string, params: unknown, timeoutMs: number): { id: number; promise: Promise<any> } {
    if (this.state === "failed" || this.state === "stopped") {
      return { id: -1, promise: Promise.reject(new Error(this.detail || "server is not running")) };
    }
    const transport = this.transport;
    if (!transport) return { id: -1, promise: Promise.reject(new Error("the MCP transport is closed")) };
    const id = this.nextId++;
    const body = this.withMeta(params);
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      void transport.send({ jsonrpc: "2.0", id, method, params: body }, timeoutMs).catch((err) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(err as Error);
      });
    });
    return { id, promise };
  }

  /** Every request carries version and client identity in the 2026-07-28 revision. */
  private withMeta(params: unknown): unknown {
    if (!this.modern) return params ?? {};
    const base = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const meta = {
      ...((base._meta as Record<string, unknown>) ?? {}),
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientCapabilities": CLIENT_CAPABILITIES,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    };
    return { ...base, _meta: meta };
  }

  private onMessage(msg: any): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? `MCP error ${msg.error.code ?? ""}`)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // A server-initiated request (sampling, roots, elicitation): refused, not
      // ignored — leaving it unanswered would hang the server's own loop.
      void this.transport
        ?.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by trcode" } })
        .catch(() => {});
      return;
    }
    switch (msg.method) {
      case "notifications/tools/list_changed":
      case "notifications/resources/list_changed":
        this.scheduleCatalogRefresh();
        break;
      case "notifications/progress": {
        const token = msg.params?.progressToken;
        const handler = this.progress.get(String(token));
        if (handler) {
          handler({
            progress: Number(msg.params?.progress ?? 0),
            total: typeof msg.params?.total === "number" ? msg.params.total : undefined,
            message: msg.params?.message ? String(msg.params.message) : undefined,
          });
        }
        break;
      }
      case "notifications/message":
        this.pushLog(String(msg.params?.data?.message ?? msg.params?.data ?? "").slice(0, 2000));
        break;
      default:
        break;
    }
  }

  private onTransportExit(detail: string): void {
    if (this.closing || this.state === "stopped") return;
    const hint = this.logRing.slice(-2).join(" · ");
    this.fail(`${detail}${hint ? ` — ${hint}` : ""}`);
    this.onCrash?.(this);
  }

  private pushLog(line: string): void {
    if (!line) return;
    this.logRing.push(line.slice(0, 2000));
    if (this.logRing.length > STDERR_TAIL) this.logRing.shift();
  }

  private limit(text: string): string {
    const max = this.cfg.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n… ${text.length - max} characters cut (mcpServers["${this.id}"].outputLimit)`;
  }

  private fail(detail: string): void {
    if (this.state === "failed") return;
    this.state = "failed";
    this.detail = detail;
    this.rejectPending(detail);
  }

  private rejectPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.state !== "failed") {
      this.state = "stopped";
      if (!this.detail) this.detail = "stopped";
    }
    this.rejectPending("server stopped");
    const transport = this.transport;
    this.transport = null;
    await transport?.close();
  }

  /** Fire-and-forget stop, kept for callers that have no place to await. */
  stop(): void {
    void this.close();
  }
}

// ── registry ─────────────────────────────────────────────────────────────────

const clients = new Map<string, McpClient>();
const cwds = new Map<string, string>();
const restarts = new Map<string, number>();
const listeners = new Set<(client: McpClient) => void>();
let exitHook = false;
const MAX_RESTARTS = 5;

/**
 * Called whenever a server's catalog changes (a `list_changed` notification
 * added or removed tools). The REPL rebuilds the registry from it.
 */
export function onMcpCatalogChange(listener: (client: McpClient) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

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
export function mcpSettled(timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
  if (!pending.size || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
    void Promise.allSettled([...pending]).then(done);
  });
}

/**
 * Launches every configured server that is not already running. `onSettled`
 * fires once per server when it becomes ready or fails — rebuild the tool
 * registry there.
 */
export function connectMcpServers(cwd: string, onSettled: (client: McpClient) => void): void {
  for (const [id, cfg] of Object.entries(mcpServerConfigs(cwd))) {
    if (clients.has(id)) continue;
    if (cfg?.enabled === false) continue;
    if (!cfg?.command && !cfg?.url) continue;
    const client = new McpClient(id, cfg);
    cwds.set(id, cwd);
    clients.set(id, client);
    client.onCatalogChanged = (c) => {
      for (const listener of listeners) listener(c);
    };
    client.onCrash = () => scheduleRestart(id);
    if (!exitHook) {
      exitHook = true;
      process.on("exit", () => {
        for (const c of clients.values()) c.stop();
      });
    }
    const started = client.start().then(() => {
      if (client.state === "ready") restarts.delete(id);
      onSettled(client);
    });
    pending.add(started);
    void started.finally(() => pending.delete(started));
  }
}

/** Stop one server and start a fresh process for the same config. */
export async function restartMcpServer(id: string): Promise<McpClient | null> {
  const cfg = clients.get(id)?.cfg;
  const cwd = cwds.get(id);
  if (!cfg || !cwd) return null;
  const old = clients.get(id);
  clients.delete(id);
  await old?.close();
  const client = new McpClient(id, cfg);
  clients.set(id, client);
  client.onCatalogChanged = (c) => {
    for (const listener of listeners) listener(c);
  };
  client.onCrash = () => scheduleRestart(id);
  await client.start();
  if (client.state === "ready") restarts.delete(id);
  return client;
}

function scheduleRestart(id: string): void {
  const attempt = (restarts.get(id) ?? 0) + 1;
  if (attempt > MAX_RESTARTS) return;
  restarts.set(id, attempt);
  const wait = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  const timer = setTimeout(() => {
    void restartMcpServer(id).then((client) => {
      if (client && client.state !== "ready") scheduleRestart(id);
    });
  }, wait);
  timer.unref?.();
}

export function mcpClients(): McpClient[] {
  return [...clients.values()];
}

export function stopMcpServers(): void {
  for (const c of clients.values()) c.stop();
  clients.clear();
  cwds.clear();
  restarts.clear();
  activated.clear();
}

// ── tool defs ────────────────────────────────────────────────────────────────

/** Tool defs for every ready server, plus the resource readers they enable. */
export function mcpToolDefs(): ToolDef[] {
  const search = loadConfig().mcpToolSearch === true;
  const defs: ToolDef[] = [];
  for (const client of clients.values()) {
    if (client.state !== "ready") continue;
    for (const t of client.tools) {
      // In search mode a schema is sent only after the model asked for it.
      if (search && !activated.has(toolKey(client.id, t.name))) continue;
      defs.push(toToolDef(client, t));
    }
  }
  defs.push(...resourceTools());
  if (search) {
    const finder = findToolsDef();
    if (finder) defs.push(finder);
  }
  return defs;
}

/**
 * Deferred tool loading: a dozen MCP servers would
 * otherwise put every schema in every request, and most of them are never
 * called. One search tool stands in, and the matches join the registry as
 * soon as they are asked for.
 */
const activated = new Set<string>();
const MAX_ACTIVATED = 64;

function toolKey(server: string, tool: string): string {
  return `${server}\u0000${tool}`;
}

function findToolsDef(): ToolDef | null {
  const ready = [...clients.values()].filter((c) => c.state === "ready" && c.tools.length);
  if (!ready.length) return null;
  const def: ToolDef = {
    name: "find_mcp_tools",
    description:
      "Search the connected MCP servers for a tool by name or purpose (\"issue\", \"quote\", \"database query\"). Matching tools become callable immediately and their schemas join this request; call them by their mcp__<server>__<tool> name in the next step.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match against tool names and descriptions" },
        server: { type: "string", description: "Only search this MCP server" },
      },
      required: ["query"],
    },
    risk: "read",
    summarize: (args) => String(args?.query ?? ""),
    async run(args, ctx) {
      const query = String(args?.query ?? "").trim().toLowerCase();
      if (!query) return { output: "Give a query: what should the tool do?", isError: true };
      const pool = ready.filter((c) => !args?.server || c.id === args.server);
      const words = query.split(/\s+/).filter(Boolean);
      const matches: { client: McpClient; tool: McpToolInfo }[] = [];
      for (const client of pool) {
        for (const tool of client.tools) {
          const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
          if (words.every((word) => haystack.includes(word))) matches.push({ client, tool });
        }
      }
      if (!matches.length) {
        const available = pool.map((c) => `${c.id}: ${c.tools.map((t) => t.name).join(", ")}`).join("\n");
        return { output: `No tool matched "${query}". Available:\n${available}` };
      }
      const picked = matches.slice(0, 8);
      const defs = picked.map(({ client, tool }) => toToolDef(client, tool));
      for (const { client, tool } of picked) activated.add(toolKey(client.id, tool.name));
      while (activated.size > MAX_ACTIVATED) {
        const oldest = activated.values().next().value;
        if (oldest === undefined) break;
        activated.delete(oldest);
      }
      ctx.exposeTools?.(defs);
      const lines = picked.map(({ client, tool }) => `${client.id} · ${tool.name} — ${tool.description || "(no description)"}`);
      if (matches.length > picked.length) lines.push(`… ${matches.length - picked.length} more — narrow the query.`);
      return { output: lines.join("\n") };
    },
  };
  return def;
}

function resourceTools(): ToolDef[] {
  const withResources = () => [...clients.values()].filter((c) => c.state === "ready" && c.supportsResources);
  if (!withResources().length) return [];

  const pick = (server?: string) => {
    const ready = withResources();
    if (server) return ready.filter((c) => c.id === server);
    return ready;
  };

  const listTool: ToolDef = {
    name: "list_mcp_resources",
    description:
      "List the resources the connected MCP servers expose (documents, issues, database rows) along with any URI templates. Pass `server` to narrow it to one server.",
    parameters: { type: "object", properties: { server: { type: "string", description: "MCP server id" } } },
    risk: "network",
    summarize: (args) => (args?.server ? String(args.server) : "all servers"),
    async run(args) {
      const targets = pick(args?.server ? String(args.server) : undefined);
      if (!targets.length) return { output: "No MCP server with resources is connected.", isError: true };
      const lines: string[] = [];
      for (const client of targets) {
        const resources = await client.listResources();
        lines.push(`${client.id}${resources.length ? "" : " (no resources)"}`);
        for (const r of resources) {
          lines.push(`  ${r.uri}${r.name ? ` — ${r.name}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}`);
        }
        for (const t of client.resourceTemplates) {
          lines.push(`  ${t.uriTemplate}${t.name ? ` — ${t.name}` : ""} (template)`);
        }
      }
      return { output: lines.join("\n") || "(no resources)" };
    },
  };

  const readTool: ToolDef = {
    name: "read_mcp_resource",
    description:
      "Read one MCP resource by URI. Use list_mcp_resources first to see what exists; for a template, fill in the URI parameters yourself.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server id" },
        uri: { type: "string", description: "Resource URI, e.g. file:///repo/README.md" },
      },
      required: ["uri"],
    },
    risk: "network",
    summarize: (args) => String(args?.uri ?? ""),
    async run(args, ctx) {
      const targets = pick(args?.server ? String(args.server) : undefined);
      if (!targets.length) return { output: "No MCP server with resources is connected.", isError: true };
      const client = targets.length === 1 ? targets[0] : targets.find((c) => c.id === args?.server) ?? targets[0];
      const ok = await ctx.confirm(readTool, args);
      if (!ok) return { output: "The user rejected the call.", isError: true };
      ctx.signal.throwIfAborted();
      return client.readResource(String(args?.uri ?? ""), ctx.signal);
    },
  };

  const templatesTool: ToolDef = {
    name: "list_mcp_resource_templates",
    description: "List the URI templates the connected MCP servers expose, with the parameters each expects.",
    parameters: { type: "object", properties: { server: { type: "string", description: "MCP server id" } } },
    risk: "network",
    summarize: (args) => (args?.server ? String(args.server) : "all servers"),
    async run(args) {
      const targets = pick(args?.server ? String(args.server) : undefined);
      const lines: string[] = [];
      for (const client of targets) {
        for (const t of client.resourceTemplates) {
          lines.push(`${client.id}: ${t.uriTemplate}${t.name ? ` — ${t.name}` : ""}${t.description ? `\n  ${t.description}` : ""}`);
        }
      }
      return { output: lines.join("\n") || "(no resource templates)" };
    },
  };

  return [listTool, readTool, templatesTool];
}

/** Provider APIs allow [a-zA-Z0-9_-] in tool names, 64 chars at most. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toToolDef(client: McpClient, t: McpToolInfo): ToolDef {
  const approval = client.cfg.toolApprovals?.[t.name] ?? client.cfg.approval ?? "ask";
  const readOnly = t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true;
  const def: ToolDef = {
    name: mcpName(client.id, t.name),
    description:
      t.description ||
      `${t.name} on the "${client.id}" MCP server`,
    parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    risk: readOnly ? (approval === "auto" ? "read" : "network") : "write",
    summarize: (args) => {
      const s = JSON.stringify(args ?? {});
      return s === "{}" ? client.id : s.length > 60 ? s.slice(0, 59) + "…" : s;
    },
    async run(args, ctx) {
      const ok = await ctx.confirm(def, args);
      if (!ok) return { output: "The user rejected the call.", isError: true };
      ctx.signal.throwIfAborted();
      return client.callTool(t.name, args, {
        signal: ctx.signal,
        onProgress: (p) => {
          const pct = p.total ? ` ${Math.round((p.progress / p.total) * 100)}%` : ` ${p.progress}`;
          ctx.emit(`${client.id}/${t.name}:${pct}${p.message ? ` ${p.message}` : ""}`.trim());
        },
      });
    },
  };
  return def;
}

function mcpName(server: string, tool: string): string {
  const name = `mcp__${sanitize(server)}__${sanitize(tool)}`;
  if (name.length <= 64 && sanitize(server) === server && sanitize(tool) === tool) return name;
  const hash = createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 12);
  return `${name.slice(0, 51)}_${hash}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function isRetryable(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  if (e?.name === "AbortError") return false;
  return /no response|timed out|timeout|ECONN|EPIPE|socket hang up|stream ended|fetch failed|HTTP (408|429|5\d\d)|response did not answer/i.test(
    e?.message ?? "",
  );
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(value) && typeof (value as AbortSignal).aborted === "boolean" && typeof (value as any).addEventListener === "function";
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}
