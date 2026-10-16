/** /stat: token and cost usage by model and period. */
import fs from "node:fs";
import path from "node:path";
import { c } from "../ansi.js";
import { contentWidth } from "../layout.js";
import { hint, line, Spinner, success, truncate } from "../render.js";
import { openModal, type ModalAction, type ModalResult, type PickerItem } from "../picker.js";
import { choose } from "../choice.js";
import { sessionsDir } from "../../config.js";
import { providerLabel, providers, splitModelId, wireModelId } from "../../provider/registry.js";
import { fmtTokens, fmtCost, dayKey, addDelegated } from "../../usage.js";
import type { Delegated, ModelUsage } from "../../usage.js";
import { t } from "../../i18n.js";
import type { App } from "../repl.js";

// ── /stat ─────────────────────────────────────────────────────────────────

export const STAT_PERIODS = [
  { key: "today", label: () => t("Today", "Сегодня") },
  { key: "week", label: () => t("Week", "Неделя") },
  { key: "month", label: () => t("Month", "Месяц") },
  { key: "all", label: () => t("All time", "Всё время") },
] as const;

export type StatPeriod = (typeof STAT_PERIODS)[number]["key"];

export function statSince(p: StatPeriod): number {
  if (p === "all") return 0;
  const d = new Date();
  if (p === "today") d.setHours(0, 0, 0, 0);
  else if (p === "week") d.setDate(d.getDate() - 7);
  else d.setDate(d.getDate() - 30);
  return d.getTime();
}

/**
 * The first local day that still belongs to the period, as a daily-bucket key.
 * Calendar days, not rolling 24h windows: a bucket holds a whole day, and
 * slicing one would need timestamps it does not store.
 */
export function statDayCutoff(p: StatPeriod): string {
  const back = p === "today" ? 0 : p === "week" ? 6 : 29;
  const d = new Date();
  d.setDate(d.getDate() - back);
  return dayKey(d.getTime());
}

/**
 * The share of one row that falls inside the period.
 *
 * A row is a whole session's aggregate, so lastUsed alone cannot say which
 * part of it belongs to "today": a session that ran for a month and made its
 * last request this morning used to show its entire month under Today.
 * Daily buckets give the true share. A row recorded before daily accounting
 * existed falls back to the session file's own date — closer than lastUsed,
 * which is only when the session was last touched.
 */
export function periodSlice(u: ModelUsage, p: StatPeriod): ModelUsage | null {
  if (p === "all") return u;
  if (!u.daily) {
    const cutoff = statDayCutoff(p);
    // The session id opens with YYYYMMDD — the day the session was created,
    // which is the best a legacy row can be dated by.
    const created = sessionDayOf(u);
    if (created) return created >= cutoff ? u : null;
    return !u.lastUsed || u.lastUsed >= statSince(p) ? u : null;
  }
  const cutoff = statDayCutoff(p);
  let requests = 0, input = 0, output = 0, cached = 0, reasoning = 0, costUsd = 0;
  let hit = false;
  const delegated: Delegated = {};
  for (const [k, d] of Object.entries(u.daily)) {
    if (k < cutoff) continue;
    hit = true;
    for (const [src, share] of Object.entries(d.delegated ?? {})) addDelegated(delegated, src, share);
    requests += d.requests;
    input += d.input;
    output += d.output;
    cached += d.cached;
    reasoning += d.reasoning ?? 0;
    costUsd += d.costUsd;
  }
  if (!hit) return null;
  return {
    model: u.model, requests, input, output, cached, reasoning, costUsd, priceUnknown: u.priceUnknown, lastUsed: u.lastUsed,
    ...(Object.keys(delegated).length ? { delegated } : {}),
  };
}

/** Every stored request row; the live session's rows replace what is on disk. */
export function loadUsageRows(app: App): ModelUsage[] {
  const out: ModelUsage[] = [];
  let dir: string;
  try {
    dir = sessionsDir(app.cwd);
  } catch {
    return [];
  }
  // Skip the live session's own file, not every file that shares a model with
  // it: dropping rows by model threw away other sessions' history — and with
  // it most of the period totals — whenever the running model was reused.
  const liveFile = `${app.session.id}.json`;
  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith(".json") || n === liveFile) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      for (const u of data.usage ?? []) out.push({ ...u, sessionFile: n });    } catch {
      /* skip corrupt files */
    }
  }
  for (const u of app.usage.all()) out.push({ ...u, sessionFile: `${app.session.id}.json` });
  return out;
}

/** The YYYY-MM-DD a stored row's session was created, from its file name. */
export function sessionDayOf(u: ModelUsage & { sessionFile?: string }): string {
  const stem = (u.sessionFile ?? "").slice(0, 12);
  if (!/^\d{8}-/.test(stem)) return "";
  return `${stem.slice(0, 4)}-${stem.slice(4, 6)}-${stem.slice(6, 8)}`;
}

/** Folds raw per-session rows into one ModelUsage per model. */
export function foldUsage(rows: ModelUsage[]): Map<string, ModelUsage> {
  const m = new Map<string, ModelUsage>();
  for (const u of rows) {
    // A fresh accumulator, not a copy of the row: the loop below adds the row
    // itself, and seeding with it counted the first session twice.
    const e = m.get(u.model) ?? {
      model: u.model,
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      costUsd: 0,
      priceUnknown: u.priceUnknown,
    };
    for (const k of ["requests", "input", "output", "cached", "reasoning", "costUsd"] as const) e[k] += u[k];
    e.priceUnknown = e.priceUnknown || u.priceUnknown;
    e.lastUsed = Math.max(e.lastUsed ?? 0, u.lastUsed ?? 0);
    for (const [src, share] of Object.entries(u.delegated ?? {})) addDelegated((e.delegated ??= {}), src, share);
    m.set(u.model, e);
  }
  return m;
}

/** The one-line summary that sits above the table. */
export function usageTotals(rows: Map<string, ModelUsage>): string {
  let input = 0, output = 0, cached = 0, cost = 0, reqs = 0, models = 0, unknown = false;
  for (const u of rows.values()) {
    input += u.input;
    output += u.output;
    cached += u.cached;
    cost += u.costUsd;
    reqs += u.requests;
    models++;
    unknown = unknown || u.priceUnknown;
  }
  const fresh = Math.max(0, input - cached);
  const cachedPct = cached && input ? Math.round((cached / input) * 100) : 0;
  return (
    `${c.gray(t("models", "моделей"))} ${c.bold(String(models))}   ` +
    `${c.gray(t("reqs", "запросов"))} ${c.bold(String(reqs))}   ` +
    `${c.gray("↑")} ${fmtTokens(fresh)} ${c.gray(`(${cachedPct}% cached)`)}   ` +
    `${c.gray("↓")} ${fmtTokens(output)}   ` +
    `${c.gray(t("cost", "стоимость"))} ${c.bold(c.brightGreen(fmtCost(cost, unknown)))}`
  );
}

/**
 * What helpers cost inside those totals — task, swarm, orchestrate, brain —
 * or "" when nothing was delegated. A share of the line above, not extra.
 */
export function delegatedNote(rows: Map<string, ModelUsage>): string {
  const all: Delegated = {};
  for (const u of rows.values()) for (const [src, share] of Object.entries(u.delegated ?? {})) addDelegated(all, src, share);
  const parts = Object.entries(all)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([src, d]) => `${src} ${c.bold(fmtCost(d.costUsd))} ${c.gray(`(${d.requests} ${t("reqs", "запр.")}, ${fmtTokens(d.input + d.output)})`)}`);
  return parts.length ? `${c.gray(t("of which helpers:", "из них помощники:"))} ${parts.join(c.gray(" · "))}` : "";
}

/** The table body: a section per provider, its models, then a subtotal row. */
export function usageRows(folded: Map<string, ModelUsage>, only: string | null): PickerItem[] {
  const byProvider = new Map<string, ModelUsage[]>();
  for (const u of folded.values()) {
    const pid = splitModelId(u.model).providerId;
    if (only && pid !== only) continue;
    (byProvider.get(pid) ?? byProvider.set(pid, []).get(pid)!).push(u);
  }

  // Each token cell carries its share of the row's total, so a glance tells
  // which side of the traffic — fresh input, cache reads, output — dominates.
  // Column widths come from the widest value in the table: a fixed width that
  // fits "1.2k" clips "245.04M(97%)" into the next column, and the row stops
  // being readable.
  const shown = [...folded.values()].filter((u) => !only || splitModelId(u.model).providerId === only);
  const cellText = (n: number, total: number): string => (n > 0 && total > 0 ? fmtTokens(n) + `(${Math.round((n / total) * 100)}%)` : "—");
  const widths = { req: 3, input: 6, cached: 6, output: 6, reasoning: 9 };
  for (const u of shown) {
    const total = u.input + u.output + (u.reasoning ?? 0);
    widths.req = Math.max(widths.req, String(u.requests).length);
    widths.input = Math.max(widths.input, cellText(Math.max(0, u.input - u.cached), total).length);
    widths.cached = Math.max(widths.cached, cellText(u.cached, total).length);
    widths.output = Math.max(widths.output, cellText(u.output, total).length);
    widths.reasoning = Math.max(widths.reasoning, cellText(u.reasoning ?? 0, total).length);
  }
  const cellOf = (u: { requests: number; input: number; cached: number; output: number; reasoning: number }): string => {
    const total = u.input + u.output + (u.reasoning ?? 0);
    return (
      `${String(u.requests).padStart(widths.req)} ` +
      `${cellText(Math.max(0, u.input - u.cached), total).padStart(widths.input)} ` +
      `${cellText(u.cached, total).padStart(widths.cached)} ` +
      `${cellText(u.output, total).padStart(widths.output)} ` +
      `${cellText(u.reasoning ?? 0, total).padStart(widths.reasoning)}`
    );
  };
  const tableWidth = widths.req + widths.input + widths.cached + widths.output + widths.reasoning + 5;
  const nameWidth = Math.max(12, Math.min(30, contentWidth() - tableWidth - 9));

  const items: PickerItem[] = [];
  for (const pid of [...byProvider.keys()].sort()) {
    const list = byProvider.get(pid)!.sort((a, b) => b.costUsd - a.costUsd);
    items.push({ value: `__${pid}`, label: "", header: providerLabel(pid) });
    items.push({
      value: `__head-${pid}`,
      label: c.gray(
        `${"model".padEnd(nameWidth)} ${"req".padStart(widths.req)} ${"input*".padStart(widths.input)} ${"cached".padStart(widths.cached)} ${"output".padStart(widths.output)} ${"reasoning".padStart(widths.reasoning)}`,
      ),
    });
    let cost = 0;
    let unknown = false;
    for (const u of list) {
      cost += u.costUsd;
      unknown = unknown || u.priceUnknown;
      items.push({
        value: u.model,
        label: truncate(wireModelId(u.model), nameWidth).padEnd(nameWidth) + " " + cellOf(u),
        badge: c.gray(fmtCost(u.costUsd, u.priceUnknown).padStart(9)),
      });
    }
    const sub = list.reduce(
      (a, u) => ({
        requests: a.requests + u.requests,
        input: a.input + u.input,
        cached: a.cached + u.cached,
        output: a.output + u.output,
        reasoning: a.reasoning + (u.reasoning ?? 0),
      }),
      { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
    );
    items.push({
      value: `__sub-${pid}`,
      label: c.gray(t("subtotal", "итого").padEnd(nameWidth) + " " + cellOf(sub)),
      badge: c.bold(fmtCost(cost, unknown).padStart(9)),
    });
  }
  return items;
}

/**
 * The usage panel. The periods are its tabs and the providers its buttons, so
 * the two questions this report ever answers — since when, and whose key — are
 * both a keypress away instead of a re-run of the command.
 */
/**
 * The usage panel. Buttons switch provider scope; the reset asks twice,
 * because what it throws away is every session's record, not a view's filter.
 */
export async function statModal(app: App): Promise<void> {
  const all = loadUsageRows(app);
  if (!all.length) {
    line();
    return void hint(t("No usage recorded yet.", "Расход пока не записан."));
  }

  // Every provider that ever appears, so the buttons do not come and go as
  // the period changes — a button that vanishes is one you cannot press back.
  const everyProvider = [...new Set(all.map((u) => splitModelId(u.model).providerId))].sort();
  // Slice each session's row to the period before folding: the fold throws
  // the daily buckets away, so they have to be read while they are still there.
  const foldFor = (p: string): Map<string, ModelUsage> => {
    const period = (p || "all") as StatPeriod;
    return foldUsage(all.map((u) => periodSlice(u, period)).filter((u): u is ModelUsage => u !== null));
  };

  let period: StatPeriod = "all";
  let only: string | null = null;

  for (;;) {
    const scope = (rows: Map<string, ModelUsage>): Map<string, ModelUsage> =>
      only ? new Map([...rows].filter(([m]) => splitModelId(m).providerId === only)) : rows;

    const actions: ModalAction[] = [
      ...(only ? [{ id: "__all", label: t("All providers", "Все поставщики") }] : []),
      ...everyProvider.filter((pid) => pid !== only).map((pid) => ({ id: pid, label: providerLabel(pid) })),
      { id: "__reset", label: t("Reset", "Сбросить"), tone: "danger" as const },
    ];

    const res: ModalResult | null = await app.exclusiveInput(() =>
      openModal({
        title: t("Usage", "Расход"),
        subtitle: t(
          "input* counts fresh tokens only — cache reads are the cached column. ←→ changes the period.",
          "input* — только чистые токены, чтения из кеша в колонке cached. ←→ меняет период.",
        ),
        notes: (tabKey) => {
          const rows = scope(foldFor(tabKey));
          const helpers = delegatedNote(rows);
          return rows.size ? [usageTotals(rows), ...(helpers ? [helpers] : [])] : [];
        },
        tabs: STAT_PERIODS.map((p) => ({ key: p.key, label: p.label() })),
        initialTab: period,
        items: (tabKey) => usageRows(foldFor(tabKey), only),
        readOnly: true,
        search: false,
        empty: t("No usage in this period.", "За этот период расхода нет."),
        actions: actions,
      }),
    );
    if (!res || res.kind !== "action") return;

    if (res.id === "__reset") {
      const rows = foldFor(period);
      const totals = usageTotals(scope(rows));
      if (!totals)
        { period = (res.tab || period) as StatPeriod; continue; }
      const sure = await app.exclusiveInput(() =>
        choose<"yes" | "no">(
          [
            { value: "no", label: t("Keep it", "Оставить"), key: "n" },
            { value: "yes", label: t("Erase all usage records", "Удалить все записи расхода"), key: "y", tone: "danger" },
          ],
          {
            initial: "no",
            fallback: "no",
            hint: totals.replace(/<[^>]+>/g, "").trim() + "?",
          },
        ),
      );
      if (sure === "yes") await resetUsage(app, all);
      return;
    }

    // The panel reopens on the period it was left on, not on the one it opened
    // with: switching provider must not throw the period away.
    period = (res.tab || period) as StatPeriod;
    only = res.id === "__all" ? null : res.id;
  }
}

/**
 * Wipes the usage record everywhere it lives: in the session files on disk and
 * in the live tracker — whose next save would otherwise write its counts back.
 */
export async function resetUsage(app: App, rows: (ModelUsage & { sessionFile?: string })[]): Promise<void> {
  const sp = new Spinner(t("erasing usage records", "стираю записи расхода"));
  sp.start();
  try {
    const live = `${app.session.id}.json`;
    const files = [...new Set(rows.map((u) => u.sessionFile ?? "").filter(Boolean))];
    for (const n of files) {
      const f = path.join(sessionsDir(app.cwd), n);
      let data: { usage?: unknown; messages?: unknown[] };
      try {
        data = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        continue; // gone by itself — nothing stored there to reset
      }
      if (n === live) continue; // handled below through the running tracker
      data.usage = [];
      fs.writeFileSync(f, JSON.stringify(data));
    }
    app.usage.reset();
    app.session.save();
  } finally {
    sp.stop();
  }
  success(t("Usage records erased.", "Записи расхода стёрты."));
}
