/** /uilib: the UI library — browse, match, blend and capture entries. */
import { c } from "../ansi.js";
import { contentWidth } from "../layout.js";
import { error, hint, line, padded, renderMarkdownBlock, rule, success, truncate, warn } from "../render.js";
import { openModal, pick, pickMulti, type PickerItem } from "../picker.js";
import { choose } from "../choice.js";
import { askLine } from "../prompt.js";
import { t } from "../../i18n.js";
import { listEntries, getEntry, deleteEntry, type UiEntry } from "../../ui-library/store.js";
import { matchLibrary } from "../../ui-library/match.js";
import type { App } from "../repl.js";

// ── /uilib ────────────────────────────────────────────────────────────────

/**
 * The library panel. Capture, blend and removal are the typed sub-commands
 * turned into buttons; Enter on a row shows what that mockup actually says,
 * which is the one thing a bare listing could never do.
 */
export async function uiLibraryModal(app: App): Promise<void> {
  for (;;) {
    const entries = listEntries();
    const items: PickerItem[] = entries.map((e) => ({
      value: e.slug,
      label: e.title.padEnd(22),
      hint: c.dim(e.keywords.slice(0, 6).join(" ")),
      badge: truncate(e.summary, Math.max(16, contentWidth() - 64)),
    }));

    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("UI library", "Библиотека UI"),
        subtitle: t(
          "Saved mockups. A design request offers them by itself; Enter opens one's brief.",
          "Сохранённые макеты. Запрос на дизайн предложит их сам; Enter открывает бриф.",
        ),
        items,
        empty: t(
          "The library is empty — capture a design from a live site to start.",
          "Библиотека пуста — сохраните дизайн с живого сайта.",
        ),
        actions: [
          { id: "add", label: t("Capture a site…", "Сохранить сайт…"), hotkey: "c" },
          { id: "blend", label: t("Blend…", "Смешать…"), hotkey: "b", disabled: entries.length < 2 },
          { id: "match", label: t("Match a request…", "Подобрать под запрос…"), hotkey: "m", disabled: !entries.length },
          { id: "delete", label: t("Remove", "Удалить"), hotkey: "r", tone: "danger", disabled: !entries.length },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "item") {
      showUiEntry(res.value);
      continue;
    }

    if (res.id === "add") {
      const url = await app.exclusiveInput(() => askLine(t("Site to capture:", "Сайт для захвата:"), "https://"));
      if (!url || !/^https?:\/\/\S+$/i.test(url.trim())) {
        if (url) error(t("That is not a URL.", "Это не URL."));
        continue;
      }
      app.pendingUilibGate = (proposal) => app.confirmUiEntry(proposal);
      app.skipNextDesignMatch = true;
      await app.turn(uilibCapturePrompt(url.trim(), ""));
      return;
    }
    if (res.id === "blend") {
      const picked = await blendUiEntries(app);
      if (!picked || picked === "none") continue;
      startBlendTurn(app, picked);
      return;
    }
    if (res.id === "match") {
      const q = await app.exclusiveInput(() => askLine(t("Describe the design:", "Опишите дизайн:"), ""));
      if (!q) continue;
      renderMatches(app, q);
      continue;
    }
    if (res.id === "delete" && res.value) {
      const entry = entries.find((e) => e.slug === res.value);
      if (!entry) continue;
      const sure = await app.exclusiveInput(() =>
        choose<"yes" | "no">(
          [
            { value: "no", label: t("Keep", "Оставить"), key: "n" },
            { value: "yes", label: t("Remove", "Удалить"), key: "y", tone: "danger" },
          ],
          {
            initial: "no",
            fallback: "no",
            cancel: () => {},
            hint: t("remove {title}?", "удалить {title}?", { title: entry.title }),
          },
        ),
      );
      if (sure === "yes" && deleteEntry(entry.slug)) {
        success(t("Removed {title}.", "Удалено: {title}.", { title: entry.title }));
      }
      continue;
    }
  }
}

/** The brief itself, rendered as the markdown it is. */
export function showUiEntry(slug: string): void {
  const found = getEntry(slug);
  if (!found) return void error(t("No such entry: {slug}", "Такого макета нет: {slug}", { slug }));
  line();
  rule(c.brightCyan(` ${found.entry.title} `));
  for (const l of renderMarkdownBlock(found.brief, { width: contentWidth() })) line(l);
  line();
  if (found.entry.source) hint(t("from {source}", "источник: {source}", { source: found.entry.source }));
  hint(t("A design request will offer this style by itself.", "Запрос на дизайн предложит этот стиль сам."));
}

/** Ranked matches for an explicit /uilib match — a listing, not a picker. */
export function renderMatches(app: App, q: string): void {
  const matches = matchLibrary(q);
  line();
  if (!matches.length) {
    hint(t("Nothing in the library matches that.", "Под это в библиотеке совпадений нет."));
    hint(t("Capture a design first: /uilib add <site-url>", "Сначала сохраните макет: /uilib add <url сайта>"));
    return;
  }
  for (const m of matches) {
    padded(
      `${c.bold(m.entry.slug.padEnd(24))} ${c.gray(`score ${String(Math.round(m.score)).padStart(3)}`)}  ` +
        c.dim(truncate(m.via.slice(0, 4).join(", "), Math.max(16, contentWidth() - 44))),
    );
  }
  line();
}

/**
 * The library picker for a design request: one modal with every saved mockup —
 * ranked by how well it matches the request — over three buttons. "Auto" takes
 * the best-ranked entry, "Blend" fuses several, "Unique design" draws from
 * scratch. Returns the picked entry (or several, for a blend), "none" when the
 * user wants a design from scratch, or null when the panel was dismissed.
 */
export async function pickUiEntry(
  app: App,
  request: string,
): Promise<{ entry: UiEntry; brief: string } | { entry: UiEntry; brief: string }[] | "none" | null> {
  const entries = listEntries();
  if (!entries.length) return null;
  // Matched first, in rank order; the rest of the library stays reachable below.
  const matched = new Set(matchLibrary(request).map((m) => m.entry.slug));
  const ranked = [
    ...matchLibrary(request).map((m) => m.entry),
    ...entries.filter((e) => !matched.has(e.slug)),
  ];
  line();
  hint(t("I can draw it in a style from your UI library:", "Могу нарисовать в стиле из вашей библиотеки макетов:"));
  const res = await app.exclusiveInput(() =>
    openModal({
      title: t("Design reference", "Дизайн-референс"),
      subtitle: t(
        "Pick a saved mockup for this request, or let the CLI decide.",
        "Выберите сохранённый макет под запрос или доверьтесь автоподбору.",
      ),
      items: ranked.map((e) => ({
        value: e.slug,
        label: e.title.padEnd(22),
        hint: c.dim(e.keywords.slice(0, 5).join(" ")),
        badge: truncate(e.summary, Math.max(16, contentWidth() - 64)),
      })),
      empty: t("The library is empty — capture a design with /uilib add.", "Библиотека пуста — сохраните макет через /uilib add."),
      actions: [
        { id: "auto", label: t("Auto-pick", "Авто-подбор"), hotkey: "a", tone: "ok" },
        { id: "blend", label: t("Blend several…", "Смешать несколько…"), hotkey: "b", disabled: entries.length < 2 },
        { id: "scratch", label: t("Unique design", "Уникальный дизайн"), hotkey: "u", tone: "warn" },
      ],
    }),
  );
  if (!res) return null;
  if (res.kind === "item") return getEntry(res.value);
  if (res.id === "auto") return ranked[0] ? getEntry(ranked[0].slug) : null;
  if (res.id === "blend") return blendUiEntries(app);
  if (res.id === "scratch") return "none";
  return null;
}

/**
 * Picking several mockups to fuse into one style. The multi-picker returns the
 * slugs; the confirm step after it is where the user sees what is about to be
 * blended and can still back out.
 */
export async function blendUiEntries(app: App): Promise<{ entry: UiEntry; brief: string }[] | "none" | null> {
  const entries = listEntries();
  const picked = await app.exclusiveInput(() =>
    pickMulti({
      title: t("Blend which mockups?", "Какие макеты смешать?"),
      items: entries.map((e) => ({ value: e.slug, label: e.title, hint: e.summary })),
    }),
  );
  if (!picked || picked.length < 2) {
    if (picked?.length === 1) warn(t("Blending needs at least two — picked one.", "Для смешения нужно минимум два — выбран один."));
    return picked ? "none" : null;
  }
  const parts = picked.map((s) => getEntry(s)).filter((p): p is { entry: UiEntry; brief: string } => p !== null);
  line();
  padded(
    c.bold(t("Blend:", "Смешать:")) + " " + parts.map((p) => c.brightCyan(p.entry.title)).join(c.gray(" + ")),
  );
  const ok = await app.exclusiveInput(() =>
    choose<"yes" | "no">(
      [
        { value: "yes", label: t("Generate blend", "Сгенерировать смешение"), key: "G", tone: "ok" },
        { value: "no", label: t("Cancel", "Отмена"), key: "N", tone: "danger" },
      ],
      { initial: "yes", fallback: "yes", cancel: () => {} },
    ),
  );
  return ok === "yes" ? parts : "none";
}

/**
 * The blend turn: the model synthesises one style from the chosen briefs and
 * saves it as a new library entry, going through the same propose → confirm
 * gate as a capture. The blend itself is written into the session history by
 * the model, so the next "нарисуй дизайн …" matches it like any other entry.
 */
export function startBlendTurn(app: App, parts: { entry: UiEntry; brief: string }[]): void {
  const briefs = parts.map((p) => `<source name="${p.entry.title}">\n${p.brief}\n</source>`).join("\n\n");
  app.pendingUilibGate = (proposal) => app.confirmUiEntry(proposal);
  app.skipNextDesignMatch = true;
  app.turn(
    `Blend these UI library mockups into ONE new coherent design style and save it into the trcode UI library.\n\n` +
      `${briefs}\n\n` +
      `Rules:\n` +
      `- Synthesise a style, do not average: take what each source does best (palette from one, typography from ` +
      `another, motion from a third…) and resolve their contradictions explicitly.\n` +
      `- The result must stand on its own: someone who has never seen the sources should be able to use the brief.\n` +
      `- Propose the entry BEFORE writing anything. Show exactly this form and stop:\n` +
      `  slug: <short-slug>\n  title: <human label>\n  summary: <one line on the style>\n  keywords: <comma-separated>\n\n` +
      `Then STOP and end your reply. The CLI will ask the user to confirm, edit or reject the proposal interactively.\n` +
      `- CONFIRMED arrives with the form unchanged (or corrected, if the user edited it): write two files under ` +
      `\`~/.trcode/ui-library/<slug>/\`: \`entry.json\` of shape\n` +
      `{ "slug": "...", "title": "...", "summary": "...", "keywords": ["..."], "addedAt": ${Date.now()} }\n` +
      `and \`design.md\` — the synthesized design brief, structured by palette / typography / spacing / components / motion.\n` +
      `- REJECTED means save nothing; acknowledge in one line.`,
  );
}

/**
 * Pulls the four-field proposal form out of the model's reply, so a confirm
 * can re-send exactly what was approved. Fields it never named stay blank —
 * the user saw the same reply and confirmed it as it was.
 */
export function extractEntryForm(reply: string): string {
  const fields = ["slug", "title", "summary", "keywords"];
  const got: string[] = [];
  for (const line of reply.split("\n")) {
    const m = /^\s*(slug|title|summary|keywords)\s*[:=]\s*(.*)$/i.exec(line);
    if (m && !got.some((g) => g.startsWith(`${m[1].toLowerCase()}:`))) {
      got.push(`${m[1].toLowerCase()}: ${m[2].trim()}`);
    }
  }
  const ordered = fields
    .map((f) => got.find((g) => g.startsWith(`${f}:`)))
    .filter((g): g is string => Boolean(g));
  return ordered.length ? ordered.join("\n") : reply.trim();
}

/**
 * The capture prompt: what the agent is to extract from the site and propose.
 */
export function uilibCapturePrompt(url: string, label: string): string {
  const name = label || new URL(url).hostname.replace(/^www\./, "");
  return (
    `Analyse the visual design of ${url} and save it into the trcode UI library.\n\n` +
    `Steps:\n` +
    `1. Map the site first, not just the landing page: fetch ${url} and look for internal pages — ` +
    `the sitemap at <origin>/sitemap.xml (fetch returns it verbatim as XML), plus nav/footer links on the homepage. ` +
    `Pick 4-8 representative inner pages (pricing, docs, blog, dashboard, auth, changelog…) and fetch them too: a ` +
    `design often shows its real system on components the homepage never renders — tables, forms, empty states, ` +
    `code blocks, badges. The landing page alone is not enough: read at least three inner pages whenever the site ` +
    `has them, and say so explicitly when there genuinely is nothing else to open. If a page blocks fetching or is ` +
    `client-rendered, note that in the brief instead of guessing.\n` +
    `2. Across those pages extract the design system, not the content: colour palette with concrete values, ` +
    `typography scale, spacing rhythm, corner radii, borders and shadows, button/input/card anatomy, and any signature ` +
    `visual effects (animations, transitions, glows, gradients) worth copying. Fetching a raw CSS file is fine when it helps.\n` +
    `3. Decide what kind of product this design fits (SaaS dashboard, landing, docs, terminal app…) and 5-10 keywords ` +
    `a person would type when asking for such a design, in English and Russian ("saas, dark, dashboard, тёмный…").\n` +
    `4. Propose the entry BEFORE writing anything. Show exactly this form and stop:\n` +
    `   slug: <short-slug>\n   title: <human label>\n   summary: <one line on the style>\n` +
    `   keywords: <comma-separated>\n\n` +
    `Then STOP and end your reply. The CLI will ask the user to confirm, edit or reject the proposal interactively.\n` +
    `- CONFIRMED arrives with the form unchanged (or corrected, if the user edited it): write two files under ` +
    `\`~/.trcode/ui-library/<slug>/\`: \`entry.json\` of shape\n` +
    `{ "slug": "...", "title": "...", "summary": "...", "keywords": ["..."], "source": "${url}", "addedAt": ${Date.now()} }\n` +
    `and \`design.md\` — the design brief itself, structured by palette / typography / spacing / components / motion, ` +
    `concrete enough to reproduce the style without seeing the original site. End it with a "Pages read" list of ` +
    `the URLs the brief was actually taken from, marking any that could not be fetched — a brief drawn from the ` +
    `homepage alone is worth less than one drawn from six pages, and the reader has to be able to tell which it ` +
    `is. Then report where it was saved.\n` +
    `- REJECTED means save nothing; acknowledge in one line.\n\n` +
    `The entry name should mention "${name}".`
  );
}
