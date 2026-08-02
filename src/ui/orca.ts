/**
 * Status reporting to Orca (https://orcaterm.com), the multi-pane agent
 * terminal this CLI often runs inside.
 *
 * Orca watches its panes through a loopback HTTP server: an agent POSTs what
 * it is doing to `http://127.0.0.1:<port>/hook/<agent>` and the pane turns
 * "working", "done" or "needs attention" in the dashboard. Without it a pane
 * running trcode looks like a dumb terminal — no state, no notification when a
 * long turn finishes.
 *
 * The route has to be one Orca knows: it answers 404 to an unknown agent id,
 * and `trcode` is not on its list. `opencode` is the closest relative and its
 * contract is public — Orca ships the plugin that speaks it — so that is the
 * dialect used here. `orcaAgent` in the config switches to another route.
 *
 * Everything here fails open. Orca being closed, slow or a version ahead must
 * never cost a turn.
 */
import fs from "node:fs";
import { loadConfig } from "../config.js";

const POST_TIMEOUT_MS = 1500;
/** Assistant text arrives as deltas; the dashboard only needs a preview. */
const PART_THROTTLE_MS = 250;
const PART_MAX_CHARS = 4000;

interface Coords {
  port: string;
  token: string;
  env: string;
  version: string;
}

/**
 * Orca rewrites the endpoint file on every start, so the env this process was
 * launched with goes stale the moment Orca restarts. Read the file instead,
 * cached on mtime+size so a streaming turn does not stat it hundreds of times.
 */
let cachedKey = "";
let cachedValues: Record<string, string> | null = null;

function readEndpointFile(): Record<string, string> | null {
  const path = process.env.ORCA_AGENT_HOOK_ENDPOINT;
  if (!path) return null;
  try {
    const stat = fs.statSync(path);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key === cachedKey && cachedValues) return cachedValues;
    const out: Record<string, string> = {};
    // Windows writes `set KEY=VALUE`, Unix writes `KEY=VALUE`.
    for (const l of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^(?:set\s+)?([A-Z0-9_]+)=(.*)$/.exec(l);
      if (m) out[m[1]] = m[2].replace(/\r$/, "");
    }
    cachedKey = key;
    cachedValues = out;
    return out;
  } catch {
    cachedKey = "";
    cachedValues = null;
    return null;
  }
}

function coords(): Coords | null {
  const file = readEndpointFile() ?? {};
  const port = file.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT || "";
  const token = file.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN || "";
  if (!port || !token) return null;
  return {
    port,
    token,
    env: file.ORCA_AGENT_HOOK_ENV || process.env.ORCA_AGENT_HOOK_ENV || "",
    version: file.ORCA_AGENT_HOOK_VERSION || process.env.ORCA_AGENT_HOOK_VERSION || "",
  };
}

export type OrcaEvent =
  | "SessionBusy"
  | "SessionIdle"
  | "PermissionRequest"
  | "AskUserQuestion"
  | "MessagePart";

export class OrcaReporter {
  private lastStatus: "busy" | "idle" | "" = "";
  private pendingPart: { role: string; text: string } | null = null;
  private partTimer: NodeJS.Timeout | null = null;
  private lastPartAt = 0;
  /** In-flight posts, so a turn can wait for them before it says "idle". */
  private inflight = new Set<Promise<void>>();

  private constructor(
    private readonly paneKey: string,
    private readonly route: string,
  ) {}

  /** Returns a reporter only when this process really runs inside an Orca pane. */
  static detect(): OrcaReporter | null {
    const cfg = loadConfig();
    if (cfg.orca === false) return null;
    const paneKey = process.env.ORCA_PANE_KEY;
    if (!paneKey || !coords()) return null;
    return new OrcaReporter(paneKey, cfg.orcaAgent || "opencode");
  }

  busy(sessionId: string): void {
    this.status("busy", sessionId);
  }

  /** Flushes any queued preview first, so the finished pane shows the answer. */
  async idle(sessionId: string): Promise<void> {
    this.flushPart();
    this.status("idle", sessionId);
    await this.drain();
  }

  /**
   * A tool is waiting on the human — the pane goes red, not green. This is
   * not a busy/idle transition, but it does replace the pane's state on
   * Orca's side, so forget the last one: work resuming has to be announced
   * again or the pane stays red for the rest of the turn.
   */
  waiting(tool: string, detail: string): void {
    this.lastStatus = "";
    this.post("PermissionRequest", { toolName: tool, title: detail.slice(0, 200) });
  }

  userPrompt(text: string, sessionId: string): void {
    this.post("MessagePart", { role: "user", text: cap(text), sessionID: sessionId });
  }

  /**
   * Assistant text, coalesced: deltas arrive dozens of times a second and the
   * dashboard renders a preview. Only the latest snapshot matters.
   */
  assistantText(text: string, sessionId: string): void {
    this.pendingPart = { role: "assistant", text };
    const since = Date.now() - this.lastPartAt;
    if (since >= PART_THROTTLE_MS) return this.flushPart(sessionId);
    if (this.partTimer) return;
    this.partTimer = setTimeout(() => this.flushPart(sessionId), PART_THROTTLE_MS - since);
    this.partTimer.unref?.();
  }

  private flushPart(sessionId = ""): void {
    if (this.partTimer) {
      clearTimeout(this.partTimer);
      this.partTimer = null;
    }
    const part = this.pendingPart;
    this.pendingPart = null;
    if (!part) return;
    this.lastPartAt = Date.now();
    this.post("MessagePart", { role: part.role, text: cap(part.text), sessionID: sessionId });
  }

  private status(next: "busy" | "idle", sessionId: string): void {
    if (this.lastStatus === next) return;
    this.lastStatus = next;
    this.post(next === "busy" ? "SessionBusy" : "SessionIdle", { sessionID: sessionId });
  }

  private post(event: OrcaEvent, props: Record<string, unknown>): void {
    const c = coords();
    if (!c) return;
    const body = JSON.stringify({
      paneKey: this.paneKey,
      launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN ?? "",
      tabId: process.env.ORCA_TAB_ID ?? "",
      worktreeId: process.env.ORCA_WORKTREE_ID ?? "",
      env: c.env,
      version: c.version,
      payload: { hook_event_name: event, ...props },
    });

    const p = fetch(`http://127.0.0.1:${c.port}/hook/${this.route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orca-agent-hook-token": c.token },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
      .then(() => {})
      .catch(() => {})
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** Lets a turn end knowing the pane already heard about it. */
  private async drain(): Promise<void> {
    await Promise.all([...this.inflight]);
  }
}

function cap(s: string): string {
  return s.length > PART_MAX_CHARS ? s.slice(0, PART_MAX_CHARS) : s;
}
