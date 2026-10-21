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
  /** The workspace the token acts for, on hosts that need one named. */
  orgId?: string;
  orgName?: string;
  /** Official Sign in with ChatGPT registration and verified identity. */
  clientId?: string;
  hostId?: string;
  issuer?: string;
  subject?: string;
  email?: string;
  idToken?: string;
  scopes?: string[];
}

function authDir(): string {
  return ensureDir(path.join(configDir(), "auth"));
}

function credPath(provider: string): string {
  return path.join(authDir(), `${provider}.json`);
}

export function readCredentials(provider: string): Credentials | null {
  try {
    let raw = JSON.parse(fs.readFileSync(credPath(provider), "utf8"));
    if (provider === "openai" && typeof raw?.profileId === "string") raw = readChatgptProfile(raw.profileId);
    return raw?.accessToken ? raw : null;
  } catch {
    return null;
  }
}

export function writeCredentials(provider: string, creds: Credentials): Credentials {
  if (provider === "openai" && creds.mode === "oauth" && creds.clientId) {
    saveChatgptProfile(creds);
    selectChatgptProfile(creds.clientId);
  } else writeProtectedJson(credPath(provider), creds);
  return creds;
}

/** Atomic replacement keeps tokens and refresh state together on disk. */
export function writeProtectedJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed, or never created */ }
  }
}

export function chatgptProfilePath(clientId: string): string {
  const id = crypto.createHash("sha256").update(clientId).digest("hex");
  return path.join(authDir(), "openai-profiles", `${id}.json`);
}

export function readChatgptProfile(clientId: string): Credentials | null {
  try {
    const profile = JSON.parse(fs.readFileSync(chatgptProfilePath(clientId), "utf8")) as Credentials;
    return profile.clientId === clientId ? profile : null;
  } catch { return null; }
}

export function savedChatgptProfiles(): Credentials[] {
  const dir = path.join(authDir(), "openai-profiles");
  try {
    return fs.readdirSync(dir).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).flatMap((file) => {
      try {
        const profile = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Credentials;
        return profile.clientId && profile.issuer ? [profile] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

export function saveChatgptProfile(creds: Credentials): void {
  if (!creds.clientId) throw new Error("Missing ChatGPT client registration");
  writeProtectedJson(chatgptProfilePath(creds.clientId), creds);
}

export function selectChatgptProfile(clientId: string): void {
  if (!readChatgptProfile(clientId)) throw new Error("Unknown ChatGPT account registration");
  writeProtectedJson(credPath("openai"), { profileId: clientId });
}

export function activeChatgptClientId(): string | undefined {
  try { return JSON.parse(fs.readFileSync(credPath("openai"), "utf8")).profileId; }
  catch { return undefined; }
}

export function clearChatgptTokens(creds: Credentials): void {
  saveChatgptProfile({ ...creds, accessToken: "", refreshToken: undefined, idToken: undefined, expiresAt: undefined, scopes: [] });
}

export function clearCredentials(provider: string): boolean {
  try {
    if (provider === "openai") {
      const active = readCredentials(provider);
      if (active?.mode === "oauth" && active.clientId) clearChatgptTokens(active);
    }
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
    if (!accessToken) {
      // A vendor CLI may keep a plain API key instead of a session (Muse Code
      // does when the user chose "paste an API key").
      const apiKey = deepFind(json, ["api_key", "apiKey", "META_API_KEY"]);
      if (apiKey) return { mode: "apikey", accessToken: apiKey, source: file };
      continue;
    }
    const refreshToken = deepFind(json, ["refresh_token", "refreshToken"]);
    // Hosts that serve several accounts name the one a token acts for in the
    // file too (often `tokens.account_id`), and a request without it
    // is refused even though the token itself is fine.
    const accountId = deepFind(json, ["account_id", "accountId"]);
    return {
      mode: "oauth",
      accessToken,
      refreshToken,
      expiresAt: deepExpiry(json),
      orgId: accountId,
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
  const at = deepNumber(node, ["expires_at", "expiresAt", "expiry", "expiration", "expiry_date"]);
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
