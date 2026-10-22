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
import path from "node:path";
import os from "node:os";
import type { ToolDef, ToolResult } from "../types.js";
import { loadSharp } from "./sharp.js";

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

/** File extension for each image type a generator may return. */
export const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif" };

/** The first bytes say what a file is better than a missing content type. */
export function sniffImage(buf: Buffer): string | undefined {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (/^\s*(<\?xml|<svg)/.test(buf.toString("utf8", 0, 64))) return "image/svg+xml";
  return undefined;
}

export function mimeForPath(p: string): string | null {
  return MIME_BY_EXT[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? null;
}

export const readImageTool: ToolDef = {
  name: "read_image",
  risk: "read",
  description:
    "Reads an image file (png, jpeg, gif, webp) and shows a preview if the current model understands images. BMP supports metadata-only inspection. " +
    "Use for screenshots pasted into the chat ([Image #N] tokens expand to temp-file paths) or any image file on disk. " +
    "Returns format and dimensions with a bounded preview by default. describe=false reads metadata only, including for large files. crop selects a region without modifying the original.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the image file" },
      describe: {
        type: "boolean",
        description:
          "Send the actual pixels to the model (default true). Pass false to only check format, dimensions and size without spending context on the image itself.",
      },
      max_dimension: { type: "integer", description: "Preview longest side, 128..2048 (default 1600); original is preserved" },
      crop: { type: "object", properties: { left: { type: "integer" }, top: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } }, required: ["left", "top", "width", "height"], description: "Crop in original image pixels for inspecting fine details" },
    },
    required: ["path"],
  },
  summarize: (a) => String(a.path),
  spillBias: "head",
  async run(args, ctx): Promise<ToolResult> {
    const abs = path.resolve(ctx.cwd, String(args.path).replace(/^~(?=[\\/]|$)/, os.homedir()));
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
    if (st.size > 100_000_000 && args.describe !== false) {
      return {
        output: `Image exceeds 100 MB. Use describe=false for metadata.`,
        isError: true,
      };
    }

    const handle = await fsp.open(abs, "r");
    let buf: Buffer;
    try {
      if (args.describe === false) {
        const prefix = Buffer.alloc(Math.min(st.size, 131_072));
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        buf = prefix.subarray(0, bytesRead);
      } else buf = await handle.readFile();
    } finally { await handle.close(); }
    let dims = imageDimensions(buf);
    try {
      const sharp = await loadSharp();
      const meta = await sharp(abs, { limitInputPixels: 64_000_000 }).metadata();
      if (meta.width && meta.height) dims = { width: meta.width, height: meta.height };
    } catch (err) {
      if (args.describe !== false) return { output: `Image could not be decoded: ${(err as Error).message}`, isError: true };
    }
    const head =
      `${abs} — ${mime.replace("image/", "").toUpperCase()}, ` +
      `${dims ? `${dims.width}×${dims.height}` : "unknown dimensions"}, ${(st.size / 1024).toFixed(0)} KB.`;

    if (args.describe === false) return { output: head, display: dims ? `${dims.width}×${dims.height}` : st.size + " B" };
    let preview: Buffer;
    let previewMime: string;
    let previewInfo: { width: number; height: number };
    try {
      let max = args.max_dimension ?? 1600;
      if (!Number.isInteger(max) || max < 128 || max > 2048) throw new Error("max_dimension must be 128..2048");
      const sharp = await loadSharp();
      const pipeline = () => {
        let image = sharp(buf, { limitInputPixels: 64_000_000, failOn: "warning" });
        if (args.crop) {
          const rect = args.crop;
          for (const k of ["left", "top", "width", "height"]) if (!Number.isInteger(rect[k]) || rect[k] < (k === "left" || k === "top" ? 0 : 1)) throw new Error("Invalid crop rectangle");
          image = image.extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        }
        return image.rotate().resize({ width: max, height: max, fit: "inside", withoutEnlargement: true });
      };
      // PNG preserves alpha and screenshot text; retry a smaller preview if
      // noisy pixels would exceed the context budget.
      let result = await pipeline().png().toBuffer({ resolveWithObject: true });
      while (result.data.length > MAX_IMAGE_BYTES && max > 128) { max = Math.max(128, Math.floor(max * 0.7)); result = await pipeline().png().toBuffer({ resolveWithObject: true }); }
      if (result.data.length > MAX_IMAGE_BYTES) throw new Error("Preview exceeds context byte limit");
      ctx.signal.throwIfAborted();
      preview = result.data; previewMime = "image/png"; previewInfo = result.info;
    } catch (err) { return { output: `Image preview failed: ${(err as Error).message}`, isError: true }; }
    ctx.readFiles.add(abs);
    return {
      output: head + ` Preview ${previewInfo.width}×${previewInfo.height}${args.crop ? " (cropped region)" : ""} follows; original preserved.`,
      images: [{ data: preview.toString("base64"), mime: previewMime }],
      display: dims ? `${dims.width}×${dims.height}` : `${(st.size / 1024).toFixed(0)} KB`,
    };
  },
};

function be32(b: Buffer, o: number): number {
  return b.readUInt32BE(o);
}

function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function gifSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 10 || b.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

export function imageDimensions(b: Buffer): { width: number; height: number } | null {
  const simple = pngSize(b) ?? gifSize(b) ?? bmpSize(b);
  if (simple) return simple;
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const tag = b.toString("ascii", 12, 16);
    if (tag === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (tag === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (tag === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at++] !== 0xff) continue;
      while (b[at] === 0xff) at++;
      const marker = b[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > b.length) break;
      const len = b.readUInt16BE(at);
      if (len < 2 || at + len > b.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && len >= 7) {
        return { width: b.readUInt16BE(at + 5), height: b.readUInt16BE(at + 3) };
      }
      at += len;
    }
  }
  return null;
}

function bmpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 26 || b.toString("ascii", 0, 2) !== "BM") return null;
  // BMP heights may be negative for top-down rows.
  const h = b.readInt32LE(22);
  return { width: b.readInt32LE(18), height: Math.abs(h) };
}
