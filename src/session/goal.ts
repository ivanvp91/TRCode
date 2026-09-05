/** Session goal: a persistent objective the agent keeps working toward. */
import { t } from "../i18n.js";

export type GoalStatus = "active" | "paused" | "complete";

export interface Goal {
  objective: string;
  status: GoalStatus;
  /** Interaction-turn budget; no budget when absent. */
  maxTurns?: number;
  turnsUsed: number;
  startedAt: number;
  /** When the goal last had a turn spent on it. */
  lastUsedAt: number;
  /** How many turns it took to reach "complete"; set on completion. */
  completedAt?: number;
}

export const DEFAULT_MAX_TURNS = 25;

export function newGoal(objective: string, maxTurns?: number): Goal {
  return {
    objective,
    status: "active",
    maxTurns: maxTurns && maxTurns > 0 ? maxTurns : undefined,
    turnsUsed: 0,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

/**
 * A turn about to run against the goal. Returns the reason it must not: the
 * budget ran out (pause), the model already declared it done, or it was not
 * running in the first place.
 */
export function turnGate(goal: Goal | undefined): "ok" | "no-goal" | "paused" | "complete" | "exhausted" {
  if (!goal) return "no-goal";
  if (goal.status === "complete") return "complete";
  // Exhausted beats paused: spendTurn pauses at the budget line, and the two
  // must not be told apart by guesswork.
  if (goal.maxTurns && goal.turnsUsed >= goal.maxTurns) return "exhausted";
  if (goal.status === "paused") return "paused";
  return "ok";
}

/** Spends one turn on the goal; the turn limit pauses it on its own. */
export function spendTurn(goal: Goal): void {
  goal.turnsUsed++;
  goal.lastUsedAt = Date.now();
  if (goal.maxTurns && goal.turnsUsed >= goal.maxTurns && goal.status === "active") {
    goal.status = "paused";
  }
}

/** Marks the goal reached and stops the loop; the completion turn counts too. */
export function completeGoal(goal: Goal): void {
  goal.status = "complete";
  goal.completedAt = Date.now();
}

/** The one-line status shown under /goal and in the status line. */
export function goalLine(goal: Goal | undefined): string {
  if (!goal) return t("no goal set", "цель не задана");
  const bits = [statusMark(goal.status), goal.objective];
  if (goal.maxTurns) bits.push(t(`${goal.turnsUsed}/${goal.maxTurns} turns`, `${goal.turnsUsed}/${goal.maxTurns} ходов`));
  else if (goal.turnsUsed) bits.push(t(`${goal.turnsUsed} turns`, `${goal.turnsUsed} ходов`));
  return bits.join(" · ");
}

export function statusMark(status: GoalStatus): string {
  return { active: "◉", paused: "◎", complete: "✓" }[status];
}

/**
 * The continuation prompt of a goal turn. The objective is repeated verbatim
 * every round — the model has no other durable marker of what it is chasing —
 * and the completion tag is the only thing that ends the loop.
 */
export function goalPrompt(goal: Goal): string {
  const budget = goal.maxTurns
    ? t(`Turns used: ${goal.turnsUsed} of ${goal.maxTurns}.`, `Потрачено ходов: ${goal.turnsUsed} из ${goal.maxTurns}.`)
    : "";
  return t(
    `Continue working toward the session goal (do not ask for confirmation, act):\n${goal.objective}\n\n` +
      `Work step by step: assess the current state, do the next concrete step, verify the result. ` +
      `When the goal is fully reached — and only then — end your reply with <goal-complete>. ` +
      `If you genuinely cannot proceed, say exactly what blocks you. ${budget}`.trim(),
    `Продолжай работать над целью сессии (не спрашивай подтверждений, действуй):\n${goal.objective}\n\n` +
      `Работай по шагам: оцени текущее состояние, сделай следующий конкретный шаг, проверь результат. ` +
      `Когда цель полностью достигнута — и только тогда — заверши ответ тегом <goal-complete>. ` +
      `Если продолжать невозможно, скажи точно, что мешает. ${budget}`.trim(),
  );
}
