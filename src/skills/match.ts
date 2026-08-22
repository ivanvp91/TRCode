/**
 * Auto-selection: picking the skill a request needs without waiting for the
 * model to call the `skill` tool.
 *
 * The catalogue in the system prompt already invites the model to choose, but
 * that is a suggestion competing with everything else in the prompt — a weaker
 * model skips it, and the one request where the procedure mattered is the one
 * that goes without it. Matching here is deterministic and costs nothing.
 *
 * Scoring is deliberately blunt: a trigger word carries the decision, the name
 * helps, the description only breaks ties. When two skills come out close the
 * pick is dropped rather than guessed — a wrong procedure is worse than none,
 * and the model can still load one itself.
 *
 * Matching happens twice: on the request, and again at every step boundary of
 * the turn. A task rarely announces everything it will need in its first
 * sentence — "почини баг" turns into writing a test for the fix ten steps
 * later — and a procedure that arrives after the work is done is a procedure
 * that never arrived. See `skillInterjector`.
 */
import type { Message, ToolCall } from "../types.js";
import type { Skill } from "./loader.js";

export interface Pick {
  skill: Skill;
  score: number;
  /** What matched, for the one line printed to the user. */
  matched: string[];
}

/** Score at which a match is trusted: one trigger hit, or name plus context. */
const THRESHOLD = 3;

/**
 * The bar a match has to clear mid-turn, where the text being read is the
 * model's own narration rather than a request. Narration is long, it restates
 * the task in its own words, and it names in passing everything it considered
 * and dropped — so one stray trigger word proves nothing there. Five means a
 * trigger phrase, or two separate trigger words: something the model came back
 * to, not something it mentioned.
 */
const STEP_THRESHOLD = 5;

/** How far the winner must be ahead of the runner-up to be unambiguous. */
const MARGIN = 1.5;

/** Below this a request is too short to carry intent ("ok", "go on"). */
const MIN_CHARS = 12;

/**
 * Openers that mark a conversation rather than a request for work. They are
 * matched on the normalised text, so punctuation and case do not matter.
 */
const DISCUSSION = [
  "обсудим",
  "обсудить",
  "обсуждаем",
  "поговорим",
  "поговорить",
  "как думаешь",
  "что думаешь",
  "твое мнение",
  "как считаешь",
  "что скажешь",
  "порассуждай",
  "давай подумаем",
  "lets discuss",
  "let us discuss",
  "lets talk",
  "what do you think",
  "your thoughts",
  "thoughts on",
];

const STOPWORDS = new Set([
  // English
  "the", "and", "for", "you", "your", "our", "with", "this", "that", "there", "here", "have", "has",
  "was", "were", "are", "can", "could", "would", "should", "please", "make", "made", "need", "want",
  "into", "from", "about", "than", "then", "them", "they", "what", "when", "where", "which", "how",
  "all", "any", "some", "not", "but", "one", "two", "get", "got", "let", "its", "his", "her",
  // Russian
  "это", "как", "что", "для", "или", "если", "надо", "нужно", "можешь", "можно", "давай", "сделай",
  "сделать", "пожалуйста", "потом", "тут", "там", "мне", "меня", "тебе", "мой", "моя", "мои", "наш",
  "все", "весь", "вот", "так", "чтобы", "когда", "где", "куда", "еще", "ещё", "уже", "быть", "есть",
  "они", "него", "нее", "его", "тоже", "очень", "просто",
]);

/**
 * Paths, identifiers and fenced code, dropped before anything is read as
 * prose. "переименуй foo в bar в src/index.ts" is not a request about
 * databases — `index` is a database word, but a filename is where it came
 * from. What the user typed is evidence; what a path happens to contain is
 * not.
 */
/** A backtick span — code the user quoted rather than words they wrote. */
const FENCED = /`[^`]*`/g;
/** A path. */
const PATHY = /[\\/]/;
/** A file name or a dotted call: `config.ts`, `obj.method`. */
const DOTTED = /\w\.\w/;
/** An identifier: `tool_call_id`. */
const SNAKE = /\w_\w/;
const CAMEL = /[a-z][A-Z]/;
/**
 * "a/b" is not a path. A token whose every part is a letter or two is prose
 * that happens to carry a slash — "a/b тест", "и/или" — and dropping it took
 * away exactly the half that made the trigger specific.
 */
const TINY_PARTS = /^[\p{L}\p{N}]{1,2}([\\/.][\p{L}\p{N}]{1,2})+$/u;

function stripCode(text: string): string {
  return text
    .replace(FENCED, " ")
    .split(/\s+/)
    .filter((w) => TINY_PARTS.test(w) || (!PATHY.test(w) && !DOTTED.test(w) && !SNAKE.test(w) && !CAMEL.test(w)))
    .join(" ");
}

function normalize(text: string): string {
  return stripCode(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * A trigger reduced to the same shape as the text it is searched for in — but
 * without the code-stripping pass, which exists to stop a path in a *request*
 * reading as prose. Applied to a trigger it silently ate half of it: "a/b
 * тест" came out as "тест", and from then on every sentence with the word
 * "тест" in it matched a marketing skill on an exact-phrase score.
 */
function normalizeTrigger(trigger: string): string {
  return trigger.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function words(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Same word, allowing for inflection: one being a prefix of the other covers
 * "тест / тесты / тестирование" and "design / designer" without a stemmer,
 * which for Russian would be a project of its own.
 */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  let shared = 0;
  while (shared < n && a[shared] === b[shared]) shared++;
  if (shared < 4) return false;
  // Only the ending may differ — "дублирование" against "дублирования". A
  // longer shared stem earns more slack, because that is where the long
  // Russian endings are; four shared letters and two different tails is a
  // coincidence ("почини" / "почисти", "spec" / "special").
  const slack = shared >= 6 ? 3 : 2;
  return a.length - shared <= slack && b.length - shared <= slack;
}

interface Scored extends Pick {
  /** Auto-selection needs a trigger; name and description only rank. */
  triggered: boolean;
}

function scoreSkill(
  skill: Skill,
  text: string,
  tokens: string[],
  phrases: string[],
  generic: Set<string>,
): Scored {
  const matched: string[] = [];
  let score = 0;
  let triggered = false;

  /** A word explained by a phrase another skill matched is not evidence: the
   * "дизайн" inside "ревью дизайна" belongs to the critique, not to design. */
  const covered = (word: string) => phrases.some((p) => p.includes(word) && !skill.triggers.includes(p));

  for (const trigger of skill.triggers) {
    // A phrase is worth more than a word because it is far harder to hit by
    // accident: "ревью дизайна" means one thing, "дизайн" means several.
    if (trigger.includes(" ") && text.includes(normalizeTrigger(trigger))) {
      score += 5;
      triggered = true;
      matched.push(trigger);
    }
  }

  // Counted once per word of the request, not once per trigger that word
  // resembles: "серверов" matching three spellings of the same trigger is one
  // fact, and scoring it three times made a passing mention look like a case.
  for (const token of new Set(tokens)) {
    if (covered(token)) continue;
    const trigger = skill.triggers.find((t) => !t.includes(" ") && related(token, t));
    if (!trigger) continue;
    // A word half the catalogue lists is weak evidence for any one of them:
    // it ranks, but on its own it no longer reaches the threshold.
    score += generic.has(trigger) ? 1.5 : 3;
    triggered = true;
    matched.push(trigger);
  }

  for (const part of skill.name.split("-")) {
    if (part.length >= 3 && !covered(part) && tokens.some((t) => related(t, part))) {
      score += 2;
      matched.push(part);
    }
  }

  // The description is written for the model, so it is supporting evidence at
  // best — capped so a long one cannot outweigh a real trigger.
  const descHits = words(skill.description).filter((w) => tokens.some((t) => related(t, w)));
  score += Math.min(descHits.length * 0.4, 1.6);

  return { skill, score, matched, triggered };
}

/**
 * The skill a request calls for, or null when nothing matches clearly.
 * `exclude` holds the skills already loaded in this session — a procedure is
 * worth sending once, not on every turn that mentions the same word.
 */
export function pickSkill(
  skills: Skill[],
  request: string,
  opts: { exclude?: Set<string>; threshold?: number } = {},
): Pick | null {
  const threshold = opts.threshold ?? THRESHOLD;
  const text = normalize(request);
  if (text.length < MIN_CHARS) return null;
  // Talking about a subject is not asking for work on it. A procedure is a few
  // thousand tokens of instructions; "давай обсудим продвижение продукта" is
  // not the moment to load one, and the model can still pull it in with the
  // skill tool once the talk turns into a task.
  if (DISCUSSION.some((d) => text.includes(d))) return null;

  const tokens = words(request);
  if (!tokens.length) return null;

  const candidates = skills.filter((s) => s.auto && !opts.exclude?.has(s.name));

  // Phrases are collected across all candidates first: which of them the text
  // hit decides whether a bare word elsewhere counts as its own evidence.
  const phrases: string[] = [];
  for (const s of candidates) {
    for (const t of s.triggers) {
      if (t.includes(" ") && text.includes(normalizeTrigger(t))) phrases.push(normalizeTrigger(t));
    }
  }

  // A word that several skills claim cannot decide between them: "дизайн",
  // "тест", "план" belong to half the catalogue, and a sentence containing one
  // says nothing about which procedure the request needs.
  const claims = new Map<string, number>();
  for (const s of candidates) {
    for (const t of new Set(s.triggers)) if (!t.includes(" ")) claims.set(t, (claims.get(t) ?? 0) + 1);
  }
  const generic = new Set([...claims].filter(([, n]) => n >= 3).map(([t]) => t));

  const ranked = candidates
    .map((s) => scoreSkill(s, text, tokens, phrases, generic))
    .sort((a, b) => b.score - a.score);

  const [best, second] = ranked;
  // Name and description are the model's way in; firing by itself takes a
  // trigger, so "run npm test" cannot pull in the skill about writing them.
  if (!best || !best.triggered || best.score < threshold) return null;
  if (second && best.score - second.score < MARGIN) return null;
  return { skill: best.skill, score: best.score, matched: best.matched };
}

/** The injected turn: the procedure itself, plus why it is there. */
export function skillInjection(skill: Skill, opts: { midTurn?: boolean } = {}): string {
  const res = skill.resources.length
    ? `\n\nFiles that ship with this skill, read them if the procedure needs them:\n${skill.resources
        .map((r) => `- ${skill.dir}/${r}`)
        .join("\n")}`
    : "";
  // Mid-turn the "request above" is a tool result, not a request: the match
  // was made on what the model itself just said it was about to do, and saying
  // so is what keeps it from reading the procedure as a change of task.
  const why = opts.midTurn
    ? `This procedure was matched to the work you just described and is now loaded — apply it to the part of the task it covers, and carry on with the rest`
    : `This procedure was matched to the request above and is now loaded — follow it`;
  return `<skill name="${skill.name}" loaded="automatically">
${skill.body}${res}
</skill>
${why}, and do not call the skill tool for "${skill.name}". If it turns out not to fit, say so in one line and work normally.`;
}

/**
 * Tools whose arguments say what the work is rather than carry it. A todo list
 * and a subagent brief are the model stating its own plan in words; a write's
 * payload is a file, and a file that happens to contain the word "тест" a
 * hundred times is not a request to write tests. Only the first kind is read.
 */
const INTENT_TOOLS = new Set(["todo", "task"]);

/** Enough of a step to read its intent from; the rest is repetition. */
const MAX_STEP_CHARS = 4000;
const MAX_ARGS_CHARS = 800;

/**
 * What a step says about the work ahead: the model's own text, plus the
 * arguments of the calls that state a plan.
 */
export function stepText(assistant: Message, calls: ToolCall[] = []): string {
  const parts: string[] = [];
  if (typeof assistant.content === "string" && assistant.content.trim()) {
    parts.push(assistant.content.slice(0, MAX_STEP_CHARS));
  }
  for (const call of calls) {
    if (INTENT_TOOLS.has(call.function.name)) parts.push(call.function.arguments.slice(0, MAX_ARGS_CHARS));
  }
  return parts.join("\n");
}

/**
 * The mid-turn matcher, as the agent loop wants it: hand it a finished step,
 * get back the message to splice into the history, or null.
 *
 * `loaded` is shared with the rest of the session — a body is worth sending
 * once — and `max` bounds the damage of a turn that keeps changing subject:
 * each load is a few thousand tokens paid on every remaining step, so a turn
 * that pulls in half the library costs more than the library is worth.
 */
export function skillInterjector(
  skills: Skill[],
  opts: { loaded: Set<string>; max?: number; onLoad?: (skill: Skill, matched: string[]) => void },
): (assistant: Message, calls: ToolCall[]) => Message | null {
  let left = opts.max ?? 2;
  return (assistant, calls) => {
    if (left <= 0 || !skills.length) return null;
    const pick = pickSkill(skills, stepText(assistant, calls), {
      exclude: opts.loaded,
      threshold: STEP_THRESHOLD,
    });
    if (!pick) return null;
    left--;
    opts.loaded.add(pick.skill.name);
    opts.onLoad?.(pick.skill, pick.matched);
    return {
      role: "user",
      content: skillInjection(pick.skill, { midTurn: true }),
      meta: { skill: pick.skill.name },
    };
  };
}
