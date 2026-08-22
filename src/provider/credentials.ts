/**
 * Tokens for third-party providers, stored apart from config.json.
 *
 * config.json is printed whole by `trc config` and /config, and gets pasted
 * into issues; a refresh token that unlocks a paid subscription for 30 days
 * has no business riding along in it. These live in ~/.trcode/auth/, one file
 * per provider, 0600.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { configDir, ensureDir } from "../config.js";

/** How the bearer was obtained. Picks both the endpoint and the dialect. */
export type AuthMode = "oauth" | "apikey";

export interface Credentials {
  mode: AuthMode;
  /** Sent as `Authorization: Bearer`. */
  accessToken: string;
  /** Only for OAuth; trades for a fresh access token. */
  refreshToken?: string;
  /** Epoch ms. Absent when the credential does not expire. */
  expiresAt?: number;
  /** Where it came from, shown by `trc auth status`. */
  source?: string;
}

function authDir(): string {
  return ensureDir(path.join(configDir(), "auth"));
}

function credPath(provider: string): string {
  return path.join(authDir(), `${provider}.json`);
}

export function readCredentials(provider: string): Credentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(credPath(provider), "utf8")) as Credentials;
    return raw?.accessToken ? raw : null;
  } catch {
    return null;
  }
}

export function writeCredentials(provider: string, creds: Credentials): Credentials {
  fs.writeFileSync(credPath(provider), JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  return creds;
}

export function clearCredentials(provider: string): boolean {
  try {
    fs.unlinkSync(credPath(provider));
    return true;
  } catch {
    return false;
  }
}

/** Providers with a credential on disk. */
export function storedProviders(): string[] {
  try {
    return fs
      .readdirSync(authDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/** True once the token is close enough to expiry that it should be renewed. */
export function isStale(creds: Credentials, skewMs = 5 * 60_000): boolean {
  if (!creds.expiresAt) return false;
  return Date.now() >= creds.expiresAt - skewMs;
}

/**
 * Stable per-install id. Some hosts refuse a request without one and treat a
 * changing value as a new device, so it is generated once and kept. An id left
 * by the vendor's own CLI wins — same machine, same device.
 */
export function deviceId(vendorFiles: string[] = []): string {
  for (const f of vendorFiles) {
    try {
      const body = fs.readFileSync(expandHome(f), "utf8").trim();
      if (body && body.length < 200) return body.replace(/^"|"$/g, "");
    } catch {
      /* not installed */
    }
  }
  const own = path.join(authDir(), "device-id");
  try {
    const body = fs.readFileSync(own, "utf8").trim();
    if (body) return body;
  } catch {
    /* first run */
  }
  const id = crypto.randomUUID();
  try {
    fs.writeFileSync(own, id + "\n", { mode: 0o600 });
  } catch {
    /* best effort — a fresh id per run still works, just looks like a new device */
  }
  return id;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Picks up a login the vendor's own CLI already performed, so a user who ran
 * `kimi /login` does not have to authorize twice. The on-disk shape is not
 * documented and has changed between versions, so rather than binding to one
 * layout we walk the JSON for the fields we need.
 */
export function importVendorCredentials(files: string[]): Credentials | null {
  for (const file of files) {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(expandHome(file), "utf8"));
    } catch {
      continue;
    }
    const accessToken = deepFind(json, ["access_token", "accessToken", "token"]);
    if (!accessToken) continue;
    const refreshToken = deepFind(json, ["refresh_token", "refreshToken"]);
    return {
      mode: "oauth",
      accessToken,
      refreshToken,
      expiresAt: deepExpiry(json),
      source: file,
    };
  }
  return null;
}

function deepFind(node: unknown, keys: string[]): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  for (const key of keys) {
    const v = (node as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 8) return v;
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const hit = deepFind(v, keys);
    if (hit) return hit;
  }
  return undefined;
}

/** Absolute expiry in ms, from whichever of the usual spellings is present. */
function deepExpiry(node: unknown): number | undefined {
  const at = deepNumber(node, ["expires_at", "expiresAt", "expiry", "expiration"]);
  if (at !== undefined) return at < 1e12 ? at * 1000 : at; // seconds or ms
  const inSec = deepNumber(node, ["expires_in", "expiresIn"]);
  return inSec !== undefined ? Date.now() + inSec * 1000 : undefined;
}

function deepNumber(node: unknown, keys: string[]): number | undefined {
  if (!node || typeof node !== "object") return undefined;
  for (const key of keys) {
    const v = (node as Record<string, unknown>)[key];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const hit = deepNumber(v, keys);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
