/**
 * Image reading for vision models.
 *
 * A screenshot lands in the chat as a path (`[Image #1]` → a temp file), and
 * until now that path was dead weight: the read tool refuses binary, so the
 * model could never see what the user pasted. This tool loads the file once,
 * base64-encodes it, and sends it as real image content on the wire.
 *
 * The base64 travels inside the history from then on, which makes every later
 * step pay for it — so it is capped by bytes, and trim.ts stubs old copies
 * like any other oversized tool result.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { ToolDef, ToolResult } from "../types.js";

/** ~1600 KB of PNG is ~2.2 MB of base64; enough for any screenshot. */
const MAX_IMAGE_BYTES = 1_600_000;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function mimeForPath(p: string): string | null {
  return MIME_BY_EXT[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? null;
}

export const readImageTool: ToolDef = {
  name: "read_image",
  risk: "read",
  description:
    "Reads an image file (png, jpeg, gif, webp, bmp) and shows it to you, if the current model understands images. " +
    "Use for screenshots pasted into the chat ([Image #N] tokens expand to temp-file paths) or any image file on disk. " +
    "Returns dimensions and format first; call again with describe=true to also get the pixels.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the image file" },
      describe: {
        type: "boolean",
        description:
          "Send the actual pixels to the model (default true). Pass false to only check format, dimensions and size without spending context on the image itself.",
      },
    },
    required: ["path"],
  },
  summarize: (a) => String(a.path),
  spillBias: "head",
  async run(args, ctx): Promise<ToolResult> {
    const abs = ctx.cwd && !pathIsAbsolute(String(args.path)) ? joinCwd(ctx.cwd, String(args.path)) : String(args.path);
    let st: fs.Stats;
    try {
      st = await fsp.stat(abs);
    } catch {
      return { output: `File not found: ${args.path}`, isError: true };
    }
    if (!st.isFile()) return { output: `Not a file: ${args.path}`, isError: true };

    const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      return {
        output: `Unsupported image format "${ext}". Supported: ${Object.keys(MIME_BY_EXT).join(", ")}.`,
        isError: true,
      };
    }
    if (st.size > MAX_IMAGE_BYTES) {
      return {
        output: `Image is too large (${(st.size / 1024).toFixed(0)} KB; limit ${(MAX_IMAGE_BYTES / 1024).toFixed(0)} KB). Downscale or crop it first.`,
        isError: true,
      };
    }

    const buf = await fsp.readFile(abs);
    const dims = pngSize(buf) ?? gifSize(buf) ?? bmpSize(buf);
    const head =
      `${abs} — ${mime.replace("image/", "").toUpperCase()}, ` +
      `${dims ? `${dims.width}×${dims.height}` : "unknown dimensions"}, ${(st.size / 1024).toFixed(0)} KB.`;

    if (args.describe === false) return { output: head, display: dims ? `${dims.width}×${dims.height}` : st.size + " B" };
    ctx.readFiles.add(abs);
    return {
      output: head + " The image itself follows above.",
      images: [{ data: buf.toString("base64"), mime }],
      display: dims ? `${dims.width}×${dims.height}` : `${(st.size / 1024).toFixed(0)} KB`,
    };
  },
};

function pathIsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/") || p.startsWith("~");
}

function joinCwd(cwd: string, p: string): string {
  const clean = p.replace(/^~(?=\/|\\|$)/, cwd);
  return /^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith("/") ? clean : cwd.replace(/[\\/]+$/, "") + "/" + p;
}

function be16(b: Buffer, o: number): number {
  return b.readUInt16BE(o);
}
function be32(b: Buffer, o: number): number {
  return b.readUInt32BE(o);
}

function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function gifSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 10 || b.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: be16(b, 6), height: be16(b, 8) };
}

function bmpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 26 || b.toString("ascii", 0, 2) !== "BM") return null;
  // BMP heights may be negative for top-down rows.
  const h = b.readInt32LE(22);
  return { width: b.readInt32LE(18), height: Math.abs(h) };
}
