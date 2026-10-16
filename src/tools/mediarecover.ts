/** Recover synchronous media from retained provider output, without payment. */
import fsp from "node:fs/promises";
import path from "node:path";
import { inspectGeneratedImage } from "./mediaquality.js";
import { readBounded, withTimeout, GENERATE_TIMEOUT_MS } from "./media.js";
import { IMAGE_EXT } from "./image.js";
import { resolveInside } from "./fsutil.js";
import { finishMedia, mediaOutputPath, saveMedia, updateMedia, type MediaWorkspace } from "./mediaworkspace.js";
import type { ToolContext, ToolResult } from "../types.js";

export async function recoverLocalMedia(work: MediaWorkspace, ctx: ToolContext, out?: string): Promise<ToolResult> {
  const saved: string[] = [];
  const qa: Record<string, unknown>[] = [];
  const publish = async (file: string, buf: Buffer) => {
    let existing: Buffer | undefined;
    try { existing = await fsp.readFile(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (existing) { if (!existing.equals(buf)) throw new Error(`Existing file has different content: ${file}. Choose another out path.`); }
    else await saveMedia(file, buf, work, ctx.signal);
    saved.push(file);
  };
  try {
    if (work.manifest.kind === "audio") {
      if (!work.manifest.recoveryFile) throw new Error("No completed audio was retained; an incomplete stream cannot be recovered locally");
      const source = resolveInside(work.dir, work.manifest.recoveryFile);
      const ext = path.extname(source).slice(1);
      const buf = await fsp.readFile(source);
      await publish(mediaOutputPath(work, out ?? work.manifest.parameters?.out, ext, ctx.cwd), buf);
    } else if (work.manifest.kind === "image") {
      const response = JSON.parse(await fsp.readFile(path.join(work.tmp, "generated-response.json"), "utf8"));
      const items = (response.data ?? []).filter((d: any) => d.b64_json || d.url);
      if (!items.length) throw new Error("No completed images were retained");
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let buf: Buffer;
        if (item.b64_json) buf = Buffer.from(String(item.b64_json).replace(/^data:[^,]+,/, ""), "base64");
        else {
          const res = await fetch(item.url, { signal: withTimeout(ctx.signal, GENERATE_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`HTTP ${res.status} downloading retained result`);
          buf = await readBounded(res);
        }
        const meta = await inspectGeneratedImage(buf, work.manifest.parameters ?? {});
        qa.push(meta);
        const ext = meta.format === "jpeg" ? "jpg" : meta.format;
        if (!ext || !Object.values(IMAGE_EXT).includes(ext)) throw new Error("Unsupported recovered image format");
        await publish(mediaOutputPath(work, out ?? work.manifest.parameters?.out, ext, ctx.cwd, i, items.length), buf);
      }
    } else throw new Error("Unsupported local media kind");
    const warnings = work.manifest.kind === "image" ? qa.flatMap((q) => q.warnings as string[]) : work.manifest.warnings ?? [];
    await updateMedia(work, { status: warnings.length ? "quality_mismatch" : "completed", saved, ...(qa.length ? { qa } : {}) });
    const where = (await finishMedia(work)) ? "" : ` Workspace: ${work.dir}`;
    return { output: `Recovered ${saved.join(", ")}.${where}${warnings.length ? `\nQuality checks: ${warnings.join("; ")}` : ""}`, isError: warnings.length > 0 };
  } catch (e) {
    await updateMedia(work, { status: "recovery_failed", saved, error: (e as Error).message });
    return { output: `Media recovery failed: ${(e as Error).message}. Workspace: ${work.dir}. No new paid request was sent.`, isError: true };
  }
}
