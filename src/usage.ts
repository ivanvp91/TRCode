/** Token and cost accounting for a session. */
import type { Message, ModelInfo, Usage } from "./types.js";

export interface ModelUsage {
  model: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  costUsd: number;
  /** True when we had no price for this model and cost is unknown. */
  priceUnknown: boolean;
}

export class UsageTracker {
  private byModel = new Map<string, ModelUsage>();
  /** Last request only — what the status line shows after each turn. */
  lastTurn: { input: number; output: number; reasoning: number; costUsd: number; priceUnknown: boolean } = {
    input: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    priceUnknown: false,
  };

  record(model: string, usage: Usage | undefined, catalog: ModelInfo[]): void {
    if (!usage) return;
    const price = catalog.find((m) => m.id === model)?.pricing;
    const cached = usage.cached_tokens ?? 0;
    const freshInput = Math.max(0, usage.prompt_tokens - cached);
    const cost = price
      ? (freshInput / 1e6) * price.input +
        (cached / 1e6) * (price.cachedInput ?? price.input) +
        (usage.completion_tokens / 1e6) * price.output
      : 0;

    const entry = this.byModel.get(model) ?? {
      model,
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      costUsd: 0,
      priceUnknown: !price,
    };
    entry.requests++;
    entry.input += usage.prompt_tokens;
    entry.output += usage.completion_tokens;
    entry.cached += cached;
    entry.reasoning += usage.reasoning_tokens ?? 0;
    entry.costUsd += cost;
    entry.priceUnknown = entry.priceUnknown || !price;
    this.byModel.set(model, entry);

    this.lastTurn = {
      input: usage.prompt_tokens,
      output: usage.completion_tokens,
      reasoning: usage.reasoning_tokens ?? 0,
      costUsd: cost,
      priceUnknown: !price,
    };
  }

  /** Merges a subagent's tracker into this one. */
  absorb(other: UsageTracker): void {
    for (const u of other.all()) {
      const entry = this.byModel.get(u.model) ?? {
        model: u.model,
        requests: 0,
        input: 0,
        output: 0,
        cached: 0,
        reasoning: 0,
        costUsd: 0,
        priceUnknown: false,
      };
      entry.requests += u.requests;
      entry.input += u.input;
      entry.output += u.output;
      entry.cached += u.cached;
      entry.reasoning += u.reasoning ?? 0;
      entry.costUsd += u.costUsd;
      entry.priceUnknown = entry.priceUnknown || u.priceUnknown;
      this.byModel.set(u.model, entry);
    }
  }

  all(): ModelUsage[] {
    return [...this.byModel.values()].sort((a, b) => b.input + b.output - (a.input + a.output));
  }

  totals(): {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
    costUsd: number;
    priceUnknown: boolean;
    requests: number;
  } {
    let input = 0;
    let output = 0;
    let cached = 0;
    let reasoning = 0;
    let costUsd = 0;
    let requests = 0;
    let priceUnknown = false;
    for (const u of this.byModel.values()) {
      input += u.input;
      output += u.output;
      cached += u.cached;
      reasoning += u.reasoning ?? 0;
      costUsd += u.costUsd;
      requests += u.requests;
      priceUnknown = priceUnknown || u.priceUnknown;
    }
    return { input, output, cached, reasoning, costUsd, priceUnknown, requests };
  }

  toJSON(): ModelUsage[] {
    return this.all();
  }

  static fromJSON(data: ModelUsage[] | undefined): UsageTracker {
    const t = new UsageTracker();
    for (const u of data ?? []) t.byModel.set(u.model, { ...u });
    return t;
  }
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return trimZeros((n / 1000).toFixed(n < 10_000 ? 1 : 0)) + "k";
  return trimZeros((n / 1_000_000).toFixed(2)) + "M";
}

/** "1.00" → "1", "1.50" → "1.5". */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export function fmtCost(usd: number, unknown = false): string {
  if (unknown && usd === 0) return "n/a";
  if (usd < 0.01) return "$" + usd.toFixed(4);
  return "$" + usd.toFixed(2);
}

/**
 * Rough token estimate for context-pressure warnings. Real counts come from
 * the API `usage` field; this only drives the "when to compact" heuristic
 * before the first response of a turn arrives.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~3.6 chars/token for mixed code + Cyrillic prose.
  return Math.ceil(text.length / 3.6);
}

/**
 * Size of a stored history. Used both for live context pressure and for the
 * session list, so a session shows the same number before and after opening it.
 */
export function historyTokens(messages: Message[]): number {
  let used = 0;
  for (const m of messages) {
    used += estimateTokens(String(m.content ?? ""));
    for (const tc of m.tool_calls ?? []) used += estimateTokens(tc.function.arguments) + 12;
  }
  return used;
}
