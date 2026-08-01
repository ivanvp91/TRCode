/** File tools: read, write, edit, ls. */
import fs from "node:fs";
import path from "node:path";
import type { ToolDef } from "../types.js";
import { detectLineEnding, isIgnored, looksBinary, rel, resolveInside } from "./fsutil.js";
import { renderDiff } from "../ui/render.js";

const MAX_READ_BYTES = 400_000;
const MAX_READ_LINES = 2000;

export const readTool: ToolDef = {
  name: "read",
  risk: "read",
  description:
    "Reads a file from the working directory and returns it with line numbers. " +
    "Supports partial reads via offset/limit for large files. " +
    "Always read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file, relative to the working directory" },
      offset: { type: "integer", description: "First line number (1-based)" },
      limit: { type: "integer", description: "How many lines to read" },
    },
    required: ["path"],
  },
  summarize: (a) => String(a.path),
  async run(args, ctx) {
    const abs = resolveInside(ctx.cwd, String(args.path));
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return { output: `File not found: ${args.path}`, isError: true };
    }
    if (st.isDirectory()) return { output: `That is a directory, not a file: ${args.path}. Use ls.`, isError: true };
    if (st.size > MAX_READ_BYTES && !args.limit) {
      return {
        output: `File is too large (${(st.size / 1024).toFixed(0)} KB). Read it in parts with offset/limit, or use grep.`,
        isError: true,
      };
    }
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return { output: `Binary file (${st.size} bytes), skipped.`, isError: true };

    const lines = buf.toString("utf8").split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.min(Number(args.limit ?? MAX_READ_LINES), MAX_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (!slice.length) {
      return { output: `Line ${offset} is past the end of the file (${lines.length} lines total).`, isError: true };
    }
    ctx.readFiles.add(abs);

    const pad = String(offset + slice.length - 1).length;
    const body = slice.map((l, i) => `${String(offset + i).padStart(pad, " ")}\t${l}`).join("\n");
    const more =
      offset - 1 + slice.length < lines.length
        ? `\n\n… showing ${slice.length} of ${lines.length} lines. Next chunk: offset=${offset + slice.length}`
        : "";
    return { output: body + more, display: `${slice.length} of ${lines.length} lines` };
  },
};

export const writeTool: ToolDef = {
  name: "write",
  risk: "write",
  description:
    "Creates a new file or overwrites an existing one completely. " +
    "Use edit for targeted changes — it is safer. Parent directories are created automatically.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file" },
      content: { type: "string", description: "The complete file contents" },
    },
    required: ["path", "content"],
  },
  summarize: (a) => String(a.path),
  async run(args, ctx) {
    const abs = resolveInside(ctx.cwd, String(args.path));
    const content = String(args.content ?? "");
    const exists = fs.existsSync(abs);
    let before = "";
    if (exists) {
      before = fs.readFileSync(abs, "utf8");
      if (!ctx.readFiles.has(abs)) {
        return {
          output: `File ${args.path} exists but has not been read yet. Read it first so you do not overwrite changes you have not seen.`,
          isError: true,
        };
      }
    }

    const preview = exists
      ? renderDiff(before, content)
      : content.split("\n").slice(0, 40).map((l) => " + " + l).join("\n");
    const ok = await ctx.confirm(writeTool, args, preview);
    if (!ok) return { output: "The user rejected the file write.", isError: true };

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    ctx.readFiles.add(abs);
    const lines = content.split("\n").length;
    return {
      output: `${exists ? "Overwrote" : "Created"} ${rel(ctx.cwd, abs)} (${lines} lines).`,
      display: preview,
    };
  },
};

export const editTool: ToolDef = {
  name: "edit",
  risk: "write",
  description:
    "Replaces an exact string in a file. old_string must occur exactly once — " +
    "include enough surrounding context to make the match unique. " +
    "Set replace_all=true to replace every occurrence (a rename, for instance). " +
    "The file must be read first with read.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file" },
      old_string: { type: "string", description: "The exact text to replace, indentation included" },
      new_string: { type: "string", description: "The replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence" },
    },
    required: ["path", "old_string", "new_string"],
  },
  summarize: (a) => String(a.path),
  async run(args, ctx) {
    const abs = resolveInside(ctx.cwd, String(args.path));
    if (!fs.existsSync(abs)) return { output: `File not found: ${args.path}`, isError: true };
    if (!ctx.readFiles.has(abs)) {
      return { output: `Read ${args.path} first with the read tool.`, isError: true };
    }

    const before = fs.readFileSync(abs, "utf8");
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    if (oldStr === newStr) return { output: "old_string and new_string are identical — nothing to change.", isError: true };
    if (!oldStr) return { output: "old_string is empty. Use write to create a file.", isError: true };

    // Tolerate the model echoing back CRLF-normalised text.
    const eol = detectLineEnding(before);
    const needle = before.includes(oldStr) ? oldStr : oldStr.split("\n").join(eol);
    const count = countOccurrences(before, needle);
    if (count === 0) {
      return {
        output: `String not found in ${args.path}. Re-read the file — it may have changed, or the indentation differs.`,
        isError: true,
      };
    }
    if (count > 1 && !args.replace_all) {
      return {
        output: `Found ${count} occurrences. Add context to make it unique, or pass replace_all=true.`,
        isError: true,
      };
    }

    const replacement = newStr.split("\n").join(eol);
    const after = args.replace_all
      ? before.split(needle).join(replacement)
      : before.replace(needle, () => replacement);

    const preview = renderDiff(before, after);
    const ok = await ctx.confirm(editTool, args, preview);
    if (!ok) return { output: "The user rejected the edit.", isError: true };

    fs.writeFileSync(abs, after, "utf8");
    return {
      output: `Updated ${rel(ctx.cwd, abs)} (${count > 1 ? `${count} replacements` : "1 replacement"}).`,
      display: preview,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const found = haystack.indexOf(needle, i);
    if (found === -1) return n;
    n++;
    i = found + needle.length;
  }
}

export const lsTool: ToolDef = {
  name: "ls",
  risk: "read",
  description:
    "Lists a directory: subdirectories and files with sizes. " +
    "Housekeeping directories (node_modules, .git, dist…) are hidden.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory; defaults to the working directory" },
      depth: { type: "integer", description: "Recursion depth, 1..3 (default 1)" },
    },
  },
  summarize: (a) => String(a.path ?? "."),
  async run(args, ctx) {
    const abs = resolveInside(ctx.cwd, String(args.path ?? "."));
    if (!fs.existsSync(abs)) return { output: `Directory not found: ${args.path ?? "."}`, isError: true };
    const depth = Math.min(3, Math.max(1, Number(args.depth ?? 1)));
    const lines: string[] = [];
    let shown = 0;

    const list = (dir: string, level: number, prefix: string) => {
      if (level > depth || shown > 400) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const dirs = entries.filter((e) => e.isDirectory() && !isIgnored(e.name)).sort(byName);
      const files = entries.filter((e) => e.isFile() && !isIgnored(e.name)).sort(byName);
      for (const d of dirs) {
        lines.push(`${prefix}${d.name}/`);
        shown++;
        list(path.join(dir, d.name), level + 1, prefix + "  ");
      }
      for (const f of files) {
        let size = "";
        try {
          size = ` (${fmtSize(fs.statSync(path.join(dir, f.name)).size)})`;
        } catch {
          /* ignore */
        }
        lines.push(`${prefix}${f.name}${size}`);
        shown++;
      }
    };

    list(abs, 1, "");
    if (!lines.length) return { output: "Directory is empty (or everything was filtered out)." };
    const capped = shown > 400 ? "\n… listing truncated" : "";
    return { output: `${rel(ctx.cwd, abs)}/\n` + lines.slice(0, 400).join("\n") + capped, display: `${shown} entries` };
  },
};

function byName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name.localeCompare(b.name);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
