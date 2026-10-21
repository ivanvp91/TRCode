/**
 * The wire under the MCP client: one stdio child, newline-framed JSON-RPC.
 *
 * Two things here are not obvious and were both bugs in the first version:
 * `child.kill()` reaches the launcher and nothing below it (on Windows `npx`
 * is a cmd shim with a node grandchild), so cleanup goes through `killTree`;
 * and a descendant that escaped the kill keeps the stderr pipe open, which is
 * why the reader is drained for a moment after the exit instead of being
 * abandoned mid-line.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killTree } from "../tools/shell.js";

export interface McpTransport {
  /** Resolves once the channel can carry messages. */
  start(): Promise<void>;
  /** Fire-and-forget at the RPC level: responses arrive through `onMessage`. */
  send(msg: unknown, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  onMessage?: (msg: any) => void;
  /** The channel died on its own (crash, exit) — not a deliberate close. */
  onExit?: (detail: string) => void;
  onStderr?: (line: string) => void;
  /** Set after the handshake; the HTTP transport puts it on every request. */
  protocolVersion?: string;
}

/** Frame cap. A single line bigger than this is a runaway server, not a result. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const STDERR_DRAIN_MS = 250;
const EXIT_WAIT_MS = 3000;

export class StdioTransport implements McpTransport {
  onMessage?: (msg: any) => void;
  onExit?: (detail: string) => void;
  onStderr?: (line: string) => void;
  protocolVersion?: string;

  private proc: ChildProcess | null = null;
  private buf = "";
  private closing = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly opts: { env?: Record<string, string>; cwd?: string },
  ) {}

  async start(): Promise<void> {
    const env = { ...process.env, ...(this.opts.env ?? {}) };
    const spawnOpts = {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    // npx, uvx and friends are .cmd shims on Windows, which only a shell can
    // start. Real executables spawn directly — going through cmd.exe would
    // break on the unquoted spaces of a path like "C:\Program Files\...".
    const viaShell = process.platform === "win32" && !isDirectlySpawnable(this.command);
    this.proc = viaShell
      ? spawn([quoteWin(this.command), ...this.args.map(quoteWin)].join(" "), { ...spawnOpts, shell: true })
      : spawn(this.command, this.args, spawnOpts);

    this.exited = new Promise<void>((resolve) => {
      const done = () => resolve();
      this.proc!.once("exit", done);
      this.proc!.once("error", done);
      this.proc!.once("close", done);
    });

    this.proc.stdout?.on("data", (b: Buffer) => this.onData(b.toString("utf8")));
    this.proc.stderr?.on("data", (b: Buffer) => {
      for (const line of b.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this.onStderr?.(trimmed);
      }
    });
    this.proc.on("error", (err) => {
      if (!this.closing) this.onExit?.(err.message);
    });
    this.proc.on("exit", (code) => {
      if (!this.closing) this.onExit?.(`exited (code ${code ?? "?"})`);
    });
    // A dead pipe surfaces as an exit; writing to it must not throw.
    this.proc.stdin?.on("error", () => {});
  }

  async send(msg: unknown, _timeoutMs?: number): Promise<void> {
    const line = JSON.stringify(msg) + "\n";
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("request exceeds the 8 MiB MCP frame limit");
    await new Promise<void>((resolve, reject) => {
      const stdin = this.proc?.stdin;
      if (!stdin || stdin.destroyed) return reject(new Error("MCP server is not running"));
      stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    killTree(proc);
    await Promise.race([this.exited, delay(EXIT_WAIT_MS)]);
    // Escaped descendants can still hold the pipes; drop them after the drain.
    try {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.stdin?.destroy();
    } catch {
      /* already gone */
    }
    await delay(STDERR_DRAIN_MS);
  }

  /** Newline-delimited JSON-RPC; anything unparseable is a server's stray log. */
  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MAX_FRAME_BYTES) {
      this.buf = "";
      if (!this.closing) this.onExit?.("a single message exceeded the 8 MiB frame limit");
      return;
    }
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
      this.onMessage?.(msg);
    }
  }
}

/** `${VAR}` and `$VAR`, resolved from the process environment (config files hold names, not secrets). */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "")
    .replace(/(^|[^\\$])\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, pre: string, name: string) => pre + (env[name] ?? ""));
}

/** True when Windows can start it without a shell: a real executable, not a .cmd shim. */
export function isDirectlySpawnable(command: string): boolean {
  if (/\.(exe|com)$/i.test(command)) return true;
  if (/\.(cmd|bat)$/i.test(command)) return false;
  // A bare name ("npx", "python"): only a shell resolves the .cmd variants,
  // and it handles the .exe ones too, so the shell is the safe route. An
  // extensionless absolute path is a script by convention — shell as well.
  return false;
}

/** cmd.exe quoting for the one shape that breaks in practice: embedded spaces. */
export function quoteWin(s: string): string {
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

export function delay(ms: number): Promise<void> {
  // Deliberately ref'd: this promise is awaited by close() and by retries, and
  // an unref'd timer would let the process exit before the wait ever resolves.
  return new Promise((resolve) => setTimeout(resolve, ms));
}
