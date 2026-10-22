/**
 * Streamable HTTP transport: one POST per JSON-RPC message, the response
 * arriving either as plain JSON or as an SSE stream whose events are the
 * messages. There is no legacy HTTP+SSE transport here — every server that
 * matters speaks Streamable HTTP.
 *
 * The details that make it usable against real servers: the session id is
 * echoed back from `Mcp-Session-Id`, a 404 on an established session means the
 * server forgot us (the client re-initialises and retries once), and a broken
 * stream loses only the request it carried.
 */
import http from "node:http";
import https from "node:https";
import type { McpTransport } from "./transport.js";
import { MAX_FRAME_BYTES } from "./transport.js";
import { VERSION } from "../config.js";

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 30_000;
const NON_JSON_PREVIEW = 8 * 1024;

export class SessionExpiredError extends Error {
  readonly status = 404;
  constructor() {
    super("the server no longer knows this session");
    this.name = "SessionExpiredError";
  }
}

export class HttpTransport implements McpTransport {
  onMessage?: (msg: any) => void;
  onExit?: (detail: string) => void;
  onStderr?: (line: string) => void;
  protocolVersion?: string;

  private sessionId = "";
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly token?: string,
  ) {}

  async start(): Promise<void> {
    const parsed = new URL(this.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`unsupported URL: ${this.url}`);
    if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
      // A bearer token over plaintext is worth refusing out loud.
      if (this.token) throw new Error("refusing to send a bearer token over plaintext HTTP to a non-local host");
    }
  }

  async send(msg: unknown, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.closed) throw new Error("transport is closed");
    await this.post(msg, timeoutMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.sessionId) return;
    const session = this.sessionId;
    this.sessionId = "";
    await new Promise<void>((resolve) => {
      try {
        const parsed = new URL(this.url);
        const headers: Record<string, string> = { "User-Agent": `trcode/${VERSION}`, ...this.headers, "Mcp-Session-Id": session };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        const req = (parsed.protocol === "https:" ? https : http).request(parsed, { method: "DELETE", headers, timeout: 2_000 }, (res) => {
          res.resume();
          res.once("end", () => resolve());
          res.once("error", () => resolve());
        });
        req.once("error", () => resolve());
        req.once("timeout", () => {
          req.destroy();
          resolve();
        });
        req.end();
      } catch {
        /* the server is gone; nothing to delete */
      }
    });
  }

  private headerObject(): Record<string, string> {
    const out: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": `trcode/${VERSION}`,
      ...this.headers,
    };
    if (this.token) out.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) out["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) out["MCP-Protocol-Version"] = this.protocolVersion;
    return out;
  }

  private async post(msg: unknown, timeoutMs: number): Promise<void> {
    const body = Buffer.from(JSON.stringify(msg) + "\n", "utf8");
    if (body.byteLength > MAX_FRAME_BYTES) throw new Error("request exceeds the 8 MiB MCP frame limit");
    let url = this.url;
    for (let hop = 0; ; hop++) {
      const outcome = await this.postOnce(url, body, msg, timeoutMs);
      if (!outcome.redirect) return;
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      const from = new URL(url);
      const to = new URL(outcome.redirect, url);
      // Custom headers may carry credentials for our server; never hand them
      // to another origin just because it answered with a 307.
      if (to.origin !== from.origin) throw new Error(`refusing a cross-origin redirect to ${to.origin}`);
      url = to.toString();
    }
  }

  private postOnce(
    url: string,
    body: Buffer,
    msg: any,
    timeoutMs: number,
  ): Promise<{ redirect?: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const expectId = typeof msg?.id === "number" ? msg.id : undefined;
      let settled = false;
      const done = (err?: Error, redirect?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ redirect });
      };

      const req = (parsed.protocol === "https:" ? https : http).request(parsed, {
        method: "POST",
        headers: { ...this.headerObject(), "Content-Length": String(body.byteLength) },
        timeout: Math.max(CONNECT_TIMEOUT_MS, timeoutMs),
      });
      const timer = setTimeout(() => {
        req.destroy();
        done(new Error(`no response in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs + 5_000);
      timer.unref?.();

      req.on("error", (err) => done(err));
      req.on("timeout", () => {
        req.destroy();
        done(new Error("the request timed out"));
      });

      req.on("response", (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return done(undefined, String(res.headers.location));
        }
        const session = res.headers["mcp-session-id"];
        if (typeof session === "string" && session) this.sessionId = session;

        if (status === 404 && this.sessionId && !isHandshake(msg?.method)) {
          res.resume();
          // The spec's rule for a 404: start a new session *without* the old id.
          // Kept, it rode along on the re-initialise, and a server that does not
          // know it refused that too — the recovery this exists for never worked.
          this.sessionId = "";
          return done(new SessionExpiredError());
        }
        if (status < 200 || status >= 300) {
          collect(res, (text) => {
            const preview = (text ?? "").slice(0, NON_JSON_PREVIEW).trim();
            done(new Error(`HTTP ${status}${preview ? `: ${preview}` : ""}`));
          });
          return;
        }

        const type = String(res.headers["content-type"] ?? "");
        if (type.includes("text/event-stream")) {
          this.readEvents(res, expectId, () => done(), (err) => done(err));
          res.on("end", () => {
            if (expectId === undefined) done();
            else done(new Error("the stream ended before a response arrived"));
          });
          res.on("error", (err) => done(err));
          return;
        }

        collect(res, (text) => {
          if (text === null) return done(new Error(TOO_BIG));
          const trimmed = text.trim();
          if (!trimmed) {
            // 202 Accepted: a notification was taken, nothing to read.
            if (expectId === undefined) return done();
            return done(new Error("the server accepted the request but answered nothing"));
          }
          try {
            const parsedBody = JSON.parse(trimmed);
            const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
            for (const m of messages) this.emit(m);
            if (expectId !== undefined && !messages.some((m) => m?.id === expectId)) {
              done(new Error("the response did not answer this request"));
            } else done();
          } catch {
            done(new Error("the server answered with something that is not JSON"));
          }
        });
        res.on("error", (err) => done(err));
      });

      req.end(body);
    });
  }

  private readEvents(
    res: http.IncomingMessage,
    expectId: number | undefined,
    finish: () => void,
    fail: (err: Error) => void,
  ): void {
    let buf = "";
    let size = 0;
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_FRAME_BYTES) {
        res.destroy();
        // A destroyed response never ends, so the request is failed here —
        // left to its timer, it hung for minutes and then blamed the network.
        fail(new Error(TOO_BIG));
        return;
      }
      buf += chunk;
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          const msg = JSON.parse(data);
          this.emit(msg);
          if (expectId !== undefined && msg?.id === expectId) {
            finish();
            res.destroy();
            return;
          }
        } catch {
          /* keep-alive comments and stray text are not messages */
        }
      }
    });
  }

  private emit(msg: any): void {
    try {
      this.onMessage?.(msg);
    } catch {
      /* a handler's failure must not kill the stream */
    }
  }
}

const TOO_BIG = "the response exceeded the 8 MiB MCP frame limit";

/** The whole body, or null once it outgrows the frame limit. */
function collect(res: http.IncomingMessage, cb: (text: string | null) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  res.on("data", (chunk: Buffer) => {
    if (over) return;
    size += chunk.byteLength;
    if (size > MAX_FRAME_BYTES) {
      over = true;
      res.destroy();
      cb(null);
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => {
    if (!over) cb(Buffer.concat(chunks).toString("utf8"));
  });
}

function isHandshake(method: string | undefined): boolean {
  return method === "initialize" || method === "server/discover" || method === "notifications/initialized";
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}
