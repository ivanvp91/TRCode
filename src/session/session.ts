/** Session state: message history, persistence, resume. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../config.js";
import { removeProjection } from "./projection.js";
import { UsageTracker, historyTokens, type ModelUsage } from "../usage.js";
import type { Message } from "../types.js";

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Estimated history size. Recomputed on listing, so old files have it too. */
  tokens?: number;
  /** How many times this session has already been compacted. */
  compactions?: number;
}

interface SessionFile {
  meta: SessionMeta;
  messages: Message[];
  usage: ModelUsage[];
}

/**
 * Above this, a session file is certainly not empty: metadata and usage on
 * their own never come near it, and one stored message clears it easily.
 */
const EMPTY_SESSION_MAX_BYTES = 8 * 1024;

export class Session {
  readonly id: string;
  title: string;
  readonly cwd: string;
  model: string;
  readonly createdAt: number;
  messages: Message[] = [];
  usage: UsageTracker;
  /** Set once /compact or auto-compact has run, for the status line. */
  compactions = 0;

  constructor(opts: { id?: string; cwd: string; model: string; title?: string; createdAt?: number }) {
    this.id = opts.id ?? newId();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.title = opts.title ?? "";
    this.createdAt = opts.createdAt ?? Date.now();
    this.usage = new UsageTracker();
  }

  add(m: Message): void {
    this.messages.push({ ...m, meta: { ts: Date.now(), ...(m.meta ?? {}) } });
  }

  /** Messages the model sees, minus the system prompt (added at call time). */
  history(): Message[] {
    return this.messages;
  }

  lastUserText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "user" && typeof m.content === "string") return m.content;
    }
    return "";
  }

  file(): string {
    return path.join(sessionsDir(this.cwd), `${this.id}.json`);
  }

  /** Renames the session; an empty title falls back to the derived one. */
  rename(title: string): void {
    this.title = title.trim().slice(0, 120);
    if (this.messages.length) this.save();
  }

  save(): void {
    // A session with nothing in it is not worth a file: /new, a start with no
    // prompt and every exit used to leave one behind, and the list filled up
    // with dead entries nobody could tell apart.
    if (!this.messages.length) return;
    const payload: SessionFile = {
      meta: {
        id: this.id,
        title: this.title || deriveTitle(this),
        cwd: this.cwd,
        model: this.model,
        createdAt: this.createdAt,
        updatedAt: Date.now(),
        messageCount: this.messages.length,
        tokens: historyTokens(this.messages),
        compactions: this.compactions,
      },
      messages: this.messages,
      usage: this.usage.toJSON(),
    };
    try {
      fs.writeFileSync(this.file(), JSON.stringify(payload, null, 2));
    } catch {
      /* never let a disk hiccup kill the turn */
    }
  }

  static load(cwd: string, id: string): Session | null {
    try {
      const raw = fs.readFileSync(path.join(sessionsDir(cwd), `${id}.json`), "utf8");
      const data = JSON.parse(raw) as SessionFile;
      const s = new Session({
        id: data.meta.id,
        cwd: data.meta.cwd || cwd,
        model: data.meta.model,
        title: data.meta.title,
        createdAt: data.meta.createdAt,
      });
      s.messages = data.messages ?? [];
      s.usage = UsageTracker.fromJSON(data.usage);
      s.compactions = data.meta.compactions ?? 0;
      return s;
    } catch {
      return null;
    }
  }

  static list(cwd: string, limit = 30): SessionMeta[] {
    const dir = sessionsDir(cwd);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const n of names) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as SessionFile;
        const messages = data.messages ?? [];
        // Recompute rather than trust the stored count: files written by an
        // older build have no `tokens` field at all.
        if (!data?.meta?.id || !messages.length) continue;
        metas.push({ ...data.meta, messageCount: messages.length, tokens: historyTokens(messages) });
      } catch {
        /* skip corrupt files */
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** Removes a session file. Returns false when there was nothing to remove. */
  static remove(cwd: string, id: string): boolean {
    try {
      fs.unlinkSync(path.join(sessionsDir(cwd), `${id}.json`));
      removeProjection(cwd, id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes files left behind by earlier builds that saved empty sessions.
   * Only files with no messages at all — there is nothing in them to lose.
   */
  static pruneEmpty(cwd: string): number {
    const dir = sessionsDir(cwd);
    let removed = 0;
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return 0;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        // A session with even one message runs to several KB, so anything
        // larger than a stub cannot be empty. Reading and parsing every
        // transcript in the project — some of them hundreds of KB — to learn
        // that is the slowest thing startup used to do.
        if (fs.statSync(file).size > EMPTY_SESSION_MAX_BYTES) continue;
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as SessionFile;
        if ((data.messages ?? []).length) continue;
        fs.unlinkSync(file);
        removed++;
      } catch {
        /* leave anything unreadable alone */
      }
    }
    return removed;
  }

  static latest(cwd: string): Session | null {
    const [top] = Session.list(cwd, 1);
    return top ? Session.load(cwd, top.id) : null;
  }

  /**
   * A branch, not a rewind: a new session carrying this one's history up to
   * `at` messages, while the original stays untouched on disk and keeps its
   * checkpoint log. Tool-call pairs are never split — the cut moves back to
   * before the assistant message that issued them, the same rule trim lives
   * by; a history ending in a dangling tool result is one most hosts refuse.
   */
  static forkFrom(source: Session, at: number): Session | null {
    const messages = source.messages.slice(0, at);
    // Walk back over a trailing tool run so the cut lands between turns.
    while (messages.length && messages[messages.length - 1].role === "tool") messages.pop();
    if (messages.length && messages[messages.length - 1]?.tool_calls) messages.pop();
    const forked = new Session({
      cwd: source.cwd,
      model: source.model,
      title: (source.title || deriveTitle(source)).slice(0, 110) + " · fork",
      createdAt: Date.now(),
    });
    forked.messages = messages.map((m) => structuredClone(m));
    return forked;
  }
}

function newId(): string {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
  ].join("");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function deriveTitle(s: Session): string {
  const first = s.messages.find((m) => m.role === "user" && typeof m.content === "string");
  const text = (first?.content as string) ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "(untitled)";
}
