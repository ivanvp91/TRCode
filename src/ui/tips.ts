/**
 * One-line hints about features the session has not used yet.
 *
 * A command index is something you read once; a tool you never knew existed is
 * something you never look for. So a tip appears on its own — one line, under
 * the answer, where the eye already is — and then never again. The rules that
 * keep it from becoming noise:
 *
 *   - one tip per turn at most, and only every few turns;
 *   - never while a goal is running or the turn failed (the user has work to
 *     do, not a brochure);
 *   - never the same tip twice, across restarts too (config.tipsSeen);
 *   - a tip whose subject the session already uses is skipped, not shown late.
 */
import { t } from "../i18n.js";

/** What a tip is allowed to know about the session. */
export interface TipState {
  /** Turns that have completed in this run of the client. */
  turns: number;
  /** The session has a goal set. */
  goal: boolean;
  /** At least one subagent has been launched in this session. */
  subagents: boolean;
  /** The UI library has at least one saved design. */
  uiLibrary: boolean;
  /** A council of models has been configured (/brain). */
  brain: boolean;
  /** The user has run something in the shell themselves ("!cmd"). */
  shell: boolean;
  /** The session has been compacted at least once. */
  compacted: boolean;
  /** Provider id of the model in use, e.g. "openrouter". */
  provider: string;
}

export interface Tip {
  id: string;
  /** What the line says. Short enough to sit under an answer without wrapping. */
  text: () => string;
  /** Only offer it when this holds: a tip about a thing already in use is noise. */
  when?: (s: TipState) => boolean;
}

/** The tips. Which one comes next is drawn at random — see nextTip. */
export const TIPS: Tip[] = [
  {
    id: "brain",
    when: (s) => !s.brain,
    text: () => t(
      "`/brain` puts several models on one question and has them answer the council's way.",
      "`/brain` собирает совет из нескольких моделей и сводит их ответы в один.",
    ),
  },
  {
    id: "uilib",
    when: (s) => !s.uiLibrary,
    text: () => t(
      "`/uilib add <url>` saves a site's look once; later design work reuses it.",
      "`/uilib add <url>` один раз сохраняет облик сайта — дальше дизайн берёт его сам.",
    ),
  },
  {
    id: "swarm",
    when: (s) => !s.subagents,
    text: () => t(
      "`/swarm <task>` runs several models in parallel; `/orchestrate` splits the work instead.",
      "`/swarm <задача>` гоняет несколько моделей параллельно; `/orchestrate` вместо этого делит работу.",
    ),
  },
  {
    id: "goal",
    when: (s) => !s.goal,
    text: () => t(
      "`/goal <objective>` keeps the agent working turn after turn until the goal is done.",
      "`/goal <цель>` заставляет агента работать ход за ходом, пока цель не будет достигнута.",
    ),
  },
  {
    id: "rewind",
    text: () => t(
      "`/rewind` puts back the files a turn changed — the conversation stays as it is.",
      "`/rewind` возвращает файлы к состоянию до хода — переписка при этом остаётся.",
    ),
  },
  {
    id: "fork",
    text: () => t(
      "`/fork` branches the session at any earlier turn, so a dead end costs nothing.",
      "`/fork` ответвляет сессию с любого прошлого хода — тупик перестаёт быть тупиком.",
    ),
  },
  {
    id: "compact",
    when: (s) => !s.compacted,
    text: () => t(
      "Context full? `/compact` summarises the old turns and keeps the recent ones word for word.",
      "Контекст полон? `/compact` сжимает старые ходы и оставляет последние дословно.",
    ),
  },
  {
    id: "trace",
    text: () => t(
      "`/trace` shows what a request was made of — prompt, tools, history — and what it cost.",
      "`/trace` показывает, из чего состоял запрос — промпт, инструменты, история — и во сколько обошёлся.",
    ),
  },
  {
    id: "preset",
    text: () => t(
      "`/preset minimal` strips the toolset to shell and edit: fewer tokens, less choice.",
      "`/preset minimal` оставляет только shell и edit: меньше токенов и меньше выбора.",
    ),
  },
  {
    id: "shell",
    when: (s) => !s.shell,
    text: () => t(
      "A line starting with `!` runs in your shell, and the model reads what it printed.",
      "Строка с `!` выполняется в вашей оболочке, а модель читает её вывод.",
    ),
  },
  {
    id: "stat",
    text: () => t(
      "`/stat` breaks spending down by day and model; `/cost` is just the current session.",
      "`/stat` раскладывает расход по дням и моделям; `/cost` — только текущая сессия.",
    ),
  },
  {
    id: "subagents",
    when: (s) => !s.subagents,
    text: () => t(
      "`/subagents` decides which models helpers run on — a cheap model is enough for most steps.",
      "`/subagents` задаёт модели для помощников — на большинстве шагов хватает дешёвой.",
    ),
  },
];

/** How often a tip may appear at all: one every this many completed turns. */
export const TIP_EVERY = 3;

/**
 * The next tip worth showing, or null.
 *
 * `turns` counts completed turns, and the gap is what keeps the hint a hint:
 * the first turn is the user's own, and every third after that is early enough
 * to be useful and late enough not to interrupt.
 *
 * Which one is drawn at random from the unseen ones that still apply. In list
 * order every user met the same three tips first, and the ones at the end of
 * the list — `!`, `/stat`, `/subagents` — waited thirty turns or forever.
 */
export function nextTip(state: TipState, seen: string[], random: () => number = Math.random): Tip | null {
  if (state.goal) return null;
  if (state.turns < 2 || state.turns % TIP_EVERY !== 0) return null;
  const taken = new Set(seen);
  const open = TIPS.filter((tip) => !taken.has(tip.id) && (!tip.when || tip.when(state)));
  if (!open.length) return null;
  return open[Math.min(open.length - 1, Math.floor(random() * open.length))];
}

/** Every id, for `/tips reset`. */
export function allTipIds(): string[] {
  return TIPS.map((tip) => tip.id);
}
