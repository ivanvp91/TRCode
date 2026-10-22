/** Self-update from GitHub Releases: check, download, swap the dist folder. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
 * Whether the passive startup check may run at all. One place decides, because
 * there used to be two callers with different ideas: the CLI honoured the
 * environment switches, the interactive start did not, so `TRCODE_NO_UPDATE_CHECK`
 * still made a request, and a first start made the same request twice.
 */
export function passiveCheckEnabled(cfg: { updateCheck?: boolean } = {}): boolean {
  if (process.env.TRCODE_UPDATE_API) return false; // pointing somewhere else is a test, not a user
  if (process.env.TRCODE_NO_UPDATE_CHECK) return false;
  return cfg.updateCheck !== false;
}

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
  const stage = fs.mkdtempSync(path.join(configDir(), ".update-applied-"));
  try {
    const file = path.join(stage, "update-applied.json");
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), version }));
    fs.renameSync(file, appliedPath());
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* locked marker temp */ }
  }
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

/**
 * Which tar to run. Windows 10+ ships bsdtar as System32\tar.exe, and that is
 * the one to name outright: a Git-for-Windows install puts GNU tar earlier on
 * PATH, and GNU tar reads an archive path of "C:\..." as host:path — it goes
 * looking for a machine called C and the unpack fails on the user's own disk.
 */
function tarBin(): string {
  if (process.platform !== "win32") return "tar";
  const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(sys) ? sys : "tar";
}

function untar(file: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // bsdtar ships with Windows 10+ and every Linux/macOS; args-array spawn,
    // so nothing from the network ever touches a shell.
    const child = spawn(tarBin(), ["-xzf", file, "-C", dir], { windowsHide: true, stdio: "ignore" });
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

const require = createRequire(import.meta.url);
type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: unknown };

/** Resolve the first installed package, including a broken package shadowing a parent. */
function installedVersion(from: string, dep: string, localOnly: boolean): string | null {
  for (let dir = from; ; ) {
    const pkg = path.join(dir, "node_modules", dep);
    if (fs.existsSync(pkg)) {
      try {
        const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (localOnly || up === dir) return null;
    dir = up;
  }
}

/**
 * Missing or incompatible dependencies, as npm specs. Load semver only when
 * updating: older clients that swapped dist without dependencies can still
 * boot and report how to repair the install.
 */
function missingDeps(deps: Record<string, string>, root: string, localOnly = false): string[] {
  if (!Object.keys(deps).length) return [];
  let semver: { validRange(range: string): string | null; satisfies(version: string, range: string): boolean };
  try { semver = require("semver"); }
  catch { throw new Error("Dependency checker is missing. Run npm install semver in the TRCode install directory, then update again."); }
  return Object.entries(deps).flatMap(([dep, range]) => {
    if (typeof range !== "string" || !semver.validRange(range)) {
      throw new Error(`Cannot verify dependency ${dep}@${range}: expected a semver range.`);
    }
    const version = installedVersion(root, dep, localOnly);
    return version && semver.satisfies(version, range) ? [] : [`${dep}@${range}`];
  });
}

/**
 * npm's own entry point, run through this node: no PATH lookup and no shell,
 * so the specs from the archive reach npm as plain arguments. Overridable so
 * the tests need neither the network nor a real install.
 */
function npmCli(): string | null {
  if (process.env.TRCODE_UPDATE_NPM) return process.env.TRCODE_UPDATE_NPM;
  const bin = path.dirname(process.execPath);
  return (
    [
      path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"), // Windows
      path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // Unix layouts
    ].find((p) => fs.existsSync(p)) ?? null
  );
}

/**
 * npm runs against a staged copy of node_modules. A failed install must never
 * change the dependencies used by the working build.
 */
function installDeps(root: string, specs: string[]): Promise<void> {
  const cli = npmCli();
  if (!cli) return Promise.reject(new Error("npm was not found next to node"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, "install", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", ...specs],
      { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    // A native package downloads its prebuilt binary; give it room, not forever.
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const last = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
      reject(new Error(last || `npm exited with code ${code}`));
    });
  });
}

/**
 * Prepare everything before touching the install. Live directories are only
 * renamed on the same filesystem; a failed rename cannot partially delete
 * them. Keep backups until all replacements and the restart marker succeed.
 */
export async function applyUpdate(
  rel: Release,
  opts: { to?: string; onStep?: (msg: string) => void } = {},
): Promise<{ to: string }> {
  if (!rel.tarball) throw new Error("No download URL for this release.");
  const target = path.resolve(opts.to ?? distDir());
  if (!fs.existsSync(path.join(target, "index.js"))) {
    throw new Error(`Unexpected install layout: no index.js in ${target}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trc-update-"));
  let work: string | undefined;
  let keepBackups = false;
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
    const root = path.dirname(target);
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(src), "package.json"), "utf8")) as Manifest;
    const deps = manifest.dependencies ?? {};
    const missing = missingDeps(deps, root);
    // Stage on the install's filesystem, so every live replacement is an
    // atomic rename even if the download directory is on another drive.
    work = fs.mkdtempSync(path.join(root, ".trc-update-"));
    const stagedDist = path.join(work, "dist");
    fs.cpSync(src, stagedDist, { recursive: true });
    const replacements: { target: string; staged: string; backup: string; backed?: boolean; installed?: boolean }[] = [];
    if (missing.length) {
      opts.onStep?.(`Installing ${missing.join(", ")}…`);
      const stage = path.join(work, "deps");
      fs.mkdirSync(stage);
      const modules = path.join(root, "node_modules");
      if (fs.existsSync(modules)) {
        fs.cpSync(modules, path.join(stage, "node_modules"), { recursive: true, dereference: true });
      }
      let current: Manifest = {};
      if (fs.existsSync(path.join(root, "package.json"))) {
        current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      }
      // Preserve development dependencies in source checkouts, and omit root
      // lifecycle scripts: installing dependencies should not run the app.
      const { scripts: _scripts, ...stagedManifest } = current;
      fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({
        ...stagedManifest, private: true, dependencies: { ...current.dependencies, ...deps },
      }));
      try {
        await installDeps(stage, missing);
        const still = missingDeps(deps, stage, true);
        if (still.length) throw new Error(`npm left incompatible dependencies: ${still.join(", ")}`);
      } catch (err) {
        const cmd = `npm install ${missing.map((d) => `"${d}"`).join(" ")}`;
        throw new Error(
          `Release ${rel.version} needs ${missing.join(", ")}, and npm could not add (${(err as Error).message}). ` +
          `Run ${cmd} in ${root}, then update again`,
        );
      }
      replacements.push({ target: modules, staged: path.join(stage, "node_modules"), backup: path.join(work, "old-node_modules") });
    }
    replacements.push({ target, staged: stagedDist, backup: path.join(work, "old-dist") });
    try {
      for (const entry of replacements) {
        if (fs.existsSync(entry.target)) {
          fs.renameSync(entry.target, entry.backup);
          entry.backed = true;
        }
        fs.renameSync(entry.staged, entry.target);
        entry.installed = true;
      }
      markUpdateApplied(rel.version);
    } catch (err) {
      const failures: string[] = [];
      for (const entry of [...replacements].reverse()) {
        try {
          if (entry.installed) fs.renameSync(entry.target, entry.staged);
          if (entry.backed) fs.renameSync(entry.backup, entry.target);
        } catch (restoreError) {
          failures.push((restoreError as Error).message);
        }
      }
      if (failures.length) {
        keepBackups = true;
        throw new Error(`Update failed (${(err as Error).message}); rollback failed (${failures.join("; ")}). Backups kept in ${work}`);
      }
      throw err;
    }
    return { to: target };
  } finally {
    // Cleanup cannot turn a committed update into a reported failure. A locked
    // leftover is safe to remove later; failed rollback backups must survive.
    if (work && !keepBackups) {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* locked backup */ }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* locked download */ }
  }
}
