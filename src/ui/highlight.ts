/**
 * Enough syntax colour for a diff to be readable.
 *
 * Not a parser: one pass over the line, longest-match-first, no state carried
 * between lines. A diff shows fragments — a line can open a string it never
 * closes — so anything that tried to track state across lines would mis-colour
 * the rest of the hunk. Getting a stray line wrong is worth more than getting
 * every line after it wrong.
 */
import { c } from "./ansi.js";

/** Words that read as keywords in the languages this CLI is pointed at. */
const KEYWORDS = new Set([
  // JS/TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case",
  "break", "continue", "new", "class", "extends", "implements", "interface", "type", "enum", "import",
  "export", "from", "as", "async", "await", "yield", "try", "catch", "finally", "throw", "typeof",
  "instanceof", "in", "of", "delete", "void", "this", "super", "static", "readonly", "public",
  "private", "protected", "abstract", "declare", "namespace", "satisfies", "keyof", "infer",
  // Shared with Python / Go / Rust / shell
  "def", "elif", "lambda", "pass", "raise", "with", "global", "nonlocal", "and", "or", "not",
  "func", "package", "defer", "go", "chan", "select", "struct", "map", "range", "fn", "let mut",
  "impl", "trait", "pub", "use", "mod", "match", "loop", "where", "echo", "then", "fi", "esac", "local",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "NaN", "Infinity"]);

/** Colours one line of code. Input must be plain text — no ANSI. */
export function highlight(line: string, lang = ""): string {
  // A whole-line comment is the common case and needs no tokenising.
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("*/")) {
    return c.gray(line);
  }
  if ((lang === "" || isHash(lang)) && trimmed.startsWith("#")) return c.gray(line);

  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    // Comment to end of line.
    if (ch === "/" && line[i + 1] === "/") {
      out += c.gray(line.slice(i));
      break;
    }

    // Block comment, opened or closed on this line.
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const stop = end === -1 ? line.length : end + 2;
      out += c.gray(line.slice(i, stop));
      i = stop;
      continue;
    }

    // String or template literal. An unterminated one runs to end of line
    // rather than swallowing the next.
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      const stop = Math.min(j + 1, line.length);
      out += c.yellow(line.slice(i, stop));
      i = stop;
      continue;
    }

    // Number.
    if (/[0-9]/.test(ch) && !/[A-Za-z_$]/.test(line[i - 1] ?? "")) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX_.]/.test(line[j])) j++;
      out += c.brightMagenta(line.slice(i, j));
      i = j;
      continue;
    }

    // Word: keyword, literal, type-ish or plain. The first char is consumed
    // unconditionally: '@' starts a word without being a word character, and
    // taking it through the loop instead once left `i` stuck on a zero-length
    // word — "@keyframes" in a diff froze the whole process.
    if (/[A-Za-z_$@]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      const next = line[j];
      if (KEYWORDS.has(word)) out += c.brightMagenta(word);
      else if (LITERALS.has(word)) out += c.brightMagenta(word);
      else if (next === "(") out += c.brightCyan(word);
      // Capitalised words are types often enough to be worth colouring.
      else if (/^[A-Z]/.test(word)) out += c.cyan(word);
      else out += word;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function isHash(lang: string): boolean {
  return /^(py|python|sh|bash|zsh|yml|yaml|toml|rb|ruby|conf|ini)$/i.test(lang);
}

/** Language hint from a path, used only to decide what `#` means. */
export function langOf(pathLike: string): string {
  const dot = pathLike.lastIndexOf(".");
  return dot === -1 ? "" : pathLike.slice(dot + 1).toLowerCase();
}
