/** Slash commands, grouped from everyday to occasional. */
import fs from "node:fs";
import path from "node:path";
import { c } from "./ansi.js";
import { contentWidth } from "./layout.js";
import { error, hint, info, line, padded, plural, renderMarkdownBlock, rule, Spinner, success, truncate, warn, wrapText } from "./render.js";
import { pick } from "./picker.js";
import { choose } from "./choice.js";
import { toggleFavorite } from "./modelpicker.js";
import { askSecret } from "./secret.js";
import { askLine } from "./prompt.js";
import { scanKeys } from "./keyscan.js";
import { setExtraNewlineKeys } from "./editor.js";
import { loadConfig, saveConfig, configPath, rememberProjectState, VERSION, EFFORT_LEVELS, LANGUAGES, type Effort, type Lang } from "../config.js";
import { fetchModels, resolveModelId, findModel } from "../provider/models.js";
import { protocolFor } from "../provider/protocol.js";
import { verifyKey, modelRejectsEffort, modelRejectsCache, resetEffortLearning } from "../provider/client.js";
import { DEFAULT_PROVIDER, providerById, providers, rememberProviderState, wireModelId } from "../provider/registry.js";
import { loginProvider } from "./login.js";
import { Session } from "../session/session.js";
import { contextPressure } from "../session/compact.js";
import { loadProjections } from "../session/projection.js";
import { fmtTokens, historyTokens, estimateTokens } from "../usage.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { runSwarm } from "../agent/swarm.js";
import { runOrchestration, orchestrationStatus } from "../agent/orchestrator.js";
import { createSkill } from "../skills/loader.js";
import { memoryPath, memoryCount } from "../tools/memory.js";
import { resetPromptSnapshots } from "../agent/prompt.js";
import { connectMcpServers, mcpClients, stopMcpServers } from "../mcp/client.js";
import { t, count } from "../i18n.js";
import { deleteEntry } from "../ui-library/store.js";
import type { App } from "./repl.js";
import { GROUP_ORDER, groupLabel, effortHint, txt, type Command, parseTokens, currentProviderId, setModel, warnIfIncompatible } from "./commands/shared.js";
import { goalCommand } from "./commands/goal.js";
import { switchToProvider, refreshCatalog, setDefaultProvider, setProviderHost, logoutFromProvider, settingsModal, runUpdate, modelModal, providerModal, favModal } from "./commands/providers.js";
import { brainPanel, brainNeedsPanel, brainPanelModal, brainModal, swarmPanelModal, swarmModal, addSubagentModel, setSubagentMode, setSubagentAuto, subagentsModal } from "./commands/agents.js";
import { setSkillsEnabled, editSkill, skillGenPrompt, skillsModal } from "./commands/skills.js";
import { statModal } from "./commands/stat.js";
import { uiLibraryModal, renderMatches, blendUiEntries, startBlendTurn, uilibCapturePrompt } from "./commands/uilib.js";
import { openSession, browseSessions, eraseSessions, rewindTurn, forkTurn, compactNow, expandCollapsed, editTurn } from "./commands/sessions.js";
import { ensureWriterChosen, chooseWriter } from "./commands/writer.js";
import { mediaCommand, videoCommand } from "./commands/media.js";
export { rememberCurrent } from "./commands/providers.js";
export { subagentsModal } from "./commands/agents.js";
export { periodSlice, foldUsage } from "./commands/stat.js";
export { pickUiEntry, extractEntryForm } from "./commands/uilib.js";

const COMMANDS: Command[] = [
  // ── main ────────────────────────────────────────────────────────────────
  {
    name: "/model",
    group: "main",
    args: () => t("[name|alias|only|refresh]", "[имя|алиас|only|refresh]"),
    help: () =>
      t(
        "switch model — every connected provider at once, `only` narrows to this one, `refresh` re-reads the catalog",
        "сменить модель — все подключённые поставщики сразу, `only` сузить до текущего, `refresh` перечитать каталог",
      ),
    async run(app, rest) {
      const arg = rest.trim();
      // The catalogue is cached, and a provider that has just published a
      // model is exactly when that shows. This is what /models was for.
      if (/^(refresh|reload|update|sync)$/i.test(arg)) {
        await refreshCatalog(app);
        return void hint(t("Pick one with /model.", "Выбрать: /model."));
      }
      if (arg && !/^only$/i.test(arg)) {
        // A name is searched across every provider: naming one is an explicit
        // enough request to cross over.
        const id = resolveModelId(arg, app.catalog);
        // The header states the provider, so crossing to another needs no
        // separate line about it.
        setModel(app, id);
        warnIfIncompatible(app, id);
        return;
      }
      await modelModal(app, { only: /^only$/i.test(arg) });
    },
  },
  {
    name: "/fav",
    group: "main",
    args: () => t("[name|alias]", "[имя|алиас]"),
    help: () =>
      t(
        "edit favorite models — checkboxes on the provider tabs, the starred ones lead every model picker",
        "редактировать избранное — чекбоксы на табах поставщиков, отмеченные ведут каждый список моделей",
      ),
    async run(app, rest) {
      const arg = rest.trim();
      if (arg) {
        const id = resolveModelId(arg, app.catalog);
        const on = toggleFavorite(id);
        return void (on
          ? success(t(`Favorite: ${c.brightMagenta(wireModelId(id))}`, `В избранном: ${c.brightMagenta(wireModelId(id))}`))
          : hint(t(`Removed from favorites: ${wireModelId(id)}`, `Убрана из избранного: ${wireModelId(id)}`)));
      }
      await favModal(app);
    },
  },
  {
    name: "/provider",
    group: "main",
    args: () => t("[name] | default [name] | host [name] [url] | logout <name>", "[имя] | default [имя] | host [имя] [url] | logout <имя>"),
    help: () => t("switch provider — the router or a direct subscription", "сменить поставщика — роутер или прямая подписка"),
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const others = providers().filter((p) => p.id !== DEFAULT_PROVIDER);

      if (parts[0] === "default") {
        const def = parts[1] ? providerById(parts[1].toLowerCase()) : providerById(currentProviderId(app));
        if (!def) return error(t(`Unknown provider: ${parts[1]}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${parts[1]}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
        return setDefaultProvider(app, def);
      }

      // The host a key belongs to is not always the one a provider defaults
      // to, and getting it wrong is reported as a rejected key. Changing it
      // must not cost a logout — the credential is still good.
      if (parts[0] === "host") {
        const named = parts.slice(1).find((p) => !/^https?:\/\//i.test(p));
        const def = named ? providerById(named.toLowerCase()) : providerById(currentProviderId(app));
        if (!def) return error(t(`Unknown provider: ${named}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${named}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
        return setProviderHost(app, def, parts.find((p) => /^https?:\/\//i.test(p)));
      }

      if (parts[0] === "logout") {
        const def = parts[1] ? providerById(parts[1].toLowerCase()) : undefined;
        if (!def) return error(t(`Which provider? ${others.map((p) => p.id).join(", ") || "none to disconnect"}`, `Какого поставщика? ${others.map((p) => p.id).join(", ") || "отключать нечего"}`));
        return logoutFromProvider(app, def);
      }

      if (parts[0]) {
        const def = providerById(parts[0].toLowerCase());
        if (!def) return error(t(`Unknown provider: ${parts[0]}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${parts[0]}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
        return switchToProvider(app, def);
      }

      await providerModal(app);
    },
  },
  {
    name: "/lang",
    group: "settings",
    args: "[en|ru]",
    help: () => t("language for answers and skill descriptions", "язык ответов и описаний навыков"),
    async run(app, rest) {
      const arg = rest.trim().toLowerCase();
      const named = arg
        ? LANGUAGES.find((l) => l.code === arg || l.label.toLowerCase() === arg || l.native.toLowerCase() === arg)
        : undefined;
      if (arg && !named) {
        return error(t(`Unknown language: ${arg}. Available: ${LANGUAGES.map((l) => l.code).join(", ")}`, `Неизвестный язык: ${arg}. Доступны: ${LANGUAGES.map((l) => l.code).join(", ")}`));
      }

      const current = loadConfig().lang;
      const code =
        named?.code ??
        ((await app.exclusiveInput(() =>
          pick({
            title: "Language",
            items: LANGUAGES.map((l) => ({
              value: l.code,
              label: l.native.padEnd(10),
              hint: c.gray(l.code === current ? `${l.label} · current` : l.label),
            })),
            initial: current,
          }),
        )) as Lang | null);
      if (!code) return;

      saveConfig({ lang: code });
      app.cfg = loadConfig();
      // Both the system prompt and the skill descriptions are built from the
      // language, and both are cached — rebuild them rather than wait for the
      // next session.
      resetPromptSnapshots();
      app.rebuildTools();
      // The header is drawn in the interface language, so it is redrawn in the
      // new one — which also clears the screen of the old language.
      app.repaintHeader();
      const picked = LANGUAGES.find((l) => l.code === code)!;
      success(t(`Language: ${c.brightYellow(picked.native)}`, `Язык: ${c.brightYellow(picked.native)}`));
      hint(
        code === "ru"
          ? "Ответы и описания навыков — по-русски. Код, пути и команды остаются как есть."
          : "Answers and skill descriptions are in English. Code, paths and commands are never translated.",
      );
      // The prompt is rebuilt per turn, so the change lands on the next one.
      if (app.session.messages.length) hint(code === "ru" ? "Применится со следующего сообщения." : "Applies from the next message.");
    },
  },
  {
    name: "/effort",
    group: "main",
    args: "[off|minimal|low|medium|high] [save] | reset",
    help: () => t("reasoning budget", "бюджет размышлений"),
    async run(app, rest) {
      const cfg = loadConfig();
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const persist = parts.includes("save");
      const wanted = parts.find((p) => (EFFORT_LEVELS as string[]).includes(p)) as Effort | undefined;

      if (parts[0] === "reset") {
        const target = parts[1] === "all" ? undefined : app.session.model;
        resetEffortLearning(target);
        success(
          target
            ? `Forgot that ${target} rejects the reasoning budget — it will be probed again on the next request.`
            : "Cleared what was learned about reasoning support for every model.",
        );
        return;
      }

      if (parts.length && !wanted && !persist) {
        error(t(`Unknown level "${parts[0]}". Available: ${EFFORT_LEVELS.join(", ")}`, `Неизвестный уровень "${parts[0]}". Доступны: ${EFFORT_LEVELS.join(", ")}`));
        hint(t("Also: /effort reset re-probes support for the current model.", "Ещё: /effort reset заново проверит поддержку у текущей модели."));
        return;
      }

      const level =
        wanted ??
        ((await app.exclusiveInput(() =>
          pick({
            title: t(`Reasoning budget (now: ${app.effort()})`, `Бюджет размышлений (сейчас: ${app.effort()})`),
            items: EFFORT_LEVELS.map((l) => ({
              value: l,
              label: l.padEnd(10),
              hint: c.gray(effortHint(l)),
            })),
            initial: app.effort(),
          }),
        )) as Effort | null);

      if (!level) return;

      app.effortOverride = level;
      // Kept against the provider too: what one host charges for thinking, and
      // what it is worth there, does not carry over to the next.
      rememberProviderState(currentProviderId(app), { effort: level });
      rememberProjectState(app.cwd, { effort: level });
      if (persist) {
        saveConfig({ effort: level });
        app.cfg = loadConfig();
      }
      // The budget is one of the three things the header states, so restate it.
      app.repaintHeader();
      hint(persist ? t("Saved as the default.", "Сохранено как значение по умолчанию.") : t("This session only — add save to keep it.", "Только на эту сессию — добавьте save, чтобы запомнить."));
      if (level !== "off" && modelRejectsEffort(app.session.model)) {
        warn(t(`${app.session.model} rejected this parameter before — it is being omitted.`, `${app.session.model} уже отвергала этот параметр — он не отправляется.`));
        hint(t("Re-check with: /effort reset", "Перепроверить: /effort reset"));
      }
      if (level !== "off") {
        hint(
          `Sent as ${cfg.effortParam === "both" ? "the shape this model accepts" : cfg.effortParam}; ` +
            "dropped automatically if the model rejects it.",
        );
      }
    },
  },
  {
    name: "/yolo",
    group: "main",
    help: () => t("skip confirmations — tools run immediately", "без подтверждений — инструменты запускаются сразу"),
    async run(app, rest) {
      const arg = rest.trim().toLowerCase();
      const next = arg ? ["on", "1", "true"].includes(arg) : !app.broker.autoApprove;
      app.broker.autoApprove = next;
      if (next) {
        warn(t("YOLO on — file writes and shell commands run without asking.", "YOLO включён — запись файлов и команды оболочки идут без спроса."));
        hint(t("Turn it off with: /yolo off, or Shift+Tab.", "Выключить: /yolo off или Shift+Tab."));
      } else {
        success(t("YOLO off — confirmations are back.", "YOLO выключен — подтверждения вернулись."));
        hint(t("Shift+Tab flips it without typing a command.", "Shift+Tab переключает это без команды."));
      }
    },
  },
  {
    name: "/orchestrate",
    group: "main",
    args: () => t("<task> | resume | status | replan <instructions>", "<задача> | resume | status | replan <уточнения>"),
    help: () => t("split a task into subtasks and run them on subagents", "разбить задачу на подзадачи и раздать субагентам"),
    async run(app, rest) {
      const task = rest.trim();
      if (/^status$/i.test(task)) return void orchestrationStatus(app);
      if (/^resume$/i.test(task)) return void await runOrchestration(app, "", "resume");
      const revision = /^replan(?:\s+([\s\S]*))?$/i.exec(task);
      if (revision) return void await runOrchestration(app, revision[1]?.trim() ?? "", "replan");
      if (!task) {
        warn(t("Name the task: /orchestrate <what to do>", "Назовите задачу: /orchestrate <что сделать>"));
        hint("The task is split into steps with dependencies; independent ones run in parallel.");
        hint("Unlike /swarm, which sends one whole task to several models.");
        return;
      }
      await runOrchestration(app, task);
    },
  },
  {
    name: "/uilib",
    group: "main",
    args: () =>
      t(
        "[add <site-url> | match <request> | blend | rm <slug>]  ·  bare /uilib lists the library",
        "[add <url сайта> | match <запрос> | blend | rm <слаг>]  ·  без аргументов — список библиотеки",
      ),
    help: () =>
      t(
        "UI mockup library: capture a site's design, then reuse it in design requests",
        "библиотека UI-макетов: сохранить дизайн сайта и потом применять его в запросах",
      ),
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      // Capture: the agent analyses the site, proposes an entry, the user
      // confirms or edits it. Everything interactive stays here; the agent only
      // writes the brief it is told to write.
      if (sub === "add" || sub === "capture") {
        const url = parts[1];
        if (!url || !/^https?:\/\//i.test(url)) {
          return error(t("Give the site: /uilib add https://example.com", "Укажите сайт: /uilib add https://example.com"));
        }
        const label = parts.slice(2).join(" ");
        app.pendingUilibGate = (proposal) => app.confirmUiEntry(proposal);
        app.skipNextDesignMatch = true;
        await app.turn(uilibCapturePrompt(url, label));
        return;
      }

      if (sub === "rm" || sub === "remove" || sub === "delete") {
        const slug = parts[1];
        if (!slug) return error(t("Which one: /uilib rm <slug>", "Какой удалить: /uilib rm <слаг>"));
        const ok = deleteEntry(slug);
        return ok
          ? success(t(`Removed ${slug}.`, `Удалено: ${slug}.`))
          : error(t(`No such entry: ${slug}`, `Такого макета нет: ${slug}`));
      }

      if (sub === "match") {
        const q = parts.slice(1).join(" ");
        if (!q) return error(t('What to match: /uilib match "saas dashboard dark"', 'Что сопоставить: /uilib match "saas dashboard dark"'));
        return renderMatches(app, q);
      }

      if (sub === "blend") {
        const picked = await blendUiEntries(app);
        if (!picked || picked === "none") return;
        return startBlendTurn(app, picked);
      }

      if (sub) return error(t(`Unknown subcommand: ${sub}`, `Неизвестная подкоманда: ${sub}`));

      await uiLibraryModal(app);
    },
  },
  {
    name: "/swarm",
    group: "main",
    args: () => t("<task> | models", "<задача> | models"),
    help: () => t("swarm: several models solve it in parallel, then a synthesis pass", "рой: несколько моделей решают параллельно, затем сведение"),
    async run(app, rest) {
      const arg = rest.trim();
      if (/^models?$/i.test(arg)) return void (await swarmPanelModal(app));
      if (arg) return void (await runSwarm(app, arg));
      await swarmModal(app);
    },
  },
  {
    name: "/compact",
    group: "main",
    args: () => t("[what to focus on]", "[на чём сфокусироваться]"),
    help: () => t("compact the history into a digest", "сжать историю в конспект"),
    async run(app, rest) {
      await compactNow(app, rest);
    },
  },
  {
    name: "/edit",
    group: "main",
    args: () => t("[last]", "[last]"),
    help: () => t("go back to one of your messages and rewrite it", "вернуться к своему сообщению и переписать его"),
    async run(app, rest) {
      await app.exclusiveInput(() => editTurn(app, rest));
    },
  },
  {
    name: "/expand",
    group: "main",
    args: () => t("[n]", "[n]"),
    help: () => t("print a shortened message in full", "показать сокращённое сообщение целиком"),
    async run(_app, rest) {
      expandCollapsed(rest);
    },
  },
  {
    name: "/goal",
    group: "main",
    args: () => t("<objective> [--turns <n>] | status | pause | resume | clear", "<цель> [--turns <n>] | status | pause | resume | clear"),
    help: () => t("set a persistent goal the agent keeps working toward", "задать постоянную цель, к которой агент идёт сам"),
    async run(app, rest) {
      goalCommand(app, rest);
    },
  },
  {
    name: "/rewind",
    group: "main",
    args: () => t("[last]", "[last]"),
    help: () => t("put files back to how they were before a turn", "вернуть файлы к состоянию до хода"),
    async run(app, rest) {
      await app.exclusiveInput(() => rewindTurn(app, rest));
    },
  },
  {
    name: "/new",
    group: "main",
    help: () => t("start a new session", "начать новую сессию"),
    async run(app) {
      app.session.save();
      const fresh = new Session({ cwd: app.cwd, model: app.session.model });
      app.session = fresh;
      app.usage = fresh.usage;
      app.readFiles.clear();
      app.broker.reset();
      app.todo.replace([]);
      app.rebuildTools();
      success(t("New session: ", "Новая сессия: ") + fresh.id);
    },
  },

  // ── session ─────────────────────────────────────────────────────────────
  {
    name: "/sessions",
    group: "session",
    args: "",
    help: () => t("browse, rename, delete or compact saved sessions", "просмотр, переименование, удаление и сжатие сессий"),
    async run(app) {
      await app.exclusiveInput(() => browseSessions(app, "manage"));
    },
  },
  {
    name: "/resume",
    group: "session",
    args: "[id]",
    help: () => t("restore a session", "восстановить сессию"),
    async run(app, rest) {
      const id = rest.trim();
      await app.exclusiveInput(() => (id ? openSession(app, id) : browseSessions(app, "resume")));
    },
  },
  {
    name: "/erase",
    group: "session",
    help: () => t("delete all saved sessions of this project except the current one", "удалить все сохранённые сессии проекта, кроме текущей"),
    async run(app) {
      await app.exclusiveInput(() => eraseSessions(app));
    },
  },
  {
    name: "/fork",
    group: "session",
    args: () => t("[turn]", "[ход]"),
    help: () => t("branch the current session at a past turn; the original stays intact", "ветвление текущей сессии от прошлого хода; оригинал не трогается"),
    async run(app, rest) {
      await forkTurn(app, rest);
    },
  },
  {
    name: "/rename",
    group: "session",
    args: () => t("[title]", "[название]"),
    help: () => t("rename the current session", "переименовать текущую сессию"),
    async run(app, rest) {
      const given = rest.trim();
      const title = given || (await app.exclusiveInput(() => askLine("New title:", app.session.title)));
      if (title === null) return;
      app.session.rename(title);
      success(t(`Renamed to: ${app.session.title || "(untitled)"}`, `Переименована в: ${app.session.title || "(без названия)"}`));
    },
  },
  {
    name: "/brain",
    group: "main",
    args: () => t("<question> | models", "<вопрос> | models"),
    help: () =>
      t(
        "several models answer, read each other, and one writes the result",
        "несколько моделей отвечают, читают друг друга, одна сводит итог",
      ),
    async run(app, rest) {
      const arg = rest.trim();
      if (/^models?$/i.test(arg)) return void (await brainPanelModal(app));
      if (arg) {
        const panel = brainPanel(app);
        if (panel.length < 2) return void brainNeedsPanel();
        return void (await app.runBrain(arg, panel));
      }
      await brainModal(app);
    },
  },
  {
    name: "/subagents",
    group: "settings",
    args: () => t("[model [id]] | session | list | auto on/off", "[model [id]] | session | list | auto on/off"),
    help: () =>
      t(
        "helper models and auto on/off; auto off asks before the agent launches helpers",
        "модели помощников и авто on/off; при auto off самостоятельный запуск требует разрешения",
      ),
    async run(app, rest) {
      const arg = rest.trim();
      const automatic = /^auto(?:\s+(on|off))?$/i.exec(arg);
      if (automatic) {
        if (automatic[1]) return setSubagentAuto(app, automatic[1].toLowerCase() === "on");
        const enabled = loadConfig().subagentAuto?.[currentProviderId(app)] === true;
        return void info(t(`Subagent auto is ${enabled ? "on" : "off"}. /subagents auto on|off`,
          `Авто запуск субагентов ${enabled ? "включён" : "выключен"}. /subagents auto on|off`));
      }

      // /subagents model [id] — put one more model on the list without walking
      // the whole catalogue; without an id it falls through to the panel.
      if (/^models?\s+\S/i.test(arg)) {
        return void addSubagentModel(app, arg.replace(/^models?\s+/i, "").trim());
      }
      if (/^(session|reset|any|all)$/i.test(arg)) return void setSubagentMode(app, "session");
      if (/^lists?$/i.test(arg)) return void setSubagentMode(app, "list");
      await subagentsModal(app);
    },
  },
  {
    name: "/image",
    group: "main",
    args: () => t("[model id|off|status|refresh]", "[id модели|off|status|refresh]"),
    help: () =>
      t(
        "choose the model that draws images; the chat then calls it on request",
        "выбрать модель OpenRouter для рисования; дальше чат вызывает её по просьбе",
      ),
    async run(app, rest) {
      await mediaCommand(app, "image", rest);
    },
  },
  {
    name: "/audio",
    group: "main",
    args: () => t("[model id|off|status|refresh]", "[id модели|off|status|refresh]"),
    help: () =>
      t(
        "choose the model that speaks or makes music; the chat then calls it on request",
        "выбрать модель для озвучки и музыки; дальше чат вызывает её по просьбе",
      ),
    async run(app, rest) {
      await mediaCommand(app, "audio", rest);
    },
  },
  {
    name: "/video",
    group: "main",
    args: () => t("[on|off|status|model [id]|prompt_model [id]]", "[on|off|status|model [id]|prompt_model [id]]"),
    help: () =>
      t(
        "video mode: a text model writes the prompt, an OpenRouter model (Seedance…) makes the clip",
        "режим видео: текстовая модель пишет промпт, модель OpenRouter (Seedance…) делает ролик",
      ),
    async run(app, rest) {
      await videoCommand(app, rest);
    },
  },
  {
    name: "/prompt_model",
    group: "settings",
    args: () => t("[id|auto]", "[id|auto]"),
    help: () => t("choose the model that writes prompts here", "выбрать модель, которая пишет промпты"),
    async run(app, rest) {
      await chooseWriter(app, rest.trim());
    },
  },
  {
    name: "/prompt",
    group: "session",
    args: () => t("<task> | model [id] | off|command|auto", "<задача> | model [id] | off|command|auto"),
    help: () =>
      t(
        "a small model turns a short ask into a brief for the big one",
        "маленькая модель разворачивает короткий запрос в задание для большой",
      ),
    async run(app, rest) {
      const arg = rest.trim();
      const cfg = loadConfig();

      // /prompt off | command | auto — when the rewriting happens at all.
      if (/^(off|command|auto)$/i.test(arg)) {
        const mode = arg.toLowerCase() as "off" | "command" | "auto";
        saveConfig({ promptMode: mode });
        app.cfg = loadConfig();
        const said = {
          off: t("never rewritten", "не переписывать"),
          command: t("only when /prompt asks", "только по команде /prompt"),
          auto: t("a new task is rewritten before it is sent", "новая задача переписывается перед отправкой"),
        }[mode];
        return void success(t(`Prompt mode: ${mode} — ${said}`, `Режим промптов: ${mode} — ${said}`));
      }

      // /prompt model [id] — the writer for the provider in use.
      if (/^models?/i.test(arg)) {
        await chooseWriter(app, arg.replace(/^models?/i, "").trim());
        return;
      }

      // /prompt <task> — compose one now.
      const task = arg || (await app.exclusiveInput(() => askLine(t("What do you want done?", "Что нужно сделать?"), "")));
      if (!task) return;

      if (!(await ensureWriterChosen(app))) return;
      const written = await app.composePrompt(task);
      if (!written) return;

      line();
      padded(c.gray(t("— brief —", "— задание —")));
      // Wrapped, not printed raw: a brief is a paragraph, and the terminal
      // wraps at column zero — leaving every line but the first outside the
      // margin the rest of the transcript keeps.
      for (const l of wrapText(written, contentWidth() - 2)) padded(l);
      line();
      const action = await app.exclusiveInput(() =>
        choose<"send" | "edit" | "drop">(
          [
            { value: "send", label: t("Send", "Отправить"), key: "s", tone: "ok" },
            { value: "edit", label: t("Edit first", "Поправить"), key: "e" },
            { value: "drop", label: t("Discard", "Отменить"), key: "n", tone: "danger" },
          ],
          { initial: "send", fallback: "drop" },
        ),
      );
      if (action === "send") return void app.queue(written);
      if (action === "edit") app.prefill(written);
    },
  },
  {
    name: "/context",
    group: "session",
    args: "[<tokens>|auto]",
    help: () => t("how full the context window is", "насколько заполнено окно контекста"),
    async run(app, rest) {
      const arg = rest.trim().toLowerCase();
      if (arg) {
        // The catalog endpoint publishes no window sizes, so a wrong guess is
        // the user's to correct — and the correction has to outlive the
        // session, hence the config rather than a session field.
        if (arg === "auto" || arg === "reset") {
          const next = { ...loadConfig().contextWindows };
          delete next[app.session.model];
          saveConfig({ contextWindows: next }, { replace: ["contextWindows"] });
          hint(t(`${app.session.model}: back to the reported or assumed size.`, `${app.session.model}: снова размер из каталога или оценка.`));
        } else {
          const pinned = parseTokens(arg);
          if (!pinned) {
            return void error(t(`Not a token count: ${rest.trim()} (try 500k, 2m, 128000)`, `Не похоже на число токенов: ${rest.trim()} (например 500k, 2m, 128000)`));
          }
          saveConfig({ contextWindows: { [app.session.model]: pinned } });
          hint(t(`${app.session.model}: window pinned to ${fmtTokens(pinned)} tokens.`, `${app.session.model}: окно закреплено на ${fmtTokens(pinned)} токенов.`));
        }
        app.cfg = loadConfig();
        // Cached catalog, re-decorated: the pin applies without a round trip.
        app.catalog = await fetchModels();
      }
      const { used, window, ratio } = contextPressure(app.session, app.catalog);
      const m = findModel(app.session.model, app.catalog);
      const barWidth = Math.min(40, contentWidth() - 10);
      const filled = Math.min(barWidth, Math.round(ratio * barWidth));
      line();
      padded(c.brightCyan("█".repeat(filled)) + c.gray("░".repeat(barWidth - filled)) + ` ${Math.round(ratio * 100)}%`);
      hint(
        `~${fmtTokens(used)} of ${fmtTokens(window)} tokens · ${app.session.messages.length} ${plural(app.session.messages.length, "message", "messages")}` +
          (app.session.compactions ? ` · compactions: ${app.session.compactions}` : ""),
      );
      if (!m?.contextWindow) {
        hint(t(`The API does not report the window size — this is an estimate. Pin the real one with /context 500k.`, `API не сообщает размер окна — это оценка. Закрепить настоящий: /context 500k.`));
      }
      line();
    },
  },
  {
    name: "/debug",
    group: "session",
    args: "request",
    help: () => t("where the tokens of a request go, by section", "куда уходят токены запроса, по секциям"),
    async run(app, rest) {
      const sub = rest.trim().toLowerCase();
      if (sub !== "request" && sub !== "req") {
        error(t(`Usage: /debug request`, `Использование: /debug request`));
        return;
      }
      const system = buildSystemPrompt({ cwd: app.cwd, model: app.session.model, skills: app.activeSkills });
      const tools = app.toolList();
      let schemas = 0;
      for (const tool of tools) {
        schemas += estimateTokens(tool.name + tool.description) + 12;
        schemas += estimateTokens(JSON.stringify(tool.parameters));
      }
      const msgs = app.session.messages.filter((m) => !m.meta?.hidden);
      const byRole = new Map<string, number>();
      for (const m of msgs) {
        let n = estimateTokens(String(m.content ?? ""));
        for (const tc of m.tool_calls ?? []) n += estimateTokens(tc.function.arguments) + 12;
        const role = m.role === "tool" ? "tool results" : m.role === "assistant" ? "assistant" : m.meta?.skill ? "skill" : m.role;
        byRole.set(role, (byRole.get(role) ?? 0) + n);
      }
      const history = historyTokens(msgs);
      const { used, window } = contextPressure(app.session, app.catalog);
      line();
      const rows: [string, number][] = [
        ["system prompt", estimateTokens(system)],
        ["tool schemas", schemas],
        ...[...byRole.entries()].sort((a, b) => b[1] - a[1]),
      ];
      const labelW = Math.max(...rows.map(([k]) => k.length));
      for (const [label, n] of rows) {
        const pct = used ? Math.round((n / used) * 100) : 0;
        padded(`  ${c.gray(label.padEnd(labelW))}  ~${fmtTokens(n).padStart(7)}  ${c.gray(`${String(pct).padStart(3)}%`)}`);
      }
      padded(`  ${c.bold("history".padEnd(labelW))}  ~${c.bold(fmtTokens(history)).padStart(7)}  ${c.gray("of the window:")} ${fmtTokens(window)}`);
      hint(t("estimates (~3.6 chars/token); the real count is in the usage line after a turn.", "оценки (~3.6 симв./токен); точные числа — в строке usage после хода."));
      line();
    },
  },
  {
    name: "/cost",
    group: "session",
    help: () => t("session token usage by model", "расход токенов по моделям"),
    async run(app) {
      const rows = app.usage.all();
      const t = app.usage.totals();
      line();
      rule(c.brightCyan(" session tokens "));
      if (!rows.length) {
        hint("No requests yet.");
        line();
        return;
      }
      const row = (model: string, u: { requests: number; input: number; cached: number; output: number; reasoning: number }) =>
        `${model.padEnd(30)} ${String(u.requests).padStart(5)} ${fmtTokens(u.input).padStart(9)} ` +
        `${fmtTokens(Math.round(u.input / Math.max(1, u.requests))).padStart(9)} ` +
        `${(u.cached ? fmtTokens(u.cached) : "—").padStart(9)} ` +
        `${fmtTokens(u.output).padStart(9)} ${(u.reasoning ? fmtTokens(u.reasoning) : "—").padStart(10)}`;

      padded(
        c.gray(
          `${"model".padEnd(30)} ${"reqs".padStart(5)} ${"input".padStart(9)} ${"per req".padStart(9)} ` +
            `${"cached".padStart(9)} ${"output".padStart(9)} ${"reasoning".padStart(10)}`,
        ),
      );
      for (const r of rows) padded(row(r.model, r));
      // A rule under a table is structure, not commentary: it has to line up
      // with the columns, so it keeps the table's own margin.
      padded(c.gray("─".repeat(Math.min(85, contentWidth()))));
      padded(c.bold(row("total", t)));

      // Caching is the difference between paying for the history once and
      // paying for it on every step, so a flat zero is worth pointing at.
      if (t.cached && t.input) {
        hint(
          `${Math.round((t.cached / t.input) * 100)}% of all input came from the provider cache, billed at its discounted rate — ` +
            `${fmtTokens(t.input - t.cached)} of ${fmtTokens(t.input)} was fresh and paid for in full.`,
        );
      }
      // What the session actually costs to serve, and what a metered plan
      // counts: reading the cache is nearly free on both, so fresh input plus
      // output is the number to watch — and the one that says whether the
      // history is staying append-only.
      if (t.requests > 1) {
        const billable = t.input - t.cached + t.output;
        hint(
          `Fresh input + output: ${fmtTokens(billable)} over ${t.requests} requests ` +
            `(${fmtTokens(Math.round(billable / t.requests))} per request). ` +
            `That is the part a prompt cache cannot make cheaper.`,
        );
      }
      const anthropic = rows.some((r) => protocolFor(r.model) === "anthropic");
      if (anthropic && !t.cached && t.requests > 1) {
        hint(
          "Nothing came back cached. Either the host drops cache_control, or the prefix keeps changing" +
            (modelRejectsCache(app.session.model) ? " — this model rejected it and it is now off." : "."),
        );
      }
      if (t.reasoning > t.output * 0.5) {
        line();
        hint(
          "More than half the output is the model thinking. It is billed as output;" +
            " lower it with /effort medium or /effort low.",
        );
      }

      line();
    },
  },
  {
    name: "/stat",
    group: "session",
    help: () => t("usage by provider and model, with period filters", "расход по провайдерам и моделям, с фильтром по периоду"),
    async run(app) {
      await statModal(app);
    },
  },
  {
    name: "/trace",
    group: "session",
    args: () => "[n]",
    help: () => t("what the model was sent on each step: system, schemas, history, injected", "что уходило модели на каждом шаге: промпт, схемы, история, инъекции"),
    async run(app, rest) {
      const all = loadProjections(app.cwd, app.session.id);
      line();
      rule(c.brightCyan(" request trace "));
      if (!all.length) {
        hint(t(
          "No requests logged yet — projections appear after the first turn of this session.",
          "Запросов ещё не было — проекции появятся после первого хода этой сессии.",
        ));
        line();
        return;
      }
      const n = Math.max(1, Math.min(50, Number.parseInt(rest, 10) || 10));
      const rows = all.slice(-n);
      padded(
        c.gray(
          `${"step".padStart(4)} ${"time".padStart(8)} ${"system".padStart(8)} ${"schemas".padStart(8)} ` +
            `${"history".padStart(9)} ${"injected".padStart(9)} ${"trim→".padStart(7)} ${"cached".padStart(7)} ${"model"}`,
        ),
      );
      for (const p of rows) {
        const inj = p.injected.length ? fmtTokens(p.injected.reduce((s, i) => s + i.tokens, 0)) : "—";
        const time = new Date(p.ts).toTimeString().slice(0, 5);
        const cached = p.cachedTokens ? fmtTokens(p.cachedTokens) : "—";
        padded(
          `${String(p.step).padStart(4)} ${time.padStart(8)} ${fmtTokens(p.systemTokens).padStart(8)} ` +
            `${fmtTokens(p.schemaTokens).padStart(8)} ${fmtTokens(p.historyTokens).padStart(9)} ` +
            `${inj.padStart(9)} ${(p.trimmed ? `-${fmtTokens(p.trimSaved)}` : "—").padStart(7)} ` +
            `${cached.padStart(7)} ${c.gray(p.model)}`,
        );
      }
      // The injected column hides what it was; name it when there is anything.
      const sources = new Set(rows.flatMap((p) => p.injected.map((i) => i.source)));
      if (sources.size) hint(t(`Injected: ${[...sources].join(", ")}.`, `Инъекции: ${[...sources].join(", ")}.`));
      hint(t(
        "~estimates per request; history is what travelled after trim. /trace <n> for more steps.",
        "~оценки на запрос; history — то, что ушло после trim. /trace <n> — больше шагов.",
      ));
      line();
    },
  },
  {
    name: "/mcp",
    group: "session",
    args: () => "[reload]",
    help: () => t("MCP servers: status and tools", "MCP-серверы: статус и инструменты"),
    async run(app, rest) {
      if (rest.trim().toLowerCase() === "reload") {
        stopMcpServers();
        connectMcpServers(app.cwd, (client) => {
          app.rebuildTools();
          if (client.state === "ready") info(t(`MCP ${client.id}: ${client.tools.length} tools connected.`, `MCP ${client.id}: подключено инструментов: ${client.tools.length}.`));
          else warn(t(`MCP ${client.id} failed: ${client.detail}`, `MCP ${client.id} не подключился: ${client.detail}`));
        });
        app.rebuildTools();
        return info(t("Reconnecting MCP servers…", "Переподключаю MCP-серверы…"));
      }

      const clients = mcpClients();
      if (!clients.length) {
        info(t("No MCP servers configured.", "MCP-серверы не настроены."));
        hint(
          t(
            `Add one to ${configPath()} (or .trcode/mcp.json in the project):`,
            `Добавьте сервер в ${configPath()} (или .trcode/mcp.json проекта):`,
          ),
        );
        padded(c.dim(`  "mcpServers": { "tradingview": { "command": "npx", "args": ["-y", "<package>"] } }`));
        line();
        return;
      }

      line();
      rule(c.brightCyan(" mcp "));
      for (const cl of clients) {
        const state =
          cl.state === "ready"
            ? c.green("ready")
            : cl.state === "starting"
              ? c.yellow("starting")
              : c.red(cl.state);
        const extra =
          cl.state === "ready"
            ? c.gray(` · ${count(cl.tools.length, ["tool", "tools"], ["инструмент", "инструмента", "инструментов"])}${cl.detail ? ` · ${cl.detail}` : ""}`)
            : c.gray(cl.detail ? ` · ${truncate(cl.detail, 80)}` : "");
        padded(`${cl.id.padEnd(20)} ${state}${extra}`);
        if (cl.state === "ready" && cl.tools.length) {
          const names = cl.tools.map((t2) => t2.name);
          padded(c.dim("  " + truncate(names.join(", "), contentWidth() - 4)));
        }
      }
      const total = clients.reduce((n, cl) => n + (cl.state === "ready" ? cl.tools.length : 0), 0);
      if (total > 20) {
        hint(
          t(
            `${total} tool schemas ride along in every request. Trim a server with "tools": ["name", …] in its config.`,
            `Схемы всех ${total} инструментов едут в каждом запросе. Урежьте сервер через "tools": ["имя", …] в его конфиге.`,
          ),
        );
      }
      line();
    },
  },
  {
    name: "/reasoning",
    group: "session",
    help: () => t("show the last turn's full reasoning", "полные размышления последнего хода"),
    async run(app) {
      const text = app.lastReasoning.trim();
      if (!text) return info(t("The last turn had no reasoning to show.", "В последнем ходе не было размышлений."));
      line();
      rule(c.brightCyan(t(" reasoning ", " размышления ")));
      for (const l of text.split("\n")) {
        if (!l.trim()) {
          line();
          continue;
        }
        for (const w of wrapText(l, contentWidth() - 2)) padded(c.dim(w));
      }
      line();
    },
  },

  // ── settings ────────────────────────────────────────────────────────────
  {
    name: "/default",
    group: "settings",
    args: () => t("[name|alias]", "[имя|алиас]"),
    help: () => t("pin the default model", "закрепить модель по умолчанию"),
    async run(app, rest) {
      const cfg = loadConfig();
      const target = rest.trim() ? resolveModelId(rest.trim(), app.catalog) : app.session.model;
      if (target === cfg.model) return info(t(`The default model is already ${c.brightYellow(target)}.`, `Модель по умолчанию уже ${c.brightYellow(target)}.`));
      saveConfig({ model: target });
      app.cfg = loadConfig();
      app.session.model = target;
      app.rebuildTools();
      app.session.save();
      success(t(`Default model: ${c.brightYellow(target)}`, `Модель по умолчанию: ${c.brightYellow(target)}`));
      hint(`Written to ${configPath()}. Applies to this session too.`);
    },
  },
  {
    name: "/aliases",
    group: "settings",
    help: () => t("short names for models", "короткие имена моделей"),
    async run() {
      const cfg = loadConfig();
      line();
      for (const [k, v] of Object.entries(cfg.aliases)) padded(`${c.brightGreen(k.padEnd(10))} → ${v}`);
      line();
      hint(`Edit them in ${configPath()} → "aliases".`);
    },
  },
  {
    name: "/permissions",
    group: "settings",
    args: () => t("[class] [ask|allow|deny]", "[класс] [ask|allow|deny]"),
    help: () => t("confirmation rules", "правила подтверждений"),
    async run(_app, rest) {
      const cfg = loadConfig();
      const [risk, mode] = rest.trim().split(/\s+/);
      if (!risk) {
        line();
        for (const [k, v] of Object.entries(cfg.permissions)) {
          const color = v === "allow" ? c.green : v === "deny" ? c.red : c.yellow;
          padded(`${k.padEnd(10)} ${color(v)}`);
        }
        line();
        hint("Change with: /permissions shell allow");
        return;
      }
      if (!["read", "write", "shell", "network", "agent"].includes(risk)) return error(t(`Unknown class: ${risk}`, `Неизвестный класс: ${risk}`));
      if (!["ask", "allow", "deny"].includes(mode)) return error(t("Mode must be ask, allow or deny", "Режим должен быть ask, allow или deny"));
      saveConfig({ permissions: { ...cfg.permissions, [risk]: mode } as any });
      success(`${risk} → ${mode}`);
    },
  },
  {
    name: "/login",
    group: "settings",
    args: () => t("[provider] [url]", "[поставщик] [url]"),
    help: () => t("connect a provider — the one in use unless another is named", "подключить поставщика — текущего, если не указан другой"),
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      // A host can be given straight away — `/login alibabacloud https://…` —
      // for the providers whose endpoint is per-account.
      const baseUrl = parts.find((p) => /^https?:\/\//i.test(p));
      const name = (parts.find((p) => p !== baseUrl) ?? "").toLowerCase();
      // Unnamed means the provider being used: asking for a TokenRouter key
      // while the session runs on Kimi answers a question nobody asked.
      const def = name ? providerById(name) : providerById(currentProviderId(app));
      if (!def) {
        return error(t(`Unknown provider: ${name}. Available: ${providers().map((p) => p.id).join(", ")}`, `Неизвестный поставщик: ${name}. Доступны: ${providers().map((p) => p.id).join(", ")}`));
      }

      // A third-party provider goes through the shared flow, which may need
      // the keyboard for a device code — hence exclusiveInput.
      if (def.id !== DEFAULT_PROVIDER) {
        const res = await loginProvider(def, { baseUrl, exclusive: (fn) => app.exclusiveInput(fn) });
        if (!res.connected) return;
        app.cfg = loadConfig();
        app.catalog = await fetchModels({ force: true });
        app.rebuildTools();
        return;
      }

      const key = await app.exclusiveInput(() => askSecret(`  ${def.keyHint}: `));
      if (!key) return warn(t("Cancelled.", "Отменено."));
      const cfg = loadConfig();
      const sp = new Spinner("verifying the key");
      sp.start();
      const check = await verifyKey(cfg.baseUrl, key);
      sp.stop();
      if (!check.ok) return error(t(`Key rejected: ${check.detail}`, `Ключ отклонён: ${check.detail}`));
      saveConfig({ apiKey: key });
      app.cfg = loadConfig();
      app.catalog = await fetchModels({ force: true });
      app.rebuildTools();
      success(t(`Key saved to ${configPath()} — ${check.detail}`, `Ключ сохранён в ${configPath()} — ${check.detail}`));
      if (providers().length > 1) {
        hint(`Other providers: ${providers().filter((p) => p.id !== DEFAULT_PROVIDER).map((p) => `/login ${p.id}`).join(", ")}`);
      }
    },
  },
  {
    name: "/settings",
    group: "settings",
    help: () => t("status line fields, update checks", "поля строки состояния, проверка обновлений"),
    async run(app) {
      await app.exclusiveInput(() => settingsModal(app));
    },
  },
  {
    name: "/update",
    group: "settings",
    help: () => t("update to the latest GitHub release", "обновиться до последнего релиза с GitHub"),
    async run(app) {
      await runUpdate(app);
    },
  },
  {
    name: "/config",
    group: "settings",
    help: () => t("current configuration", "текущая конфигурация"),
    async run(app) {
      const cfg = loadConfig();
      const shown = { ...cfg, apiKey: cfg.apiKey ? cfg.apiKey.slice(0, 6) + "…" + cfg.apiKey.slice(-4) : null };
      line();
      hint(configPath());
      for (const l of JSON.stringify(shown, null, 2).split("\n")) padded(c.dim(l));
      line();
      hint(`Directory: ${app.cwd}`);
    },
  },
  {
    name: "/cwd",
    group: "settings",
    args: () => t("[path]", "[путь]"),
    help: () => t("change the working directory", "сменить рабочий каталог"),
    async run(app, rest) {
      if (!rest.trim()) return info(app.cwd);
      const next = path.resolve(app.cwd, rest.trim());
      try {
        process.chdir(next);
      } catch (err) {
        return error(t(`Failed: ${(err as Error).message}`, `Не вышло: ${(err as Error).message}`));
      }
      app.cwd = next;
      app.readFiles.clear();
      app.reloadHistory();
      app.rebuildTools();
      // The workspace listing is snapshotted per directory; a new one is due.
      resetPromptSnapshots();
      success(t(`Working directory: ${next}`, `Рабочий каталог: ${next}`));
    },
  },

  // ── other ───────────────────────────────────────────────────────────────
  {
    name: "/keys",
    group: "other",
    help: () => t("show what the terminal sends; pin your own newline key", "показать, что шлёт терминал; закрепить свою клавишу переноса"),
    async run(app) {
      const seen = await app.exclusiveInput(() => scanKeys());
      line();
      if (!seen.length) {
        warn(t("The terminal sent nothing at all.", "Терминал не прислал вообще ничего."));
        hint("It most likely swallows those combinations as its own shortcuts — the CLI never sees them.");
        hint("Use Ctrl+Enter, Alt+Enter, or a trailing backslash instead.");
        return;
      }

      // Anything that is not already a newline key is a candidate to become one.
      const candidates = seen.filter(
        (k) => !k.meaning.startsWith("insert a newline") && k.raw !== "\r" && k.raw.length > 1,
      );
      if (!candidates.length) {
        success(t("Every key you pressed is already recognised.", "Все нажатые клавиши уже распознаются."));
        return;
      }

      const last = candidates[candidates.length - 1];
      const chosen = await app.exclusiveInput(() =>
        pick({
          title: "Pin this as a newline key?",
          items: [
            { value: last.raw, label: last.readable.padEnd(22), hint: c.gray(last.hex) },
            { value: "", label: "do not pin".padEnd(22), hint: "" },
          ],
        }),
      );
      if (!chosen) return;

      const cfg = loadConfig();
      const keys = [...new Set([...(cfg.newlineKeys ?? []), chosen])];
      saveConfig({ newlineKeys: keys });
      setExtraNewlineKeys(keys);
      app.cfg = loadConfig();
      success(t("Pinned — that combination now inserts a newline.", "Закреплено — это сочетание теперь переносит строку."));
      hint(`Written to ${configPath()} → "newlineKeys".`);
    },
  },
  {
    name: "/tools",
    group: "other",
    help: () => t("tools available to the model", "инструменты, доступные модели"),
    async run(app) {
      line();
      for (const t of app.toolList()) {
        const risk = t.risk === "shell" ? c.red(t.risk) : t.risk === "write" ? c.yellow(t.risk) : c.gray(t.risk);
        padded(`${c.bold(t.name.padEnd(10))} ${risk.padEnd(16)} ${c.dim(truncate(t.description, contentWidth() - 32))}`);
      }
      line();
    },
  },
  {
    name: "/skills",
    group: "other",
    args: () => t("[on | off | new <name> [description] | gen <task> | edit <name> | auto [on|off] | global]", "[on | off | new <имя> [описание] | gen <задача> | edit <имя> | auto [on|off] | global]"),
    help: () => t("skills: turn on/off, list, create, edit", "навыки: включить/выключить, список, создание, правка"),
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (sub === "on" || sub === "off") {
        setSkillsEnabled(app, sub === "on");
        if (sub === "on") hint(t("Off again with: /skills off.", "Выключить обратно: /skills off."));
        return;
      }

      if (sub === "new") {
        const global = parts.includes("global");
        const args = parts.slice(1).filter((p) => p !== "global");
        const name = args[0];
        if (!name) return error(t("Name it: /skills new code-review [description]", "Дайте имя: /skills new code-review [описание]"));
        const { file, existed } = createSkill({
          cwd: app.cwd,
          name,
          description: args.slice(1).join(" "),
          scope: global ? "user" : "project",
        });
        app.rebuildTools();
        if (existed) warn(t(`That skill already exists: ${file}`, `Такой навык уже есть: ${file}`));
        else success(t(`Created ${file}`, `Создан ${file}`));
        hint("Open the file and write the procedure. The description line is what matters:");
        hint("the model decides whether to load the skill from it.");
        hint(`Edit it with: /skills edit ${name}`);
        return;
      }

      if (sub === "edit") {
        await editSkill(app, parts[1] ?? null);
        return;
      }

      if (sub === "auto") {
        const want = parts[1]?.toLowerCase();
        if (want && !["on", "off"].includes(want)) return error(t("Use: /skills auto [on|off]", "Использование: /skills auto [on|off]"));
        if (want) {
          app.cfg = saveConfig({ skillAuto: want === "on" });
          success(t(`Skill auto-selection ${want}.`, `Автовыбор навыков: ${want}.`));
        } else {
          info(t(`Skill auto-selection is ${app.cfg.skillAuto === false ? "off" : "on"}.`, `Автовыбор навыков ${app.cfg.skillAuto === false ? "выключен" : "включён"}.`));
        }
        const withTriggers = app.skills.filter((s) => s.auto && s.triggers.length).length;
        hint(
          `${withTriggers} of ${app.skills.length} skills carry trigger words; the rest wait for the model to pick them.`,
        );
        hint(
          t(
            "Matching runs on the request and again at every step of a turn, so a procedure still arrives when the work turns towards it.",
            "Совпадение ищется и в запросе, и на каждом шаге хода — процедура успевает прийти, когда работа сворачивает к ней.",
          ),
        );
        return;
      }

      if (sub === "gen") {
        const task = parts.slice(1).join(" ");
        if (!task) return error(t("Describe the task: /skills gen review pull requests", "Опишите задачу: /skills gen ревью пул-реквестов"));
        await app.turn(skillGenPrompt(task));
        app.rebuildTools();
        return;
      }

      await skillsModal(app);
    },
  },
  {
    name: "/preset",
    group: "other",
    args: () => t("[standard | minimal]", "[standard | minimal]"),
    help: () => t("tool set for this session: full or just shell+edit", "набор инструментов сессии: полный или только shell+edit"),
    async run(app, rest) {
      const want = rest.trim().toLowerCase();
      if (want && !["standard", "minimal"].includes(want)) {
        return error(t("Use: /preset standard | minimal", "Использование: /preset standard | minimal"));
      }
      const target = (want || "standard") as "standard" | "minimal";
      if (!want) {
        info(
          t(
            `Preset: ${app.preset}. /preset minimal keeps only shell and edit; /preset standard brings everything back.`,
            `Пресет: ${app.preset}. /preset minimal оставляет только shell и edit; /preset standard возвращает всё.`,
          ),
        );
        return;
      }
      if (target === app.preset) {
        return info(t(`Already on ${target}.`, `Уже включён ${target}.`));
      }
      app.presetOverride = target;
      // The preset decides both halves of a request: the tool list and the
      // base prompt. Both changed, so the cached prefix is void either way —
      // saying it beats the user wondering why the next request billed fresh.
      app.rebuildTools();
      resetPromptSnapshots();
      app.session.save();
      if (target === "minimal") {
        success(t("Minimal preset: two tools (shell, edit) and a short prompt.", "Минимальный пресет: два инструмента (shell, edit) и короткий промпт."));
        hint(t("Back with: /preset standard", "Вернуть: /preset standard"));
      } else {
        success(t("Standard preset: the full tool set and prompt are back.", "Стандартный пресет: полный набор инструментов и промпт возвращены."));
      }
      warn(t("The prompt changed — the next request rebuilds the cache from scratch.", "Промпт сменился — следующий запрос соберёт кэш заново."));
    },
  },
  {
    name: "/memory",
    group: "other",
    args: () => t("[on | off | show]", "[on | off | показать]"),
    help: () => t("project memory: on/off, show what is remembered", "память проекта: вкл/выкл, что запомнено"),
    async run(app, rest) {
      const sub = rest.trim().toLowerCase();
      const file = memoryPath(app.cwd);
      const enabled = loadConfig().memoryEnabled !== false;

      if (sub === "on" || sub === "off") {
        app.cfg = saveConfig({ memoryEnabled: sub === "on" });
        app.rebuildTools();
        resetPromptSnapshots();
        if (sub === "on") {
          success(t("Project memory is on — facts go to .trcode/memory.md and ride in the prompt.", "Память проекта включена — факты пишутся в .trcode/memory.md и едут в промпте."));
          hint(t(`Off again with: /memory off`, `Выключить обратно: /memory off`));
        } else {
          success(t("Project memory is off — the section and the tool leave the session.", "Память проекта выключена — секция и тулз memory уходят из сессии."));
        }
        return;
      }

      if (sub === "show" || sub === "list") {
        const facts = memoryCount(app.cwd) ? fs.readFileSync(file, "utf8").trim() : "";
        if (!facts) return info(t("Memory is empty.", "Память пуста."));
        line();
        for (const l of renderMarkdownBlock(facts)) padded(l);
        return;
      }

      // Bare `/memory` is a settings screen: state, where the file lives,
      // and a button row — the way it is reached most often.
      line();
      padded(c.bold(t("Project memory", "Память проекта")));
      info(
        enabled
          ? t("On — remembered facts join every request.", "Включена — запомненные факты добавляются к каждому запросу.")
          : t("Off — nothing is remembered or shown.", "Выключена — ничего не запоминается и не показывается."),
      );
      hint(`${file} · ${t("facts:", "фактов:")} ${memoryCount(app.cwd)}`);
      hint(t("The agent saves durable project facts there itself (the memory tool).", "Агент сам записывает туда прочные факты о проекте (тулз memory)."));
      if (!process.stdin.isTTY) return hint(t("Toggle with: /memory on | /memory off", "Переключить: /memory on | /memory off"));

      const answer = await app.exclusiveInput(() =>
        choose<"toggle" | "show">(
          [
            {
              value: "toggle",
              label: enabled ? t("Turn off", "Выключить") : t("Turn on", "Включить"),
              key: "o",
              tone: enabled ? "warn" : "ok",
            },
            { value: "show", label: t("Show", "Показать"), key: "s" },
          ],
          { initial: "toggle", fallback: "toggle", hint: t("←/→ · Enter to confirm", "←/→ · Enter — подтвердить") },
        ),
      );
      if (answer === "toggle") return this.run(app, enabled ? "off" : "on");
      if (answer === "show") return this.run(app, "show");
    },
  },
  {
    name: "/todo",
    group: "other",
    help: () => t("current plan", "текущий план"),
    async run(app) {
      line();
      line(app.todo.render());
      line();
    },
  },
  {
    name: "/init",
    group: "other",
    help: () => t("write AGENTS.md from the repository", "написать AGENTS.md по репозиторию"),
    async run(app) {
      await app.turn(
        "Study this repository and write AGENTS.md at its root — a short briefing for an agent working here. " +
          "Cover: what the project is, the stack, the directory layout, the build/test/lint commands (taken from real files, not invented), " +
          "and the conventions the code follows. Write densely, no filler, under 60 lines. If AGENTS.md already exists, update it.",
      );
    },
  },
  {
    name: "/clear",
    group: "other",
    help: () => t("clear the screen", "очистить экран"),
    async run(app) {
      app.repaintHeader({ clear: true });
    },
  },
  {
    name: "/version",
    group: "other",
    help: () => t("version", "версия"),
    async run() {
      info(`trcode ${VERSION} · node ${process.version} · ${process.platform}`);
    },
  },
  {
    name: "/help",
    group: "other",
    help: () => t("full help", "полная справка"),
    async run() {
      line();
      rule(c.brightCyan(" commands "));
      for (const g of GROUP_ORDER) {
        const inGroup = COMMANDS.filter((cmd) => cmd.group === g);
        if (!inGroup.length) continue;
        line();
        padded(c.bold(c.brightBlue(g.toUpperCase())));
        for (const cmd of inGroup) {
          const label = `${cmd.name}${cmd.args ? " " + txt(cmd.args) : ""}`;
          padded(`  ${c.bold(label.padEnd(34))} ${c.gray(txt(cmd.help))}`);
        }
      }
      line();
      hint("Plain text is a task for the agent.");
      hint("Shift+Tab turns confirmations off and on again.");
      hint("Ctrl+Enter inserts a newline (so does a trailing backslash).");
      hint("Esc interrupts the current turn. Ctrl+C exits.");
      line();
    },
  },
  {
    name: "/exit",
    group: "other",
    help: () => t("exit", "выход"),
    async run() {
      return false;
    },
  },
];

const ALIASES: Record<string, string> = {
  "/quit": "/exit",
  "/q": "/exit",
  "/?": "/help",
  "/h": "/help",
  "/orch": "/orchestrate",
  // The word is spelled one way and typed another. A command nobody can hit
  // first time is a command with a tax on it.
  "/promt": "/prompt",
  "/promt_model": "/prompt_model",
  "/promptmodel": "/prompt_model",
  "/promtmodel": "/prompt_model",
};

export function commandNames(): string[] {
  return [...COMMANDS.map((cmd) => cmd.name), ...Object.keys(ALIASES)].sort();
}

/**
 * Rows for the editor dropdown. Opens on a leading "/" and stays open only
 * while the first word is still being typed.
 */
export function commandSuggestions(buffer: string): { value: string; hint: string }[] {
  if (!buffer.startsWith("/")) return [];
  if (/\s/.test(buffer)) return [];
  const q = buffer.toLowerCase();
  const ordered = GROUP_ORDER.flatMap((g) => COMMANDS.filter((cmd) => cmd.group === g));
  return ordered
    .filter((cmd) => cmd.name.startsWith(q))
    .map((cmd) => ({ value: cmd.name, hint: cmd.args ? `${txt(cmd.args)}  —  ${txt(cmd.help)}` : txt(cmd.help) }));
}

export function isCommand(text: string): boolean {
  return text.startsWith("/");
}

/** Compact grouped listing shown when the user types just "/". */
export function printCommandIndex(): void {
  line();
  padded(c.bold(t("Commands", "Команды")) + c.gray(t("   /help for details", "   /help — подробно")));
  for (const g of GROUP_ORDER) {
    const names = COMMANDS.filter((cmd) => cmd.group === g).map((cmd) => cmd.name);
    if (!names.length) continue;
    padded(c.gray(groupLabel(g).padEnd(11)) + names.map((n) => c.brightCyan(n)).join(c.gray(" · ")));
  }
  line();
}

/** Returns false when the REPL should exit. */
export async function runCommand(app: App, text: string): Promise<boolean> {
  if (text.trim() === "/") {
    printCommandIndex();
    return true;
  }
  const space = text.indexOf(" ");
  const rawName = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : text.slice(space + 1);
  const name = ALIASES[rawName] ?? rawName;

  const cmd = COMMANDS.find((x) => x.name === name);
  if (!cmd) {
    const near = commandNames().filter((n) => n.startsWith(rawName.slice(0, 3)));
    error(t(`Unknown command ${rawName}${near.length ? ` — did you mean: ${near.join(", ")}` : ""}`, `Неизвестная команда ${rawName}${near.length ? ` — возможно: ${near.join(", ")}` : ""}`));
    return true;
  }
  const res = await cmd.run(app, rest);
  return res !== false;
}
