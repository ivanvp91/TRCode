/** The /model chooser: modality tabs, vendor sections, newest first. */
import { c } from "./ansi.js";
import { pick, type PickerItem, type PickerTab } from "./picker.js";
import { fmtTokens } from "../usage.js";
import { MODALITIES, groupByVendor, incompatibleReason, usableModels } from "../provider/models.js";
import type { ModelInfo } from "../types.js";

export interface ModelPickerOptions {
  catalog: ModelInfo[];
  current: string;
  defaultModel: string;
  /** Show every modality, including models this client cannot drive. */
  includeIncompatible?: boolean;
}

function rowsFor(opts: ModelPickerOptions, modality: string): PickerItem[] {
  const pool = modality === "text" && !opts.includeIncompatible ? usableModels(opts.catalog) : opts.catalog;
  const models = pool.filter((m) => (m.modality ?? "text") === modality);
  if (!models.length) return [];

  const width = Math.min(34, Math.max(...models.map((m) => m.id.length)) + 1);
  const rows: PickerItem[] = [];

  for (const group of groupByVendor(models)) {
    rows.push({ value: `__${group.vendor}`, label: "", header: group.vendor });
    for (const m of group.models) {
      const why = incompatibleReason(m);
      const marks = [
        m.id === opts.defaultModel ? c.brightGreen("★") : "",
        m.id === opts.current ? c.brightCyan("●") : "",
      ]
        .filter(Boolean)
        .join("");
      const ctxWin = m.contextWindow ? `ctx ${fmtTokens(m.contextWindow)}` : "";
      const price = m.pricing ? `$${m.pricing.input}/$${m.pricing.output}` : "";
      rows.push({
        value: m.id,
        label: m.id.padEnd(width),
        hint: [marks, ctxWin].filter(Boolean).join(" "),
        badge: why ? c.red(why) : price,
      });
    }
  }
  return rows;
}

export async function pickModel(opts: ModelPickerOptions): Promise<string | null> {
  const counts = new Map<string, number>();
  for (const m of opts.catalog) {
    const k = m.modality ?? "text";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const tabs: PickerTab[] = MODALITIES.filter((mo) => counts.get(mo.key)).map((mo) => ({
    key: mo.key,
    label: mo.label,
    count: mo.key === "text" && !opts.includeIncompatible ? usableModels(opts.catalog).length : counts.get(mo.key),
  }));

  const currentModality = opts.catalog.find((m) => m.id === opts.current)?.modality ?? "text";

  return pick({
    title: "Models",
    tabs,
    initialTab: currentModality,
    initial: opts.current,
    items: (tabKey) => rowsFor(opts, tabKey || "text"),
  });
}
