/**
 * Bounding tool output at the moment it is produced.
 *
 * An agent loop re-sends the whole history on every step, so a provider-side
 * prompt cache only pays off while the history is *append-only*: change one
 * byte at position i and everything after it is a miss, re-prefilled at full
 * price on that step and every step until it is changed again.
 *
 * Shortening old tool results on the wire (session/trim.ts) breaks exactly
 * that. Its stub is deterministic, but the *set* of messages it applies to
 * moves forward one step at a time, so on every step some message in the
 * middle of the history is rewritten — and the whole tail behind it is paid
 * for again. Measured on real sessions: 76.7% cache hit-rate against a 99%
 * ceiling, the missing quarter being precisely that sliding tail.
 *
 * So the result is bounded here, once, before it ever reaches the history —
 * and nothing that follows ever rewrites it. Nothing is lost either: the full
 * output is parked in `.trcode/artifacts/` and the context carries its path,
 * which the model pages through with `read` at the cost of what it asks for.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface SpillStore {
  /** Where full outputs are parked; created on first write. */
  dir: string;
  /** Path shown to the model, relative to the working directory. */
  rel: string;
  /**
   * Content hash → the call whose result it already was. Per agent, not per
   * session: a repeat is only worth collapsing to a pointer if the thing it
   * points at is in *this* agent's history, and a subagent cannot see the
   * lead's transcript.
   */
  seen: Map<string, { tool: string; ref: number; path?: string }>;
  /** Artifact numbering, shared by every agent writing into the same dir. */
  counter: { n: number };
}

export interface BoundOptions {
  tool: string;
  /**
   * Which end of a long result carries the answer. Logs and test runs end
   * with the thing that was asked for, so they keep their tail; a file read
   * or a listing keeps its head.
   */
  bias?: "head" | "tail";
  /** Characters kept in the context. 0 or less keeps everything. */
  limit: number;
  /** Results shorter than this are passed through untouched. */
  dedupeMin: number;
}

export interface BoundResult {
  content: string;
  /** Set when the full output was parked; the path is relative to cwd. */
  path?: string;
  /** Set when this result repeated one already in the history. */
  repeat?: boolean;
}

/** Days an artifact directory outlives the session that wrote it. */
const KEEP_DAYS = 7;

/**
 * Artifacts are working files for one session: once its history is gone, a
 * path in it points at nothing anyone will follow. Swept when a new store is
 * made — once per session, over a directory with a handful of entries.
 */
function prune(root: string, keep: string): void {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const name of fs.readdirSync(root)) {
      if (name === keep || name === ".gitignore") continue;
      const p = path.join(root, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* a directory that vanished under us needs no pruning */
      }
    }
  } catch {
    /* nothing written yet, or nowhere to write — either way nothing to sweep */
  }
}

export function createSpillStore(cwd: string, sessionId: string): SpillStore {
  const root = path.join(cwd, ".trcode", "artifacts");
  prune(root, sessionId);
  return {
    dir: path.join(root, sessionId),
    rel: [".trcode", "artifacts", sessionId].join("/"),
    seen: new Map(),
    counter: { n: 0 },
  };
}

/**
 * A store for a delegated run: the same directory and the same numbering, its
 * own record of what has been seen. Without the split, a subagent's first read
 * of a file the lead had already read would collapse to "identical to the
 * result above" — pointing at a transcript it has no access to.
 */
export function forkSpillStore(parent: SpillStore | undefined): SpillStore | undefined {
  if (!parent) return undefined;
  return { dir: parent.dir, rel: parent.rel, seen: new Map(), counter: parent.counter };
}

/**
 * Writes the full output beside the session and returns the path to hand the
 * model, or undefined when there is nowhere to write it — a one-shot run, a
 * read-only checkout. A failure here is never fatal: the caller still gets a
 * bounded result, it just says the rest is gone rather than where it is.
 */
function park(store: SpillStore, tool: string, n: number, body: string): string | undefined {
  try {
    fs.mkdirSync(store.dir, { recursive: true });
    // Artifacts are working files, not history: keep them out of the index
    // whatever the project's own ignore rules happen to say.
    const ignore = path.join(store.dir, "..", ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    const name = `${String(n).padStart(4, "0")}-${tool.replace(/[^a-z0-9_-]+/gi, "-")}.txt`;
    fs.writeFileSync(path.join(store.dir, name), body);
    return `${store.rel}/${name}`;
  } catch {
    return undefined;
  }
}

/** Cuts on a line boundary when one is near, so a fragment stays readable. */
function headSlice(body: string, n: number): string {
  const cut = body.slice(0, n);
  const nl = cut.lastIndexOf("\n");
  return nl > n * 0.6 ? cut.slice(0, nl) : cut;
}

function tailSlice(body: string, n: number): string {
  const cut = body.slice(-n);
  const nl = cut.indexOf("\n");
  return nl !== -1 && nl < n * 0.4 ? cut.slice(nl + 1) : cut;
}

/**
 * The form a tool result takes in the history. Called once per call, by the
 * agent loop, before the message is appended — never again afterwards.
 */
export function boundToolOutput(
  store: SpillStore | undefined,
  output: string,
  opts: BoundOptions,
): BoundResult {
  const body = output ?? "";
  if (body.length < Math.max(1, opts.dedupeMin)) return { content: body };

  const key = crypto.createHash("sha1").update(body).digest("hex");
  const prev = store?.seen.get(key);
  if (prev) {
    // Agents re-read the same file and re-run the same grep constantly, and
    // every copy is paid for again on every later step. The first one stays
    // verbatim above; this one says what it is — which is also the answer the
    // model was looking for when it read the file a second time.
    const where = prev.path ? `, or read ${prev.path}` : "";
    return {
      content:
        `[identical to the ${prev.tool} result earlier in this session (call #${prev.ref}) — ` +
        `unchanged since then. It is still above you in the transcript${where}.]`,
      repeat: true,
    };
  }

  const n = store ? ++store.counter.n : 0;
  if (opts.limit <= 0 || body.length <= opts.limit) {
    store?.seen.set(key, { tool: opts.tool, ref: n });
    return { content: body };
  }

  const parked = store ? park(store, opts.tool, n, body) : undefined;
  store?.seen.set(key, { tool: opts.tool, ref: n, path: parked });

  // A quarter of the budget goes to the end that matters less; neither end is
  // dropped outright, because a result with no head has no context and one
  // with no tail loses the summary the command was run for.
  const share = opts.bias === "tail" ? 0.25 : 0.75;
  const headBudget = Math.floor(opts.limit * share);
  const head = headSlice(body, headBudget);
  const tail = tailSlice(body, opts.limit - head.length);
  const omitted = body.length - head.length - tail.length;
  const rest = parked
    ? `Full output: ${parked} — read it with the read tool (offset/limit), or narrow the call.`
    : `The rest was not kept — narrow the call (offset/limit, a tighter pattern) if you need it.`;

  return {
    content: `${head}\n\n… [${omitted} characters omitted from the middle. ${rest}] …\n\n${tail}`,
    path: parked,
  };
}
