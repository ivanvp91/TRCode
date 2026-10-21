/**
 * TokenRouter hosts three different wire protocols behind one key:
 *   openai     → /v1/chat/completions   (most models)
 *   responses  → /v1/responses          (openai/gpt-5.6-*)
 *   anthropic  → /v1/messages           (anthropic/claude-*)
 * The catalog says which one a model speaks; this module keeps that mapping
 * so the client can dispatch without threading ModelInfo everywhere.
 */
import type { ModelInfo } from "../types.js";

export type Protocol = "openai" | "responses" | "anthropic" | "unsupported";

const byModel = new Map<string, Protocol>();

export function protocolOf(m: ModelInfo): Protocol {
  return protocolOfEndpoints(m.endpoints ?? []);
}

/**
 * The dialect a set of endpoint types implies. Split out of `protocolOf`
 * because a provider that knows its own models states them as endpoint types
 * as well — the same vocabulary the catalogs use — and reads the answer back
 * through here rather than repeating the mapping.
 */
export function protocolOfEndpoints(e: string[]): Protocol {
  if (!e.length) return "openai"; // no metadata — assume the common case
  if (e.includes("openai")) return "openai";
  if (e.includes("openai-response")) return "responses";
  if (e.some((x) => x.startsWith("anthropic"))) return "anthropic";
  return "unsupported";
}

/** Rebuilds the mapping whenever the catalog is refreshed. */
export function registerProtocols(models: ModelInfo[]): void {
  byModel.clear();
  for (const m of models) byModel.set(m.id, protocolOf(m));
}

/** Protocol for a model id; falls back to plain chat completions. */
export function protocolFor(id: string): Protocol {
  return byModel.get(id) ?? "openai";
}

export function isDrivable(p: Protocol): boolean {
  return p !== "unsupported";
}
