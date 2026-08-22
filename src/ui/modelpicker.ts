/** The /model chooser: modality tabs, vendor sections, newest first. */
import { c } from "./ansi.js";
import { pick, pickMulti, type PickerItem, type PickerTab } from "./picker.js";
import { fmtTokens } from "../usage.js";
import { MODALITIES, groupByVendor, incompatibleReason, servesModality, usableModels } from "../provider/models.js";
import { providerLabel, splitModelId, wireModelId } from "../provider/registry.js";
import type { ModelInfo } from "../types.js";

export interface ModelPickerOptions {
  catalog: ModelInfo[];
  current: string;
  defaultModel: string;
  /** Heading for the list; the default names it "Models". */
  title?: string;
  /** Show every modality, including models this client cannot drive. */
  includeIncompatible?: boolean;
}

function rowsFor(opts: ModelPickerOptions, modality: string): PickerItem[] {
  const pool = modality === "text" && !opts.includeIncompatible ? usableModels(opts.catalog) : opts.catalog;
  // A model belongs under every type it can produce: one that answers in text
  // and can also return an image is a chat model and an image model both.
  const models = pool.filter((m) => servesModality(m, modality as NonNullable<ModelInfo["modality"]>));
  if (!models.length) return [];

  // Names are shown without their routing prefix — a column of repeated
  // "alibabacloud:" is width spent on nothing. The full id stays the row's
  // value, so both spellings still match when typing to filter.
  const bare = (id: string) => wireModelId(id);
  const hosts = new Set(models.map((m) => splitModelId(m.id).providerId));
  const width = Math.min(34, Math.max(...models.map((m) => bare(m.id).length)) + 1);
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
      // Only worth a column when the list actually spans more than one host.
      const host = hosts.size > 1 ? c.dim(providerLabel(splitModelId(m.id).providerId)) : "";
      const price = m.pricing ? `$${m.pricing.input}/$${m.pricing.output}` : "";
      rows.push({
        value: m.id,
        label: bare(m.id).padEnd(width),
        hint: [marks, ctxWin, host].filter(Boolean).join(" "),
        badge: why ? c.red(why) : price,
      });
    }
  }
  return rows;
}

export async function pickModel(opts: ModelPickerOptions): Promise<string | null> {
  const counts = new Map<string, number>();
  for (const mo of MODALITIES) {
    const n = opts.catalog.filter((m) => servesModality(m, mo.key)).length;
    if (n) counts.set(mo.key, n);
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

/**
 * The same list, choosing several — for the places where a set is the answer
 * rather than one model: which models subagents may be launched on.
 */
export async function pickModels(opts: ModelPickerOptions & { selected?: string[] }): Promise<string[] | null> {
  return pickMulti({
    title: opts.title ?? "Models",
    items: rowsFor(opts, "text"),
    initial: opts.current,
    selected: opts.selected,
  });
}

/**
 * Several models, from several hosts — the tabs are the providers rather than
 * the output types. A panel of models from one vendor shares that vendor's
 * blind spots, so crossing hosts is the point rather than an edge case, and
 * ←/→ is how you get there without leaving the list.
 */
export async function pickModelsAcrossProviders(
  opts: ModelPickerOptions & { selected?: string[] },
): Promise<string[] | null> {
  const text = usableModels(opts.catalog).filter((m) => servesModality(m, "text"));
  const providers = [...new Set(text.map((m) => splitModelId(m.id).providerId))];
  const tabs: PickerTab[] = providers.map((id) => ({
    key: id,
    label: providerLabel(id),
    count: text.filter((m) => splitModelId(m.id).providerId === id).length,
  }));
  const here = splitModelId(opts.current).providerId;

  return pickMulti({
    title: opts.title ?? "Models",
    tabs,
    initialTab: providers.includes(here) ? here : providers[0],
    initial: opts.current,
    selected: opts.selected,
    items: (tabKey) =>
      rowsFor(
        { ...opts, catalog: text.filter((m) => splitModelId(m.id).providerId === (tabKey || providers[0])) },
        "text",
      ),
  });
}
