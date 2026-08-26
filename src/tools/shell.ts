/** Shell tool with a per-platform launcher and hard timeouts. */
import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import { fmtDuration } from "../ui/layout.js";
import { recordChanges, watchTargets } from "./shellsnap.js";
import type { ToolDef, ToolResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
/** However talkative a command is, this is where it ends. */
const HARD_LIMIT_MS = 20 * 60_000;
/**
 * How often a command that is printing nothing says so.
 *
 * A gradle build sits silent through compileKotlin for minutes, and the
 * screen it leaves behind is indistinguishable from a hung turn — which is
 * what it was taken for. The tail only speaks when there is output; this
 * speaks when there is none.
 */
const HEARTBEAT_MS = 10_000;
/**
 * After we have killed a tree, how long we wait for the `close` event before
 * resolving with what was captured anyway. `taskkill` is fire-and-forget, and
 * a grandchild that survives it — a gradle daemon's java.exe — keeps the
 * stdout pipe open, which is what the promise waits on; without this the turn
 * sat there for good, deaf even to Esc.
 */
const KILL_GRACE_MS = 10_000;
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

/**
 * Windows shells speak the console's OEM codepage (cp866 on Russian systems)
 * while the pipe below is decoded as UTF-8, so any non-ASCII output arrives
 * as mojibake. The prelude flips both directions to UTF-8 before the command
 * runs; pwsh 7+ is UTF-8 already and takes it as a no-op. Get-Content is
 * pinned too: Windows PowerShell reads BOM-less files as ANSI, and source
 * trees are UTF-8.
 */
const PS_UTF8 =
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();" +
  "$OutputEncoding=[Console]::OutputEncoding;" +
  "$PSDefaultParameterValues['Get-Content:Encoding']='utf8';";

function launcher(): { cmd: string; args: (script: string) => string[] } {
  const cfg = loadConfig();
  const mode = cfg.shell === "auto" ? (process.platform === "win32" ? "powershell" : "bash") : cfg.shell;
  switch (mode) {
    case "powershell":
      return {
        cmd: process.env.ComSpec?.toLowerCase().includes("cmd") || process.platform === "win32" ? "powershell.exe" : "pwsh",
        args: (s) => ["-NoProfile", "-NonInteractive", "-Command", PS_UTF8 + s],
      };
    case "cmd":
      return { cmd: "cmd.exe", args: (s) => ["/d", "/s", "/c", `chcp 65001>nul & ${s}`] };
    default:
      return { cmd: "bash", args: (s) => ["-c", s] };
  }
}

/**
 * Kills the command and everything it started.
 *
 * `child.kill()` reaches the shell we spawned and nothing below it, so a
 * `gradle`, an `npm test` or a dev server survived its own timeout — and kept
 * the stdout pipe open, which is what the tool waits on. The turn then sat
 * there with a dead shell and a live build, looking hung, and Esc could not
 * end it either. On Windows the tree goes through taskkill; elsewhere the
 * child leads its own process group and the group gets the signal.
 */
export function killTree(child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean }): void {
  if (!child.pid) return void child.kill("SIGKILL");
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
      /* fall through to the plain kill */
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      /* no group, or already gone */
    }
  }
  child.kill("SIGKILL");
}

/** The lines worth putting on screen: the ending when it failed, else the start. */
function displayOf(body: string, failed: boolean, rows = 8): string {
  const lines = body.split("\n").filter((l) => l.trim());
  if (!failed) return lines.slice(0, rows).join("\n");
  const tail = lines.slice(-rows);
  return lines.length > rows ? `… ${lines.length - rows} lines above\n${tail.join("\n")}` : tail.join("\n");
}

export const shellTool: ToolDef = {
  name: "shell",
  risk: "shell",
  // A build or a test run says at the end whether it worked. Cut the head off
  // a long log and the model reruns the command to see how it finished.
  spillBias: "tail",
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
      timeout_ms: {
        type: "integer",
        description:
          "How long the command may produce NO output before it is killed, in ms (default 120000). " +
          "A command that keeps printing keeps running, so a build does not need a bigger number — " +
          "a silent one does. A first Gradle/Maven/CMake build compiles quietly for many minutes: " +
          "pass 600000 or more for one. Hard ceiling: 20 minutes.",
      },
      cwd: { type: "string", description: "Subdirectory to run in, relative to the project" },
    },
    required: ["command"],
  },
  // The command, not the sentence about it: a model's description of what it
  // is doing is prose, and the line above the output should be the thing that
  // produced the output.
  summarize: (a) => String(a.command || a.description),
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

    // Read as "how long it may stay silent", not "how long it may run".
    const timeout = Math.min(Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS), HARD_LIMIT_MS);
    const { cmd, args: mkArgs } = launcher();
    const cwd = args.cwd ? `${ctx.cwd}/${String(args.cwd)}` : ctx.cwd;

    // What the command names, read before it runs: the only part of a shell
    // edit /rewind can put back. See tools/shellsnap.ts for what this misses.
    const watched = ctx.snapshot ? await watchTargets(command, cwd) : [];

    const result = await new Promise<ToolResult>((resolve) => {
      const child = spawn(cmd, mkArgs(command), {
        cwd,
        env: { ...process.env, TRCODE: "1", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" },
        windowsHide: true,
        // Its own process group, so a timeout or an Esc can take the whole
        // tree down rather than the shell alone. Windows has no groups here —
        // killTree uses taskkill /T instead.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const out = new Capture();
      const err = new Capture();
      let killed = false;

      // setEncoding buffers a multibyte sequence split across chunks;
      // per-chunk toString("utf8") would turn the halves into U+FFFD.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        out.push(c);
        tail(c);
      });
      child.stderr.on("data", (c: string) => {
        err.push(c);
        tail(c);
      });

      // A kill is a promise, not an event: taskkill is fire-and-forget, and a
      // grandchild that survives it — a gradle daemon's java.exe — keeps the
      // stdout pipe open, which close waits on. Once the tree has been killed,
      // the run is over by definition; settle with what was captured.
      let forceResolve: ReturnType<typeof setTimeout> | undefined;
      const scheduleForceResolve = () => {
        if (forceResolve) return;
        forceResolve = setTimeout(() => {
          child.emit("close", null);
        }, KILL_GRACE_MS);
      };
      const stopForceResolve = () => {
        clearTimeout(forceResolve);
        forceResolve = undefined;
      };

      // The limit is on silence, not on duration. A build that prints for six
      // minutes is working; a command that has said nothing for two is the one
      // worth killing, and the old rule killed them both at the same mark —
      // which is how `gradle compileDebugKotlin` came back as a timeout.
      const started = Date.now();
      let quiet: ReturnType<typeof setTimeout>;
      let reason = "";
      const stopAfterSilence = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          killed = true;
          reason = `[no output for ${Math.round(timeout / 1000)}s — killed]`;
          killTree(child);
          scheduleForceResolve();
        }, timeout);
      };
      stopAfterSilence();
      // A hard ceiling all the same: a command that prints forever is still a
      // command nobody is going to read the end of.
      const ceiling = setTimeout(() => {
        killed = true;
        reason = `[still running after ${Math.round(HARD_LIMIT_MS / 1000)}s — killed]`;
        killTree(child);
        scheduleForceResolve();
      }, HARD_LIMIT_MS);

      /**
       * The last line, as it appears — a live tail so a long command reads as
       * working rather than hung. Throttled: a build prints faster than a
       * terminal can usefully repaint.
       */
      let lastEmit = 0;
      let lastOutput = Date.now();
      const tail = (chunk: string) => {
        lastOutput = Date.now();
        stopAfterSilence();
        if (!ctx.emit || Date.now() - lastEmit < 400) return;
        const line = chunk.split(/\r?\n/).filter((l) => l.trim()).pop();
        if (!line) return;
        lastEmit = Date.now();
        ctx.emit(`${Math.round((Date.now() - started) / 1000)}s · ${line.trim().slice(0, 120)}`);
      };

      // Silence is the case the tail cannot cover: while a command prints
      // nothing, this says how long it has been quiet and how long it is
      // allowed to stay quiet before it is killed.
      const heartbeat = setInterval(() => {
        const quietMs = Date.now() - lastOutput;
        if (!ctx.emit || quietMs < HEARTBEAT_MS) return;
        lastEmit = Date.now();
        ctx.emit(
          `Running… (${fmtDuration(Date.now() - started)} · quiet ${fmtDuration(quietMs)} of ${fmtDuration(timeout)})`,
        );
      }, HEARTBEAT_MS);

      const onAbort = () => {
        killed = true;
        killTree(child);
        scheduleForceResolve();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        stopForceResolve();
        clearTimeout(quiet);
        clearTimeout(ceiling);
        clearInterval(heartbeat);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ output: `Could not start the shell (${cmd}): ${err.message}`, isError: true });
      });

      child.on("close", (code) => {
        stopForceResolve();
        clearTimeout(quiet);
        clearTimeout(ceiling);
        clearInterval(heartbeat);
        ctx.signal.removeEventListener("abort", onAbort);
        const stdout = out.text();
        const stderr = err.text();
        const parts: string[] = [];
        if (stdout.trim()) parts.push(stdout.trimEnd());
        if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        if (killed) parts.push(reason || "[killed]");
        if (!parts.length) parts.push("(no output)");
        const body = parts.join("\n");
        const failed = killed || (code !== 0 && code !== null);
        resolve({
          output: `exit=${code ?? "killed"}\n${body}`,
          isError: failed,
          // A failure is explained at the end of the output, not at the start:
          // a Gradle build opens with JBR warnings and says what actually went
          // wrong in its last lines. Showing the first eight showed the
          // warnings and a bare "FAILURE", and the user had to ask again for
          // the part they needed. The model still receives the whole thing.
          display: displayOf(body, failed),
        });
      });
    });

    await recordChanges(ctx, watched);
    return result;
  },
};
