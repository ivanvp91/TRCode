/** /prompt: which model rewrites prompts. */
import { error, hint, success, warn } from "../render.js";
import { openModal, pick } from "../picker.js";
import { choose } from "../choice.js";
import { openModelModal } from "../modelpicker.js";
import { loadConfig, saveConfig } from "../../config.js";
import { resolveModelId, servesModality } from "../../provider/models.js";
import { providerById, providerLabel, providers, splitModelId, wireModelId } from "../../provider/registry.js";
import { AUTO, promptModelFor } from "../../agent/promptwriter.js";
import { t } from "../../i18n.js";
import type { App } from "../repl.js";
import { currentProviderId, providerModels } from "./shared.js";
import { refreshCatalog } from "./providers.js";

/**
 * Picks the model that writes prompts for the provider in use, and remembers
 * it. Named outright it is taken as a name; without an argument the same list
 * the model picker shows opens, minus everything this provider cannot serve —
 * typing an id from memory is not a way to choose among four hundred models.
 */
/**
 * The first /prompt on a provider asks who should write, and remembers the
 * answer — including "the default one", which is an answer too. Everything
 * after that just works; `/prompt models` reopens the list.
 */
export async function ensureWriterChosen(app: App): Promise<boolean> {
  const provider = currentProviderId(app);
  if (loadConfig().promptModels?.[provider]) return true;

  const fallback = promptModelFor(app.session.model, app.catalog);
  const res = await app.exclusiveInput(() =>
    openModal({
      title: t("Prompt model", "Модель промптов"),
      subtitle: t(
        "Which model should write the briefs? A small one is enough, and it is cheaper than letting the big one guess.",
        "Какая модель будет писать задания? Хватит маленькой — это дешевле, чем давать большой домысливать.",
      ),
      items: [
        {
          value: "default",
          label: t(`Keep ${wireModelId(fallback)}`, `Оставить ${wireModelId(fallback)}`),
          hint: t("the default writer, asked once", "модель по умолчанию, спрашивается один раз"),
        },
        {
          value: "pick",
          label: t("Choose one…", "Выбрать…"),
          hint: t("pick from the list", "выбрать из списка"),
        },
      ],
      search: false,
      actions: [{ id: "auto", label: t("Auto (default)", "Авто (по умолчанию)"), hotkey: "a" }],
    }),
  );
  if (!res) return false;
  if (res.kind === "action" && res.id === "auto" || (res.kind === "item" && res.value === "default")) {
    saveConfig({ promptModels: { [provider]: AUTO } });
    app.cfg = loadConfig();
    hint(t(`Writing with ${fallback}. Change it with /prompt models.`, `Пишет ${fallback}. Сменить: /prompt models.`));
    return true;
  }
  if (res.kind === "item" && res.value === "pick") {
    await chooseWriter(app, "");
    // Backing out of the list is not an answer; ask again next time.
    return Boolean(loadConfig().promptModels?.[provider]);
  }
  return false;
}

export async function chooseWriter(app: App, named: string): Promise<void> {
  const cfg = loadConfig();
  const provider = currentProviderId(app);

  if (/^(auto|reset|default)$/i.test(named)) {
    saveConfig({ promptModels: { [provider]: AUTO } });
    app.cfg = loadConfig();
    success(
      t(
        `${providerLabel(provider)}: the default writer — ${promptModelFor(app.session.model, app.catalog)}.`,
        `${providerLabel(provider)}: модель по умолчанию — ${promptModelFor(app.session.model, app.catalog)}.`,
      ),
    );
    return;
  }

  if (named) {
    let id: string;
    try {
      id = resolveModelId(named, app.catalog);
    } catch (err) {
      return void error((err as Error).message);
    }
    if (splitModelId(id).providerId !== provider) {
      return void error(
        t(
          `${id} belongs to another provider — a writer has to be one this key can call.`,
          `${id} у другого поставщика — писать промпты должна модель, доступная этому ключу.`,
        ),
      );
    }
    saveConfig({ promptModels: { [provider]: id } });
    app.cfg = loadConfig();
    success(t(`${providerLabel(provider)} writes prompts with ${id}.`, `${providerLabel(provider)}: промпты пишет ${id}.`));
    return;
  }

  // The same panel /model shows, scoped to this provider and with the writer's
  // own buttons along the foot. A button changes what is on offer and the
  // panel comes straight back, so widening to every provider or re-reading the
  // catalogue never costs a re-typed command.
  let all = false;
  for (;;) {
    const mine = providerModels(app, provider);
    // The writer has to be one this provider's key can call, so the list is
    // its models first — and widens to every host when the host's own
    // catalogue came up empty, or by the scope button.
    const scoped = all || !mine.length ? app.catalog : mine;
    const pool = scoped.filter((m) => m.chatCapable !== false && servesModality(m, "text"));
    const label = providerById(provider)?.label ?? provider;
    const writer = cfg.promptModels?.[provider];
    const current = writer && writer !== AUTO ? writer : promptModelFor(app.session.model, app.catalog);

    if (!pool.length) {
      await refreshCatalog(app);
      continue;
    }

    const res = await app.exclusiveInput(() =>
      openModelModal({
        catalog: pool,
        // The writer is pinned per provider but called on its own key, so a
        // star from another host is a working choice — the tab shows them all.
        favoritesCatalog: app.catalog.filter((m) => m.chatCapable !== false && servesModality(m, "text")),
        current,
        defaultModel: app.session.model,
        title: t("Prompt model", "Модель промптов"),
        subtitle: t(
          `${all ? "Every provider" : label} · ★ session model · ● in use · a small one is enough`,
          `${all ? "Все поставщики" : label} · ★ модель сессии · ● текущая · хватит маленькой`,
        ),
        actions: [
          { id: "auto", label: t("Auto (default)", "Авто (по умолчанию)"), hotkey: "a" },
          { id: "refresh", label: t("Refresh", "Обновить"), hotkey: "r" },
          all
            ? { id: "scope", label: t(`Only ${label}`, `Только ${label}`), hotkey: "o" }
            : { id: "scope", label: t("All providers", "Все поставщики"), hotkey: "s" },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "action") {
      if (res.id === "refresh") {
        await refreshCatalog(app);
        continue;
      }
      if (res.id === "scope") {
        all = !all;
        continue;
      }
      if (res.id === "auto") {
        saveConfig({ promptModels: { [provider]: AUTO } });
        app.cfg = loadConfig();
        success(
          t(
            `${providerLabel(provider)}: the default writer — ${promptModelFor(app.session.model, app.catalog)}.`,
            `${providerLabel(provider)}: модель по умолчанию — ${promptModelFor(app.session.model, app.catalog)}.`,
          ),
        );
        return;
      }
      continue;
    }

    if (!res.value || splitModelId(res.value).providerId !== provider) {
      warn(
        t(
          `${res.value} belongs to another provider — pin it with /model first.`,
          `${res.value} у другого поставщика — сначала переключитесь на него через /model.`,
        ),
      );
      continue;
    }
    saveConfig({ promptModels: { [provider]: res.value } });
    app.cfg = loadConfig();
    success(
      t(`${providerLabel(provider)} writes prompts with ${res.value}.`, `${providerLabel(provider)}: промпты пишет ${res.value}.`),
    );
    return;
  }
}
