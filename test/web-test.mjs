/**
 * Web tools, offline: the HTML-to-text stripper and the DuckDuckGo result
 * parser run against fixtures — the suite must pass with no network.
 */
const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const { htmlToText, parseDuckDuckGo } = await import("../dist/tools/web.js");

// ── htmlToText ──────────────────────────────────────────────────────────────
{
  const page = `<html><head><title>T</title><style>.x{color:red}</style>
<script>var a = "<p>not text</p>";</script></head>
<body><h1>Заголовок</h1><p>Первый  абзац &amp; ссылка.</p>
<ul><li>пункт один</li><li>пункт два</li></ul>
<!-- comment --><div>хвост &#1090;&#1077;&#x43a;&#x441;&#x442;</div></body></html>`;
  const text = htmlToText(page);
  ok("скрипты и стили выброшены", !/var a|color:red/.test(text), text);
  ok("комментарии выброшены", !/comment/.test(text), text);
  ok("текст сохранён", /Заголовок/.test(text) && /Первый абзац & ссылка\./.test(text), text);
  ok("списки маркируются", /- пункт один/.test(text) && /- пункт два/.test(text), text);
  ok("числовые entity декодированы", /хвост текст/.test(text), text);
  ok("нет пустой простыни", !/\n\n\n/.test(text), JSON.stringify(text));
}

// ── parseDuckDuckGo ─────────────────────────────────────────────────────────
{
  const fixture = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example <b>Title</b></a>
  <a class="result__snippet" href="#">Snippet with &quot;quotes&quot; here</a>
</div>
<div class="result">
  <a class="result__a" href="https://plain.example.org/">Plain result</a>
  <a class="result__snippet" href="#">Second snippet</a>
</div>`;
  const hits = parseDuckDuckGo(fixture);
  ok("оба результата найдены", hits.length === 2, String(hits.length));
  ok("обёртка uddg развёрнута", hits[0]?.url === "https://example.com/page", hits[0]?.url);
  ok("заголовок очищен от тегов", hits[0]?.title === "Example Title", hits[0]?.title);
  ok("сниппет привязан и декодирован", /"quotes"/.test(hits[0]?.snippet ?? ""), hits[0]?.snippet);
  ok("прямые ссылки проходят как есть", hits[1]?.url === "https://plain.example.org/", hits[1]?.url);

  ok("мусор не превращается в результаты", parseDuckDuckGo("<html><body>nothing here</body></html>").length === 0);
}

// ── the tools ask permission and honour a refusal (no network involved) ─────
{
  const { webSearchTool, fetchTool } = await import("../dist/tools/web.js");
  const ctx = (allow) => ({
    cwd: process.cwd(), signal: new AbortController().signal, depth: 0,
    confirm: async () => allow, emit: () => {}, readFiles: new Set(),
  });
  const denied = await webSearchTool.run({ query: "anything" }, ctx(false));
  ok("отказ на поиск не уходит в сеть", denied.isError === true && /rejected/.test(denied.output), denied.output);
  const badUrl = await fetchTool.run({ url: "ftp://x" }, ctx(true));
  ok("не-http URL отклонён", badUrl.isError === true, badUrl.output);
}

let failed = 0;
for (const r of results) {
  if (r.ok) console.log("  ok   " + r.name);
  else { failed++; console.log("  FAIL " + r.name + (r.detail ? "\n       " + r.detail : "")); }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
