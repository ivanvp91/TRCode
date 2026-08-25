/**
 * Matching a "нарисуй дизайн …" request against the library.
 *
 * The same shape as skills/match.ts but much blunter, and deliberately so: a
 * skill decides whether thousands of tokens of procedure arrive uninvited, so
 * it needs a threshold and a margin; a mockup only decides what goes on a
 * list the user picks from, and a list is allowed to be short. There is no
 * auto-fire — the worst case is a suggestion the user skips.
 */
import { listEntries, type UiEntry } from "./store.js";

/** Requests that are about design at all — the only ones the library answers. */
const DESIGN_INTENT = [
  "нарисуй дизайн",
  "нарисовать дизайн",
  "нарисуй макет",
  "нарисовать макет",
  "сделай дизайн",
  "сделать дизайн",
  "сделай макет",
  "сделать макет",
  "свёрстай",
  "дизайн для",
  "дизайн интерфейса",
  "дизайн сайта",
  "дизайн страницы",
  "макет",
  "макеты",
  "лендинг",
  "mockup",
  "mock up",
  "design a",
  "design the",
  "design for",
  "ui for",
  "ui kit",
  "landing page",
  "layout for",
  "redesign",
];

/**
 * The phrases as patterns: a word start on the left, a word end — or a short
 * inflection, "макет / макета" — on the right.
 *
 * Plain substring matching is what let "gui format" read as "ui for", and one
 * false positive is enough: the library then interrupts a conversation that
 * was never about design, with a picker nobody asked for.
 */
const DESIGN_PATTERNS = DESIGN_INTENT.map(
  (p) => new RegExp(`(?:^|\\s)${p.trim()}\\p{L}{0,3}(?:\\s|$)`, "u"),
);

/** Words that name a thing to build rather than a style to borrow — ignored. */
const NOISE = new Set([
  "дизайн", "design", "интерфейс", "interface", "ui", "сделай", "сделать",
  "нарисуй", "нарисовать", "сгенерируй", "сгенерировать", "make", "create",
  "generate", "draw", "please", "пожалуйста", "мне", "нужно", "надо", "хочу",
  "для", "под", "the", "a", "an", "for", "me", "my", "our", "with", "in",
  "style", "стиле", "стиль", "в",
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Same word, allowing for the ending: "терминал / терминала", "dark / darker". */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  let shared = 0;
  while (shared < n && a[shared] === b[shared]) shared++;
  return shared >= 4 && a.length - shared <= 3 && b.length - shared <= 3;
}

/**
 * Lead-ins that quote a design request instead of making one.
 *
 * "когда мы говорим нарисуй дизайн, должно быть 3 кнопки" is a specification
 * for this feature, not a use of it: the phrase is in quotes in everything but
 * punctuation. Firing there interrupts the one conversation that is least
 * about drawing anything — the one about how the picker itself should behave.
 */
const QUOTING_LEAD =
  /(?:когда|если|каждый раз|говор\p{L}*|скаж\p{L}*|сказ\p{L}*|пиш\p{L}*|напиш\p{L}*|вводит|просит|запрос\p{L}*|фраз\p{L}*|слов\p{L}*|when|if|whenever|says?|saying|said|types?|writes?|asks?|phrase|word)\s+(?:\p{L}+\s+){0,3}$/u;

/**
 * The feature named out loud, in the mood of a spec. A user asking for a
 * design says what to draw; only a user designing *this* says "uilib" and
 * "должно быть" in the same breath.
 */
const SPEC_TALK = /(?:^|\s)uilib(?:\s|$)/u;
const SPEC_MOOD = /(?:^|\s)(?:должн\p{L}*|should|must)(?:\s|$)/u;

/** Is this request asking for a design, as opposed to mentioning one in passing? */
export function isDesignRequest(text: string): boolean {
  const norm = ` ${normalize(text)} `;
  if (SPEC_TALK.test(norm) && SPEC_MOOD.test(norm)) return false;
  for (const re of DESIGN_PATTERNS) {
    const hit = re.exec(norm);
    if (!hit) continue;
    // The words in front of the phrase decide whether it is being used or
    // only reported. A phrase that opens the message is always a request.
    if (QUOTING_LEAD.test(norm.slice(0, hit.index + 1))) continue;
    return true;
  }
  return false;
}

export interface Match {
  entry: UiEntry;
  score: number;
  /** What matched, for the one line shown in the picker. */
  via: string[];
}

/**
 * Ranks the library against a design request. Everything with a hit comes
 * back, best first — the user picks, so precision can stay loose.
 */
export function matchLibrary(text: string, library: UiEntry[] = listEntries()): Match[] {
  const norm = normalize(text);
  const tokens = norm.split(" ").filter((w) => w.length >= 3 && !NOISE.has(w));
  const out: Match[] = [];
  for (const entry of library) {
    const via = new Set<string>();
    let score = 0;
    for (const kw of entry.keywords) {
      const k = normalize(kw);
      if (!k) continue;
      // A phrase keyword ("saas dashboard") is worth more than a word.
      if (k.includes(" ")) {
        if (norm.includes(k)) {
          score += 4;
          via.add(kw);
        }
        continue;
      }
      if (tokens.some((tk) => related(tk, k))) {
        score += 2;
        via.add(kw);
      }
    }
    for (const part of entry.slug.split("-")) {
      if (part.length >= 4 && tokens.some((tk) => related(tk, part))) {
        score += 1;
        via.add(part);
      }
    }
    for (const w of normalize(entry.summary).split(" ")) {
      if (w.length >= 4 && tokens.some((tk) => related(tk, w))) {
        score += 0.5;
        via.add(w);
        break;
      }
    }
    if (score > 0) out.push({ entry, score, via: [...via] });
  }
  return out.sort((a, b) => b.score - a.score || a.entry.slug.localeCompare(b.entry.slug));
}

/** The brief, wrapped as a reference block for the history. */
export function designInjection(entry: UiEntry, brief: string, auto: boolean): string {
  const how = auto ? "matched to the request automatically" : "chosen by the user";
  return (
    `<design-reference name="${entry.title}" ${how}>\n${brief.trim()}\n</design-reference>\n` +
    `This mockup is the visual reference for the request above — follow its palette, ` +
    `typography, spacing and motion. If it clearly does not fit, say so in one line and design from scratch.`
  );
}

/**
 * Several briefs fused into one reference. Synthesis is left to the model on
 * purpose: which half of each mockup survives the merge is a design decision,
 * not string concatenation — the instruction only fixes the contract.
 */
export function blendInjection(parts: { entry: UiEntry; brief: string }[]): string {
  const blocks = parts.map((p) => `<source name="${p.entry.title}">\n${p.brief.trim()}\n</source>`).join("\n\n");
  const names = parts.map((p) => p.entry.title).join(" + ");
  return (
    `<design-reference name="blend: ${names}" chosen by the user>\n${blocks}\n</design-reference>\n` +
    `The sources above are references the user chose to blend. First synthesise ONE coherent style from them — ` +
    `borrow what each does best (palette from one, typography from another, motion from a third…) and resolve their ` +
    `contradictions explicitly rather than averaging everything — then apply that synthesized style to the request above. ` +
    `Show the resulting style in two or three lines (the decisions you made and what you took from where) before the work itself.`
  );
}

