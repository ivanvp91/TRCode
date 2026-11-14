/** /hooks and /commands: what this project has wired into the session. */
import fs from "node:fs";
import path from "node:path";
import { c } from "../ansi.js";
import { hint, line, padded, success } from "../render.js";
import { configPath } from "../../config.js";
import { hooksDisabled, hookSettings, projectSettingsPath, resetHookSettings, trustProjectHooks } from "../../hooks.js";
import { customCommandDirs, discoverCustomCommands, resetCustomCommandCache } from "./custom.js";
import { t } from "../../i18n.js";
import type { App } from "../repl.js";

/**
 * Lifecycle hooks, the turn notification and the files they came from. This is
 * the whole debugging story for a hook that does not seem to fire: the list is
 * what is in force, and the source line says which file won.
 */
export async function hooksCommand(app: App, rest: string): Promise<boolean | void> {
  if (rest.trim() === "reload") {
    resetHookSettings();
    resetCustomCommandCache();
    return success(t("Hooks and command files re-read.", "Хуки и файлы команд перечитаны."));
  }
  if (rest.trim() === "trust") {
    const trusted = trustProjectHooks(app.cwd);
    if (!trusted.ok) return hint(t("There are no project hooks to trust.", "В проекте нет хуков, которым можно доверять."));
    return success(t("Project hooks enabled: {count}.", "Хуки проекта включены: {count}.", { count: trusted.count }));
  }
  if (hooksDisabled()) {
    return hint(t("Hooks are disabled here by TRCODE_NO_HOOKS.", "Здесь хуки выключены переменной TRCODE_NO_HOOKS."));
  }
  const settings = hookSettings(app.cwd);
  const project = projectSettingsPath(app.cwd);
  const events = Object.entries(settings.hooks);
  line();
  padded(c.bold(t("Hooks and notifications", "Хуки и уведомления")));
  if (settings.pending) {
    padded(c.brightYellow(t("Not trusted yet", "Ещё не одобрены")));
    hint(
      t(
        "{file} defines {count} hooks. They run commands on this machine — /hooks trust enables them.",
        "{file} определяет хуков: {count}. Они запускают команды на этой машине — включить: /hooks trust.",
        { file: path.relative(app.cwd, settings.pending.file) || settings.pending.file, count: settings.pending.count },
      ),
    );
  }
  if (!events.length && !settings.notify.length) {
    padded(c.gray(t("Nothing configured.", "Ничего не настроено.")));
    line();
    hint(
      t(
        "Add hooks to {project} (committed with the repo) or to {global} under \"hooks\".",
        "Хуки кладутся в {project} (вместе с репозиторием) или в {global} в ключ \"hooks\".",
        { project: path.relative(app.cwd, project) || project, global: configPath() },
      ),
    );
    hint(
      t(
        'Example: {"hooks": {"PostToolUse": [{"matcher": "edit", "command": "npm run lint --silent"}]}}',
        'Пример: {"hooks": {"PostToolUse": [{"matcher": "edit", "command": "npm run lint --silent"}]}}',
      ),
    );
    line();
    return;
  }
  for (const [event, defs] of events) {
    padded(c.brightYellow(event));
    for (const def of defs) {
      const matcher = def.matcher ? c.gray(`  [${def.matcher}]`) : "";
      padded(`  ${def.command}${matcher}`);
    }
  }
  if (settings.notify.length) {
    padded(c.brightYellow("notify"));
    padded(`  ${settings.notify.join(" ")}`);
  }
  line();
  hint(t("Sources: {files}", "Источники: {files}", { files: settings.sources.map((p) => path.relative(app.cwd, p) || p).join(", ") }));
  line();
}

/** The project's own slash commands — files, not built-ins. */
export async function commandsListCommand(app: App, rest: string): Promise<boolean | void> {
  if (rest.trim() === "reload") {
    resetCustomCommandCache();
    return success(t("Command files re-read.", "Файлы команд перечитаны."));
  }
  const list = discoverCustomCommands(app.cwd);
  const dir = customCommandDirs(app.cwd)[0];
  line();
  padded(c.bold(t("Custom commands", "Свои команды")));
  if (!list.length) {
    padded(c.gray(t("None.", "Нет.")));
    line();
    hint(
      t(
        "A markdown file in {dir} becomes a command: frontmatter \"description:\" and the prompt as the body.",
        "Markdown-файл в {dir} становится командой: в frontmatter \"description:\", в теле — промпт.",
        { dir: path.relative(app.cwd, dir) || dir },
      ),
    );
    line();
    return;
  }
  for (const cmd of list) {
    padded(`${c.brightCyan(cmd.name.padEnd(18))} ${cmd.description}`);
    padded(c.gray(`  ${path.relative(app.cwd, cmd.file) || cmd.file}`));
  }
  line();
  hint(t('"$ARGUMENTS" is what you type after the name; !`cmd` is replaced by its output.', '"$ARGUMENTS" — то, что набрано после имени; !`cmd` заменяется выводом команды.'));
  line();
}

/** Nearby names for the unknown-command hint: built-ins and files alike. */
export function customCommandNames(cwd: string): string[] {
  return discoverCustomCommands(cwd).map((cmd) => cmd.name);
}

/**
 * Project settings are read from a file the repository owns, so they may only
 * add hooks and override the notification — never permissions, a model or an
 * endpoint. A file that tries more is reported once at startup, because
 * silence would look like the setting had simply not worked.
 */
export function checkProjectSettings(cwd: string): { warning?: string; hint?: string } {
  const file = projectSettingsPath(cwd);
  let body: string;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const extra = Object.keys(parsed).filter((k) => !["hooks", "notify", "$schema"].includes(k));
    if (!extra.length) return {};
    return {
      hint: t(
        "Project settings ignore {keys} — only hooks and notify are read from a repository.",
        "Проектные настройки не читают {keys} — из репозитория берутся только hooks и notify.",
        { keys: extra.join(", ") },
      ),
    };
  } catch (err) {
    return { warning: t("Ignoring {file}: {reason}", "Пропускаю {file}: {reason}", { file, reason: (err as Error).message }) };
  }
}
