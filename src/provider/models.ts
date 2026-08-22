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
import {
  configuredProviders,
  DEFAULT_PROVIDER,
  modeConfig,
  modeFor,
  providerLabelFor,
  qualifyModelId,
  resolveAuth,
  seedModels,
  splitModelId,
  endpointFor,
  type ProviderMode,
} from "./registry.js";
import type { ModelInfo } from "../types.js";

/** Used when neither the API nor the user config states a real window. */
export const ASSUMED_CONTEXT = 128_000;

/**
 * Context windows the API does not report.
 *
 * TokenRouter's catalog carries no `context_window` for any model, so without
 * this table every model in the picker claims the assumed 128k — including the
 * ones that hold 256k or a million. The numbers are the windows each vendor
 * publishes for the family.
 *
 * Exact ids first, then families: the catalog renames models faster than this
 * table can follow ("qwen3.7-max" became "qwen3.8-max"), and a family that
 * shipped 262k does not quietly drop to 128k in the next point release. A
 * model matching nothing here stays at ASSUMED_CONTEXT and /context says so.
 * Both are overridable per model via config → "contextWindows" (/context 500k).
 */
const KNOWN_CONTEXT: Record<string, number> = {
  "x-ai/grok-4.20-beta": 2_000_000,
};

/**
 * Family rules, matched against the bare model name — provider prefix and
 * vendor namespace stripped, so "alibabacloud:qwen3-max", "qwen/qwen3.8-max"
 * and a plain "qwen3.6-flash" all reach the same rule.
 *
 * `from` is the release at which the family grew its window: Qwen's -max line
 * held 256k through 3.6 and moved to 1M with 3.7, so the rule for the newer
 * one is listed first and the older number stays behind it. The version is the
 * first number in the name, which is where every vendor here puts it.
 *
 * First satisfied rule wins. When a guess would have to be made, none is: an
 * overstated window is not caught until the host rejects a request, while the
 * assumed 128k only compacts a session earlier than it had to.
 */
interface ContextRule {
  match: RegExp;
  /** Applies from this version of the family upwards. */
  from?: number;
  window: number;
}

const CONTEXT_RULES: ContextRule[] = [
  // Qwen. Coder takes the 1M window; -max moved to 1M with 3.7 (May 2026);
  // plus/flash/turbo are 1M on Model Studio; the open weights are 256k native.
  { match: /^qwen.*coder/, window: 1_048_576 },
  { match: /^qwen[\d.]*-?max/, from: 3.7, window: 1_000_000 },
  { match: /^qwen[\d.]*-?max/, window: 262_144 },
  { match: /^qwen.*omni/, window: 65_536 },
  { match: /^qwen.*-(plus|flash|turbo)/, window: 1_000_000 },
  // Open weights: 3.8 shares the 1M window of the hosted -max it was cut from.
  { match: /^qwen.*\d+b/, from: 3.8, window: 1_000_000 },
  { match: /^qwen.*\d+b/, window: 262_144 },
  // Kimi K3 is the 1M model; K2 and its code variants are 256k.
  { match: /^kimi/, from: 3, window: 1_048_576 },
  { match: /^kimi/, window: 262_144 },
  // The Claude 5 family ships 1M as the default window, no beta header; 4.x
  // stays at the 200k it was released with.
  { match: /^claude/, from: 5, window: 1_000_000 },
  { match: /^claude/, window: 200_000 },
  // GPT-5.4 raised the line to 1M; the earlier 5.x are 400k.
  { match: /^gpt-5/, from: 5.4, window: 1_050_000 },
  { match: /^gpt-5/, window: 400_000 },
  { match: /^gpt-4/, window: 128_000 },
  { match: /^gpt-oss/, window: 131_072 },
  { match: /^gemini-(2\.5|[3-9])/, window: 1_048_576 },
  { match: /^gemma/, window: 131_072 },
  { match: /^grok-.*fast/, window: 2_000_000 },
  { match: /^grok/, from: 4.5, window: 500_000 },
  { match: /^grok/, window: 256_000 },
  // GLM-5.2 jumped to 1M; 4.6 raised the line to 200k; 4.5 and older are 128k.
  { match: /^glm/, from: 5.2, window: 1_000_000 },
  { match: /^glm-4\.5/, window: 131_072 },
  { match: /^glm/, from: 4.6, window: 200_000 },
  { match: /^glm/, window: 131_072 },
  { match: /^minimax-m/, from: 3, window: 1_000_000 },
  { match: /^minimax-m/, window: 204_800 },
  // V4 is the million-token release; V3 and older are 128k.
  { match: /^deepseek/, from: 4, window: 1_048_576 },
  { match: /^deepseek/, window: 131_072 },
  { match: /^(mistral|devstral|magistral|codestral|voxtral)/, window: 131_072 },
];

/** The version a name carries: "qwen3.8-max" → 3.8, "claude-opus-4-5" → 4. */
function versionOf(name: string): number | undefined {
  const m = name.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

/** The published window for a model id, or undefined when we do not know one. */
export function knownContextFor(id: string): number | undefined {
  const bare = splitModelId(id).model;
  const exact = KNOWN_CONTEXT[id] ?? KNOWN_CONTEXT[bare];
  if (exact) return exact;
  const name = bare.slice(bare.lastIndexOf("/") + 1).toLowerCase();
  const version = versionOf(name);
  return CONTEXT_RULES.find(
    (r) => r.match.test(name) && (r.from === undefined || (version !== undefined && version >= r.from)),
  )?.window;
}

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
  // OpenRouter's catalog is a hundred namespaces deep; these are the ones
  // whose casing the generic rule below would get wrong.
  meta: "Meta",
  "meta-llama": "Meta",
  bytedance: "ByteDance",
  ai21: "AI21",
  allenai: "AI2",
  "ibm-granite": "IBM",
  nousresearch: "Nous Research",
  thinkingmachines: "Thinking Machines",
  inclusionai: "InclusionAI",
  cognitivecomputations: "Cognitive Computations",
  deepcogito: "Deep Cogito",
  thedrummer: "TheDrummer",
  rekaai: "Reka",
  "arcee-ai": "Arcee",
  "nex-agi": "Nex AGI",
  sao10k: "Sao10K",
  "anthracite-org": "Anthracite",
  undi95: "Undi95",
  openrouter: "OpenRouter",
  "z-image": "Z.AI",
};

/**
 * A namespace nobody named: "aion-labs" → "Aion Labs". OpenRouter mints a new
 * one whenever a lab ships, so the list above cannot be complete and the
 * fallback has to be presentable rather than raw.
 */
function prettyNamespace(ns: string): string {
  return ns
    .split(/[-_]/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Vendors read off a bare model name, for the catalogs that carry no vendor
 * namespace. Model Studio serves 159 models as plain names, and a host that
 * resells other people's models — OpenRouter, Model Studio — is not itself the
 * answer to "whose model is this".
 */
const NAME_VENDOR: [RegExp, string][] = [
  [/^(qwen|qwq|qvq|tongyi)/, "Qwen"],
  [/^(kimi|moonshot|k\d)/, "Kimi"],
  [/^glm/, "Z.AI"],
  [/^deepseek/, "DeepSeek"],
  [/^(minimax|hailuo)/, "MiniMax"],
  [/^claude/, "Anthropic"],
  [/^(gpt|o[1-9]-|davinci|text-embedding-(ada|3))/, "OpenAI"],
  [/^(gemini|gemma)/, "Google"],
  [/^grok/, "xAI"],
  [/^(wan\d|wanx)/, "Wan"],
  [/^(seed|seedream|seedance|doubao)/, "ByteDance"],
  [/^kling/, "Kling"],
  [/^(mistral|devstral|codestral|voxtral|magistral|ministral)/, "Mistral"],
  [/^llama/, "Meta"],
  [/^step-/, "StepFun"],
  [/^mimo/, "Xiaomi"],
  [/^nemotron/, "NVIDIA"],
  [/^(hunyuan|hy\d)/, "Tencent"],
];

/** Vendors pinned to the top of every list, in this order. */
const VENDOR_RANK = ["Kimi", "MoonShot", "Anthropic", "OpenAI", "Qwen", "xAI"];

export function vendorOf(m: ModelInfo): string {
  // Whose model it is comes from the id, whichever host it was reached at: a
  // reseller's catalog is a hundred vendors deep, and filing all of it under
  // the reseller's own name is a list nobody can navigate. Which host serves
  // it stays visible in the prefix the id carries.
  const bare = splitModelId(m.id).model;
  // A leading "~" marks a routed variant of the same lab's model on OpenRouter;
  // it is the same vendor and belongs in the same section.
  const ns = bare.includes("/") ? bare.split("/")[0].toLowerCase().replace(/^~/, "") : "";
  if (ns) return VENDOR_LABELS[ns] ?? prettyNamespace(ns);
  const name = bare.toLowerCase();
  const known = NAME_VENDOR.find(([re]) => re.test(name))?.[1];
  if (known) return known;
  const head = name.split(/[-_.]/)[0];
  // Nothing recognisable in the name: the host it came from is a better
  // heading than "Other", and for a single-vendor host it is the right one.
  return VENDOR_LABELS[head] ?? providerLabelFor(m.id) ?? "Other";
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

/** One entry per provider: they are fetched, and go stale, independently. */
type CacheFile = Record<string, CacheShape>;

function readCacheFile(): CacheFile {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    // Pre-multi-provider caches were a bare CacheShape; let those expire.
    return raw && typeof raw === "object" && !Array.isArray(raw.models) ? (raw as CacheFile) : {};
  } catch {
    return {};
  }
}

function readCache(providerId: string, baseUrl: string, opts: { stale?: boolean } = {}): ModelInfo[] | null {
  const entry = readCacheFile()[providerId];
  if (!entry || entry.baseUrl !== baseUrl) return null;
  if (!opts.stale && Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry.models?.length ? entry.models : null;
}

function writeCache(providerId: string, baseUrl: string, models: ModelInfo[]): void {
  try {
    const all = readCacheFile();
    all[providerId] = { fetchedAt: Date.now(), baseUrl, models };
    fs.writeFileSync(cacheFile(), JSON.stringify(all, null, 2));
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

/**
 * Everything the model can produce. Catalogues state it in three different
 * ways — endpoint types, a tag string, an explicit modality list — and several
 * of them state more than one: `Text, Image` on TokenRouter, `image+text` on
 * OpenRouter. All of them count, so the model shows up under each type it can
 * actually serve.
 */
function modalitiesOf(endpoints: string[], tags: string, outputs: string[]): NonNullable<ModelInfo["modalities"]> {
  const found = new Set<NonNullable<ModelInfo["modality"]>>();
  const note = (v: string) => {
    const k = v.toLowerCase();
    if (k === "text" || k === "image" || k === "video" || k === "audio") found.add(k);
  };
  for (const e of endpoints) {
    if (e.startsWith("video")) note("video");
    else if (e.startsWith("image")) note("image");
    else if (e.startsWith("audio")) note("audio");
    else note("text");
  }
  for (const t of tags.split(/[,s]+/)) note(t);
  for (const o of outputs) note(o);
  return [...found];
}

/** What the model produces. Endpoints are more reliable than the tag string. */
function modalityOf(endpoints: string[], tags: string, outputs: string[] = []): ModelInfo["modality"] {
  if (endpoints.some((e) => e.startsWith("video"))) return "video";
  if (endpoints.some((e) => e.startsWith("image"))) return "image";
  if (endpoints.some((e) => e.startsWith("audio"))) return "audio";
  // OpenRouter states modalities instead of endpoints; text alongside anything
  // else still means a chat model, so only a non-text-only output counts.
  if (outputs.length && !outputs.includes("text")) {
    const o = outputs.find((x) => x === "video" || x === "image" || x === "audio");
    if (o) return o as ModelInfo["modality"];
  }
  const t = tags.toLowerCase();
  if (t.includes("text")) return "text";
  if (t.includes("video")) return "video";
  if (t.includes("image")) return "image";
  if (t.includes("audio")) return "audio";
  return "text";
}

/**
 * Modality read off the id, for the catalogs that state none — Model Studio
 * answers with a bare list of names, so without this its speech and image
 * models sit in the text section pretending to be chat models. Only markers
 * that are unambiguous count; a vision model like `qwen-vl-max` reads images
 * but answers in text, which is a text model here.
 */
const NAME_MODALITY: [RegExp, NonNullable<ModelInfo["modality"]>][] = [
  [/(^|[-.])(tts|asr|s2s|stt|voice|speech|audio)([-.]|$)/, "audio"],
  [/(^|[-.])(t2v|i2v|video|hailuo|seedance|kling)/, "video"],
  [/(^|[-.])(image|wanx|seedream|dall-e|flux)/, "image"],
];

/** Models that answer with vectors rather than text: not drivable from here. */
const EMBEDDING = /(^|[-.])(embedding|embed|rerank)([-.]|$)/;

function modalityFromName(id: string): ModelInfo["modality"] {
  const name = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  return NAME_MODALITY.find(([re]) => re.test(name))?.[1] ?? "text";
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
  // OpenRouter nests the real window and output cap under top_provider, and
  // describes what a model reads and writes under architecture.
  const top = raw?.top_provider ?? {};
  const outputs: string[] = Array.isArray(raw?.architecture?.output_modalities)
    ? raw.architecture.output_modalities.map(String)
    : [];
  // A catalog that says nothing about a model leaves only its name to go on.
  const stated = endpoints.length || tags || outputs.length;
  const modality = stated ? modalityOf(endpoints, tags, outputs) : modalityFromName(id);
  const modalities = stated ? modalitiesOf(endpoints, tags, outputs) : [modalityFromName(id)!];
  const info: ModelInfo = {
    id,
    label: raw?.name ?? raw?.display_name ?? undefined,
    owner: raw?.owned_by && raw.owned_by !== "custom" ? raw.owned_by : id.includes("/") ? id.split("/")[0] : undefined,
    contextWindow: num(raw?.context_window ?? raw?.context_length ?? raw?.max_context_tokens ?? top.context_length),
    maxOutput: num(raw?.max_output_tokens ?? raw?.max_completion_tokens ?? top.max_completion_tokens),
    supportsTools: raw?.supports_tools ?? raw?.tools ?? true,
    endpoints,
    tags,
    modality,
    modalities: modalities.length ? modalities : undefined,
    created: num(raw?.created),
    chatCapable: isChatCapable(endpoints, tags) && modality === "text" && !EMBEDDING.test(id),
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

/**
 * Fills in what a host knows about its models but does not put in its listing.
 *
 * OpenCode serves three wire shapes under one base URL and names none of them
 * in the catalog, so the provider's rules are the only source — for how a
 * request is built, and for whether the model can be driven from here at all.
 * The same listing carries no prices, and on a subscription whose limits are
 * counted in dollars those are worth having too.
 *
 * Both only where the catalog itself said nothing: a host that publishes a
 * field is always right about its own models.
 */
function stampProviderFacts(m: ModelInfo, mode: ProviderMode): ModelInfo {
  const bare = m.id.slice(m.id.lastIndexOf("/") + 1).toLowerCase();
  const pricing = m.pricing ?? mode.prices?.[bare];
  if (!mode.endpoints?.length || m.endpoints?.length) return pricing === m.pricing ? m : { ...m, pricing };
  const endpoint = endpointFor(mode, m.id);
  if (!endpoint) return pricing === m.pricing ? m : { ...m, pricing };
  const endpoints = [endpoint];
  return {
    ...m,
    endpoints,
    pricing,
    chatCapable: m.chatCapable !== false && isChatCapable(endpoints, m.tags ?? ""),
  };
}

/**
 * The catalog of every connected provider, merged. Each is fetched and cached
 * on its own, so a host being down costs that host's entries and nothing else.
 */
export async function fetchModels(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
  const connected = configuredProviders();
  if (!connected.length) return decorate(SEED);

  const lists = await Promise.all(connected.map((p) => fetchProviderModels(p.id, opts)));
  const merged = lists.flat();
  return decorate(merged.length ? merged : SEED);
}

async function fetchProviderModels(
  providerId: string,
  opts: { force?: boolean; signal?: AbortSignal },
): Promise<ModelInfo[]> {
  const mode = modeFor(providerId);
  const modeCfg = mode ? modeConfig(providerId, mode) : null;
  if (!mode || !modeCfg) return [];

  const fallback = () =>
    readCache(providerId, modeCfg.baseUrl, { stale: true }) ??
    (providerId === DEFAULT_PROVIDER ? SEED : seedModels(providerId, mode));

  if (!opts.force) {
    const hit = readCache(providerId, modeCfg.baseUrl);
    if (hit) return hit;
  }
  if (!modeCfg.listModels) return fallback();

  try {
    const auth = await resolveAuth(providerId);
    const res = await fetch(`${auth.baseUrl}/models`, { headers: auth.headers, signal: opts.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    const list: any[] = Array.isArray(body) ? body : body?.data ?? [];
    const models = list
      .map(normalize)
      .filter((m) => m.id)
      .map((m) => stampProviderFacts(m, modeCfg))
      .map((m) => ({ ...m, id: qualifyModelId(providerId, m.id) }));
    if (!models.length) throw new Error("empty model list");
    writeCache(providerId, modeCfg.baseUrl, models);
    return models;
  } catch {
    return fallback();
  }
}

/** Overlays user-pinned pricing/context onto whatever the provider gave us. */
function decorate(models: ModelInfo[]): ModelInfo[] {
  const cfg = loadConfig();
  const seedById = new Map(SEED.map((m) => [m.id, m]));
  const out = models.map((m) => {
    const seed = seedById.get(m.id);
    const modality = m.modality ?? seed?.modality ?? "text";
    return {
      ...m,
      label: m.label ?? seed?.label ?? m.id,
      owner: m.owner ?? seed?.owner,
      pricing: cfg.pricing[m.id] ?? m.pricing ?? seed?.pricing,
      contextWindow:
        cfg.contextWindows[m.id] ??
        m.contextWindow ??
        seed?.contextWindow ??
        // A window means nothing for an image or speech model, and the family
        // rules would happily give `qwen-image-plus` the plus line's 1M.
        (modality === "text" ? knownContextFor(m.id) : undefined),
      chatCapable: m.chatCapable ?? seed?.chatCapable ?? true,
      modality,
      modalities: m.modalities ?? seed?.modalities ?? [modality],
    };
  });
  registerProtocols(out);
  return out;
}

/**
 * A dated snapshot of a model — `qwen3.7-max-2026-05-17`, `devstral-2512`.
 * The undated id is the one to pick unless a build is being pinned, so the
 * snapshots sink below it rather than burying it among near-identical rows.
 */
const DATED_SNAPSHOT = /-(20\d\d-\d\d-\d\d|\d{8}|\d{6}|\d{4})$/;

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
    models: list.sort((a, b) => {
      const da = DATED_SNAPSHOT.test(a.id) ? 1 : 0;
      const db = DATED_SNAPSHOT.test(b.id) ? 1 : 0;
      return da - db || (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id);
    }),
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

/**
 * What the catalog calls a model's type — the same `[Text] [Image] [Video]
 * [Audio]` split TokenRouter tags its models with. Text first, then whatever
 * else the list holds; empty types are dropped rather than shown as headings
 * with nothing under them.
 */
export function groupByModality(
  models: ModelInfo[],
): { key: NonNullable<ModelInfo["modality"]>; label: string; models: ModelInfo[] }[] {
  return MODALITIES.map((mo) => ({ ...mo, models: models.filter((m) => servesModality(m, mo.key)) })).filter(
    (g) => g.models.length,
  );
}

/** True when the model can produce this kind of output. */
export function servesModality(m: ModelInfo, key: NonNullable<ModelInfo["modality"]>): boolean {
  return (m.modalities ?? [m.modality ?? "text"]).includes(key);
}

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
  if (EMBEDDING.test(m.id)) return "embeddings";
  // Providers that publish modalities rather than endpoints (OpenRouter), or
  // none at all (Model Studio), where the id is all there is to go on.
  if (!e.length && m.modality && m.modality !== "text") return `${m.modality} output`;
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
  // A provider written under one of its other names — `qwencloud:qwen3.8-max`
  // for `alibabacloud:` — is the same model; the catalogue only carries the
  // canonical spelling, so normalise before matching against it.
  const { providerId, model } = splitModelId(raw);
  const canonical = qualifyModelId(providerId, model);
  if (canonical !== raw && all.includes(canonical)) return canonical;

  // Prefer models this client can drive; fall back to the whole catalog so a
  // deliberate pick of an incompatible model still resolves (and warns later).
  const pools = [usableModels(catalog).map((m) => m.id), all];
  const q = raw.toLowerCase();
  // The bare model name, with both the provider prefix and the vendor
  // namespace stripped, so "kimi-for-coding" matches "kimi:kimi-for-coding".
  const base = (id: string) => {
    const bare = splitModelId(id).model;
    return bare.slice(bare.lastIndexOf("/") + 1).toLowerCase();
  };

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

/**
 * The same model served by another connected provider, best first. What makes
 * two ids the same model is the bare name — `alibabacloud:qwen3.8-max` and
 * `qwen/qwen3.8-max` are one model at two hosts — and when one host refuses a
 * conversation, the other is the way to carry on with it.
 */
export function sameModelElsewhere(id: string, catalog: ModelInfo[], limit = 3): string[] {
  const nameOf = (x: string) => {
    const bare = splitModelId(x).model.toLowerCase();
    return bare.slice(bare.lastIndexOf("/") + 1);
  };
  const here = splitModelId(id).providerId;
  const wanted = nameOf(id);
  return catalog
    .filter((m) => nameOf(m.id) === wanted && splitModelId(m.id).providerId !== here && m.chatCapable !== false)
    .map((m) => m.id)
    .slice(0, limit);
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
