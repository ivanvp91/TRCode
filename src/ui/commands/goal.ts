/** /goal: start, inspect and stop a goal. */
import { error, hint, info, success } from "../render.js";
import { DEFAULT_MAX_TURNS, goalLine, newGoal } from "../../session/goal.js";
import { t } from "../../i18n.js";
import type { App } from "../repl.js";

/**
 * /goal: a persistent objective the agent keeps working toward between the
 * user's own inputs. The state lives on the session, so it survives resume.
 */
export function goalCommand(app: App, rest: string): void {
  const goal = app.session.goal;
  const sub = rest.trim();
  const [word] = sub.split(/\s+/);

  if (!word) {
    // Bare /goal is /goal status, like in Qoder.
    info(t("Goal: ", "Цель: ") + goalLine(goal ?? undefined));
    if (goal?.status === "active") hint(t("The agent continues it after every turn; /goal pause stops that.", "Агент продолжает её после каждого хода; /goal pause останавливает."));
    return;
  }
  switch (word) {
    case "status":
      info(t("Goal: ", "Цель: ") + goalLine(goal ?? undefined));
      if (goal?.maxTurns) info(t(`Turns used: ${goal.turnsUsed} of ${goal.maxTurns}.`, `Потрачено ходов: ${goal.turnsUsed} из ${goal.maxTurns}.`));
      return;
    case "clear":
      if (!goal) return info(t("No goal set.", "Цель не задана."));
      app.session.goal = null;
      app.session.save();
      return success(t("Goal cleared.", "Цель снята."));
    case "pause":
      if (!goal || goal.status !== "active") return info(t("No active goal.", "Активной цели нет."));
      goal.status = "paused";
      app.session.save();
      return success(t("Goal paused — /goal resume continues it.", "Цель на паузе — /goal resume продолжит."));
    case "resume":
      if (!goal) return info(t("No goal set.", "Цель не задана."));
      if (goal.status === "complete") return info(t("The goal is already complete.", "Цель уже достигнута."));
      // Resuming grants a fresh turn budget when a limit had been reached.
      if (goal.maxTurns && goal.turnsUsed >= goal.maxTurns) goal.turnsUsed = 0;
      goal.status = "active";
      app.session.save();
      success(t("Goal resumed — the agent continues it after every turn.", "Цель возобновлена — агент продолжит её после каждого хода."));
      return;
  }

  if (word.startsWith("--")) {
    return error(t(`Unknown option ${word}.`, `Неизвестный флаг ${word}.`));
  }

  // A new (or replaced) goal: parse the --turns flag out of the tail.
  const m = /\s--turns\s+(\d+)\s*$/.exec(sub);
  let objective = sub;
  let maxTurns: number | undefined;
  if (m) {
    objective = sub.slice(0, m.index);
    maxTurns = Number(m[1]);
  }
  objective = objective.trim().replace(/\s+/g, " ");
  if (!objective) return error(t("Usage: /goal <objective> [--turns <n>]", "Использование: /goal <цель> [--turns <n>]"));
  if (objective.length > 500) objective = objective.slice(0, 500);

  app.session.goal = newGoal(objective, maxTurns);
  app.session.save();
  success(t("Goal set — the agent keeps working toward it after every turn.", "Цель задана — агент будет продолжать работать над ней после каждого хода."));
  if (!maxTurns) {
    hint(
      t(
        `A built-in limit of ${DEFAULT_MAX_TURNS} turns pauses it automatically — /goal resume grants a fresh budget.`,
        `Встроенный лимит ${DEFAULT_MAX_TURNS} ходов остановит её автоматически — /goal resume выдаст новый бюджет.`,
      ),
    );
  }
}
