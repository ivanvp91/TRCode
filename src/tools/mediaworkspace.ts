/**
 * Every media task owns a scratch folder under <cwd>/.tmp. One-off results land
 * in cwd itself and their folder is deleted at once; project workspaces (from
 * prepare_media_workspace) live until exit. Only folders still holding paid,
 * unsaved output survive, so resume_media can finish them without paying again.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { resolveInside } from "./fsutil.js";
import { resolvePath, stamp } from "./media.js";
import { IMAGE_EXT } from "./image.js";
import type { ToolContext, ToolDef } from "../types.js";

export const MEDIA_TMP = ".tmp";
/** tmp and scenes are the record's own folder; output is cwd unless the record is a scene of a project. */
export interface MediaWorkspace { dir: string; tmp: string; scenes: string; output: string; manifest: Record<string, any> }
export function mediaWork(dir: string, manifest: Record<string, any>, cwd: string): MediaWorkspace {
  return { dir, tmp: dir, scenes: dir, output: manifest.project ? dir : cwd, manifest };
}
/** Folders created by this process, swept on exit. */
const owned = new Map<string, string>();
export async function prepareMedia(ctx: ToolContext, kind: string, model: string, args: Record<string, any>, inputs: string[] = []): Promise<MediaWorkspace> {
  ctx.signal.throwIfAborted();
  let dir: string;
  let project = false;
  const name = `${kind}-${stamp()}`;
  if (args.workspace) {
    dir = resolveInside(ctx.cwd, String(args.workspace));
    const parent = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
    if (parent.version !== 1 || !parent.id) throw new Error("Not a media workspace.");
    // Distinct records preserve every scene generation in a shared project.
    dir = path.join(dir, `${name}-${randomUUID().slice(0, 8)}`);
    project = true;
  } else {
    dir = resolveInside(ctx.cwd, path.join(MEDIA_TMP, `${name}-${randomUUID().slice(0, 8)}`));
    owned.set(dir, ctx.cwd);
  }
  resolveInside(ctx.cwd, dir);
  const scrub = (v: any): any => typeof v === "string" && v.startsWith("data:") ? { sha256: createHash("sha256").update(v).digest("hex") } : Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, scrub(value)])) : v;
  const safeArgs = scrub(args);
  const manifest: Record<string, any> = { version: 1, id: randomUUID(), kind, model, name, project, createdAt: new Date().toISOString(), status: "prepared", parameters: safeArgs };
  const work = mediaWork(dir, manifest, ctx.cwd);
  await fsp.mkdir(dir, { recursive: true });
  const references: Record<string, unknown>[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const source = inputs[i];
    const data = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(source);
    if (data) {
      const bytes = Buffer.from(data[2], "base64");
      const ext = data[1] === "image/jpeg" ? "jpg" : data[1].split("/")[1].replace(/[^a-z0-9]/gi, "");
      const file = path.join(work.tmp, `reference-${i + 1}.${ext}`);
      await fsp.writeFile(file, bytes, { flag: "wx" });
      references.push({ file, mime: data[1], sha256: createHash("sha256").update(bytes).digest("hex") });
    } else references.push({ source, sha256: null, note: "Remote reference is fetched by the provider" });
  }
  manifest.inputs = references;
  await updateMedia(work, {});
  return work;
}
export async function updateMedia(work: MediaWorkspace, patch: Record<string, any>): Promise<void> {
  Object.assign(work.manifest, patch, { updatedAt: new Date().toISOString() });
  const temp = path.join(work.tmp, `manifest-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, JSON.stringify(work.manifest, null, 2), { flag: "wx", mode: 0o600 });
    await fsp.rename(temp, path.join(work.dir, "manifest.json"));
  } finally { await fsp.unlink(temp).catch(() => {}); }
}
/** Default names handed out in this process, so concurrent generations never pick the same one. */
const claimed = new Map<string, string>();
export function mediaOutputPath(work: MediaWorkspace, out: unknown, ext: string, cwd: string, index = 0, count = 1): string {
  if (!out) {
    const m = work.manifest;
    const base = path.join(work.output, m.project ? "result" : m.name ?? `${m.kind}-${m.id.slice(0, 8)}`);
    const suffix = count > 1 ? `-${index + 1}` : "";
    const file = `${base}${suffix}.${ext}`;
    // Two generations started in the same second must not collide in cwd.
    const taken = (claimed.get(file) ?? m.id) !== m.id || (fs.existsSync(file) && !m.saved?.includes(file));
    const chosen = taken ? `${base}-${m.id.slice(0, 8)}${suffix}.${ext}` : file;
    claimed.set(chosen, m.id);
    return chosen;
  }
  const abs = resolvePath(String(out), cwd);
  const directory = /[\\/]$/.test(String(out)) || (fs.existsSync(abs) && fs.statSync(abs).isDirectory());
  if (directory) return path.join(abs, `result-${work.manifest.id.slice(0, 8)}${count > 1 ? `-${index + 1}` : ""}.${ext}`);
  const oldExt = path.extname(abs);
  return `${oldExt ? abs.slice(0, -oldExt.length) : abs}${count > 1 ? `-${index + 1}` : ""}.${ext}`;
}
export async function saveMedia(file: string, bytes: Buffer, work: MediaWorkspace, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const temp = path.join(work.tmp, `${randomUUID()}.part`);
  let published = false;
  try {
    await fsp.writeFile(temp, bytes, { flag: "wx" });
    signal.throwIfAborted();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try { await fsp.link(temp, file); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fsp.copyFile(temp, file, fs.constants.COPYFILE_EXCL);
    }
    published = true;
  } catch (err) {
    throw new Error(`${(err as Error).message}. Generated bytes retained at ${temp}`);
  } finally { if (published) await fsp.unlink(temp).catch(() => {}); }
}

/** A finished one-off generation needs no scratch folder; true when it was removed. */
export async function finishMedia(work: MediaWorkspace): Promise<boolean> {
  if (work.manifest.project || !["completed", "quality_mismatch"].includes(work.manifest.status)) return false;
  await fsp.rm(work.dir, { recursive: true, force: true }).catch(() => {});
  owned.delete(work.dir);
  await fsp.rmdir(path.dirname(work.dir)).catch(() => {}); // only succeeds once .tmp is empty
  return !fs.existsSync(work.dir);
}
/** Paid output that was never saved, or a video job still in flight. */
function recoverable(dir: string): boolean {
  let m: Record<string, any> | undefined;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { /* not a record */ }
  if (m && !["completed", "quality_mismatch", "prepared"].includes(m.status) && (m.jobId || m.recoveryFile || fs.existsSync(path.join(dir, "generated-response.json")))) return true;
  try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && recoverable(path.join(dir, e.name))); }
  catch { return false; }
}
/** On exit: drop this process's media folders unless resume_media could still use them. */
export function sweepMediaTmp(): void {
  for (const [dir, cwd] of owned) {
    try { if (!recoverable(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmdirSync(path.join(cwd, MEDIA_TMP)); } catch { /* not empty */ }
  }
  owned.clear();
}

export function checkMediaOutput(out: unknown, cwd: string, count = 1): string | undefined {
  if (!out) return;
  const abs = resolvePath(String(out), cwd);
  if (/[\\/]$/.test(String(out)) || (fs.existsSync(abs) && fs.statSync(abs).isDirectory())) return;
  const ext = path.extname(abs);
  const stem = ext ? abs.slice(0, -ext.length) : abs;
  for (let i = 0; i < Math.min(count, 16); i++) for (const suffix of [...Object.values(IMAGE_EXT), "jpeg", "mp4", "wav", "mp3", "m4a", "ogg", "flac"]) {
    const candidate = `${stem}${count > 1 ? `-${i + 1}` : ""}.${suffix}`;
    if (fs.existsSync(candidate)) return `Output already exists: ${candidate}. Choose a new path before generating.`;
  }
}
export const prepareMediaTool: ToolDef = {
  name: "prepare_media_workspace", risk: "write",
  description: "Create a scratch directory (under .tmp/, deleted when trcode exits) before planning or assembling multi-part media. Put ALL scripts, downloads, intermediate scenes and clips in it, and pass workspace to generation tools so scene results stay there. Write only the finished deliverable to the current directory. A single one-off generation does not need this.",
  parameters: { type: "object", properties: { kind: { type: "string", enum: ["video", "audio", "image"] }, title: { type: "string" } }, required: ["kind"] },
  async run(args, ctx) {
    if (!["video", "audio", "image"].includes(args.kind)) return { output: "kind must be video, audio, or image", isError: true };
    if (!(await ctx.confirm(prepareMediaTool, args))) return { output: "Workspace creation rejected", isError: true };
    const w = await prepareMedia(ctx, args.kind, "", args);
    return { output: `Media workspace: ${w.dir}\nPut every script, scratch file, download and scene here; it is deleted when trcode exits.\nSave the finished deliverable to ${ctx.cwd}.` };
  },
};
