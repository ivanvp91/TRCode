/** /image, /audio and /video: media models and video mode. */
import { c } from "../ansi.js";
import { error, hint, info, line, padded, Spinner, success, warn } from "../render.js";
import { openModal, type ModalAction } from "../picker.js";
import { choose } from "../choice.js";
import { openModelModal } from "../modelpicker.js";
import { loadConfig, saveConfig } from "../../config.js";
import { resolveModelId, servesModality } from "../../provider/models.js";
import { providers, wireModelId } from "../../provider/registry.js";
import { enterVideoMode, isVideoMode, leaveVideoMode, setVideoCaps, videoModelId, videoPromptModelId, type VideoModelInfo } from "../../agent/videomode.js";
import { fetchVideoModels, videoAvailable } from "../../tools/video.js";
import { fetchListing } from "../../tools/media.js";
import { fromPoolId, mediaModelId, mediaPool, parseMediaId, providerServes, toPoolId, type MediaKind } from "../../tools/mediamodels.js";
import { Session } from "../../session/session.js";
import { t } from "../../i18n.js";
import type { App } from "../repl.js";
import { setModel } from "./shared.js";

export const KIND_LABEL: Record<MediaKind, () => string> = {
  image: () => t("Image model", "Модель изображений"),
  video: () => t("Video model", "Модель видео"),
  audio: () => t("Audio model", "Модель аудио"),
};

export const CONFIG_KEY: Record<MediaKind, "imageModel" | "videoModel" | "audioModel"> = {
  image: "imageModel",
  video: "videoModel",
  audio: "audioModel",
};

/**
 * The /model panel, filled with what the connected providers can make of this
 * kind: provider tabs, search, the capability line where /model shows context
 * and price. `named` skips the panel. Returns the stored id, "" for off, or
 * null when nothing changed.
 */
export async function chooseMediaModel(app: App, kind: MediaKind, named: string, opts: { allowOff?: boolean } = {}): Promise<string | null> {
  let refresh = false;
  for (;;) {
    const spinner = new Spinner(t("reading {kind} models", "читаю модели: {kind}", { kind }));
    spinner.start();
    let pool: Awaited<ReturnType<typeof mediaPool>>;
    try {
      if (refresh) {
        await fetchListing("/images/models", true).catch(() => undefined);
        await fetchListing("/videos/models", true).catch(() => undefined);
        refresh = false;
      }
      pool = await mediaPool(kind, app.catalog);
    } finally {
      spinner.stop();
    }
    for (const e of pool.errors) warn(e);
    if (!pool.models.length) {
      error(t("No connected provider makes {kind} here.", "Ни один подключённый поставщик не делает {kind}.", { kind }));
      hint(
        t(
          "Supported: OpenRouter, TokenRouter, xAI (API key), Z.AI — connect one with /login.",
          "Поддерживаются: OpenRouter, TokenRouter, xAI (API-ключ), Z.AI — подключите через /login.",
        ),
      );
      return null;
    }

    let picked: string | null = null;
    if (named) {
      const q = named.trim().toLowerCase();
      const exact = pool.models.find(
        (m) => m.id.toLowerCase() === q || fromPoolId(m.id).toLowerCase() === q || wireModelId(m.id).toLowerCase() === q,
      );
      const near = exact ? [exact] : pool.models.filter((m) => fromPoolId(m.id).toLowerCase().includes(q));
      if (near.length !== 1) {
        error(t("No single {kind} model matches \"{named}\".", "Не нашлось одной модели ({kind}) по \"{named}\".", { kind, named }));
        if (near.length) hint(near.slice(0, 8).map((m) => fromPoolId(m.id)).join(", "));
        return null;
      }
      picked = near[0].id;
    } else {
      const stored = mediaModelId(kind);
      const actions: ModalAction[] = [{ id: "refresh", label: t("Refresh", "Обновить"), hotkey: "r" }];
      if (opts.allowOff) actions.unshift({ id: "off", label: t("Turn off", "Выключить"), hotkey: "o" });
      const res = await app.exclusiveInput(() =>
        openModelModal({
          catalog: pool.models,
          current: stored ? toPoolId(stored) : "",
          defaultModel: "",
          title: KIND_LABEL[kind](),
          subtitle: t(
            "{count} models · ● in use · the chat calls it when asked",
            "{count} моделей · ● текущая · чат вызывает её по просьбе",
            { count: pool.models.length },
          ),
          includeIncompatible: true,
          // Stars belong to chat models; a starred video model would sit in
          // /model's favorites as a row that cannot be picked there.
          favoritesTab: false,
          favoriteAction: false,
          describe: (m) => pool.hints.get(m.id),
          actions,
        }),
      );
      if (!res) return null;
      if (res.kind === "action") {
        if (res.id === "off") picked = "";
        else if (res.id === "refresh") {
          refresh = true;
          continue;
        } else return null;
      } else if (res.value) picked = res.value;
      else return null;
    }

    const stored = picked ? fromPoolId(picked) : "";
    saveConfig({ [CONFIG_KEY[kind]]: stored });
    app.cfg = loadConfig();
    if (kind === "video") {
      const { providerId, model } = parseMediaId(stored || mediaModelId("video"));
      const caps = providerId === "openrouter" ? (await fetchVideoModels().catch(() => [] as VideoModelInfo[])).find((m) => m.id === model) : undefined;
      setVideoCaps(caps);
    }
    // The tool's description names the model, and so does the video brief.
    app.rebuildTools();
    if (!stored) {
      success(
        t(
          "{label}: off — the chat no longer has this tool.",
          "{label}: выключено — в чате больше нет этого инструмента.",
          { label: KIND_LABEL[kind]() },
        ),
      );
    } else {
      const hintLine = pool.hints.get(picked!);
      success(`${KIND_LABEL[kind]()}: ${stored}` + (hintLine ? c.gray(`  ${hintLine}`) : ""));
    }
    return stored;
  }
}

export function mediaStatus(kind: MediaKind): void {
  const id = mediaModelId(kind);
  info(`${KIND_LABEL[kind]()}: ` + (id || t("none — off", "не выбрана — выключено")));
  const host = id ? parseMediaId(id).providerId : "";
  if (id && !providerServes(host, kind)) {
    hint(t("{host} is not connected with an API key: /login", "{host} не подключён по API-ключу: /login", { host }));
  }
}

/**
 * /image and /audio: which model draws or speaks. There is no mode — once a
 * model is set, the tool is one more in the chat and the session's model
 * calls it on request. `off` takes the tool away again.
 */
export async function mediaCommand(app: App, kind: "image" | "audio", rest: string): Promise<void> {
  const arg = rest.trim();
  if (/^(status|статус)$/i.test(arg)) return mediaStatus(kind);
  if (/^(off|none|clear|выкл)$/i.test(arg)) {
    saveConfig({ [CONFIG_KEY[kind]]: "" });
    app.cfg = loadConfig();
    app.rebuildTools();
    return void success(t("{label}: off.", "{label}: выключено.", { label: KIND_LABEL[kind]() }));
  }
  const stored = await chooseMediaModel(app, kind, /^(refresh|reload)$/i.test(arg) ? "" : arg, { allowOff: true });
  if (stored) {
    hint(
      kind === "image"
        ? t("Just ask in the chat: “draw …”. Each picture asks before it spends.", "Просто попросите в чате: «нарисуй …». Перед каждой картинкой будет подтверждение.")
        : t("Just ask in the chat: “voice this …”. Each clip asks before it spends.", "Просто попросите в чате: «озвучь …». Перед каждой генерацией будет подтверждение."),
    );
  }
}

/**
 * /video: the studio mode. Bare, it opens a small panel with the switch and
 * both model choices; the words (`on`, `off`, `model`, `prompt_model`) do the
 * same without it.
 */
export async function videoCommand(app: App, rest: string): Promise<void> {
  const arg = rest.trim();
  const [word, ...tail] = arg.split(/\s+/);
  const named = tail.join(" ").trim();

  if (/^(on|start|вкл)$/i.test(word)) return void (await startVideoMode(app));
  if (/^(off|stop|выкл)$/i.test(word)) return stopVideoMode(app);
  if (/^(status|статус)$/i.test(word)) return videoStatus(app);
  if (/^models?$/i.test(word)) return void (await chooseVideoModel(app, named));
  if (/^(prompt_?models?|writer)$/i.test(word)) return void (await chooseVideoPromptModel(app, named));
  if (word) {
    warn(t("Unknown: /video {word}", "Непонятно: /video {word}", { word }));
    return void hint("/video [on|off|status|model [id]|prompt_model [id]]");
  }

  for (;;) {
    const on = isVideoMode();
    const writer = videoPromptModelId();
    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("Video mode", "Режим видео"),
        subtitle: on
          ? t("On — every message is a video request.", "Включён — каждое сообщение становится заказом видео.")
          : t("A text model writes the prompt, a video model shoots it.", "Текстовая модель пишет промпт, видеомодель снимает."),
        items: [
          {
            value: "toggle",
            label: on ? t("Turn off", "Выключить") : t("Turn on", "Включить"),
            hint: on
              ? t("back to the model the session had before", "вернуть модель, что была до режима")
              : t("switches the session to the prompt model", "переключает сессию на модель промптов"),
          },
          { value: "model", label: t("Video model", "Модель видео"), hint: videoModelId() },
          {
            value: "writer",
            label: t("Prompt model", "Модель промптов"),
            hint: writer || t("session model ({model})", "модель сессии ({model})", { model: app.session.model }),
          },
        ],
        search: false,
      }),
    );
    if (!res || res.kind !== "item") return;
    if (res.value === "toggle") return void (on ? stopVideoMode(app) : await startVideoMode(app));
    if (res.value === "model") await chooseVideoModel(app, "");
    if (res.value === "writer") await chooseVideoPromptModel(app, "");
  }
}

export function videoStatus(app: App): void {
  info(
    t("Video mode: ", "Режим видео: ") +
      (isVideoMode() ? c.green(t("on", "включён")) : t("off", "выключен")),
  );
  padded(c.gray(t("video model   ", "модель видео     ")) + videoModelId());
  padded(c.gray(t("prompt model  ", "модель промптов   ")) + (videoPromptModelId() || `${app.session.model} (${t("session", "сессии")})`));
  const host = parseMediaId(videoModelId()).providerId;
  if (!videoAvailable()) hint(t("{host} is not connected with an API key: /login", "{host} не подключён по API-ключу: /login", { host }));
}

export async function chooseVideoModel(app: App, named: string): Promise<void> {
  await chooseMediaModel(app, "video", named);
}

export async function chooseVideoPromptModel(app: App, named: string): Promise<void> {
  const pool = app.catalog.filter((m) => m.chatCapable !== false && servesModality(m, "text"));
  let chosen: string | null = null;
  if (/^(session|auto|reset|default)$/i.test(named)) chosen = "";
  else if (named) {
    try {
      chosen = resolveModelId(named, app.catalog);
    } catch (err) {
      return void error((err as Error).message);
    }
  } else {
    const res = await app.exclusiveInput(() =>
      openModelModal({
        catalog: pool,
        favoritesCatalog: pool,
        current: videoPromptModelId() || app.session.model,
        defaultModel: app.session.model,
        title: t("Prompt model for video", "Модель промптов для видео"),
        subtitle: t(
          "Writes the shot description and calls the video model. Vision helps with attached images.",
          "Пишет описание кадра и вызывает видеомодель. Если понимает картинки — сможет смотреть вложения.",
        ),
        actions: [{ id: "session", label: t("Session model", "Модель сессии"), hotkey: "s" }],
      }),
    );
    if (!res) return;
    if (res.kind === "action" && res.id === "session") chosen = "";
    else if (res.kind === "item" && res.value) chosen = res.value;
    else return;
  }

  saveConfig({ videoPromptModel: chosen });
  app.cfg = loadConfig();
  success(
    chosen
      ? t("Video prompts are written by {model}.", "Промпты для видео пишет {model}.", { model: chosen })
      : t("Video prompts are written by the session model.", "Промпты для видео пишет модель сессии."),
  );
  // Already in the mode: the switch takes effect now, not on the next /video.
  if (isVideoMode() && chosen && app.session.model !== chosen) setModel(app, chosen);
}

export async function startVideoMode(app: App): Promise<void> {
  if (isVideoMode()) return videoStatus(app);
  if (!videoAvailable()) {
    warn(t("{model} is on a provider that is not connected; choose another.", "{model} у неподключённого поставщика; выберите другую.", { model: videoModelId() }));
    if (!(await chooseMediaModel(app, "video", ""))) return;
    if (!videoAvailable()) return;
  }
  if (app.preset === "minimal") {
    warn(t("The minimal preset has no video tool; switch with /preset standard.", "В минимальном пресете нет инструмента видео; переключите: /preset standard."));
    return;
  }
  // The first time, both choices are asked: they are what the mode is.
  if (!loadConfig().videoModel) await chooseVideoModel(app, "");
  if (loadConfig().videoPromptModel === undefined) await chooseVideoPromptModel(app, "");

  const { providerId, model } = parseMediaId(videoModelId());
  const models = providerId === "openrouter" ? await fetchVideoModels().catch(() => [] as VideoModelInfo[]) : [];
  enterVideoMode({ previousModel: app.session.model, caps: models.find((m) => m.id === model) });
  const writer = videoPromptModelId();
  if (writer && writer !== app.session.model) setModel(app, writer);
  else app.rebuildTools();

  success(t("Video mode on.", "Режим видео включён."));
  videoStatus(app);
  hint(
    t(
      "Describe the video you want; attach images if needed. Each generation asks before it spends. /video off to leave.",
      "Опишите, какое видео нужно; можно приложить картинки. Перед каждой генерацией будет подтверждение. /video off — выйти.",
    ),
  );
}

export function stopVideoMode(app: App): void {
  if (!isVideoMode()) return void info(t("Video mode is already off.", "Режим видео и так выключен."));
  const writer = videoPromptModelId();
  const prev = leaveVideoMode();
  // Only undo our own switch: a model the user picked mid-mode stays.
  if (prev && writer && app.session.model === writer && prev !== writer) setModel(app, prev);
  else app.rebuildTools();
  success(t("Video mode off. Model: {model}", "Режим видео выключен. Модель: {model}", { model: app.session.model }));
}
