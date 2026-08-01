/**
 * Model catalog. The live list comes from GET /v1/models; the seed list below
 * is only a cold-start fallback so `/model` still works offline.
 *
 * Context windows and prices are NOT published by the endpoint in a stable
 * shape, so they are treated as estimates unless the provider returns them or
 * the user pins real numbers in ~/.trcode/config.json under "pricing".
 */
import fs from "node:fs";
import path from "node:path";
import { configDir, ensureDir, loadConfig, type Effort } from "../config.js";
import { protocolOf, registerProtocols } from "./protocol.js";
import type { ModelInfo } from "../types.js";

/** Used when neither the API nor the user config states a real window. */
export const ASSUMED_CONTEXT = 128_000;

/**
 * Context windows the API does not report. Only entries we actually know go
 * here; everything else falls back to ASSUMED_CONTEXT and says so in /context.
 * Extend via config → "contextWindows".
 */
const KNOWN_CONTEXT: Record<string, number> = {
  "moonshotai/kimi-k3": 1_000_000,
  "moonshotai/kimi-k3-free": 1_000_000,
};

/** Display names for catalog namespaces. */
const VENDOR_LABELS: Record<string, string> = {
  moonshotai: "MoonShot",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  "z-ai": "Z.AI",
  "x-ai": "xAI",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  minimax: "MiniMax",
  mistralai: "Mistral",
  "bytedance-seed": "ByteDance",
  nvidia: "NVIDIA",
  xiaomi: "Xiaomi",
  stepfun: "StepFun",
  tencent: "Tencent",
  miromind: "MiroMind",
  sakana: "Sakana",
  microsoft: "Microsoft",
  ex: "EX",
};

/** Vendors pinned to the top of every list, in this order. */
const VENDOR_RANK = ["MoonShot", "Anthropic", "OpenAI", "Qwen", "xAI"];

export function vendorOf(m: ModelInfo): string {
  const ns = m.id.includes("/") ? m.id.split("/")[0].toLowerCase() : "";
  if (ns) return VENDOR_LABELS[ns] ?? ns;
  // Un-namespaced ids: guess from a leading token, else bucket them together.
  const head = m.id.split(/[-_.]/)[0].toLowerCase();
  if (head.startsWith("minimax")) return "MiniMax";
  if (head.startsWith("qwen")) return "Qwen";
  if (head.startsWith("kling")) return "Kling";
  if (head.startsWith("seed")) return "ByteDance";
  if (head.startsWith("claude")) return "Anthropic";
  return VENDOR_LABELS[head] ?? "Other";
}

const seed = (id: string, endpoints: string[] = ["openai"]): ModelInfo => ({
  id,
  owner: id.includes("/") ? id.split("/")[0] : undefined,
  endpoints,
  tags: "Text",
  chatCapable: true,
});

/** Cold-start fallback only; the live list always wins. */
const SEED: ModelInfo[] = [
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k3-free",
  "moonshotai/kimi-k2.7-code",
  "moonshotai/kimi-k2.6",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
  "qwen/qwen3-coder-next",
  "z-ai/glm-5.2",
  "z-ai/glm-5.1",
  "z-ai/glm-5-turbo",
  "x-ai/grok-4.5",
  "openai/gpt-5.2",
  "openai/gpt-oss-120b",
  "minimax/minimax-m2.7",
  "mistralai/devstral-2512",
]
  .map((id) => seed(id))
  .concat(
    // Responses-only models.
    ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "openai/gpt-5.5-pro", "openai/gpt-5.4"].map(
      (id) => seed(id, ["openai-response"]),
    ),
    // Native Anthropic models.
    [
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-5-fast",
      "anthropic/claude-fable-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4.5",
    ].map((id) => seed(id, ["anthropic"])),
  );

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cacheFile(): string {
  return path.join(ensureDir(configDir()), "models.cache.json");
}

interface CacheShape {
  fetchedAt: number;
  baseUrl: string;
  models: ModelInfo[];
}

function readCache(baseUrl: string): ModelInfo[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as CacheShape;
    if (raw.baseUrl !== baseUrl) return null;
    if (Date.now() - raw.fetchedAt > CACHE_TTL_MS) return null;
    return raw.models?.length ? raw.models : null;
  } catch {
    return null;
  }
}

function writeCache(baseUrl: string, models: ModelInfo[]): void {
  try {
    const payload: CacheShape = { fetchedAt: Date.now(), baseUrl, models };
    fs.writeFileSync(cacheFile(), JSON.stringify(payload, null, 2));
  } catch {
    /* cache is best-effort */
  }
}

/**
 * True when the model can be driven through /v1/chat/completions with text.
 * TokenRouter mixes native-Anthropic, native-Gemini, Responses-only, image,
 * video and audio models into the same catalog; none of those work here.
 */
function isChatCapable(endpoints: string[], tags: string): boolean {
  const t = tags.toLowerCase();
  if (t && !t.includes("text")) return false;
  if (!endpoints.length) return true; // no metadata — assume the common case
  // openai → /chat/completions, openai-response → /responses,
  // anthropic → /messages. All three have adapters.
  return endpoints.some((e) => e === "openai" || e === "openai-response" || e.startsWith("anthropic"));
}

/** What the model produces. Endpoints are more reliable than the tag string. */
function modalityOf(endpoints: string[], tags: string): ModelInfo["modality"] {
  if (endpoints.some((e) => e.startsWith("video"))) return "video";
  if (endpoints.some((e) => e.startsWith("image"))) return "image";
  if (endpoints.some((e) => e.startsWith("audio"))) return "audio";
  const t = tags.toLowerCase();
  if (t.includes("text")) return "text";
  if (t.includes("video")) return "video";
  if (t.includes("image")) return "image";
  if (t.includes("audio")) return "audio";
  return "text";
}

/** Reads whatever metadata the provider happens to expose, defensively. */
function normalize(raw: any): ModelInfo {
  const id = String(raw?.id ?? raw?.model ?? "").trim();
  const pricingRaw = raw?.pricing ?? raw?.price ?? {};
  const inNum = num(pricingRaw.input ?? pricingRaw.prompt ?? pricingRaw.input_per_million);
  const outNum = num(pricingRaw.output ?? pricingRaw.completion ?? pricingRaw.output_per_million);
  const endpoints = Array.isArray(raw?.supported_endpoint_types)
    ? raw.supported_endpoint_types.map(String)
    : [];
  const tags = String(raw?.tags ?? "").trim();
  const info: ModelInfo = {
    id,
    label: raw?.name ?? raw?.display_name ?? undefined,
    owner: raw?.owned_by && raw.owned_by !== "custom" ? raw.owned_by : id.includes("/") ? id.split("/")[0] : undefined,
    contextWindow: num(raw?.context_window ?? raw?.context_length ?? raw?.max_context_tokens),
    maxOutput: num(raw?.max_output_tokens ?? raw?.max_completion_tokens),
    supportsTools: raw?.supports_tools ?? raw?.tools ?? true,
    endpoints,
    tags,
    modality: modalityOf(endpoints, tags),
    created: num(raw?.created),
    chatCapable: isChatCapable(endpoints, tags),
  };
  if (inNum !== undefined && outNum !== undefined) {
    // Providers report either $/token or $/1M; normalise to $/1M.
    const scale = inNum < 0.001 ? 1_000_000 : 1;
    info.pricing = { input: inNum * scale, output: outNum * scale };
  }
  return info;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function fetchModels(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
  const cfg = loadConfig();
  if (!opts.force) {
    const hit = readCache(cfg.baseUrl);
    if (hit) return decorate(hit);
  }
  if (!cfg.apiKey) return decorate(SEED);
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    const list: any[] = Array.isArray(body) ? body : body?.data ?? [];
    const models = list.map(normalize).filter((m) => m.id);
    if (!models.length) throw new Error("empty model list");
    writeCache(cfg.baseUrl, models);
    return decorate(models);
  } catch {
    const stale = readCacheStale(cfg.baseUrl);
    return decorate(stale ?? SEED);
  }
}

function readCacheStale(baseUrl: string): ModelInfo[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as CacheShape;
    return raw.baseUrl === baseUrl && raw.models?.length ? raw.models : null;
  } catch {
    return null;
  }
}

/** Overlays user-pinned pricing/context onto whatever the provider gave us. */
function decorate(models: ModelInfo[]): ModelInfo[] {
  const cfg = loadConfig();
  const seedById = new Map(SEED.map((m) => [m.id, m]));
  const out = models.map((m) => {
    const seed = seedById.get(m.id);
    return {
      ...m,
      label: m.label ?? seed?.label ?? m.id,
      owner: m.owner ?? seed?.owner,
      pricing: cfg.pricing[m.id] ?? m.pricing ?? seed?.pricing,
      contextWindow: cfg.contextWindows[m.id] ?? m.contextWindow ?? KNOWN_CONTEXT[m.id] ?? seed?.contextWindow,
      chatCapable: m.chatCapable ?? seed?.chatCapable ?? true,
      modality: m.modality ?? seed?.modality ?? "text",
    };
  });
  registerProtocols(out);
  return out;
}

/**
 * Vendor sections, newest model first inside each. The API's `created` field
 * is the only objective "newer/stronger" signal we have, so ordering rests on
 * it; vendors are ordered by their freshest model.
 */
export function groupByVendor(models: ModelInfo[]): { vendor: string; models: ModelInfo[] }[] {
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const v = vendorOf(m);
    const bucket = groups.get(v);
    if (bucket) bucket.push(m);
    else groups.set(v, [m]);
  }
  const out = [...groups.entries()].map(([vendor, list]) => ({
    vendor,
    models: list.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id)),
  }));
  return out.sort((a, b) => {
    const ra = VENDOR_RANK.indexOf(a.vendor);
    const rb = VENDOR_RANK.indexOf(b.vendor);
    // Pinned vendors first, in the order listed; the rest by freshest model.
    if (ra !== -1 || rb !== -1) {
      if (ra === -1) return 1;
      if (rb === -1) return -1;
      return ra - rb;
    }
    const newest = (g: { models: ModelInfo[] }) => Math.max(...g.models.map((m) => m.created ?? 0));
    return newest(b) - newest(a) || a.vendor.localeCompare(b.vendor);
  });
}

export const MODALITIES: { key: NonNullable<ModelInfo["modality"]>; label: string }[] = [
  { key: "text", label: "Text" },
  { key: "image", label: "Images" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
];

/** The models this client can actually drive, unless the user opted out. */
export function usableModels(catalog: ModelInfo[]): ModelInfo[] {
  if (!loadConfig().hideIncompatibleModels) return catalog;
  const usable = catalog.filter((m) => m.chatCapable !== false);
  return usable.length ? usable : catalog;
}

/** Human explanation of why a model cannot be used through this client. */
export function incompatibleReason(m: ModelInfo): string | null {
  if (m.chatCapable !== false) return null;
  const e = m.endpoints ?? [];
  if (e.includes("image-generation")) return "image generation";
  if (e.includes("video-generation")) return "video generation";
  if (e.includes("audio-chat")) return "audio chat";
  if (e.includes("gemini")) return "native Gemini endpoint";
  return `endpoints: ${e.join(", ") || "unknown"}`;
}

/** Resolves aliases and unique prefixes to a concrete model id. */
export function resolveModelId(input: string, catalog: ModelInfo[]): string {
  const cfg = loadConfig();
  const raw = input.trim();
  if (!raw) return cfg.model;
  const alias = cfg.aliases[raw.toLowerCase()];
  if (alias) return alias;
  const all = catalog.map((m) => m.id);
  if (all.includes(raw)) return raw;

  // Prefer models this client can drive; fall back to the whole catalog so a
  // deliberate pick of an incompatible model still resolves (and warns later).
  const pools = [usableModels(catalog).map((m) => m.id), all];
  const q = raw.toLowerCase();
  const base = (id: string) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();

  for (const ids of pools) {
    const exact = ids.find((id) => id.toLowerCase() === q);
    if (exact) return exact;

    // "kimi-k3" should beat "moonshotai/kimi-k3-free" on an exact tail match.
    const tail = ids.filter((id) => base(id) === q);
    if (tail.length === 1) return tail[0];

    const prefix = ids.filter((id) => id.toLowerCase().startsWith(q) || base(id).startsWith(q));
    if (prefix.length === 1) return prefix[0];

    const sub = ids.filter((id) => id.toLowerCase().includes(q));
    if (sub.length === 1) return sub[0];

    const candidates = tail.length > 1 ? tail : prefix.length > 1 ? prefix : sub;
    if (candidates.length > 1) {
      throw new Error(`Ambiguous (${candidates.length}): ${candidates.slice(0, 8).join(", ")}${candidates.length > 8 ? "…" : ""}`);
    }
  }
  throw new Error(`Model not found: ${raw}`);
}

export function contextWindowFor(id: string, catalog: ModelInfo[]): number {
  return catalog.find((m) => m.id === id)?.contextWindow ?? ASSUMED_CONTEXT;
}

export function findModel(id: string, catalog: ModelInfo[]): ModelInfo | undefined {
  return catalog.find((m) => m.id === id);
}

/**
 * Effective reasoning budget for a model: an explicit session override wins,
 * then the per-model setting, then the global default.
 */
export function effortFor(model: string, sessionOverride?: Effort): Effort {
  if (sessionOverride) return sessionOverride;
  const cfg = loadConfig();
  return cfg.effortByModel[model] ?? cfg.effort ?? "off";
}

export { SEED as SEED_MODELS };
