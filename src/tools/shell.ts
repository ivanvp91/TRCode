/** Shell tool with a per-platform launcher and hard timeouts. */
import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import type { ToolDef } from "../types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
/** Kept from the start and from the end of a stream, in characters. */
const HEAD_LIMIT = 20_000;
const TAIL_LIMIT = 20_000;

/**
 * Head plus a rolling tail. Truncating at the head alone throws away the one
 * part that usually matters — a test run's summary, the error a build ended
 * on — and then the model runs the command again to see the end of it.
 */
class Capture {
  private head = "";
  private tail = "";
  private dropped = 0;

  push(s: string): void {
    if (this.head.length < HEAD_LIMIT) {
      const room = HEAD_LIMIT - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
      if (!s) return;
    }
    this.tail += s;
    if (this.tail.length > TAIL_LIMIT) {
      const cut = this.tail.length - TAIL_LIMIT;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  text(): string {
    if (!this.tail) return this.head;
    if (!this.dropped) return this.head + this.tail;
    return `${this.head}\n… [${this.dropped} characters omitted from the middle] …\n${this.tail}`;
  }
}

/** Commands that are refused outright regardless of permission mode. */
const HARD_BLOCK = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+\/(?:\s|$)/i,
  /\bRemove-Item\b[^|]*\b-Recurse\b[^|]*\bC:\\(?:\s|$)/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /:\(\)\{.*\|.*&.*\};:/,
  /\bdd\s+if=.*\bof=\/dev\/[sh]d/i,
];

function launcher(): { cmd: string; args: (script: string) => string[] } {
  const cfg = loadConfig();
  const mode = cfg.shell === "auto" ? (process.platform === "win32" ? "powershell" : "bash") : cfg.shell;
  switch (mode) {
    case "powershell":
      return {
        cmd: process.env.ComSpec?.toLowerCase().includes("cmd") || process.platform === "win32" ? "powershell.exe" : "pwsh",
        args: (s) => ["-NoProfile", "-NonInteractive", "-Command", s],
      };
    case "cmd":
      return { cmd: "cmd.exe", args: (s) => ["/d", "/s", "/c", s] };
    default:
      return { cmd: "bash", args: (s) => ["-c", s] };
  }
}

export const shellTool: ToolDef = {
  name: "shell",
  risk: "shell",
  description:
    "Runs a command in the system shell (PowerShell on Windows, bash elsewhere) " +
    "and returns stdout/stderr plus the exit code. It runs in the project directory. " +
    "Interactive commands are forbidden: the session is non-interactive and they will hang. " +
    "Use read/glob/grep to read and search files — cheaper and more reliable.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      description: { type: "string", description: "A short description of what the command does" },
      timeout_ms: { type: "integer", description: "Timeout in ms (default 120000, maximum 600000)" },
      cwd: { type: "string", description: "Subdirectory to run in, relative to the project" },
    },
    required: ["command"],
  },
  summarize: (a) => String(a.description || a.command),
  async run(args, ctx) {
    const command = String(args.command ?? "").trim();
    if (!command) return { output: "Empty command.", isError: true };

    for (const rx of HARD_BLOCK) {
      if (rx.test(command)) {
        return { output: "The command was blocked as destructive and did not run.", isError: true };
      }
    }

    const ok = await ctx.confirm(shellTool, args, command);
    if (!ok) return { output: "The user rejected the command.", isError: true };

    const timeout = Math.min(Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS), 600_000);
    const { cmd, args: mkArgs } = launcher();
    const cwd = args.cwd ? `${ctx.cwd}/${String(args.cwd)}` : ctx.cwd;

    return new Promise((resolve) => {
      const child = spawn(cmd, mkArgs(command), {
        cwd,
        env: { ...process.env, TRCODE: "1", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const out = new Capture();
      const err = new Capture();
      let killed = false;

      const push = (target: "out" | "err", chunk: Buffer) => {
        (target === "out" ? out : err).push(chunk.toString("utf8"));
      };

      child.stdout.on("data", (c) => push("out", c));
      child.stderr.on("data", (c) => push("err", c));

      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeout);

      const onAbort = () => {
        killed = true;
        child.kill("SIGKILL");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ output: `Could not start the shell (${cmd}): ${err.message}`, isError: true });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const stdout = out.text();
        const stderr = err.text();
        const parts: string[] = [];
        if (stdout.trim()) parts.push(stdout.trimEnd());
        if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        if (killed) parts.push(`[killed after a ${timeout} ms timeout]`);
        if (!parts.length) parts.push("(no output)");
        const body = parts.join("\n");
        resolve({
          output: `exit=${code ?? "killed"}\n${body}`,
          isError: killed || (code !== 0 && code !== null),
          display: body.split("\n").slice(0, 8).join("\n"),
        });
      });
    });
  },
};
