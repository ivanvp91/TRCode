/**
 * Big pastes, held aside.
 *
 * A pasted log, a table, a whole file: two hundred lines of it in the input
 * frame push everything else off the screen, and the same two hundred lines
 * come back in the transcript the moment the turn is echoed. The terminal is
 * not the place to read what you already have in your clipboard.
 *
 * So the paste goes into a stash and the frame gets a token — `[Вставка #1 ·
 * 245 строк]`. The token is what you edit around; it is expanded back to the
 * full text on the way to the model, so nothing is lost and the model sees
 * exactly what was pasted. Screenshots work the same way: what the terminal
 * pastes is a path to a temp file, which is noise to read and useful to keep,
 * so it shows as `[Image #1]` and travels as the path.
 */
import { t } from "../i18n.js";

export interface Stashed {
  id: number;
  kind: "text" | "image";
  /** What goes to the model in place of the token. */
  text: string;
  lines: number;
  chars: number;
}

const stash: Stashed[] = [];

/** Below this a paste is just typing, and a token would only be in the way. */
const MIN_LINES = 8;
const MIN_CHARS = 600;

const IMAGE_PATH = /^["'(]?\s*\S*\.(png|jpe?g|gif|webp|bmp|svg)\s*["')]?$/i;

/** The token for a stashed blob, in the current interface language. */
export function tokenFor(s: Stashed): string {
  if (s.kind === "image") return `[Image #${s.id}]`;
  return t(`[Pasted text #${s.id} · ${s.lines} lines]`, `[Вставка #${s.id} · ${s.lines} строк]`);
}

/**
 * Takes a pasted chunk and returns what should appear in the input frame:
 * the chunk itself when it is small, a token when it is not.
 */
export function stashPaste(text: string): string {
  const clean = text.replace(/\r/g, "");
  const oneLine = clean.trim();
  if (IMAGE_PATH.test(oneLine) && !oneLine.includes("\n")) {
    const s: Stashed = { id: stash.length + 1, kind: "image", text: oneLine.replace(/^["'(]|["')]$/g, ""), lines: 1, chars: oneLine.length };
    stash.push(s);
    return tokenFor(s);
  }
  const lines = clean.split("\n").length;
  if (lines < MIN_LINES && clean.length < MIN_CHARS) return text;
  const s: Stashed = { id: stash.length + 1, kind: "text", text: clean, lines, chars: clean.length };
  stash.push(s);
  return tokenFor(s);
}

/**
 * Any language's token, in any shape it has been written in: the id is what
 * matters, and a user who retypes the brackets by hand should still get their
 * paste back.
 */
const TOKEN = /\[(?:Pasted text|Вставка|Image|Изображение)\s*#(\d+)[^\]]*\]/g;

/** Puts every stashed blob back, for the request that is actually sent. */
export function expandPastes(s: string): string {
  return s.replace(TOKEN, (whole, id) => stash.find((x) => x.id === Number(id))?.text ?? whole);
}

/** True when the line carries a token — the caller may want to expand first. */
export function hasPasteToken(s: string): boolean {
  TOKEN.lastIndex = 0;
  return TOKEN.test(s);
}

export function stashedCount(): number {
  return stash.length;
}

/** Tests run several pastes in one process; the ids must not carry over. */
export function resetStash(): void {
  stash.length = 0;
  collapsed.length = 0;
  cursor = 0;
}

// ── collapsed blocks on screen ──────────────────────────────────────────────

/**
 * What was printed short, kept whole in case it is asked for.
 *
 * The echo and the replayed history both cut a long message down to a few
 * lines; ctrl+o opens the newest of them, then the one before it, and /expand N
 * reaches one by number. Numbering is per process and
 * shared with nothing — it is a handle for the line right above it, not an
 * index into the session.
 */
const collapsed: string[] = [];

export function rememberCollapsed(text: string): number {
  collapsed.push(text);
  // A new short block is the one ctrl+o should open next; whatever the key
  // had walked back to belongs to the part of the screen already read.
  cursor = collapsed.length;
  return collapsed.length;
}

/** Where ctrl+o is in the walk back through what was shortened. */
let cursor = 0;

/**
 * The next block to print, newest first.
 *
 * Pressing the key again goes one further back rather than repeating the
 * same block: a screen with three collapsed pastes on it is walked, not
 * argued with. Returns nothing once the walk reaches the top.
 */
export function takeCollapsed(): { id: number; text: string } | undefined {
  if (cursor < 1) return undefined;
  const id = cursor--;
  return { id, text: collapsed[id - 1] };
}

export function collapsedText(id?: number): string | undefined {
  if (id === undefined) return collapsed[collapsed.length - 1];
  return collapsed[id - 1];
}

export function collapsedCount(): number {
  return collapsed.length;
}
