/**
 * Which models make pictures, clips and sound, across providers.
 *
 * Each kind has one chosen model (config imageModel / videoModel / audioModel),
 * stored with its provider spelled out — "openrouter:bytedance/seedance-2.5",
 * "tokenrouter:kling-v3" — because the same slug can live at several hosts and
 * the host decides which API is called. The pickers are the /model panel with
 * these pools in it: provider tabs, favorites, search.
 *
 * Where each provider lists its media models:
 * - OpenRouter: its own public listings (/images/models, /videos/models); the
 *   chat catalogue carries the audio ones.
 * - TokenRouter: the chat catalogue, by endpoint type (image-generation,
 *   video-generation, audio-chat).
 * - xAI (API key) and Z.AI: a short roster below — their chat listings do
 *   not include the media models.
 */
import { loadConfig } from "../config.js";
import { DEFAULT_PROVIDER, modeFor, providerById, qualifyModelId, splitModelId } from "../provider/registry.js";
import { servesModality } from "../provider/models.js";
import type { ModelInfo } from "../types.js";
import { fetchListing } from "./media.js";
import type { VideoModelInfo } from "../agent/videomode.js";

export type MediaKind = "image" | "video" | "audio";

export const DEFAULT_VIDEO_MODEL = "openrouter:bytedance/seedance-2.5";

/** Which kinds each provider's API can make through these tools. */
const SUPPORT: Record<string, MediaKind[]> = {
  openrouter: ["image", "video", "audio"],
  tokenrouter: ["image", "video", "audio"],
  xai: ["image", "video"],
  zai: ["image", "video"],
};

/** Media models a provider serves but does not list next to its chat models. */
const ROSTER: Record<string, Partial<Record<MediaKind, { id: string; hint: string }[]>>> = {
  xai: {
    image: [
      { id: "grok-imagine-image-2.0", hint: "n≤10 · aspect_ratio · edits" },
      { id: "grok-imagine-image-quality", hint: "n≤10 · aspect_ratio" },
    ],
    video: [
      { id: "grok-imagine-video-1.5", hint: "≤15 s · aspect_ratio · resolution · first frame" },
      { id: "grok-imagine-video", hint: "≤15 s · first frame" },
    ],
  },
  zai: {
    image: [
      { id: "glm-image", hint: "size 1280x1280… · quality hd/standard" },
      { id: "cogview-4-250304", hint: "size 1024x1024… · quality hd/standard" },
    ],
    video: [{ id: "cogvideox-3", hint: "5/10 s · size up to 3840x2160 · audio · first frame" }],
  },
};

/** TokenRouter's endpoint type for each kind. */
const TR_ENDPOINT: Record<MediaKind, string> = { image: "image-generation", video: "video-generation", audio: "audio-chat" };

/** "openrouter:x/y" → provider and wire id. A bare legacy value was OpenRouter's. */
export function parseMediaId(id: string): { providerId: string; model: string } {
  const at = id.indexOf(":");
  if (at > 0) {
    const p = id.slice(0, at).toLowerCase();
    if (p === DEFAULT_PROVIDER) return { providerId: DEFAULT_PROVIDER, model: id.slice(at + 1) };
    const def = providerById(p);
    if (def) return { providerId: def.id, model: id.slice(at + 1) };
  }
  return { providerId: "openrouter", model: id };
}

/** The stored spelling: always with the provider, TokenRouter included. */
export function mediaId(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

/** The chosen model for a kind; video falls back to Seedance on OpenRouter. */
export function mediaModelId(kind: MediaKind): string {
  const cfg = loadConfig();
  const raw = kind === "image" ? cfg.imageModel : kind === "video" ? cfg.videoModel : cfg.audioModel;
  if (raw) {
    const { providerId, model } = parseMediaId(raw);
    return mediaId(providerId, model);
  }
  return kind === "video" ? DEFAULT_VIDEO_MODEL : "";
}

/** True when the provider has a credential these tools can use for the kind. */
export function providerServes(providerId: string, kind: MediaKind): boolean {
  if (!SUPPORT[providerId]?.includes(kind)) return false;
  const mode = modeFor(providerId);
  if (!mode) return false;
  // The Grok subscription reaches a chat proxy only; Imagine needs the API key.
  if (providerId === "xai" && mode !== "apikey") return false;
  return true;
}

/** A tool for the kind is worth offering: a model is set and its host is connected. */
export function mediaAvailable(kind: MediaKind): boolean {
  const id = mediaModelId(kind);
  return Boolean(id) && providerServes(parseMediaId(id).providerId, kind);
}

export interface MediaPool {
  /** Ids in the registry's spelling (TokenRouter bare), so provider tabs work. */
  models: ModelInfo[];
  /** Capability line per model id, shown where /model shows context and price. */
  hints: Map<string, string>;
  /** Providers whose listing could not be read, with the reason. */
  errors: string[];
}

function row(providerId: string, model: string, kind: MediaKind, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: qualifyModelId(providerId, model),
    owner: model.includes("/") ? model.slice(0, model.indexOf("/")) : providerId,
    modality: kind,
    modalities: [kind],
    chatCapable: false,
    ...extra,
  };
}

/** Everything the connected providers can make of this kind. */
export async function mediaPool(kind: MediaKind, catalog: ModelInfo[]): Promise<MediaPool> {
  const pool: MediaPool = { models: [], hints: new Map(), errors: [] };
  const add = (m: ModelInfo, hint: string) => {
    if (pool.models.some((x) => x.id === m.id)) return;
    pool.models.push(m);
    if (hint) pool.hints.set(m.id, hint);
  };

  if (providerServes("openrouter", kind)) {
    try {
      if (kind === "image") {
        const { imageCapsLine } = await import("./imagegen.js");
        for (const m of await fetchListing<any>("/images/models")) add(row("openrouter", m.id, kind, { label: m.name, created: m.created }), imageCapsLine(m));
      } else if (kind === "video") {
        const { capsLine, priceLine } = await import("../agent/videomode.js");
        for (const m of await fetchListing<VideoModelInfo & { created?: number }>("/videos/models")) {
          add(row("openrouter", m.id, kind, { label: m.name, created: m.created }), [capsLine(m), priceLine(m)].filter(Boolean).join(" · "));
        }
      }
    } catch (err) {
      pool.errors.push(`OpenRouter: ${(err as Error).message}`);
    }
    if (kind === "audio") {
      for (const m of catalog) {
        if (splitModelId(m.id).providerId === "openrouter" && servesModality(m, "audio")) {
          add({ ...m, modality: "audio", chatCapable: false }, /lyria/i.test(m.id) ? "music" : "speech");
        }
      }
    }
  }

  if (providerServes(DEFAULT_PROVIDER, kind)) {
    for (const m of catalog) {
      if (splitModelId(m.id).providerId !== DEFAULT_PROVIDER) continue;
      if (!(m.endpoints ?? []).includes(TR_ENDPOINT[kind])) continue;
      add({ ...m, modality: kind, chatCapable: false }, kind === "audio" ? "speech" : TR_ENDPOINT[kind]);
    }
  }

  for (const providerId of ["xai", "zai"]) {
    if (!providerServes(providerId, kind)) continue;
    for (const r of ROSTER[providerId]?.[kind] ?? []) add(row(providerId, r.id, kind), r.hint);
    // Whatever the provider's own listing does carry of this kind, too.
    for (const m of catalog) {
      if (splitModelId(m.id).providerId === providerId && servesModality(m, kind) && m.chatCapable === false) add(m, "");
    }
  }

  return pool;
}

/** Registry spelling ↔ stored spelling. */
export function fromPoolId(id: string): string {
  const { providerId, model } = splitModelId(id);
  return mediaId(providerId, model);
}

export function toPoolId(stored: string): string {
  const { providerId, model } = parseMediaId(stored);
  return qualifyModelId(providerId, model);
}
