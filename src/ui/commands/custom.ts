/**
 * Slash commands the user or the project defines as markdown files.
 *
 * Two directories are read, project first: `.trcode/commands/` at the
 * repository root and `commands/` in the config home. A file becomes `/<name>`,
 * a subdirectory is a namespace (`frontend/component.md` → `/frontend:component`),
 * and the body is the prompt sent to the model.
 *
 * A command may take arguments (`$ARGUMENTS`, appended when the body has no
 * placeholder) and may run shell commands before it is sent: `!`git branch
 * --show-current``, or a ```` ```! ```` block, is replaced by its output — so
 * what the model reads is the state of the repository, not a request to go and
 * look.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configDir, projectRoot } from "../../config.js";
import { killTree, shellLauncher } from "../../tools/shell.js";

export interface CustomCommand {
  /** With the leading slash and any namespace: `/frontend:component`. */
  name: string;
  /** One line, shown in the menu and in /help. */
  description: string;
  /** What to type after the name, e.g. `<file>`. */
  argumentHint?: string;
  /** Where it came from, for the listing. */
  file: string;
  /** Markdown body, before expansion. */
  body: string;
}

/** How long a `!`…`` command inside a command file may run. */
const SHELL_TIMEOUT_MS = 20_000;
/** Suggestions are asked for on every keystroke; the disk is read once a while. */
const SCAN_TTL_MS = 1_500;

export function customCommandDirs(cwd: string): string[] {
  return [path.join(projectRoot(cwd), ".trcode", "commands"), path.join(configDir(), "commands")];
}

/** `--- key: value ---` at the top of the file; anything else is the body. */
function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const src = text.replace(/^\uFEFF/, "");
  if (!src.startsWith("---")) return { meta: {}, body: src };
  const end = src.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: src };
  const head = src.slice(3, end);
  const body = src.slice(src.indexOf("\n", end + 4) + 1);
  const meta: Record<string, string> = {};
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }
  return { meta, body };
}

function readDir(dir: string, prefix: string, out: CustomCommand[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no such directory, or not readable
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      readDir(full, `${prefix}${entry.name}:`, out);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const base = entry.name.slice(0, -3);
    if (!base.trim()) continue;
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = splitFrontmatter(text);
    if (!body.trim()) continue;
    const description = (meta.description || body.split("\n").find((l) => l.trim()) || "").replace(/\s+/g, " ").trim();
    out.push({
      name: `/${prefix}${base}`,
      description: description || base,
      argumentHint: meta["argument-hint"] || meta.arguments || undefined,
      file: full,
      body,
    });
  }
}

let scanCache: { key: string; at: number; list: CustomCommand[] } | null = null;

/** Every command file reachable from this project. Cached briefly. */
export function discoverCustomCommands(cwd: string): CustomCommand[] {
  const dirs = customCommandDirs(cwd);
  const key = dirs.join("|");
  const now = Date.now();
  if (scanCache && scanCache.key === key && now - scanCache.at < SCAN_TTL_MS) return scanCache.list;
  const list: CustomCommand[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const found: CustomCommand[] = [];
    readDir(dir, "", found);
    // The project wins: a name defined in both places is the repository's.
    for (const cmd of found) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      list.push(cmd);
    }
  }
  scanCache = { key, at: now, list };
  return list;
}

export function resetCustomCommandCache(): void {
  scanCache = null;
}

export function findCustomCommand(cwd: string, name: string): CustomCommand | undefined {
  const wanted = name.startsWith("/") ? name : `/${name}`;
  return discoverCustomCommands(cwd).find((cmd) => cmd.name === wanted);
}

/** Runs one shell line for a `!`…`` placeholder. Never throws; failures read as text. */
function runSnippet(command: string, cwd: string): Promise<string> {
  const { cmd, args } = shellLauncher();
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (text: string) => {
      if (done) return;
      done = true;
      resolve(text.slice(0, 20_000));
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args(command), { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish(`(failed: ${(err as Error).message})`);
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish(`${out}\n(failed: timed out after ${SHELL_TIMEOUT_MS / 1000}s)`);
    }, SHELL_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(`(failed: ${err.message})`);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(out.trimEnd());
    });
  });
}

/**
 * The prompt a command stands for: arguments substituted, and every shell
 * placeholder replaced by what it printed.
 */
export async function expandCustomCommand(
  command: CustomCommand,
  args: string,
  opts: { cwd: string; sessionId?: string },
): Promise<string> {
  const rest = args.trim();
  let text = command.body;
  if (text.includes("$ARGUMENTS")) text = text.replace(/\$ARGUMENTS/g, rest);
  else if (rest) text = `${text.trimEnd()}\n\n${rest}`;
  text = text.replace(/\$\{TRCODE_CWD\}/g, opts.cwd);
  if (opts.sessionId) text = text.replace(/\$\{TRCODE_SESSION_ID\}/g, opts.sessionId);

  // Fenced blocks first: their content is usually a multi-line script.
  const blocks = /```!\s*\n([\s\S]*?)```/g;
  const pending: Promise<void>[] = [];
  text = text.replace(blocks, (_m, script: string) => {
    const token = `\u0000block${pending.length}\u0000`;
    pending.push(
      runSnippet(script.trim(), opts.cwd).then((out) => {
        text = text.replace(token, out);
      }),
    );
    return token;
  });
  await Promise.all(pending);

  // Then the inline form, one at a time: the output stays readable in order.
  const inline = /!`([^`]*?)`/g;
  const scripts: string[] = [];
  text = text.replace(inline, (_m, script: string) => {
    scripts.push(script);
    return `\u0000inline${scripts.length - 1}\u0000`;
  });
  for (let i = 0; i < scripts.length; i++) {
    const out = await runSnippet(scripts[i].trim(), opts.cwd);
    text = text.replace(`\u0000inline${i}\u0000`, out);
  }
  return text;
}
