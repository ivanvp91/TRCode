/** /skills: list, toggle, create and edit skills. */
import path from "node:path";
import { spawn } from "node:child_process";
import { c } from "../ansi.js";
import { contentWidth } from "../layout.js";
import { error, hint, info, line, success, truncate, warn } from "../render.js";
import { openModal, type PickerItem } from "../picker.js";
import { askLine } from "../prompt.js";
import { loadConfig, saveConfig } from "../../config.js";
import { createSkill, validateSkill } from "../../skills/loader.js";
import { t } from "../../i18n.js";
import type { App } from "../repl.js";

// ── /skills ───────────────────────────────────────────────────────────────

/** Opens a file in the user's editor, or names it when there is none set. */
export async function openInEditor(app: App, file: string): Promise<boolean> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    info(file);
    hint(t("EDITOR is not set — open the file in your own editor.", "EDITOR не задан — откройте файл своим редактором."));
    return false;
  }
  await app.exclusiveInput(
    () =>
      new Promise<void>((resolve) => {
        const child = spawn(editor, [file], { stdio: "inherit" });
        child.on("close", () => resolve());
        child.on("error", (err: Error) => {
          error(t(`Could not launch ${editor}: ${err.message}`, `Не удалось запустить ${editor}: ${err.message}`));
          resolve();
        });
      }),
  );
  return true;
}

export function setSkillsEnabled(app: App, on: boolean): void {
  app.cfg = saveConfig({ skillsEnabled: on });
  app.rebuildTools();
  if (on) {
    success(
      t(
        "Skills are on — the catalog and the skill tool join every request.",
        "Навыки включены — каталог и тулз skill добавляются в каждый запрос.",
      ),
    );
  } else {
    success(
      t(
        "Skills are off — they no longer cost tokens on requests.",
        "Навыки выключены — они больше не тратят токены в запросах.",
      ),
    );
  }
}

export async function editSkill(app: App, name: string | null): Promise<boolean> {
  const skill = app.skills.find((s) => s.name === name);
  if (!skill) {
    error(t(`Skill not found: ${name ?? "(no name given)"}`, `Навык не найден: ${name ?? "(имя не указано)"}`));
    return false;
  }
  const opened = await openInEditor(app, path.join(skill.dir, "SKILL.md"));
  app.rebuildTools();
  if (opened) success(t("Skills reloaded.", "Навыки перечитаны."));
  return opened;
}

/** The brief the agent is handed when it writes a skill for a task. */
export function skillGenPrompt(task: string): string {
  return (
    `Write a trcode skill for this task: "${task}".\n\n` +
    `A skill is a folder .trcode/skills/<name>/SKILL.md with frontmatter:\n` +
    `---\nname: <short-name>\ndescription: <WHEN to apply it, one sentence>\n` +
    `triggers: <comma-separated words a user would type for this, in every language they work in>\n---\n\n` +
    `The description is what the model chooses by, and it is sent with every request: one sentence saying WHEN to apply ` +
    `the skill ("when asked to …"), with the phrases a user would say, and what it is NOT for. ` +
    `Name: lowercase letters, digits and hyphens, the same as the folder.\n` +
    `Study the repository first so the procedure rests on this project's real commands and files ` +
    `rather than generalities. The body is a concrete procedure, what not to do, and the answer format. ` +
    `Keep it under 50 lines. Detail that is only sometimes needed goes to references/<file>.md, code worth running ` +
    `rather than retyping to scripts/, templates to assets/ — and the body names each file and when to open it. ` +
    `Create the files with write.`
  );
}

/**
 * /skills check: what would keep each skill from firing. Returns how many
 * skills have problems, so a caller can stay quiet when there are none.
 */
export function checkSkills(app: App, name?: string, quietWhenClean = false): number {
  const list = name ? app.skills.filter((s) => s.name === name) : app.skills;
  if (name && !list.length) {
    error(t(`Skill not found: ${name}`, `Навык не найден: ${name}`));
    return 0;
  }
  let bad = 0;
  for (const s of list) {
    const problems = validateSkill(s, app.skills);
    if (!problems.length) continue;
    bad++;
    warn(`${s.name} ${c.gray(`(${s.scope})`)}`);
    for (const p of problems) hint(`  · ${p}`);
  }
  if (!bad && !quietWhenClean) {
    success(t(`${list.length} skill(s) checked — nothing to fix.`, `Проверено навыков: ${list.length} — править нечего.`));
  }
  return bad;
}

export async function skillsModal(app: App): Promise<void> {
  for (;;) {
    app.rebuildTools();
    const cfg = loadConfig();
    const enabled = cfg.skillsEnabled === true;
    const autoOn = cfg.skillAuto !== false;
    const withTriggers = app.skills.filter((s) => s.auto && s.triggers.length).length;

    const items: PickerItem[] = app.skills.map((s) => ({
      value: s.name,
      label:
        (enabled && autoOn && s.auto && s.triggers.length ? c.brightYellow("⚡ ") : "  ") + s.name.padEnd(22),
      hint:
        (s.scope === "project" ? c.brightGreen("project") : c.gray("global")) +
        (enabled && app.loadedSkills.has(s.name) ? c.green(" ·loaded") : ""),
      badge: truncate(s.description, Math.max(20, contentWidth() - 58)),
    }));

    const res = await app.exclusiveInput(() =>
      openModal({
        title: t("Skills", "Навыки"),
        subtitle: enabled
          ? t(
              `On · ${withTriggers} of ${app.skills.length} fire on their own trigger words (⚡, auto-selection ${autoOn ? "on" : "off"}) · Enter edits`,
              `Включены · ${withTriggers} из ${app.skills.length} срабатывают по своим словам (⚡, автовыбор ${autoOn ? "вкл" : "выкл"}) · Enter — правка`,
            )
          : t(
              "Off — nothing about them is sent with requests, so they cost nothing.",
              "Выключены — в запросы ничего не отправляется, и они ничего не стоят.",
            ),
        items,
        empty: t("No skills yet — create one, or let the agent write it.", "Навыков пока нет — создайте или попросите агента."),
        actions: [
          {
            id: "toggle",
            label: enabled ? t("Turn off", "Выключить") : t("Turn on", "Включить"),
            hotkey: "t",
            tone: enabled ? "warn" : "ok",
          },
          {
            id: "auto",
            label: autoOn ? t("Auto-select off", "Автовыбор выкл") : t("Auto-select on", "Автовыбор вкл"),
            hotkey: "u",
            disabled: !enabled,
          },
          { id: "new", label: t("New…", "Создать…"), hotkey: "n" },
          { id: "edit", label: t("Edit", "Править"), hotkey: "e", disabled: !app.skills.length },
          { id: "gen", label: t("Generate…", "Сгенерировать…"), hotkey: "g" },
        ],
      }),
    );
    if (!res) return;

    if (res.kind === "item") {
      await editSkill(app, res.value);
      continue;
    }

    if (res.id === "toggle") {
      setSkillsEnabled(app, !enabled);
      continue;
    }
    if (res.id === "auto") {
      app.cfg = saveConfig({ skillAuto: !autoOn });
      success(t(`Skill auto-selection ${!autoOn ? "on" : "off"}.`, `Автовыбор навыков: ${!autoOn ? "вкл" : "выкл"}.`));
      continue;
    }
    if (res.id === "edit") {
      await editSkill(app, res.value);
      continue;
    }
    if (res.id === "new") {
      const name = await app.exclusiveInput(() => askLine(t("Name:", "Имя:"), ""));
      if (!name) continue;
      const description = (await app.exclusiveInput(() => askLine(t("When to apply it:", "Когда применять:"), ""))) ?? "";
      const { file, existed } = createSkill({ cwd: app.cwd, name: name.trim(), description, scope: "project" });
      app.rebuildTools();
      if (existed) warn(t(`That skill already exists: ${file}`, `Такой навык уже есть: ${file}`));
      else success(t(`Created ${file}`, `Создан ${file}`));
      hint(
        t(
          "The description line is what matters: the model decides whether to load the skill from it.",
          "Главная строка — описание: по нему модель решает, загружать ли навык.",
        ),
      );
      continue;
    }
    if (res.id === "gen") {
      const task = await app.exclusiveInput(() => askLine(t("The task to automate:", "Задача для автоматизации:"), ""));
      if (!task) continue;
      await app.turn(skillGenPrompt(task));
      app.rebuildTools();
      return;
    }
  }
}
