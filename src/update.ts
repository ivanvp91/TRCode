/** Self-update from GitHub Releases: check, download, swap the dist folder. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { VERSION, configDir } from "./config.js";
import { t as tr } from "./i18n.js";

export const REPO = "ivanvp91/TRCode";

/** Overridable so the tests can point the module at a local server. */
function apiBase(): string {
  return process.env.TRCODE_UPDATE_API || "https://api.github.com";
}

export interface Release {
  version: string;
  /** Download URL of the packaged tarball (.tgz asset). */
  tarball: string;
  /** Browser URL of the release page. */
  url?: string;
}

export function parseVersion(v: string): number[] {
  return v.trim().replace(/^v/, "").split(/[.\-_+]/).map((n) => parseInt(n, 10) || 0);
}

/** Is b strictly newer than a? Parts compare numerically, missing means zero. */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

async function get(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, {
    headers: { "user-agent": `TRCode/${VERSION}`, accept: "application/vnd.github+json" },
    redirect: "follow",
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

export async function latestRelease(signal?: AbortSignal): Promise<Release> {
  const res = await get(`${apiBase()}/repos/${REPO}/releases/latest`, signal);
  const j = (await res.json()) as any;
  // Our own packaging: a .tgz asset attached to the release. Fall back to the
  // source archive GitHub always serves, for releases published without one.
  const asset = (j.assets ?? []).find((a: any) => /\.tgz$/i.test(String(a.name)));
  return {
    version: String(j.tag_name ?? "").replace(/^v/, ""),
    tarball: asset?.browser_download_url ?? j.tarball_url,
    url: j.html_url,
  };
}

interface CheckCache {
  ts: number;
  version: string;
  url?: string;
}
const cachePath = () => path.join(configDir(), "update-check.json");

/**
 * One passive GET, at most once per maxAge. Nothing is ever applied here and
 * no state leaves the machine — the answer lands in a local cache file that
 * the next interactive start reads.
 */
export async function refreshCache(maxAgeMs = 6 * 3600_000): Promise<boolean> {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CheckCache;
    if (Date.now() - c.ts < maxAgeMs) return false;
  } catch {
    /* no cache yet */
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  timer.unref?.();
  try {
    const rel = await latestRelease(ac.signal);
    const cached: CheckCache = { ts: Date.now(), version: rel.version, url: rel.url };
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(cached));
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** What the last successful check found, when it beats this build. */
export function cachedUpdate(): Release | null {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CheckCache;
    if (!isNewer(VERSION, c.version)) return null;
    return { version: c.version, url: c.url, tarball: "" };
  } catch {
    return null;
  }
}

/**
 * A release installed since this process started. The running code stays in
 * memory, so the fact has to survive in a file for the *next* start to report
 * "restart to finish the update".
 */
const appliedPath = () => path.join(configDir(), "update-applied.json");

export function markUpdateApplied(version: string): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(appliedPath(), JSON.stringify({ ts: Date.now(), version }));
  try {
    fs.rmSync(cachePath(), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/** An update waiting for a restart, or null once the restart has happened. */
export function appliedUpdate(): string | null {
  try {
    const a = JSON.parse(fs.readFileSync(appliedPath(), "utf8")) as { ts: number; version: string };
    if (a.version !== VERSION) return a.version;
    // This start is already the new build — the wait is over.
    fs.rmSync(appliedPath(), { force: true });
    return null;
  } catch {
    return null;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await get(url);
  if (!res.body) throw new Error("Empty response body.");
  await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

function untar(file: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // bsdtar ships with Windows 10+ and every Linux/macOS; args-array spawn,
    // so nothing from the network ever touches a shell.
    const child = spawn("tar", ["-xzf", file, "-C", dir], { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)),
    );
  });
}

/** This file compiles to <install>/dist/update.js — so the app's dist is here. */
export function distDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * What the header's Version row should show: the version, a star when a newer
 * release exists (or one is already installed and waits for a restart), and
 * the gray explanation that goes with it. The check itself is never done here
 * — the caller decides whether the feature is on at all.
 */
export function versionBadge(): { text: string; note?: string } {
  const applied = appliedUpdate();
  if (applied) {
    return {
      text: `${VERSION}*`,
      note: tr(
        `update to ${applied} installed — restart the terminal`,
        `обновление ${applied} установлено — перезапустите терминал`,
      ),
    };
  }
  const upd = cachedUpdate();
  if (upd) {
    return {
      text: `${VERSION}*`,
      note: tr(
        `${upd.version} is available — run /update`,
        `доступна ${upd.version} — выполните /update`,
      ),
    };
  }
  return { text: VERSION };
}

function moveDir(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch {
    // Cross-device, or a handle somewhere refuses the rename.
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/**
 * Downloads the release, stages it in a temp dir, swaps it over `opts.to`
 * (default: this install's dist). The old tree is renamed aside first and
 * only deleted after the new one is fully in place, so a failure halfway
 * leaves a working install behind — the running process keeps its own code
 * in memory regardless.
 */
export async function applyUpdate(rel: Release, opts: { to?: string } = {}): Promise<{ to: string }> {
  if (!rel.tarball) throw new Error("No download URL for this release.");
  const target = opts.to ?? distDir();
  if (!fs.existsSync(path.join(target, "index.js"))) {
    throw new Error(`Unexpected install layout: no index.js in ${target}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trc-update-"));
  try {
    const tgz = path.join(tmp, "release.tgz");
    await download(rel.tarball, tgz);
    await untar(tgz, tmp);
    // npm-pack archives nest everything under package/.
    const src = [path.join(tmp, "package", "dist"), path.join(tmp, "dist")].find((p) =>
      fs.existsSync(p),
    );
    if (!src || !fs.existsSync(path.join(src, "index.js"))) {
      throw new Error("The downloaded archive has no dist/ folder — refusing to install it.");
    }

    const backup = `${target}.old`;
    fs.rmSync(backup, { recursive: true, force: true });
    moveDir(target, backup);
    try {
      moveDir(src, target);
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true });
      moveDir(backup, target);
      throw err;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    markUpdateApplied(rel.version);
    return { to: target };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
