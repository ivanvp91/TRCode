/** Search tools: glob (by name) and grep (by content). */
import fs from "node:fs";
import path from "node:path";
import type { ToolDef } from "../types.js";
import { extraIgnoresFrom, globToRegExp, looksBinary, rel, resolveInside, walk } from "./fsutil.js";

export const globTool: ToolDef = {
  name: "glob",
  risk: "read",
  description:
    "Finds files by glob pattern (e.g. 'src/**/*.ts', '**/*.{js,json}'). " +
    "Results are sorted by modification time, newest first.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search; defaults to the working directory" },
      limit: { type: "integer", description: "Maximum results (default 100)" },
    },
    required: ["pattern"],
  },
  summarize: (a) => String(a.pattern),
  async run(args, ctx) {
    const root = resolveInside(ctx.cwd, String(args.path ?? "."));
    const re = globToRegExp(String(args.pattern));
    const limit = Math.min(Number(args.limit ?? 100), 500);
    const hits: { p: string; mtime: number }[] = [];

    walk(root, {
      cwd: ctx.cwd,
      extraIgnores: extraIgnoresFrom(ctx.cwd),
      onFile(abs, st) {
        const relPath = rel(root, abs);
        if (re.test(relPath) || re.test(path.basename(abs))) {
          hits.push({ p: abs, mtime: st.mtimeMs });
        }
        return hits.length < limit * 20;
      },
    });

    if (!hits.length) return { output: `Nothing matched the pattern: ${args.pattern}` };
    hits.sort((a, b) => b.mtime - a.mtime);
    const list = hits.slice(0, limit).map((h) => rel(ctx.cwd, h.p));
    const more = hits.length > limit ? `\n… ${hits.length - limit} more` : "";
    return { output: list.join("\n") + more, display: `${hits.length} matches` };
  },
};

export const grepTool: ToolDef = {
  name: "grep",
  risk: "read",
  description:
    "Searches file contents with a regular expression and returns matching lines with numbers. " +
    "Narrow the search with include (glob) and path so the results stay usable.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (JS syntax)" },
      path: { type: "string", description: "Directory or file to search" },
      include: { type: "string", description: "Glob filter on file names, e.g. '*.ts'" },
      case_insensitive: { type: "boolean", description: "Case-insensitive" },
      context: { type: "integer", description: "Lines of context around each match" },
      files_only: { type: "boolean", description: "Return only file paths" },
      limit: { type: "integer", description: "Maximum matches (default 80)" },
    },
    required: ["pattern"],
  },
  summarize: (a) => `${a.pattern}${a.include ? ` in ${a.include}` : ""}`,
  async run(args, ctx) {
    const root = resolveInside(ctx.cwd, String(args.path ?? "."));
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern), args.case_insensitive ? "i" : "");
    } catch (err) {
      return { output: `Invalid regular expression: ${(err as Error).message}`, isError: true };
    }
    const includeRe = args.include ? globToRegExp(String(args.include)) : null;
    const limit = Math.min(Number(args.limit ?? 80), 400);
    const ctxLines = Math.min(Number(args.context ?? 0), 5);

    const out: string[] = [];
    const matchedFiles: string[] = [];
    let total = 0;

    const scanFile = (abs: string, size: number) => {
      if (size > 2_000_000) return;
      if (includeRe && !includeRe.test(path.basename(abs)) && !includeRe.test(rel(root, abs))) return;
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        return;
      }
      if (looksBinary(buf)) return;
      const lines = buf.toString("utf8").split(/\r?\n/);
      let fileHeaderWritten = false;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        total++;
        if (!fileHeaderWritten) {
          matchedFiles.push(rel(ctx.cwd, abs));
          fileHeaderWritten = true;
        }
        if (args.files_only || out.length >= limit) continue;
        const from = Math.max(0, i - ctxLines);
        const to = Math.min(lines.length - 1, i + ctxLines);
        for (let j = from; j <= to; j++) {
          const marker = j === i ? ":" : "-";
          out.push(`${rel(ctx.cwd, abs)}${marker}${j + 1}${marker}${lines[j].slice(0, 400)}`);
        }
        if (ctxLines) out.push("--");
      }
    };

    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(root);
    } catch {
      return { output: `Path not found: ${args.path}`, isError: true };
    }
    if (st.isFile()) {
      scanFile(root, st.size);
    } else {
      walk(root, {
        cwd: ctx.cwd,
        extraIgnores: extraIgnoresFrom(ctx.cwd),
        onFile(abs, s) {
          scanFile(abs, s.size);
          return total < limit * 30;
        },
      });
    }

    if (!total) return { output: `No matches: /${args.pattern}/` };
    if (args.files_only) {
      return { output: matchedFiles.slice(0, limit).join("\n"), display: `${matchedFiles.length} files` };
    }
    const more = total > limit ? `\n… ${total} matches total, showing ${limit}` : "";
    return {
      output: out.join("\n") + more,
      display: `${total} matches in ${matchedFiles.length} files`,
    };
  },
};
