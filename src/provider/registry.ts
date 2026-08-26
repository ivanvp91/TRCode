/**
 * Providers: where a request goes and what it carries.
 *
 * Until now there was one host and one key. TokenRouter is still the default
 * and unprefixed, but a model id may name its provider — "kimi:kimi-for-coding"
 * — and then the request goes straight there with that provider's credential.
 * Everything downstream (dialects, retries, effort probing, cache) is shared;
 * a provider only decides the base URL, the headers and, when the host has no
 * catalog to ask, the dialect.
 */
import { loadConfig, saveConfig, DEFAULT_BASE_URL, type Effort } from "../config.js";
import { isDrivable, protocolFor, protocolOfEndpoints, type Protocol } from "./protocol.js";
import {
  deviceId,
  importVendorCredentials,
  isStale,
  readCredentials,
  writeCredentials,
  type AuthMode,
  type Credentials,
} from "./credentials.js";
import { refreshToken, type FlowConfig } from "./oauth.js";
import type { ModelInfo, ModelPricing } from "../types.js";

export const DEFAULT_PROVIDER = "tokenrouter";

export interface SeedModel {
  id: string;
  label?: string;
  contextWindow?: number;
}

export interface ProviderMode {
  baseUrl: string;
  /** Forced dialect. Undefined leaves the choice to the catalog. */
  protocol?: Protocol;
  /** Whether GET {baseUrl}/models returns a usable catalog. */
  listModels: boolean;
  /** Path of that catalog, for hosts that serve it outside /models. */
  catalogPath?: string;
  /**
   * Set when that catalog is public. Zen serves its listing to anyone, so a
   * listing that comes back says nothing about the credential — and a login
   * that reports "63 models available" for a mistyped key has verified
   * nothing. Hosts like that are asked at the request endpoint instead.
   */
  publicCatalog?: boolean;
  /**
   * The models this host serves. A subscription endpoint typically will not
   * enumerate them — and answers 402 to the attempt when the plan lapsed — so
   * the published list is carried here rather than discovered.
   */
  seed: SeedModel[];
  /**
   * How the token is presented. Anthropic reads `x-api-key` for its own keys
   * and `Authorization: Bearer` for OAuth ones, and rejects a request that
   * carries both — so this is per mode, not per provider.
   *
   * `both` is for a gateway that reads a different header per endpoint: Zen
   * takes Bearer on /chat/completions and /responses and x-api-key on
   * /messages, and answers "Missing API key" to whichever one it is not
   * looking at. Sending both is the only way one credential reaches all three.
   */
  authHeader?: "bearer" | "x-api-key" | "both";
  /** Sent on every request beyond the credential; some hosts 403 without them. */
  headers?: Record<string, string>;
  /**
   * Per-model dialects, for a gateway that serves more than one and whose
   * catalog does not say which is which. Matched against the bare model name,
   * first hit wins; anything unmatched falls back to `protocol`.
   *
   * Stated as endpoint types rather than protocols because that is the
   * vocabulary the catalogs use, and because it also covers the endpoints this
   * client cannot drive at all — a model marked `gemini` is hidden from the
   * picker with a reason instead of being offered and failing on the first
   * request.
   */
  endpoints?: { match: RegExp; endpoint: string }[];
  /**
   * Published prices per 1M tokens, for a host whose listing carries none.
   * Merged over the catalog the same way endpoints are, and never over a price
   * the host itself stated or the user pinned.
   *
   * Only worth carrying where the number changes what the user does: a
   * subscription whose limits are denominated in dollars is spent by these
   * prices, so `/cost` is the meter for the plan rather than a curiosity.
   */
  prices?: Record<string, ModelPricing>;
}

export interface ProviderDef {
  id: string;
  /**
   * Other names this provider answers to. A host gets rebranded — Model Studio
   * is documented as QwenCloud — and its users learn it under whichever name
   * they arrived at; there is one endpoint and one key behind them, so a second
   * entry would only list the same catalogue twice. Aliases resolve to the id,
   * everywhere: `/login qwencloud`, `/provider qwencloud`, `-m qwencloud:…`.
   */
  aka?: string[];
  label: string;
  /** Shown when asking for a key. */
  keyHint: string;
  /**
   * Set when the host differs per account, which makes it a second question at
   * login rather than a constant. The text is the prompt for that question.
   */
  hostHint?: string;
  /**
   * The hosts this provider is actually reached at, when there is more than
   * one. Alibaba sells the same models as several products — pay-as-you-go
   * Model Studio, the Token Plan, a workspace deployment — each on its own
   * domain, and a key issued for one is rejected by the others. Guessing costs
   * the user a 401 with nothing in it about the real problem, so the login
   * asks; `null` url means "type your own".
   */
  hosts?: { label: string; url: string | null; note?: string }[];
  modes: Partial<Record<AuthMode, ProviderMode>>;
  oauth?: FlowConfig;
  /** Credential files the vendor's own CLI writes, reused instead of a second login. */
  importFrom?: string[];
  /** Where that CLI keeps its device id, so we look like the same machine. */
  deviceIdFrom?: string[];
}

/**
 * Kimi's coding host answers 403 unless the User-Agent looks like a coding
 * agent, and it wants the same device identity the CLI sends. Both are
 * overridable through config → providers.kimi.headers, because they are
 * undocumented and a change on their side would otherwise need a release.
 */
const KIMI_HEADERS: Record<string, string> = {
  "User-Agent": "kimi-code/0.27.0",
  "X-Msh-Platform": "cli",
  // The coding endpoint speaks the Anthropic Messages API, which requires this.
  "anthropic-version": "2023-06-01",
};

/**
 * Anthropic does publish GET /v1/models, so this is only the cold start — and
 * the fallback when a lapsed plan makes the listing fail.
 */
const CLAUDE_MODELS: SeedModel[] = [
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", contextWindow: 200_000 },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", contextWindow: 200_000 },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000 },
];

/**
 * Model Studio serves Qwen through an OpenAI-compatible endpoint. Its listing
 * is scoped to the workspace, so this is both the cold start and the fallback.
 * Windows are the ones Alibaba documents: the -max line moved to 1M with 3.7,
 * plus/flash/turbo are 1M, and the coder models take 1M as well.
 */
const QWEN_MODELS: SeedModel[] = [
  { id: "qwen3.8-max", label: "Qwen3.8 Max", contextWindow: 1_000_000 },
  { id: "qwen3.7-max", label: "Qwen3.7 Max", contextWindow: 1_000_000 },
  { id: "qwen3-max", label: "Qwen3 Max", contextWindow: 262_144 },
  { id: "qwen-plus", label: "Qwen Plus", contextWindow: 1_000_000 },
  { id: "qwen-flash", label: "Qwen Flash", contextWindow: 1_000_000 },
  { id: "qwen-turbo", label: "Qwen Turbo", contextWindow: 1_000_000 },
  { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus", contextWindow: 1_048_576 },
  { id: "qwen3-coder-flash", label: "Qwen3 Coder Flash", contextWindow: 1_048_576 },
];

/**
 * OpenCode Zen puts every model on the dialect its vendor speaks, under one
 * base URL: GPT, Grok and Muse Spark on /responses, Claude and the hosted Qwen
 * on /messages, everything else on /chat/completions. Its catalog lists ids and
 * nothing else, so the split has to be carried here.
 *
 * Gemini is served on Google's own /models/<id>:generateContent, which this
 * client does not speak. Marking it says so in the picker rather than letting
 * it be chosen and fail on the first request.
 */
const ZEN_ENDPOINTS = [
  { match: /^(gpt|grok|muse-spark)/, endpoint: "openai-response" },
  { match: /^(claude|qwen)/, endpoint: "anthropic" },
  { match: /^gemini/, endpoint: "gemini" },
];

/**
 * Go is the same gateway with a different roster and a different split: no
 * Claude, no Gemini, and MiniMax on /messages where Zen serves it on
 * /chat/completions. Which is the reason these tables live per mode.
 */
const GO_ENDPOINTS = [
  { match: /^(gpt|grok|muse-spark)/, endpoint: "openai-response" },
  { match: /^(qwen|minimax)/, endpoint: "anthropic" },
];

/**
 * What Go's models cost, per 1M tokens, as OpenCode published them on
 * 2026-08-20 (opencode.ai/docs/go). The plan's limits are stated in dollars —
 * $12 per 5 hours, $30 a week, $60 a month — so these are what /cost meters
 * the subscription against, not a curiosity.
 *
 * Two models are sold in tiers and are carried at their base one: DeepSeek is
 * off-peak (peak is 01:00–04:00 and 06:00–10:00 UTC, and doubles), Qwen's
 * -plus line is its short-context tier. The ids the listing has and the docs
 * do not price — kimi-k2.5, glm-5, qwen3.5-plus, mimo-v2-*, hy3-preview — are
 * left out rather than guessed; /cost says when it does not know.
 */
const GO_PRICES: Record<string, ModelPricing> = {
  "grok-4.5": { input: 2.0, output: 6.0, cachedInput: 0.3 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cachedInput: 0.02 },
  "glm-5.3": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "glm-5.2": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "glm-5.1": { input: 1.4, output: 4.4, cachedInput: 0.26 },
  "kimi-k3": { input: 3.0, output: 15.0, cachedInput: 0.3 },
  "kimi-k2.7-code": { input: 0.95, output: 4.0, cachedInput: 0.19 },
  "kimi-k2.6": { input: 0.95, output: 4.0, cachedInput: 0.16 },
  "mimo-v2.5": { input: 0.14, output: 0.28, cachedInput: 0.0028 },
  "mimo-v2.5-pro": { input: 0.435, output: 0.87, cachedInput: 0.003625 },
  "minimax-m3": { input: 0.3, output: 1.2, cachedInput: 0.06 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cachedInput: 0.06 },
  "minimax-m2.5": { input: 0.3, output: 1.2, cachedInput: 0.06 },
  "muse-spark-1.2-contributor": { input: 0.1, output: 0.2, cachedInput: 0.002 },
  "qwen3.8-max": { input: 2.0, output: 6.0, cachedInput: 0.25 },
  "qwen3.7-max": { input: 2.5, output: 7.5, cachedInput: 0.5 },
  "qwen3.7-plus": { input: 0.4, output: 1.6, cachedInput: 0.04 },
  "qwen3.6-plus": { input: 0.5, output: 3.0, cachedInput: 0.05 },
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cachedInput: 0.022 },
  "deepseek-v4-flash": { input: 0.22, output: 0.66, cachedInput: 0.007 },
  hy3: { input: 0.14, output: 0.58, cachedInput: 0.035 },
};

const PROVIDERS: ProviderDef[] = [
  {
    id: DEFAULT_PROVIDER,
    label: "TokenRouter",
    keyHint: "TokenRouter key (sk-…)",
    modes: {
      // baseUrl is a placeholder: the live value comes from config, which the
      // user can repoint with --base-url.
      apikey: { baseUrl: DEFAULT_BASE_URL, listModels: true, seed: [] },
    },
  },
  {
    id: "kimi",
    label: "Kimi",
    keyHint: "Moonshot platform key (sk-…)",
    modes: {
      // The subscription path: Claude-shaped requests against the coding host.
      // The four ids are the ones Kimi Code publishes; the host itself will
      // not list them, so they are carried here.
      oauth: {
        baseUrl: "https://api.kimi.com/coding/v1",
        protocol: "anthropic",
        listModels: true,
        seed: [
          { id: "k3", label: "Kimi K3", contextWindow: 1_000_000 },
          { id: "k3-256k", label: "Kimi K3 (256k)", contextWindow: 256_000 },
          { id: "kimi-for-coding", label: "Kimi K2.7 Code", contextWindow: 256_000 },
          { id: "kimi-for-coding-highspeed", label: "K2.7 Code HighSpeed", contextWindow: 256_000 },
        ],
        headers: KIMI_HEADERS,
      },
      // The documented pay-per-token path, OpenAI-shaped.
      apikey: {
        baseUrl: "https://api.moonshot.ai/v1",
        protocol: "openai",
        // This one does enumerate its models, and the list changes often
        // enough that pinning it here would go stale.
        listModels: true,
        seed: [],
      },
    },
    oauth: {
      clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
      deviceAuthUrl: "https://auth.kimi.com/api/oauth/device_authorization",
      tokenUrl: "https://auth.kimi.com/api/oauth/token",
      headers: { "User-Agent": KIMI_HEADERS["User-Agent"] },
    },
    importFrom: ["~/.kimi-code/credentials/kimi-code.json", "~/.kimi-code/credentials/oauth/kimi-code.json"],
    deviceIdFrom: ["~/.kimi-code/device_id"],
  },
  {
    id: "claude",
    label: "Claude",
    keyHint: "Anthropic API key (sk-ant-…)",
    modes: {
      // Console key only. A Pro/Max subscription could be reached with the
      // OAuth client Claude Code carries, but Anthropic's terms scope those
      // plans to their own applications, so that path is deliberately absent.
      apikey: {
        baseUrl: "https://api.anthropic.com/v1",
        protocol: "anthropic",
        listModels: true,
        seed: CLAUDE_MODELS,
        authHeader: "x-api-key",
        // The beta that unlocks hour-long cache entries. An agent turn outlives
        // the five-minute default many times over; see anthropic.ts.
        headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "extended-cache-ttl-2025-04-11" },
      },
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    keyHint: "OpenRouter key (sk-or-…)",
    modes: {
      apikey: {
        baseUrl: "https://openrouter.ai/api/v1",
        // Everything is served through /chat/completions, including the models
        // whose vendor has a native dialect of its own.
        protocol: "openai",
        // The one catalog here that reports real context windows and prices,
        // so nothing is seeded: the listing is better than anything pinned.
        listModels: true,
        seed: [],
        // Optional attribution, and the only way a request shows up under this
        // client on openrouter.ai rather than as an anonymous key call.
        headers: {
          "HTTP-Referer": "https://github.com/ivanvp91/tokenrouter-cli",
          "X-Title": "trcode",
        },
      },
    },
  },
  {
    id: "opencode",
    // The gateway is Zen and the client around it is opencode; people arrive
    // at the name from either side, and both are this one key.
    aka: ["zen", "opencode-zen", "opencodezen"],
    label: "OpenCode Zen",
    keyHint: "OpenCode Zen key (opencode.ai/auth)",
    modes: {
      apikey: {
        baseUrl: "https://opencode.ai/zen/v1",
        // The fallback for anything ZEN_ENDPOINTS does not name: the curated
        // open-weight half of the catalog is plain chat completions.
        protocol: "openai",
        endpoints: ZEN_ENDPOINTS,
        // The listing is public and needs no key, but it carries ids alone —
        // no windows, no prices, no endpoint types. Those come from the family
        // rules in models.ts, which read the bare names Zen publishes.
        listModels: true,
        // And it is served to anyone, key or no key.
        publicCatalog: true,
        seed: [],
        // One key, two headers: the /messages half of the host reads only
        // x-api-key and the other two read only Bearer, so both go out and
        // each endpoint finds the one it knows.
        authHeader: "both",
        // Required by that same half and ignored by the rest, so it rides on
        // every request rather than being decided per model.
        headers: { "anthropic-version": "2023-06-01" },
      },
    },
  },
  {
    id: "opencode-go",
    aka: ["opencodego", "zen-go", "zengo", "go"],
    label: "OpenCode Go",
    keyHint: "OpenCode Go key (opencode.ai/auth → subscribe to Go)",
    modes: {
      // A subscription, but one that authenticates with a key of its own —
      // bought in the same console as Zen, refused by the other's endpoint.
      // Hence a provider rather than a second mode: one credential per file,
      // and both can be connected at once. `kimi-k3` exists on both, so
      // failover between them is what the model prefix is for.
      apikey: {
        baseUrl: "https://opencode.ai/zen/go/v1",
        protocol: "openai",
        endpoints: GO_ENDPOINTS,
        prices: GO_PRICES,
        listModels: true,
        publicCatalog: true,
        seed: [],
        authHeader: "both",
        headers: { "anthropic-version": "2023-06-01" },
      },
    },
  },
  {
    id: "alibabacloud",
    // The same platform is documented as Model Studio, DashScope and QwenCloud,
    // depending on which door you came through; all three are this one.
    // Not "qwen": that one is already a model alias in the config, and a name
    // that means a model in one command and a host in the next is a trap.
    aka: ["qwencloud", "modelstudio", "dashscope"],
    label: "Alibaba Cloud",
    keyHint: "QwenCloud key (sk-… for Model Studio, sk-sp-… for the Token Plan)",
    hostHint: "Host URL",
    hosts: [
      {
        label: "Model Studio · international",
        url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        note: "pay-as-you-go, sk-…",
      },
      {
        label: "Model Studio · China (Beijing)",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        note: "accounts registered in China",
      },
      {
        label: "Token Plan · Singapore",
        url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        note: "prepaid token bundle, sk-sp-…",
      },
      {
        label: "Workspace or another region",
        url: null,
        note: "https://<workspace-id>.<region>.maas.aliyuncs.com/compatible-mode/v1",
      },
    ],
    modes: {
      apikey: {
        // The shared international host. A workspace account uses
        // https://<workspace-id>.<region>.maas.aliyuncs.com/compatible-mode/v1,
        // and an account registered in China dashscope.aliyuncs.com — both go
        // in at login, or later in config → providers.alibabacloud.baseUrl.
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        protocol: "openai",
        listModels: true,
        seed: QWEN_MODELS,
        // Nothing is sent to turn off Model Studio's content filter, which
        // rejects ordinary source code with 400 DataInspectionFailed. The
        // X-DashScope-DataInspection header that disables it is entitlement
        // gated: an account without the entitlement gets 403 Header.AccessDenied
        // on every request, which is worse than the filter. An account that has
        // it puts the header in config → providers.alibabacloud.headers.
      },
    },
  },
  {
    id: "xai",
    // "grok": the models are named that, and the subscription people arrive at
    // the brand rather than the company.
    aka: ["grok"],
    label: "xAI",
    keyHint: "xAI API key (console.x.ai)",
    modes: {
      // SuperGrok / X Premium+, against the same proxy the grok CLI uses. The
      // host speaks the Responses dialect and gates on a fixed header contract:
      // without X-XAI-Token-Auth / x-authenticateresponse it answers 426, and
      // unknown x-grok-* names are rejected outright — so only the reviewed
      // set goes out here, with truthful identity values.
      oauth: {
        baseUrl: "https://cli-chat-proxy.grok.com/v1",
        protocol: "responses",
        headers: {
          "X-XAI-Token-Auth": "xai-grok-cli",
          "x-authenticateresponse": "authenticate-response",
          "x-grok-client-identifier": "trcode-cli",
          // The proxy version-gates on this header and answers 426 below its
          // moving minimum (0.1.202 as of 2026-08-23), whoever the identifier
          // says is calling. It is the Grok CLI version line, not ours; when
          // the gate moves again, override via config → providers.xai.headers.
          "x-grok-client-version": "0.1.202",
          // A text terminal session; the CLI has no headless route of its own.
          "x-grok-client-mode": "interactive",
        },
        listModels: true,
        catalogPath: "models-v2",
        seed: [
          { id: "grok-4.5", label: "Grok 4.5", contextWindow: 500_000 },
          { id: "grok-4.20-beta", label: "Grok 4.20 Beta", contextWindow: 2_000_000 },
        ],
      },
      // The pay-per-token console, OpenAI-shaped.
      apikey: {
        baseUrl: "https://api.x.ai/v1",
        protocol: "openai",
        listModels: true,
        seed: [],
      },
    },
    oauth: {
      clientId: "b1a00492-073a-47ea-816f-4c329264a828",
      deviceAuthUrl: "https://auth.x.ai/oauth2/device/code",
      tokenUrl: "https://auth.x.ai/oauth2/token",
      scope: "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
    },
  },
  {
    id: "zai",
    aka: ["z.ai", "bigmodel"],
    label: "Z.AI",
    keyHint: "Z.AI API key (z.ai → API Keys)",
    hostHint: "Host URL",
    hosts: [
      {
        label: "GLM Coding Plan · international",
        url: "https://api.z.ai/api/coding/paas/v4",
        note: "Coding Plan subscription",
      },
      {
        label: "Open platform · international",
        url: "https://api.z.ai/api/paas/v4",
        note: "pay-as-you-go",
      },
      {
        label: "GLM Coding Plan · China",
        url: "https://open.bigmodel.cn/api/coding/paas/v4",
        note: "bigmodel.cn accounts",
      },
      {
        label: "Open platform · China",
        url: "https://open.bigmodel.cn/api/paas/v4",
        note: "pay-as-you-go",
      },
    ],
    modes: {
      // Key only: the service offers no OAuth grant to third-party clients.
      // The coding host serves plain chat completions; its listing is thin,
      // so the roster below is both cold start and fallback.
      apikey: {
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        protocol: "openai",
        listModels: true,
        seed: [
          { id: "glm-5.3", label: "GLM-5.3", contextWindow: 1_000_000 },
          { id: "glm-5.2", label: "GLM-5.2", contextWindow: 1_000_000 },
          { id: "glm-5.1", label: "GLM-5.1", contextWindow: 200_000 },
          { id: "glm-5-turbo", label: "GLM-5 Turbo", contextWindow: 131_072 },
        ],
      },
    },
  },
];

export function providers(): ProviderDef[] {
  // Alphabetical: the panel and /auth status read as a table, and a registry
  // ordered by history is a list nobody can scan.
  return [...PROVIDERS].sort((a, b) => a.label.localeCompare(b.label));
}

export function providerById(id: string): ProviderDef | undefined {
  const key = id.toLowerCase();
  return PROVIDERS.find((p) => p.id === key || p.aka?.includes(key));
}

/** Model ids carry their provider as a prefix; the default one carries none. */
export function splitModelId(id: string): { providerId: string; model: string } {
  const at = id.indexOf(":");
  if (at > 0) {
    // Resolved to the canonical id, so an alias and the real name share one
    // credential, one remembered model and one group in every list.
    const def = providerById(id.slice(0, at));
    if (def) return { providerId: def.id, model: id.slice(at + 1) };
  }
  return { providerId: DEFAULT_PROVIDER, model: id };
}

export function qualifyModelId(providerId: string, model: string): string {
  return providerId === DEFAULT_PROVIDER ? model : `${providerId}:${model}`;
}

/** The id as the host knows it, with our routing prefix removed. */
export function wireModelId(id: string): string {
  return splitModelId(id).model;
}

/** Provider label for a model id, or null for the default one — vendor grouping. */
export function providerLabelFor(id: string): string | null {
  const { providerId } = splitModelId(id);
  if (providerId === DEFAULT_PROVIDER) return null;
  return providerById(providerId)?.label ?? providerId;
}

/** Display name of a provider, including the default one. */
export function providerLabel(providerId: string): string {
  return providerById(providerId)?.label ?? providerId;
}

/** Config overrides for a provider: a moved host, its headers, its model list. */
function overridesFor(id: string): { baseUrl?: string; headers?: Record<string, string>; models?: string[] } {
  return loadConfig().providers?.[id] ?? {};
}

/**
 * Pins the host for a provider whose endpoint is per-account. `providers` is
 * not one of the maps saveConfig merges — it holds nested objects and a blind
 * spread would drop the sibling overrides — so the merge happens here.
 */
export function rememberBaseUrl(providerId: string, baseUrl: string): void {
  const cfg = loadConfig();
  const url = baseUrl.trim().replace(/\/+$/, "");
  if (!url) return;
  saveConfig({
    providers: { ...cfg.providers, [providerId]: { ...cfg.providers?.[providerId], baseUrl: url } },
  });
}

/** Which mode a provider is currently configured for, if any. */
export function modeFor(providerId: string): AuthMode | null {
  if (providerId === DEFAULT_PROVIDER) return loadConfig().apiKey ? "apikey" : null;
  return readCredentials(providerId)?.mode ?? null;
}

export function modeConfig(providerId: string, mode: AuthMode): ProviderMode | null {
  const def = providerById(providerId);
  const m = def?.modes[mode];
  if (!def || !m) return null;
  const over = overridesFor(providerId);
  const baseUrl = (
    providerId === DEFAULT_PROVIDER ? loadConfig().baseUrl : over.baseUrl ?? m.baseUrl
  ).replace(/\/+$/, "");
  const seed = over.models?.length ? over.models.map((id) => ({ id })) : m.seed;
  return { ...m, baseUrl, seed, headers: { ...m.headers, ...over.headers } };
}

const ENDPOINT_OF: Partial<Record<Protocol, string>> = {
  openai: "openai",
  responses: "openai-response",
  anthropic: "anthropic",
};

/**
 * The endpoint type a provider assigns a model: a per-model rule when the host
 * serves several dialects, otherwise the single one it was declared with.
 * Undefined means the host publishes the answer itself and nothing here should
 * override it.
 */
export function endpointFor(mode: ProviderMode, model: string): string | undefined {
  const name = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  const rule = mode.endpoints?.find((r) => r.match.test(name));
  if (rule) return rule.endpoint;
  return mode.protocol ? ENDPOINT_OF[mode.protocol] : undefined;
}

/**
 * Dialect for a model. A provider that knows the shape says so outright — the
 * catalog lookup only knows models it has actually seen, and guessing "openai"
 * for a Claude-shaped host would fail every request.
 */
export function protocolForModel(id: string): Protocol {
  const { providerId, model } = splitModelId(id);
  const mode = modeFor(providerId);
  const cfg = mode ? modeConfig(providerId, mode) : null;
  const endpoint = cfg ? endpointFor(cfg, model) : undefined;
  return endpoint ? protocolOfEndpoints([endpoint]) : protocolFor(id);
}

export interface ResolvedAuth {
  providerId: string;
  baseUrl: string;
  headers: Record<string, string>;
}

/** In-flight refreshes, so a burst of parallel requests renews a token once. */
const refreshing = new Map<string, Promise<Credentials>>();

async function freshCredentials(def: ProviderDef, force = false): Promise<Credentials> {
  let creds = readCredentials(def.id);
  if (!creds) {
    // A login the vendor's own CLI already did counts as a login here too.
    const imported = def.importFrom ? importVendorCredentials(def.importFrom) : null;
    if (!imported) throw new Error(`${def.label} is not connected. Run: trc auth login --provider ${def.id}`);
    creds = writeCredentials(def.id, imported);
  }
  if (creds.mode !== "oauth" || (!force && !isStale(creds))) return creds;
  if (!def.oauth || !creds.refreshToken) {
    throw new Error(`The ${def.label} session expired. Run: trc auth login --provider ${def.id}`);
  }

  const pending = refreshing.get(def.id);
  if (pending) return pending;
  const job = refreshToken(def.oauth, creds)
    .then((next) => writeCredentials(def.id, next))
    .catch((err) => {
      throw new Error(
        `Could not refresh the ${def.label} token: ${(err as Error).message}. Run: trc auth login --provider ${def.id}`,
      );
    })
    .finally(() => refreshing.delete(def.id));
  refreshing.set(def.id, job);
  return job;
}

/**
 * Force-renews an OAuth token the host just refused. `isStale` only knows the
 * expiry the token was issued with; a host can revoke one earlier — a login on
 * another device, a session cut server-side — and then every request 401s
 * while a perfectly good refresh token sits on disk. Returns true when a new
 * access token was obtained and the request is worth resending.
 */
export async function renewRejectedToken(providerId: string): Promise<boolean> {
  const def = providerById(providerId);
  if (!def?.oauth) return false;
  const before = readCredentials(def.id);
  if (before?.mode !== "oauth" || !before.refreshToken) return false;
  try {
    const next = await freshCredentials(def, true);
    return next.accessToken !== before.accessToken;
  } catch {
    return false; // the 401 stands and is reported as such
  }
}

/** Everything a request needs: where to send it and what to send with it. */
export async function resolveAuth(providerId: string): Promise<ResolvedAuth> {
  if (providerId === DEFAULT_PROVIDER) {
    const cfg = loadConfig();
    if (!cfg.apiKey) throw new Error("No API key. Run: trc auth login");
    return {
      providerId,
      baseUrl: cfg.baseUrl,
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    };
  }

  const def = providerById(providerId);
  if (!def) throw new Error(`Unknown provider: ${providerId}`);
  const creds = await freshCredentials(def);
  const mode = modeConfig(providerId, creds.mode);
  if (!mode) throw new Error(`${def.label} does not support ${creds.mode} authentication`);

  return {
    providerId,
    baseUrl: mode.baseUrl,
    headers: {
      ...mode.headers,
      ...authHeaders(mode.authHeader, creds.accessToken),
      ...(needsDeviceId(mode) ? { "X-Msh-Device-Id": deviceId(def.deviceIdFrom ?? []) } : {}),
    },
  };
}

function authHeaders(kind: ProviderMode["authHeader"], token: string): Record<string, string> {
  if (kind === "x-api-key") return { "x-api-key": token };
  if (kind === "both") return { Authorization: `Bearer ${token}`, "x-api-key": token };
  return { Authorization: `Bearer ${token}` };
}

/** The device header is only generated for hosts that ask for the platform. */
function needsDeviceId(mode: ProviderMode): boolean {
  return Boolean(mode.headers?.["X-Msh-Platform"]);
}

/** Providers with a usable credential, default first, the rest alphabetical. */
export function configuredProviders(): ProviderDef[] {
  return providers().filter((p) => modeFor(p.id) !== null || (p.importFrom && importVendorCredentials(p.importFrom)));
}

/** True once at least one provider can serve a request. */
export function hasProvider(): boolean {
  return configuredProviders().length > 0;
}

/** The published catalog for a provider, ids already prefixed. */
export function seedModels(providerId: string, mode: AuthMode): ModelInfo[] {
  const m = modeConfig(providerId, mode);
  if (!m) return [];
  return m.seed.map((s) => {
    const endpoints = [endpointFor(m, s.id) ?? "openai"];
    return {
      id: qualifyModelId(providerId, s.id),
      label: s.label,
      contextWindow: s.contextWindow,
      owner: providerById(providerId)?.label,
      endpoints,
      pricing: m.prices?.[s.id.toLowerCase()],
      tags: "Text",
      // A host can serve a dialect this client does not speak — Zen carries
      // Gemini on Google's own endpoint. Saying so here keeps the model out of
      // the picker instead of letting it fail on the first request.
      chatCapable: isDrivable(protocolOfEndpoints(endpoints)),
    };
  });
}

/**
 * Where a provider was last left. Kept in the config rather than the session,
 * because the point is to survive restarts.
 */
export function providerState(providerId: string): { model?: string; effort?: Effort } {
  return loadConfig().providerState?.[providerId] ?? {};
}

export function rememberProviderState(providerId: string, patch: { model?: string; effort?: Effort }): void {
  const current = providerState(providerId);
  try {
    saveConfig({ providerState: { [providerId]: { ...current, ...patch } } });
  } catch {
    /* remembering is a convenience, never a reason to fail a switch */
  }
}

/** The provider a new session starts on. */
export function defaultProviderId(): string {
  const cfg = loadConfig();
  const named = cfg.defaultProvider;
  if (named && providerById(named) && modeFor(named)) return named;
  // Unstated: the default model already names one.
  return splitModelId(cfg.model).providerId;
}
