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
 * object passed to it at bootstrap. Importing 'node:*' directly would not be
 * blockable reliably, so it is not attempted — the SDK's own guards are what
 * holds: every path resolves inside the project root, shell calls go through
 * the same permission broker as the shell tool, web calls carry the abort
 * signal and the same timeouts.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { resolveInside, looksBinary } from "./fsutil.js";
import { killTree } from "./shell.js";
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
const __queue = [];
let __waiter = null;
process.stdin.setEncoding("utf8");
const __dispatch = (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "res") __queue.push(msg);
  if (__waiter) { const w = __waiter; __waiter = null; w(); }
};
// Line-delimited JSON on stdin; the parent writes one response per line.
let __acc = "";
process.stdin.on("data", (chunk) => {
  __acc += chunk;
  for (;;) {
    const i = __acc.indexOf("\\n");
    if (i === -1) break;
    const line = __acc.slice(0, i);
    __acc = __acc.slice(i + 1);
    __dispatch(line);
  }
});
const __next = () => (__queue.length ? Promise.resolve(__queue.shift()) : new Promise((res) => { __waiter = res; }));
const __reply = (res) => process.stdout.write(JSON.stringify(res) + "\\n");
const __rpc = (call) => async (...args) => {
  const id = ++__rpcSeq;
  process.stdout.write(JSON.stringify({ type: "req", id, call, args }) + "\\n");
  for (;;) {
    const m = await __next();
    if (!m) continue;
    if (m.type === "res" && m.id === id) {
      if (!m.ok) throw new Error(m.error);
      return m.value;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
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
`;

/** The program body plus a runner that reports the return value back. */
function buildScript(code: string): string {
  return `${BOOTSTRAP}\n(async () => {\n${code}\n})().then(
  (v) => { __reply({ type: "done", ok: true, value: v === undefined ? null : v }); },
  (e) => __reply({ type: "done", ok: false, error: String((e && e.message) || e) }),
);\n`;
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
    const child = spawn(process.execPath, ["--no-warnings", scriptPath], {
      cwd: ctx.cwd,
      env: { ...process.env, TRCODE_CODEMODE: "1" },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map<number, (res: SdkResponse) => void>();
    let acc = "";
    let settled = false;
    let killedReason = "";

    const done = (ok: boolean, output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(ceiling);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve({ ok, output });
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
        void serveSdk(msg as SdkRequest, ctx, deps)
          .then((value) => reply({ id: msg.id, ok: true, value }))
          .catch((err) => reply({ id: msg.id, ok: false, error: String((err as Error)?.message ?? err) }));
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
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: "res", ...res }) + "\n");
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      acc += c;
      for (;;) {
        const i = acc.indexOf("\n");
        if (i === -1) break;
        handleLine(acc.slice(0, i));
        acc = acc.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      // Syntax errors land here before any of our handlers can answer; keep
      // the tail, it is where the message sits.
      stderrTail += c;
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
      switch (msg.call) {
        case "fs.read": {
          const p = resolveInside(c.cwd, String(msg.args[0] ?? ""));
          const buf = fs.readFileSync(p);
          if (looksBinary(buf)) return `[binary file, ${buf.length} bytes — skipped by the SDK]`;
          const text = buf.toString("utf8");
          const cap = Number(msg.args[1] ?? 200_000);
          return text.length > cap ? text.slice(0, cap) + `\n… [${text.length - cap} more characters]` : text;
        }
        case "fs.write": {
          const p = resolveInside(c.cwd, String(msg.args[0] ?? ""));
          const body = String(msg.args[1] ?? "");
          const existed = fs.existsSync(p);
          // Writes go through the snapshot the way writeTool does, so /rewind
          // still reaches into what a program changed.
          if (c.snapshot) {
            const before = existed ? fs.readFileSync(p, "utf8") : null;
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, body);
            c.snapshot({ path: p, tool: "run_code", before, after: body });
          } else {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, body);
          }
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
          return await runShellCapture(command, c);
        }
        case "web.fetch": {
          const url = String(msg.args[0] ?? "");
          if (!/^https?:\/\//i.test(url)) throw new Error(`Not an http(s) URL: ${url}`);
          const ok = await d.confirmWeb("fetch", url);
          if (!ok) throw new Error("The user rejected the fetch.");
          const res = await fetch(url, { headers: { "User-Agent": "trcode-codemode/1", Accept: "*/*" }, redirect: "follow" });
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
      // Same launcher rules as the shell tool, minus the live tail: the
      // program consumes the output itself.
      const cfg = loadConfig();
      const mode = cfg.shell === "auto" ? (process.platform === "win32" ? "powershell" : "bash") : cfg.shell;
      const [cmd, mkArgs]: [string, (s: string) => string[]] =
        mode === "powershell"
          ? ["powershell.exe", (s) => ["-NoProfile", "-NonInteractive", "-Command", s]]
          : mode === "cmd"
            ? ["cmd.exe", (s) => ["/d", "/s", "/c", s]]
            : ["bash", (s) => ["-c", s]];
      return await new Promise((resolve) => {
        const sh = spawn(cmd, mkArgs(command), {
          cwd: c.cwd,
          env: { ...process.env, TRCODE: "1", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" },
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        sh.stdout.setEncoding("utf8");
        sh.stderr.setEncoding("utf8");
        const push = (s: string) => {
          out += s;
          if (out.length > 300_000) out = out.slice(0, 300_000) + "\n… [output cut]";
        };
        sh.stdout.on("data", push);
        sh.stderr.on("data", (x: string) => (err += x));
        sh.on("error", (e) => resolve(`Could not start the shell: ${e.message}`));
        sh.on("close", (code) => resolve(`exit=${code ?? "killed"}\n${out}${err ? `\n[stderr]\n${err}` : ""}`));
      });
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
  return {
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

      const res = await runProgram(code, ctx, deps);
      return { output: res.output, isError: !res.ok };
    },
  };
}

/** Kept for tests that want the runner without the tool wrapper. */
export { runProgram as __runProgramForTests };
