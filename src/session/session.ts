/** Session state: message history, persistence, resume. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../config.js";
import { removeProjection } from "./projection.js";
import type { Goal } from "./goal.js";
import type { OrchestrationState } from "./orchestration.js";
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
  /**
   * Auto-compaction attempts in the current cycle — the ladder's beacons. A
   * full compaction starts a new cycle and resets them; without the caps a
   * history that hovers at a threshold would be trimmed every turn instead of
   * ever reaching the next rung.
   */
  autoCompacts?: { light?: number; medium?: number };
  /** The persistent goal (/goal), if one was ever set. */
  goal?: Goal;
}

interface SessionFile {
  meta: SessionMeta;
  messages: Message[];
  usage: ModelUsage[];
  orchestration?: OrchestrationState;
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
  /**
   * Attempts per level since the last full compaction. The ladder reads these
   * to stop repeating a rung that has had its chances (see compact.ts).
   */
  autoCompacts: { light: number; medium: number } = { light: 0, medium: 0 };
  /** The persistent goal (/goal); null when none was set. */
  goal: Goal | null = null;
  orchestration: OrchestrationState | null = null;
  saveError: string | null = null;

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

  /** The saved title, or a name derived from the first user message. */
  get displayTitle(): string {
    return this.title || deriveTitle(this);
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
        autoCompacts: { ...this.autoCompacts },
        goal: this.goal ?? undefined,
      },
      messages: this.messages,
      usage: this.usage.toJSON(),
      orchestration: this.orchestration ?? undefined,
    };
    const file = this.file();
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    const backupTemp = `${file}.${crypto.randomUUID()}.bak.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { flag: "wx", mode: 0o600 });
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, backupTemp);
        fs.renameSync(backupTemp, `${file}.bak`);
      }
      fs.renameSync(temp, file);
      this.saveError = null;
    } catch (err) {
      const message = `Could not save session ${this.id}: ${(err as Error).message}`;
      if (this.saveError !== message) process.stderr.write(message + "\n");
      this.saveError = message;
    } finally {
      for (const p of [temp, backupTemp]) { try { fs.unlinkSync(p); } catch { /* absent */ } }
    }
  }

  static load(cwd: string, id: string): Session | null {
    try {
      if (!/^[\w-]+$/.test(id)) return null;
      const file = path.join(sessionsDir(cwd), `${id}.json`);
      let data: SessionFile;
      try { data = JSON.parse(fs.readFileSync(file, "utf8")) as SessionFile; }
      catch { data = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")) as SessionFile; }
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
      s.autoCompacts = {
        light: data.meta.autoCompacts?.light ?? 0,
        medium: data.meta.autoCompacts?.medium ?? 0,
      };
      s.goal = data.meta.goal ?? null;
      s.orchestration = data.orchestration ?? null;
      if (s.orchestration?.status === "running") {
        s.orchestration.status = "paused";
        for (const [id, status] of Object.entries(s.orchestration.statuses)) {
          if (status === "running") s.orchestration.statuses[id] = "interrupted";
        }
      }
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
      try { fs.unlinkSync(path.join(sessionsDir(cwd), `${id}.json.bak`)); } catch { /* absent */ }
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
    // The fork carries the same history, so it is at the same rung of the
    // ladder: the attempts made so far still apply.
    forked.autoCompacts = { ...source.autoCompacts };
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
