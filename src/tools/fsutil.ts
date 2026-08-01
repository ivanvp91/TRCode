/** Path safety, ignore rules and a dependency-free glob matcher. */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORES = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "target",
  "vendor",
  ".DS_Store",
  ".trcode",
];

/** Resolves a user/model supplied path against cwd, rejecting escapes. */
export function resolveInside(cwd: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const root = path.resolve(cwd);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || (path.isAbsolute(rel) && rel !== "")) {
    throw new Error(`Path outside the working directory is refused: ${p}`);
  }
  return abs;
}

export function rel(cwd: string, abs: string): string {
  const r = path.relative(cwd, abs);
  return r === "" ? "." : r.split(path.sep).join("/");
}

export function isIgnored(name: string, extra: string[] = []): boolean {
  return DEFAULT_IGNORES.includes(name) || extra.includes(name);
}

/** Heuristic binary sniff so we never dump raw bytes into the context. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) suspicious++;
  }
  return suspicious / Math.max(1, n) > 0.3;
}

/** Converts a glob to a RegExp. Supports **, *, ?, {a,b} and character classes. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const g = glob.split(path.sep).join("/");
  while (i < g.length) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // `**/` swallows any number of directories, including none.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (ch === "{") {
      const close = g.indexOf("}", i);
      if (close !== -1) {
        const alts = g.slice(i + 1, close).split(",").map(escapeRe);
        re += `(?:${alts.join("|")})`;
        i = close + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = g.indexOf("]", i);
      if (close !== -1) {
        re += g.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    re += escapeRe(ch);
    i++;
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface WalkOptions {
  cwd: string;
  maxFiles?: number;
  maxDepth?: number;
  extraIgnores?: string[];
  /** Called for each file; return false to stop the walk early. */
  onFile(absPath: string, stat: fs.Stats): boolean | void;
}

export function walk(dir: string, opts: WalkOptions): void {
  const maxFiles = opts.maxFiles ?? 20000;
  const maxDepth = opts.maxDepth ?? 20;
  let count = 0;
  let stopped = false;

  const visit = (d: string, depth: number) => {
    if (stopped || depth > maxDepth || count >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    // Files first keeps results readable when a cap truncates the walk.
    const dirs: fs.Dirent[] = [];
    for (const e of entries) {
      if (stopped) return;
      if (isIgnored(e.name, opts.extraIgnores)) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        dirs.push(e);
        continue;
      }
      if (!e.isFile()) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      count++;
      if (opts.onFile(abs, st) === false) {
        stopped = true;
        return;
      }
      if (count >= maxFiles) return;
    }
    for (const e of dirs) visit(path.join(d, e.name), depth + 1);
  };

  visit(dir, 0);
}

/** Reads gitignore-style top-level dir names to skip, best effort. */
export function extraIgnoresFrom(cwd: string): string[] {
  try {
    const body = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    return body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.includes("*") && !l.includes("/"))
      .map((l) => l.replace(/\/$/, ""))
      .slice(0, 200);
  } catch {
    return [];
  }
}

export function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  return crlf > 0 && crlf >= lf / 2 ? "\r\n" : "\n";
}
