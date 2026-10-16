/** Serialize our commits and reject stale previews instead of losing edits. */
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveInside } from "./fsutil.js";
import type { ToolContext } from "../types.js";

const locks = new Map<string, Promise<void>>();
export async function commitFile(ctx: ToolContext, abs: string, before: string | null, after: string, tool: string): Promise<void> {
  const key = process.platform === "win32" ? abs.toLowerCase() : abs;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID()}.tmp`);
  try {
    ctx.signal.throwIfAborted();
    resolveInside(ctx.cwd, abs);
    let current: string | null;
    try { current = await fsp.readFile(abs, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; current = null; }
    if (current !== before) throw new Error(`File changed since the preview: ${abs}. Re-read it before retrying.`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const mode = before !== null ? (await fsp.stat(abs)).mode & 0o777 : 0o666;
    await fsp.writeFile(temp, after, { encoding: "utf8", flag: "wx", mode });
    ctx.signal.throwIfAborted();
    resolveInside(ctx.cwd, abs);
    // Check again after asynchronous staging, immediately before the commit.
    let latest: string | null;
    try { latest = await fsp.readFile(abs, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; latest = null; }
    if (latest !== before) throw new Error(`File changed while staging: ${abs}. Re-read it before retrying.`);
    ctx.signal.throwIfAborted();
    ctx.snapshot?.({ path: abs, tool, before, after });
    if (before === null) {
      // A hard link commits a new file without replacing another creator.
      await fsp.link(temp, abs);
    } else await fsp.rename(temp, abs);
    ctx.readFiles.add(abs);
  } finally {
    await fsp.unlink(temp).catch(() => {});
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
