/**
 * What the OpenRouter media tools share: the key check, the host, reference
 * images as data URLs, error bodies read down to the provider's own words, and
 * the public model listings.
 *
 * Image and video models never answer /chat/completions; each has its own
 * endpoint (/images, /videos) and its own catalogue listing what it accepts.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { modeConfig, modeFor, resolveAuth } from "../provider/registry.js";
import { mimeForPath } from "./image.js";

export const REQUEST_TIMEOUT_MS = 60_000;
/** A reference image goes up as base64 inside the JSON body; keep it sane. */
const MAX_REFERENCE_BYTES = 10_000_000;

/** True when an OpenRouter key is configured, which is all these tools need. */
export function openRouterAvailable(): boolean {
  return modeFor("openrouter") !== null;
}

/** The API root, honouring a moved host in the config (tests point it local). */
export function openRouterBase(): string {
  return (modeConfig("openrouter", "apikey")?.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
}

export function resolvePath(p: string, cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const expanded = p.replace(/^~(?=[\\/]|$)/, home);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd || process.cwd(), expanded);
}

/** A local image becomes a data URL; a remote one is passed through. */
export async function imageDataUrl(src: string, cwd: string): Promise<{ url: string } | { error: string }> {
  if (/^(https?:|data:)/i.test(src)) return { url: src };
  const abs = resolvePath(src, cwd);
  const mime = mimeForPath(abs);
  if (!mime) return { error: `unsupported image format: ${src}` };
  let st: fs.Stats;
  try {
    st = await fsp.stat(abs);
  } catch {
    return { error: `file not found: ${src}` };
  }
  if (st.size > MAX_REFERENCE_BYTES) return { error: `image too large (${(st.size / 1_048_576).toFixed(1)} MB; limit 10 MB)` };
  return { url: `data:${mime};base64,${(await fsp.readFile(abs)).toString("base64")}` };
}

/**
 * The provider's own words out of an error body. OpenRouter wraps the
 * upstream error as a string inside its own ("HTTP 400: {\"error\":…}"), and
 * the useful sentence sits at the bottom of that nesting.
 */
export function apiMessage(text: string): string {
  let found = "";
  let cur = text;
  for (let depth = 0; depth < 4; depth++) {
    const at = cur.indexOf("{");
    if (at < 0) break;
    let obj: any;
    try {
      obj = JSON.parse(cur.slice(at));
    } catch {
      break;
    }
    const e = obj?.error ?? obj;
    const msg = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : "";
    if (!msg) break;
    found = (e?.code && typeof e.code === "string" ? `${e.code}: ` : "") + msg;
    cur = msg;
  }
  return (found || text).slice(0, 600);
}

export function withTimeout(outer: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([outer, AbortSignal.timeout(ms)]);
}

/** A JSON request whose failure reads as the provider's message. */
export async function requestJson<T>(url: string, init: RequestInit, signal: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, { ...init, signal: withTimeout(signal, timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${apiMessage(text)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`not JSON: ${text.slice(0, 200)}`);
  }
}

const listings = new Map<string, Promise<unknown[]>>();

/**
 * A public OpenRouter model listing ("/videos/models", "/images/models"),
 * read once per process and again on demand. A failed read is not cached.
 */
export function fetchListing<T extends { id: string }>(route: string, refresh = false): Promise<T[]> {
  let job = listings.get(route);
  if (!job || refresh) {
    job = fetch(`${openRouterBase()}${route}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${apiMessage(await res.text())}`);
        const j: any = await res.json();
        const rows: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
        return rows.filter((r) => typeof r?.id === "string");
      })
      .catch((err) => {
        listings.delete(route);
        throw err;
      });
    listings.set(route, job);
  }
  return job as Promise<T[]>;
}

/**
 * Where a provider's media API lives and what to send with it. Z.AI's coding
 * plan host serves chat only; images and video sit on the open-platform path
 * of the same host, under the same key.
 */
export async function mediaAuth(providerId: string): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const auth = await resolveAuth(providerId);
  let baseUrl = auth.baseUrl.replace(/\/+$/, "");
  if (providerId === "zai") baseUrl = baseUrl.replace("/api/coding/paas/", "/api/paas/");
  return { baseUrl, headers: auth.headers };
}

/** The first http(s) URL under a key naming a url, anywhere in a response. */
export function findUrl(obj: unknown, depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v] as const) : Object.entries(obj as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (typeof v === "string" && /url/i.test(k) && !/cover|thumb|poster|polling/i.test(k) && /^https?:\/\//.test(v)) return v;
  }
  for (const [, v] of entries) {
    const hit = findUrl(v, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Downloads a result to `file`, creating the directory; returns its size.
 * `headers` only for links on the API host itself — a pre-signed CDN link
 * must not receive the key.
 */
export async function downloadTo(url: string, file: string, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<number> {
  const res = await fetch(url, { headers: headers ?? {}, signal: withTimeout(signal, 5 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${apiMessage(await res.text())}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buf);
  return buf.length;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** "20261001-143005" — for default file names. */
export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
