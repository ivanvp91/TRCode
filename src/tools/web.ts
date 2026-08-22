/**
 * Web tools: search and fetch. Both keyless on purpose — a search that needs
 * an API key is a search most installs will never make.
 *
 * `web_search` scrapes DuckDuckGo's no-JS HTML endpoint; it is the one major
 * engine that answers plain HTTP without tokens. The parsing is deliberately
 * tolerant: if the markup drifts, the tool degrades to an error the model can
 * read, not a crash.
 */
import type { ToolDef, ToolResult } from "../types.js";

const FETCH_TIMEOUT_MS = 20_000;
/** Kept from a fetched page; more only rides along in history unread. */
const MAX_PAGE_CHARS = 60_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) trcode-cli";

function withTimeout(outer: AbortSignal | undefined): AbortSignal {
  // AbortSignal.any: the tool dies with the turn, and on its own timeout.
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/** Entities that actually occur in titles and snippets. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * HTML → readable text: scripts/styles dropped, block tags become line
 * breaks, everything else is stripped. Not a DOM — a page the model reads
 * once does not justify one.
 */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .join("\n")
    .trim();
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Pulls results out of html.duckduckgo.com markup. Exported for the tests. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // Each result is an <a class="result__a" href="…">title</a> with a nearby
  // <a class="result__snippet">…</a>. Attribute order does vary.
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  for (let m; (m = snippetRe.exec(html)); ) snippets.push(htmlToText(m[1]));
  let i = 0;
  for (let m; (m = linkRe.exec(html)); i++) {
    let url = decodeEntities(m[1]);
    // DDG wraps targets as //duckduckgo.com/l/?uddg=<encoded>&rut=…
    const wrapped = /[?&]uddg=([^&]+)/.exec(url);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    if (url.startsWith("//")) url = "https:" + url;
    hits.push({ title: htmlToText(m[2]), url, snippet: snippets[i] ?? "" });
  }
  return hits.filter((h) => h.title && h.url.startsWith("http"));
}

export const webSearchTool: ToolDef = {
  name: "web_search",
  risk: "network",
  description:
    "Searches the web (DuckDuckGo) and returns titles, URLs and snippets. " +
    "Use for anything you do not know or that may have changed: current versions, prices, news, reviews, documentation. " +
    "Follow up with fetch on the most promising URL.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      limit: { type: "integer", description: "Max results (default 8)" },
    },
    required: ["query"],
  },
  summarize: (a) => String(a.query ?? ""),
  async run(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return { output: "Empty query.", isError: true };
    const ok = await ctx.confirm(webSearchTool, args);
    if (!ok) return { output: "The user rejected the search.", isError: true };

    let res: Response;
    try {
      res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: withTimeout(ctx.signal),
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      return { output: `Search failed: ${(err as Error).message}`, isError: true };
    }
    if (!res.ok) return { output: `Search failed: HTTP ${res.status}`, isError: true };

    const hits = parseDuckDuckGo(await res.text());
    if (!hits.length) {
      return { output: `No results for "${query}" (or the engine changed its markup).`, isError: true };
    }
    const limit = Math.min(Math.max(1, Number(args.limit ?? 8)), 20);
    const shown = hits.slice(0, limit);
    return {
      output: shown
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`)
        .join("\n\n"),
      display: `${shown.length} results`,
    };
  },
};

export const fetchTool: ToolDef = {
  name: "fetch",
  risk: "network",
  description:
    "Fetches a URL and returns the page as readable text (HTML is stripped). " +
    "Use after web_search, or when the user gives a link. JSON and plain text come back verbatim.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute http(s) URL to fetch" },
    },
    required: ["url"],
  },
  summarize: (a) => String(a.url ?? ""),
  async run(args, ctx): Promise<ToolResult> {
    const url = String(args.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return { output: `Not an http(s) URL: ${url || "(empty)"}`, isError: true };
    }
    const ok = await ctx.confirm(fetchTool, args);
    if (!ok) return { output: "The user rejected the fetch.", isError: true };

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/json,text/plain,*/*" },
        signal: withTimeout(ctx.signal),
        redirect: "follow",
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      return { output: `Fetch failed: ${(err as Error).message}`, isError: true };
    }
    if (!res.ok) return { output: `HTTP ${res.status} from ${url}`, isError: true };

    const type = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const text = /html/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw;
    const clipped =
      text.length > MAX_PAGE_CHARS
        ? text.slice(0, MAX_PAGE_CHARS) + `\n\n… [${text.length - MAX_PAGE_CHARS} more characters cut — the page goes on]`
        : text;
    return {
      output: clipped || "(the page had no readable text)",
      display: `${Math.round(text.length / 1000)}k chars${/html/i.test(type) ? " (html → text)" : ""}`,
    };
  },
};
