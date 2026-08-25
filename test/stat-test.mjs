/**
 * Period accounting for /stat.
 *
 * A stored usage row is one session's aggregate, so the period tabs used to
 * show whatever lastUsed guessed at — and the fold doubled the first row it
 * saw. Daily buckets carry the real share of each period; the fold must add,
 * not clone-then-add.
 */
Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-stat-home-"));
process.env.TRCODE_HOME = HOME;

const { foldUsage, periodSlice } = await import("../dist/ui/commands.js");
const { UsageTracker, dayKey } = await import("../dist/usage.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const now = new Date();
const at = (daysBack, hour = 12) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, hour).getTime();
const key = (daysBack) => dayKey(at(daysBack));

// ── foldUsage: the fold must add rows, never count the first one twice ──
{
  const row = { model: "mock:m", requests: 3, input: 100, output: 20, cached: 10, reasoning: 0, costUsd: 1.5, priceUnknown: false, lastUsed: at(0) };
  const folded = foldUsage([row]);
  const u = folded.get("mock:m");
  check("a single row is not doubled", u.requests === 3 && u.input === 100 && u.output === 20 && u.costUsd === 1.5, JSON.stringify(u));

  const two = foldUsage([row, { ...row, requests: 2, input: 50, costUsd: 0.5, lastUsed: at(5) }]);
  const v = two.get("mock:m");
  check("two sessions of one model are summed", v.requests === 5 && v.input === 150 && v.costUsd === 2 && v.lastUsed === at(0), JSON.stringify(v));
}

// ── periodSlice: daily buckets give the true share of each period ──
{
  const today = { requests: 2, input: 40, output: 8, cached: 4, reasoning: 0, costUsd: 0.4 };
  const old = { requests: 10, input: 500, output: 90, cached: 50, reasoning: 0, costUsd: 5 };
  const row = {
    model: "mock:m",
    requests: 12, input: 540, output: 98, cached: 54, reasoning: 0, costUsd: 5.4,
    priceUnknown: false, lastUsed: at(0),
    daily: { [key(0)]: today, [key(20)]: old },
  };

  const d0 = periodSlice(row, "today");
  check("today keeps only today's bucket", d0 && d0.requests === 2 && d0.input === 40 && d0.costUsd === 0.4, JSON.stringify(d0));
  const w = periodSlice(row, "week");
  check("week drops the bucket from 20 days ago", w && w.requests === 2 && w.input === 40, JSON.stringify(w));
  const m = periodSlice(row, "month");
  check("month keeps both buckets", m && m.requests === 12 && m.input === 540 && m.costUsd === 5.4, JSON.stringify(m));
  const a = periodSlice(row, "all");
  check("all time returns the whole row", a === row);

  const fresh = { ...row, daily: { [key(0)]: today, [key(3)]: old } };
  const w3 = periodSlice(fresh, "week");
  check("a 3-day-old bucket is inside the week", w3 && w3.requests === 12 && w3.input === 540, JSON.stringify(w3));
}

// ── legacy rows without daily fall back to the lastUsed guess ──
{
  const stale = { model: "mock:m", requests: 4, input: 80, output: 8, cached: 0, reasoning: 0, costUsd: 0.8, priceUnknown: false, lastUsed: at(20) };
  check("a 20-day-old row is out of today", periodSlice(stale, "today") === null);
  check("a 20-day-old row is out of the week", periodSlice(stale, "week") === null);
  check("a 20-day-old row is inside the month", periodSlice(stale, "month") === stale);

  const undated = { ...stale, lastUsed: undefined };
  check("a row with no timestamp survives the filter", periodSlice(undated, "today") === undated);
}

// ── UsageTracker fills the daily buckets as it records ──
{
  const tr = new UsageTracker();
  const usage = { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 40, reasoning_tokens: 2 };
  tr.record("mock:m", usage, [], at(0));
  tr.record("mock:m", usage, [], at(0));
  tr.record("mock:m", usage, [], at(3));

  const row = tr.all().find((u) => u.model === "mock:m");
  check("record keeps the all-time totals", row.requests === 3 && row.input === 300 && row.cached === 120, JSON.stringify(row));
  check("record splits the totals by day", row.daily?.[key(0)]?.requests === 2 && row.daily?.[key(3)]?.requests === 1, JSON.stringify(row.daily));
  check("the day buckets add up to the totals", Object.values(row.daily).reduce((n, d) => n + d.input, 0) === row.input);
  check("dayKey names the local day", /^\d{4}-\d{2}-\d{2}$/.test(key(0)), key(0));

  const other = new UsageTracker();
  other.record("mock:m", usage, [], at(10));
  tr.absorb(other);
  const merged = tr.all().find((u) => u.model === "mock:m");
  check("absorb merges the daily buckets too", merged.requests === 4 && merged.daily?.[key(10)]?.requests === 1, JSON.stringify(merged.daily));
}

// ── the pipeline /stat runs: slice first, fold after ──
{
  const rows = [
    { model: "mock:a", requests: 12, input: 540, output: 98, cached: 54, reasoning: 0, costUsd: 5.4, priceUnknown: false, lastUsed: at(0),
      daily: { [key(0)]: { requests: 2, input: 40, output: 8, cached: 4, reasoning: 0, costUsd: 0.4 }, [key(20)]: { requests: 10, input: 500, output: 90, cached: 50, reasoning: 0, costUsd: 5 } } },
    { model: "mock:b", requests: 4, input: 80, output: 8, cached: 0, reasoning: 0, costUsd: 0.8, priceUnknown: false, lastUsed: at(20) },
  ];
  const folded = foldUsage(rows.map((u) => periodSlice(u, "today")).filter(Boolean));
  check("today shows only today's share of each model", folded.size === 1 && folded.get("mock:a")?.input === 40, JSON.stringify([...folded]));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
