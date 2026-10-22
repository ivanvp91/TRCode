/**
 * The composer wraps on words, not on cells.
 *
 * Its rows are counted in characters, so a plain chunk of `inner` characters
 * lands wherever the count lands — "Например, в codex" came back as "cод" and
 * "ex" on the next row. The break belongs at the last space that fits, and a
 * word is only ever cut when it could not fit on a row of its own.
 */
const { wrapBuf, rowSpansOf, locatePos } = await import("../dist/ui/editor.js");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
}

const rows = (text, w) => wrapBuf(text, w).map((r) => r.replace(/\s+$/, ""));

{
  const text = "aaa bbb ccc";
  const got = rows(text, 8);
  check("a break goes at the space", JSON.stringify(got) === JSON.stringify(["aaa bbb", "ccc"]), JSON.stringify(got));
  check("the space stays at the end of the row", wrapBuf(text, 8)[0].endsWith(" "), JSON.stringify(wrapBuf(text, 8)));
}

{
  // The sentence from the report, at the widths the screenshot had room for.
  const text = "Когда во время сессии и ответа модели я отправляю второе сообщение, например в codex оно вставляется в текущее задание";
  for (const w of [20, 33, 40, 57]) {
    const raw = wrapBuf(text, w);
    // A row that does not end on a space has cut the word it ends with — only
    // fair when that word could not fit on a row of its own.
    const sawn = raw.some((r, i) => {
      if (i === raw.length - 1 || /\s$/.test(r)) return false;
      const word = r.split(/\s+/).pop() ?? "";
      return word.length <= w;
    });
    check(`no word is sawn in half at ${w} columns`, !sawn && raw.every((r) => r.length <= w), JSON.stringify(raw));
  }
}

{
  const text = "смотри docs/usage.md и src/ui/editor.ts";
  const got = rows(text, 16);
  check("a path that fits on a row moves there whole", got.some((r) => r.startsWith("docs/usage.md")), JSON.stringify(got));
}

{
  // Longer than any row: this one is cut, and cutting it is the only option.
  const text = "смотри docs/usage.md и src/ui/editor.ts";
  const got = wrapBuf(text, 12);
  check("a path longer than the row is cut by force", got.some((r) => r.replace(/\s+$/, "") === "docs/usage.m"), JSON.stringify(got));
}

{
  const token = "y".repeat(12);
  const got = wrapBuf(token, 5);
  check("a run with no space in it is cut by force", JSON.stringify(got) === JSON.stringify(["yyyyy", "yyyyy", "yy"]), JSON.stringify(got));
  check("and every row still fits", got.every((r) => r.length <= 5), JSON.stringify(got));
}

{
  const text = "первая строка ввода\nвторая строка ввода";
  const got = rows(text, 10);
  check("explicit newlines still start a row", got.length >= 4 && got.includes("первая"), JSON.stringify(got));
  check("an empty buffer is one empty row", JSON.stringify(wrapBuf("", 10)) === JSON.stringify([""]));
  check("a trailing newline keeps its empty row", JSON.stringify(wrapBuf("a\n", 10)) === JSON.stringify(["a", ""]));
}

{
  const text = "aaa bbb ccc";
  const spans = rowSpansOf(text, 8);
  const buf = text;
  const exact = spans.every((s) => wrapBuf(text, 8)[spans.indexOf(s)] === buf.slice(s.start, s.start + s.len));
  check("rows are contiguous slices of the buffer", exact, JSON.stringify(spans));
}

{
  const text = "aaa bbb ccc";
  const at = locatePos(text, 8, 8);
  check("a wrap boundary belongs to the row below", at.row === 1 && at.col === 0, JSON.stringify(at));
  const end = locatePos(text, text.length, 8);
  check("the end of the buffer sits at the end of the last row", end.row === 1 && end.col === 3, JSON.stringify(end));
  const boundary = locatePos(text, text.length - 1, 8);
  check("and the last character is on that row", boundary.row === 1 && boundary.col === 2, JSON.stringify(boundary));
}

{
  // A double space at a break is the break, not the start of the next row.
  const text = "ab  cd";
  const spans = rowSpansOf(text, 4);
  check("a row does not open on the space it broke at", wrapBuf(text, 4)[1] === "cd", JSON.stringify(wrapBuf(text, 4)));
  const onSpace = locatePos(text, 3, 4);
  check("a caret on that space stays on the row above", onSpace.row === 0, JSON.stringify(onSpace));
  check("spans never overlap", spans.every((s, i) => i === 0 || s.start >= spans[i - 1].start + spans[i - 1].len), JSON.stringify(spans));
}

{
  // An exact-width draft: the caret must not point at a row that is not drawn.
  const line = "x".repeat(12);
  const at = locatePos(line, line.length, 12);
  check("the caret on a full last row stays on it", at.row === 0 && at.col === 12, JSON.stringify(at));
  check("and the wrap produced one row, not two", rows(line, 12).length === 1, JSON.stringify(rows(line, 12)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
