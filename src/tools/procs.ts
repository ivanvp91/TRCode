/**
 * Background processes: what `shell` with background=true starts and
 * `shell_io` talks to afterwards.
 *
 * A one-shot shell call has to finish before the turn can go on, so a dev
 * server, a watcher or a twenty-minute build either blocked the turn or got
 * killed for silence. These run beside the turn instead: the call returns a
 * process id at once, and the model reads what accumulated since, types into
 * stdin when the program asks for something, and stops it when done.
 *
 * Processes live as long as this TRCode process and die with it. Their file
 * writes are outside /rewind's snapshots — the command is not known to have
 * finished when the turn ends.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { killTree, shellLauncher } from "./shell.js";
import { fmtDuration } from "../ui/layout.js";
import type { ToolDef } from "../types.js";

/** Running at once; past this a start is refused, not queued. */
const MAX_RUNNING = 6;
/** Unread output kept per process, in characters; older output is dropped. */
const UNREAD_LIMIT = 40_000;
/** How long the start waits for first output before handing back the id. */
export const START_WAIT_MS = 3_000;
/** Output is taken as settled after this much quiet. */
const SETTLE_MS = 500;
const MAX_WAIT_MS = 120_000;

interface Proc {
  id: number;
  command: string;
  child: ChildProcessWithoutNullStreams;
  started: number;
  unread: string;
  dropped: number;
  exit?: { code: number | null };
  wake: Set<() => void>;
}

const procs = new Map<number, Proc>();
let nextId = 0;
let exitHook = false;

function push(p: Proc, s: string): void {
  p.unread += s;
  if (p.unread.length > UNREAD_LIMIT) {
    const cut = p.unread.length - UNREAD_LIMIT;
    p.dropped += cut;
    p.unread = p.unread.slice(cut);
  }
  for (const w of p.wake) w();
}

function running(): Proc[] {
  return [...procs.values()].filter((p) => !p.exit);
}

/** Starts `command` in the background, or says why it cannot. */
export function startProcess(command: string, cwd: string): Proc | string {
  if (running().length >= MAX_RUNNING) {
    return `${MAX_RUNNING} background processes are already running (${running().map((p) => p.id).join(", ")}). Stop one with shell_io kill=true first.`;
  }
  const { cmd, args } = shellLauncher();
  const child = spawn(cmd, args(command), {
    cwd,
    env: { ...process.env, TRCODE: "1", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" },
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const p: Proc = { id: ++nextId, command, child, started: Date.now(), unread: "", dropped: 0, wake: new Set() };
  procs.set(p.id, p);
  // A server left running must not keep TRCode alive after the user quits.
  child.unref();
  for (const s of [child.stdin, child.stdout, child.stderr]) (s as unknown as { unref?: () => void }).unref?.();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => push(p, c));
  child.stderr.on("data", (c: string) => push(p, c));
  child.stdin.on("error", () => { /* the process closed its stdin; a later write says so */ });
  child.on("error", (err) => {
    p.exit ??= { code: null };
    push(p, `\n[could not start: ${err.message}]\n`);
  });
  child.on("close", (code) => {
    p.exit = { code };
    for (const w of p.wake) w();
  });
  if (!exitHook) {
    exitHook = true;
    process.on("exit", stopAllProcesses);
  }
  return p;
}

/** Kills every background process; on exit, and for tests. */
export function stopAllProcesses(): void {
  for (const p of running()) killTree(p.child);
}

/**
 * Waits for output: returns once the process exits, once new output has
 * settled, or when `ms` runs out — whichever comes first.
 */
export function waitForOutput(p: Proc, ms: number, signal?: AbortSignal): Promise<void> {
  if (p.exit) return Promise.resolve();
  return new Promise((resolve) => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(settle);
      p.wake.delete(onWake);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const onWake = () => {
      if (p.exit) return done();
      clearTimeout(settle);
      settle = setTimeout(done, SETTLE_MS);
    };
    const timer = setTimeout(done, ms);
    p.wake.add(onWake);
    signal?.addEventListener("abort", done, { once: true });
    // Output already waiting counts as arrived.
    if (p.unread) onWake();
  });
}

/** The status line plus everything unread, which is then marked read. */
export function report(p: Proc): string {
  const age = fmtDuration(Date.now() - p.started);
  const head = p.exit
    ? `process ${p.id} exited (exit=${p.exit.code ?? "killed"}) after ${age}`
    : `process ${p.id} running for ${age}`;
  const lost = p.dropped ? `[${p.dropped} earlier characters dropped — the buffer keeps the last ${UNREAD_LIMIT}]\n` : "";
  const body = p.unread.trimEnd();
  p.unread = "";
  p.dropped = 0;
  // A finished process is reported once more and then forgotten.
  if (p.exit && !body) procs.delete(p.id);
  return `${head}\n${lost}${body || "(no new output)"}`;
}

export const shellIoTool: ToolDef = {
  name: "shell_io",
  risk: "shell",
  spillBias: "tail",
  description:
    "Drives a process started with shell background=true: returns its status and new output. " +
    "No process_id lists them. Prefer one long wait_ms to many short polls.",
  parameters: {
    type: "object",
    properties: {
      process_id: { type: "integer" },
      input: { type: "string", description: "Written to stdin; \\n is Enter" },
      close_stdin: { type: "boolean" },
      wait_ms: { type: "integer", description: `Wait for output (default 2000, max ${MAX_WAIT_MS})` },
      kill: { type: "boolean" },
    },
  },
  summarize: (a) =>
    a.process_id === undefined
      ? "list"
      : `#${a.process_id}${a.kill ? " kill" : a.input !== undefined ? ` ← ${JSON.stringify(String(a.input)).slice(0, 40)}` : ""}`,
  async run(args, ctx) {
    if (args.process_id === undefined || args.process_id === null || args.process_id === "") {
      const all = [...procs.values()];
      if (!all.length) return { output: "No background processes." };
      return {
        output: all
          .map((p) => `${p.id}  ${p.exit ? `exited (exit=${p.exit.code ?? "killed"})` : "running"}  ${fmtDuration(Date.now() - p.started)}  ${p.command}`)
          .join("\n"),
      };
    }
    const p = procs.get(Number(args.process_id));
    if (!p) return { output: `No background process ${args.process_id}. Call shell_io without process_id to list them.`, isError: true };

    if (args.kill) {
      if (!p.exit) {
        killTree(p.child);
        await waitForOutput(p, 5_000, ctx.signal);
      }
      const out = report(p);
      procs.delete(p.id);
      return { output: out };
    }

    if (args.input !== undefined && args.input !== null) {
      if (p.exit) return { output: `${report(p)}\n[the process has exited — input was not sent]`, isError: true };
      const input = String(args.input);
      // Typing into a process is running a command in it.
      const ok = await ctx.confirm(shellIoTool, args, `#${p.id} ${p.command}\n← ${input}`);
      if (!ok) return { output: "The user rejected the input.", isError: true };
      try {
        p.child.stdin.write(input);
        if (args.close_stdin) p.child.stdin.end();
      } catch (err) {
        return { output: `Could not write to process ${p.id}: ${(err as Error).message}`, isError: true };
      }
    } else if (args.close_stdin && !p.exit) {
      p.child.stdin.end();
    }

    const wait = Math.max(0, Math.min(Number(args.wait_ms ?? 2_000) || 0, MAX_WAIT_MS));
    if (wait) await waitForOutput(p, wait, ctx.signal);
    return { output: report(p), isError: Boolean(p.exit && p.exit.code !== 0) };
  },
};
