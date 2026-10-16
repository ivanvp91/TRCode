/**
 * Programmatic tool calling: one TypeScript/JS program instead of N tool steps.
 *
 * The point is the input-token bill. A turn that gathers data through ordinary
 * tools pays for every result twice — once now, again on every later step,
 * because the whole history goes out each time (see session/trim.ts). Here the
 * model writes one program; the SDK calls inside it run in a child process and
 * only what the program *returns* enters the history, bounded like any other
 * tool result.
 *
 * The program runs in its own node process with one I/O channel: the SDK
 * object defined inside a restricted JavaScript context, without native
 * imports or inherited environment secrets. The child also uses Node's
 * filesystem/child-process permissions. SDK operations are checked by the
 * host: writes use the normal file guard, shell and web use their brokers.
 * This is defense in depth, not an OS sandbox for hostile programs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { resolveInside, looksBinary } from "./fsutil.js";
import { killTree } from "./shell.js";
import { writeTool } from "./files.js";
import { shellTool } from "./shell.js";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

/** The channel between the host and the running program. */
interface SdkRequest {
  id: number;
  call: string;
  args: unknown[];
}
interface SdkResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

const BOOTSTRAP = `
let __rpcSeq = 0;
const __pending = new Map();
const __requests = [];
const __timers = [];
const setTimeout = (fn, ms = 0, ...args) => { const t = { fn, args, at: Date.now() + Math.max(0, Number(ms) || 0) }; __timers.push(t); return t; };
const clearTimeout = (t) => { const i = __timers.indexOf(t); if (i >= 0) __timers.splice(i, 1); };
const __tick = () => { for (const t of [...__timers]) if (Date.now() >= t.at) { clearTimeout(t); t.fn(...t.args); } };
const __dispatch = (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const waiter = __pending.get(msg.id);
  if (!waiter) return;
  __pending.delete(msg.id);
  if (msg.ok) waiter.resolve(msg.value); else waiter.reject(new Error(msg.error));
};
const __reply = (res) => __requests.push(res);
const __rpc = (call) => async (...args) => {
  const id = ++__rpcSeq;
  const result = new Promise((resolve, reject) => __pending.set(id, { resolve, reject }));
  __requests.push({ type: "req", id, call, args });
  return await result;
};

const sdk = {
  fs: {
    read: __rpc("fs.read"),
    write: __rpc("fs.write"),
    list: __rpc("fs.list"),
    glob: __rpc("fs.glob"),
  },
  shell: __rpc("shell"),
  web: {
    fetch: __rpc("web.fetch"),
    search: __rpc("web.search"),
  },
};
sdk.glob = sdk.fs.glob;
`;

/** The program body plus a runner that reports the return value back. */
function buildScript(code: string): string {
  const program = `${BOOTSTRAP}\n(async () => {\n${code}\n})().then(
  (v) => { __reply({ type: "done", ok: true, value: v === undefined ? null : v }); },
  (e) => __reply({ type: "done", ok: false, error: String((e && e.message) || e) }),
);\n`;
  // The model receives only context-native objects. No host callbacks,
  // promises, process, require, fetch, or dynamic imports cross this boundary.
  // Native filesystem/child-process permissions add a second restriction.
  return `import vm from 'node:vm';
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const run = (s) => vm.runInContext(s, context, { timeout: 1000 });
run(${JSON.stringify(program)});
let acc = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => {
  acc += c;
  if (acc.length > 2000000) process.exit(1);
  let i;
  while ((i = acc.indexOf('\\n')) >= 0) {
    const line = acc.slice(0, i); acc = acc.slice(i + 1);
    run('__dispatch(' + JSON.stringify(line) + ')');
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {
  try {
    const raw = run('__tick(); JSON.stringify(__requests.splice(0))');
    for (const m of JSON.parse(raw)) process.stdout.write(JSON.stringify(m) + '\\n');
  } catch (e) { process.stderr.write(String(e)); process.exit(1); }
}, 5);
`;
}

export interface RunCodeDeps {
  /** Shell permission goes through the same broker as the shell tool. */
  confirmShell(command: string): Promise<boolean>;
  /** Web permission, same as web_search/fetch ask. */
  confirmWeb(kind: "search" | "fetch", target: string): Promise<boolean>;
}

export function codeModeTimeoutMs(): number {
  const cfg = loadConfig() as { codeModeTimeoutMs?: number };
  return cfg.codeModeTimeoutMs ?? 60_000;
}

/** Runs one program in a child process; resolves with what it returned. */
async function runProgram(code: string, ctx: ToolContext, deps: RunCodeDeps): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = codeModeTimeoutMs();
  const script = buildScript(code);

  // The script needs a file rather than stdin: node starts a stdin script only
  // at EOF, which would close the very channel the SDK answers come back on.
  // Written to the OS temp dir, deleted when the run ends either way.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-cm-"));
  const scriptPath = path.join(work, "program.mjs");
  fs.writeFileSync(scriptPath, script);

  try {
    return await new Promise((resolve) => {
    const scope = new AbortController();
    const scopedCtx = { ...ctx, signal: AbortSignal.any([ctx.signal, scope.signal]) };
    const active = new Set<Promise<unknown>>();
    ctx.signal.throwIfAborted();
    const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
    const child = spawn(process.execPath, ["--no-warnings", permissionFlag, `--allow-fs-read=${scriptPath}`, scriptPath], {
      cwd: ctx.cwd,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TRCODE_CODEMODE: "1" },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let acc = "";
    let settled = false;
    let killedReason = "";

    const done = (ok: boolean, output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(ceiling);
      ctx.signal.removeEventListener("abort", onAbort);
      scope.abort();
      child.stdin.end();
      killTree(child);
      // Wait for SDK work to observe cancellation and for the process to exit.
      const closed = child.exitCode !== null ? Promise.resolve() : new Promise<void>((r) => {
        const timer = setTimeout(r, 2000);
        child.once("close", () => { clearTimeout(timer); r(); });
      });
      const tasks = Promise.allSettled([...active, closed]);
      const grace = setTimeout(() => resolve({ ok, output }), 2500);
      void tasks.then(() => { clearTimeout(grace); resolve({ ok, output }); });
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "req") {
        if (settled || ctx.signal.aborted) return;
        const request = serveSdk(msg as SdkRequest, scopedCtx, deps)
          .then((value) => reply({ id: msg.id, ok: true, value }))
          .catch((err) => reply({ id: msg.id, ok: false, error: String((err as Error)?.message ?? err) }));
        active.add(request);
        void request.finally(() => active.delete(request));
        return;
      }
      if (msg.type === "done") {
        if (msg.ok) {
          const text =
            msg.value === null || msg.value === undefined
              ? "(the program returned nothing)"
              : typeof msg.value === "string"
                ? msg.value
                : JSON.stringify(msg.value, null, 2);
          done(true, text);
        } else {
          done(false, `The program threw: ${msg.error}`);
        }
      }
    };

    const reply = (res: SdkResponse) => {
      if (!settled && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify({ type: "res", ...res }) + "\n");
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      acc += c;
      if (acc.length > 2_000_000) return done(false, "Program output exceeded 2 MB.");
      for (;;) {
        const i = acc.indexOf("\n");
        if (i === -1) break;
        handleLine(acc.slice(0, i));
        acc = acc.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", (err) => done(false, `SDK channel closed: ${err.message}`));
    child.stderr.on("data", (c: string) => {
      // Syntax errors land here before any of our handlers can answer; keep
      // the tail, it is where the message sits.
      stderrTail = (stderrTail + c).slice(-8000);
    });
    let stderrTail = "";

    const ceiling = setTimeout(() => {
      killedReason = `[timed out after ${Math.round(timeoutMs / 1000)}s]`;
      killTree(child);
      done(false, killedReason);
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
      done(false, "[interrupted by the user]");
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();

    child.on("error", (err) => done(false, `Could not start node: ${err.message}`));
    child.on("close", () => {
      if (settled) return;
      const tail = stderrTail.trim();
      // A crash before "done" means the program never finished: syntax errors
      // and unhandled rejections outside the wrapper both end up here.
      const hint = /SyntaxError/.test(tail) ? tail.split("\n").slice(-6).join("\n") : tail.slice(-800);
      done(false, `The program exited before returning a value.${hint ? `\n${hint}` : ""}`);
    });

    async function serveSdk(msg: SdkRequest, c: ToolContext, d: RunCodeDeps): Promise<unknown> {
      c.signal.throwIfAborted();
      switch (msg.call) {
        case "fs.read": {
          const p = resolveInside(c.cwd, String(msg.args[0] ?? ""));
          const st = await fsp.stat(p);
          if (!st.isFile() || st.size > 400_000) throw new Error("SDK read requires a text file of at most 400 KB; use a targeted shell/read operation for larger files.");
          const buf = await fsp.readFile(p);
          if (looksBinary(buf)) return `[binary file, ${buf.length} bytes — skipped by the SDK]`;
          const text = buf.toString("utf8");
          c.signal.throwIfAborted();
          c.readFiles.add(p);
          const cap = Number(msg.args[1] ?? 200_000);
          return text.length > cap ? text.slice(0, cap) + `\n… [${text.length - cap} more characters]` : text;
        }
        case "fs.write": {
          const p = resolveInside(c.cwd, String(msg.args[0] ?? ""));
          const body = String(msg.args[1] ?? "");
          // Writes go through the snapshot the way writeTool does, so /rewind
          // still reaches into what a program changed.
          const result = await writeTool.run({ path: p, content: body }, c);
          if (result.isError) throw new Error(result.output);
          return path.relative(c.cwd, p);
        }
        case "fs.list": {
          const dir = resolveInside(c.cwd, String(msg.args[0] ?? "."));
          return fs.readdirSync(dir).slice(0, 2000);
        }
        case "fs.glob": {
          const pattern = String(msg.args[0] ?? "");
          const { globToRegExp, walk, isIgnored, rel } = await import("./fsutil.js");
          const rx = globToRegExp(pattern);
          const hits: string[] = [];
          walk(c.cwd, {
            cwd: c.cwd,
            maxFiles: 5000,
            onFile(abs) {
              const r = rel(c.cwd, abs);
              const name = path.basename(abs);
              if (isIgnored(name)) return;
              if (rx.test(r.replace(/\\/g, "/")) || rx.test(name)) hits.push(r);
              return hits.length < 1000;
            },
          });
          return hits;
        }
        case "shell": {
          const command = String(msg.args[0] ?? "");
          const ok = await d.confirmShell(command);
          if (!ok) throw new Error("The user rejected the command.");
          c.signal.throwIfAborted();
          return await runShellCapture(command, c);
        }
        case "web.fetch": {
          const url = String(msg.args[0] ?? "");
          if (!/^https?:\/\//i.test(url)) throw new Error(`Not an http(s) URL: ${url}`);
          const ok = await d.confirmWeb("fetch", url);
          if (!ok) throw new Error("The user rejected the fetch.");
          c.signal.throwIfAborted();
          const res = await fetch(url, { headers: { "User-Agent": "trcode-codemode/1", Accept: "*/*" }, redirect: "follow", signal: AbortSignal.any([c.signal, AbortSignal.timeout(60_000)]) });
          if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
          const text = await res.text();
          return text.length > 300_000 ? text.slice(0, 300_000) + "\n… [cut]" : text;
        }
        case "web.search": {
          const query = String(msg.args[0] ?? "");
          const ok = await d.confirmWeb("search", query);
          if (!ok) throw new Error("The user rejected the search.");
          const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; trcode)", Accept: "text/html" },
            signal: AbortSignal.any([c.signal, AbortSignal.timeout(60_000)]),
          });
          if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
          const { parseDuckDuckGo } = await import("./web.js");
          return parseDuckDuckGo(await res.text()).map((h) => ({ title: h.title, url: h.url, snippet: h.snippet }));
        }
        default:
          throw new Error(`No such SDK call: ${msg.call}`);
      }
    }

    async function runShellCapture(command: string, c: ToolContext): Promise<string> {
      const result = await shellTool.run({ command }, { ...c, confirm: async () => true });
      return result.output;
    }
    });
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* temp dir is temp either way */
    }
  }
}

export function makeRunCodeTool(deps: RunCodeDeps): ToolDef {
  const tool: ToolDef = {
    name: "run_code",
    risk: "agent",
    spillBias: "head",
    description:
      "Runs ONE JavaScript program that combines many operations — file reads, shell commands, web fetches — " +
      "and returns only the final value. Prefer it over repeated read/grep/web_search rounds when gathering data " +
      "across many files or pages: intermediate outputs never enter the conversation, which keeps every later step cheap. " +
      "SDK available in scope: sdk.fs.read(path, maxChars?), sdk.fs.write(path, text), sdk.fs.list(dir), sdk.glob(pattern), " +
      "sdk.shell(command), sdk.web.fetch(url), sdk.web.search(query) — all async; paths are relative to the working directory " +
      "and cannot leave it; shell and web calls ask the user for permission like their dedicated tools do. " +
      "Only the SDK and standard JavaScript are available: no native imports, process, require, or global fetch. " +
      "Write a plain program ending in `return {...}` — collect data with loops, return the summary, not the dumps.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript (async context). Example: `const files = await sdk.glob('src/**/*.ts'); const out = {};\nfor (const f of files) { const t = await sdk.fs.read(f); out[f] = (t.match(/TODO/g) || []).length; }\nreturn out;`",
        },
      },
      required: ["code"],
    },
    summarize: (a) => String(a.code ?? "").split("\n")[0]?.slice(0, 120),
    async run(args, ctx): Promise<ToolResult> {
      const code = String(args.code ?? "").trim();
      if (!code) return { output: "Empty program.", isError: true };
      if (!(await ctx.confirm(tool, args))) return { output: "User rejected the program.", isError: true };
      ctx.signal.throwIfAborted();

      const res = await runProgram(code, ctx, deps);
      return { output: res.output, isError: !res.ok };
    },
  };
  return tool;
}

/** Kept for tests that want the runner without the tool wrapper. */
export { runProgram as __runProgramForTests };
