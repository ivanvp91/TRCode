---
name: performance-optimization
description: Make slow code fast with evidence — measure first, find the actual bottleneck, fix it, measure again. Covers algorithmic complexity, N+1 and I/O batching, caching, memory leaks, frontend rendering. Use for "тормозит", "медленно работает", latency and memory issues.
description_ru: Ускорить медленный код доказательно — сначала измерить, найти реальное узкое место, исправить, измерить снова. Алгоритмическая сложность, N+1 и батчинг I/O, кэширование, утечки памяти, рендеринг фронтенда. Для «тормозит», «медленно работает», проблем с latency и памятью.
triggers: производительность, performance, оптимизация, оптимизируй, оптимизировать, тормозит, медленно работает, медленный, зависает, профилирование, profiling, профайлер, bottleneck, узкое место, утечка памяти, memory leak, latency, задержка, fps, лагает, долго грузится, ускорить
---

# Performance optimization

## 1. Measure before touching anything
"Кажется медленным" is not a diagnosis. First establish: what operation, how slow (number), how fast it must be (target), and under what load. Then profile or instrument — language profiler, `EXPLAIN` for queries, browser Performance tab for frontend, or at minimum timing brackets around suspect stages. The bottleneck is where the time IS, not where it looks ugly; profiles regularly contradict intuition. No optimization ships without a before-number.

## 2. Fix in order of leverage
Work down; each level routinely beats everything below it combined:
1. **Don't do the work**: cache the result, compute lazily, exit early, dedupe repeated calls, move it off the hot path (async/background/startup).
2. **Do less work**: better algorithm or data structure — O(n²) loops over growing data, linear scans where a map/set/index belongs, sorting inside loops. One complexity-class fix beats a thousand micro-optimizations.
3. **Batch the I/O**: N+1 queries → one query with join/`IN`; per-item HTTP calls → bulk endpoint; per-row writes → transaction/bulk insert; file reads in loops → read once.
4. **Tune the platform**: DB indexes for the actual query shapes, connection pooling, compression, HTTP caching headers, worker/thread counts.
5. **Micro-optimize** — only with a profile proving the hot loop, and only after 1–4.

## 3. The usual suspects by domain
- **Backend**: N+1 (ORM lazy loads), missing indexes (check `EXPLAIN` for full scans), synchronous calls that could parallelize, serializing giant payloads nobody reads.
- **Frontend**: bundle size (code-split, lazy-load routes/images), rendering the invisible (virtualize long lists), layout thrash (batch DOM reads/writes), re-render storms (memoize, stabilize deps), unoptimized images as the top LCP killer.
- **Memory**: growth without release — listeners never removed, caches without eviction, closures pinning big objects; take two heap snapshots apart in time and diff.
- **Trading/EA code**: recomputing indicators every tick instead of on new bar, object creation in `OnTick`, unbounded history arrays.

## 4. Prove it and stop
After the fix: same measurement, same conditions, report before → after with the numbers. State the cost of the fix (memory for the cache, staleness for memoization, complexity for the reader). Stop at the target: past it, further optimization is trade of readability for nothing — say the target is met and end.

## What not to do
- No speculative optimization of code nobody measured; no rewriting working code "для скорости" as a side quest.
- No cache without an invalidation story — a stale-data bug costs more than the milliseconds saved.
- No benchmark theater: measuring debug builds, cold caches vs warm, or a single run instead of several.
- Don't sacrifice correctness for speed silently; if a fix changes semantics (eventual consistency, approximation), the user decides.

## Answer format
1. The measurement: what was profiled, the bottleneck with its share of time.
2. The fix and its leverage level (why this beats alternatives).
3. Before → after numbers, same conditions.
4. Costs/trade-offs of the fix, and what's the next bottleneck if more speed is ever needed.
