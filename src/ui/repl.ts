/** Interactive REPL: input loop, turn execution, live transcript. */
import path from "node:path";
import os from "node:os";
import { c } from "./ansi.js";
import {
  MarkdownStream,
  Spinner,
  ThinkingStream,
  assistantPrefix,
  banner,
  ensureBlank,
  error,
  hint,
  info,
  line,
  padded,
  plural,
  renderMarkdownBlock,
  toolDone,
  rule,
  success,
  toolStart,
  truncate,
  userEcho,
  warn,
  wrapText,
} from "./render.js";
import { contentWidth, fmtAgo, fmtDuration } from "./layout.js";
// `t` and `count` are taken in this file by the turn totals.
import { t as tr, t, count as nOf } from "../i18n.js";
import { matchLibrary, designInjection, blendInjection, isDesignRequest } from "../ui-library/match.js";
import { listEntries, getEntry, type UiEntry } from "../ui-library/store.js";
import { pickUiEntry, extractEntryForm } from "./commands.js";
import { composeStatus, type StatusInfo } from "./inputbox.js";
import { expandPastes, rememberCollapsed } from "./paste.js";
import { InputEditor, PipeReader, setExtraNewlineKeys } from "./editor.js";
import { choose } from "./choice.js";
import { askLine } from "./prompt.js";
import { TurnBar, InterruptWatcher } from "./turnbar.js";
import { OrcaReporter } from "./orca.js";
import { pushConsumer } from "./stdin.js";
import { PermissionBroker } from "./permissions.js";
import { loadConfig, projectState, VERSION, type Config, type Effort } from "../config.js";
import { refreshCache, appliedUpdate, versionBadge } from "../update.js";
import { fetchModels, cachedModels, catalogIsFresh, effortFor, usableModels, resolveModelId, findModel, sameModelElsewhere } from "../provider/models.js";
import { defaultProviderId, hasProvider, modeFor, providerLabel, providerState, splitModelId, wireModelId } from "../provider/registry.js";

/**
 * The model a new session opens on: where this project was left, else where
 * the default provider was left, else the configured default model. The
 * project wins because switching repositories is switching tasks, and the
 * machine-wide state is about the last one worked on anywhere.
 */
function startingModel(cwd: string): string {
  const cfg = loadConfig();
  const here = projectState(cwd).model;
  // A provider logged out since then leaves its models unreachable; falling
  // through beats opening on a model every turn would 401 on.
  if (here && modeFor(splitModelId(here).providerId)) return here;
  const provider = defaultProviderId();
  const remembered = providerState(provider).model;
  // Only honour it while it still belongs to that provider — a config edited
  // by hand can leave the two disagreeing.
  if (remembered && splitModelId(remembered).providerId === provider) return remembered;
  return cfg.model;
}
import { ApiError, modelRejectsEffort } from "../provider/client.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { composePrompt, promptModelFor } from "../agent/promptwriter.js";
import { runAgent } from "../agent/loop.js";
import { buildTools, TodoStore } from "../tools/index.js";
import { shellTool } from "../tools/shell.js";
import { createSpillStore, type SpillStore } from "../tools/spill.js";
import { connectMcpServers, mcpPendingCount, mcpSettled } from "../mcp/client.js";
import { discoverSkills, type Skill } from "../skills/loader.js";
import { pickSkill, skillInjection, skillInterjector } from "../skills/match.js";
import { Session } from "../session/session.js";
import { loadInputHistory, saveInputHistory, dropSessionHistory } from "../session/history.js";
import { compactSession, contextPressure, shouldAutoCompact } from "../session/compact.js";
import { markTurn, pruneOrphanStores, recordWrite } from "../session/checkpoint.js";
import { UsageTracker, estimateTokens, fmtTokens } from "../usage.js";
import type { Message, ModelInfo, ToolCall, ToolContext, ToolDef } from "../types.js";
import { runCommand, isCommand, commandNames, commandSuggestions, printCommandIndex } from "./commands.js";

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

/**
 * A share, as a percentage that cannot exceed 100. Hosts disagree on whether
 * the prompt count includes the cache read; the counts are reconciled on the
 * way in, and this keeps a stray one from printing "793% cached".
 */
function pctOf(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

export class App {
  cwd: string;
  cfg: Config;
  catalog: ModelInfo[] = [];
  session: Session;
  skills: Skill[];
  /**
   * Skills that actually go into requests: nothing while `skillsEnabled` is
   * off (the default), so their ~1-2k-token catalogue stays out of every
   * request for the projects that never use them. `/skills on` flips it.
   */
  get activeSkills(): Skill[] {
    return this.cfg.skillsEnabled ? this.skills : [];
  }
  /** Memory joins requests only while enabled: /memory off drops both halves. */
  get memoryOn(): boolean {
    return this.cfg.memoryEnabled !== false;
  }
  /** The active preset: an explicit override wins over the config value. */
  get preset(): "standard" | "minimal" {
    return this.presetOverride ?? this.cfg.preset ?? "standard";
  }
  /** Code mode: on when forced on; "auto" stays off until models are vetted. */
  get codeModeOn(): boolean {
    return this.cfg.codeMode === true;
  }
  todo = new TodoStore();
  broker: PermissionBroker;
  usage: UsageTracker;
  readFiles = new Set<string>();
  effortOverride?: Effort;
  /**
   * Session tool preset. Config is the default; the CLI flag and /preset write
   * here, so a resumed session keeps its preset rather than the config's.
   */
  presetOverride?: "standard" | "minimal";
  /** Full reasoning of the last turn, for /reasoning. */
  lastReasoning = "";
  /** Skills whose body is already in the history — auto-loaded or asked for. */
  loadedSkills = new Set<string>();

  private abort: AbortController | null = null;
  private quitting = false;
  private tools: ToolDef[] = [];

  /** The input frame. Commands reach it to seed the next line — see /edit. */
  editor: InputEditor | null = null;
  private pipe: PipeReader | null = null;
  private history: string[] = [];
  /** Messages queued from the turn bar while the model was working. */
  private pending: string[] = [];
  /** Messages waiting to be sent; read by tests, and by nothing else. */
  get pendingCount(): number {
    return this.pending.length;
  }
  /** The bottom bar of the running turn, so prompts can step around it. */
  private bar: TurnBar | null = null;
  /** Highest context threshold already mentioned, so it is said once. */
  private nudgedAt = 0;
  private nudgeKey = "";
  /** Models already warned about a cache that never engages — once per session. */
  private cacheMissNudged = new Set<string>();
  /** Lines from background work (MCP connects), held while the editor draws. */
  private heldNotices: { kind: "info" | "warn"; text: string }[] = [];
  /** The empty-UI-library notice is said once per session, not per request. */
  private uilibNoticeShown = false;
  /**
   * Set by the uilib capture/blend prompts: when that turn stops, the entry
   * form goes through a confirm / edit / reject gate instead of free text.
   */
  pendingUilibGate: ((proposal: string) => Promise<void>) | null = null;
  /** The next turn is a uilib capture/blend — no design-reference matching. */
  skipNextDesignMatch = false;
  /** Rolling preview of subagent actions; lives in the turn bar, not the transcript. */
  private activityLines: string[] = [];
  private activityActive = 0;
  private readonly subagentActivity = {
    begin: () => {
      this.activityActive++;
    },
    push: (l: string) => {
      this.activityLines.push(l);
      if (this.activityLines.length > 8) this.activityLines.shift();
      this.bar?.setThinking([...this.activityLines]);
    },
    end: () => {
      this.activityActive = Math.max(0, this.activityActive - 1);
      if (!this.activityActive) {
        this.activityLines = [];
        this.bar?.setThinking([]);
      }
    },
  };
  /** Pane status reporting, when this process runs inside Orca. */
  private orca = OrcaReporter.detect();
  /** Releases the turn-cancel key listener; null when no turn is running. */
  private turnKeys: (() => void) | null = null;

  constructor(opts: { cwd: string; model?: string; autoApprove?: boolean; session?: Session }) {
    this.cwd = opts.cwd;
    this.cfg = loadConfig();
    // Filled by init()'s rebuildTools(), which scans the skill directories
    // anyway — doing it here too means walking them twice on every launch.
    this.skills = [];
    this.broker = new PermissionBroker({
      autoApprove: opts.autoApprove,
      interactive: process.stdin.isTTY,
      exclusive: (fn) => this.exclusiveInput(fn),
    });
    this.broker.onWaiting = (tool, detail) => this.orca?.waiting(tool, detail);
    this.broker.onAnswered = () => this.orca?.busy(this.session.id);
    // Esc at a permission prompt ends the turn. Denying just this one tool
    // leaves the model going, and the next tool asks again — which is what a
    // stuck session looks like from the outside.
    this.broker.onCancel = () => this.abort?.abort();
    this.session = opts.session ?? new Session({ cwd: this.cwd, model: opts.model ?? startingModel(this.cwd) });
    if (opts.model) this.session.model = opts.model;
    // Recall is scoped to the session: another conversation's prompts are
    // noise here, the same way another project's are.
    this.history = loadInputHistory(this.cwd, this.session.id);
    setExtraNewlineKeys(this.cfg.newlineKeys ?? []);
    // A resumed session keeps its own model, so only a fresh one inherits the
    // remembered reasoning budget — this project's, else the provider's.
    if (!opts.session && !opts.model) {
      this.effortOverride = projectState(this.cwd).effort ?? providerState(defaultProviderId()).effort;
    }
    this.usage = this.session.usage;
  }

  async init(): Promise<void> {
    Session.pruneEmpty(this.cwd);
    pruneOrphanStores(this.cwd);
    // When every provider's catalog is already on disk this costs a file read;
    // when one of them would have to be asked over the network, the prompt
    // opens on the cached catalog instead and the refresh lands behind it. A
    // provider that is slow, unpaid or down must never delay the input box.
    const fresh = catalogIsFresh();
    this.catalog = fresh ? await fetchModels() : cachedModels();
    this.reconcileModel();
    this.rebuildTools();
    if (!fresh) {
      void fetchModels()
        .then((catalog) => {
          if (!catalog.length) return;
          this.catalog = catalog;
          this.reconcileModel();
          // Tools carry a snapshot of the catalog, so they are rebuilt on the
          // new one the same way an MCP server joining does it.
          this.rebuildTools();
        })
        .catch(() => {});
    }
    // MCP servers connect in the background: a cold `npx` can take a minute,
    // and the prompt must not wait on it. Tools join the registry as each
    // server comes up.
    connectMcpServers(this.cwd, (client) => {
      this.rebuildTools();
      if (client.state === "ready") {
        this.notice("info", tr(`MCP ${client.id}: ${client.tools.length} tools connected.`, `MCP ${client.id}: подключено инструментов: ${client.tools.length}.`));
      } else {
        this.notice("warn", tr(`MCP ${client.id} failed: ${client.detail}`, `MCP ${client.id} не подключился: ${client.detail}`));
      }
    });
    // The release check rides along in the background: at most one GET every
    // six hours, and when it finds something the header is reprinted with a
    // starred version — the same way a model switch reaches it.
    if (this.cfg.updateCheck !== false) {
      void refreshCache()
        .then(() => {
          if (versionBadge().text.includes("*")) this.repaintHeader();
        })
        .catch(() => {});
    }
  }

  /**
   * A model saved in the config or an old session may not exist on this host
   * (renamed catalog, switched endpoint). Falling back beats a 404 per turn.
   */
  private reconcileModel(): void {
    if (this.catalog.length < 2) return;
    const known = (id: string) => this.catalog.some((m) => m.id === id);
    if (known(this.session.model)) return;

    // An alias or a shorthand ("k3") reaches here unresolved on some paths.
    try {
      const resolved = resolveModelId(this.session.model, this.catalog);
      if (resolved !== this.session.model) {
        this.session.model = resolved;
        return;
      }
    } catch {
      /* genuinely unknown — fall through to the fallback below */
    }

    const stale = this.session.model;
    const fallback = known(this.cfg.model) ? this.cfg.model : usableModels(this.catalog)[0]?.id;
    if (!fallback) return;
    this.session.model = fallback;
    warn(tr(`Model "${stale}" is not in the ${this.cfg.baseUrl} catalog — switched to ${fallback}.`, `Модели "${stale}" нет в каталоге ${this.cfg.baseUrl} — переключился на ${fallback}.`));
  }

  rebuildTools(): void {
    this.skills = discoverSkills(this.cwd);
    // A skill's body lives in the history, so what counts as already loaded
    // follows the current session — /new and /resume swap it underneath. It
    // gets there two ways: injected by auto-selection, or returned by the tool.
    this.loadedSkills = new Set();
    for (const m of this.session.messages) {
      if (m.meta?.skill) this.loadedSkills.add(m.meta.skill);
      else if (m.role === "tool") {
        const hit = /^<skill name="([^"]+)"/.exec(String(m.content ?? ""));
        if (hit) this.loadedSkills.add(hit[1]);
      }
    }
    this.tools = buildTools({
      skills: this.activeSkills,
      loadedSkills: this.loadedSkills,
      todo: this.todo,
      onTodoChange: () => {},
      cwd: this.memoryOn ? this.cwd : undefined,
      preset: this.preset,
      runCode: this.codeModeOn
        ? {
            confirmShell: (command) =>
              this.broker.confirm({ ...shellTool, name: "run_code>shell" }, { command }),
            confirmWeb: (kind, target) =>
              this.broker.confirm(
                { name: kind === "fetch" ? "fetch" : "web_search", risk: "network", parameters: {}, description: "", run: async () => ({ output: "" }) } as any,
                kind === "fetch" ? { url: target } : { query: target },
              ),
          }
        : undefined,
      subagentDeps: {
        cwd: this.cwd,
        catalog: this.catalog,
        skills: this.skills,
        tools: () => this.tools,
        defaultModel: this.session.model,
        effortFor: (model) => effortFor(model, this.effortOverride),
        maxSteps: this.cfg.maxSteps,
        usage: this.usage,
        // In a pipe there is no bar to preview into — print steps as before.
        activity: process.stdout.isTTY ? this.subagentActivity : undefined,
      },
    });
  }

  /** Sends text as a turn, the same way a queued message is sent. */
  queue(text: string): void {
    this.pending.push(text);
  }

  /** Puts text in the input box for the user to finish. */
  prefill(text: string): void {
    this.editor?.prefill(text);
  }

  /**
   * Rewrites a short ask into a brief, on the small model. Returns null when
   * the writer fails or is interrupted: the user's own words are always a
   * usable fallback, and losing them to a failed rewrite would be absurd.
   */
  async composePrompt(task: string): Promise<string | null> {
    const model = promptModelFor(this.session.model, this.catalog);
    const label = tr(`writing the brief on ${wireModelId(model)}`, `пишу задание на ${wireModelId(model)}`);
    // Mid-turn the bar already owns the bottom of the screen and stdin; a
    // second spinner on top of it would hide the input frame. Idle (from
    // /prompt) still needs its own spinner and Esc listener.
    const bar = this.bar;
    const spinner = bar ? null : new Spinner(label);
    const ac = new AbortController();
    const composeWatch = bar ? null : new InterruptWatcher(() => ac.abort());
    const release = !bar && process.stdin.isTTY
      ? pushConsumer((buf) => void composeWatch!.feed(buf.toString("utf8")))
      : () => {};
    bar?.setLabel(label);
    spinner?.start();
    try {
      return await composePrompt({
        task,
        model,
        cwd: this.cwd,
        skills: this.activeSkills,
        catalog: this.catalog,
        effort: effortFor(model, this.effortOverride),
        signal: bar ? this.abort?.signal ?? ac.signal : ac.signal,
        usage: this.usage,
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") warn(tr("Interrupted.", "Прервано."));
      else warn(tr(`Could not write the brief: ${(err as Error).message}`, `Не удалось составить задание: ${(err as Error).message}`));
      return null;
    } finally {
      composeWatch?.stop();
      release();
      spinner?.stop();
      bar?.setLabel("thinking");
    }
  }

  /**
   * Automatic mode: a task worth rewriting is rewritten, a follow-up is not.
   *
   * "продолжи", "да", "нет" and their kind carry no task to expand, and a
   * request short enough to be one word is already as precise as it gets.
   * Prefixing a message with "!" says "these are my words, send them".
   */
  private async maybeRewrite(text: string): Promise<string> {
    if (this.cfg.promptMode !== "auto") return text;
    if (text.startsWith("!")) return text.slice(1).trimStart();
    if (text.length < 40) return text;
    if (/^(продолж|дальше|да|нет|ок|ok|yes|no|continue|go on|ещё|еще|стоп|stop)/i.test(text)) return text;
    const written = await this.composePrompt(text);
    if (!written || written === text) return text;
    line();
    padded(c.gray(tr("— brief —", "— задание —")));
    for (const l of wrapText(written, contentWidth() - 2)) padded(c.dim(l));
    hint(tr("/prompt off stops this; ! before a message skips it once", "/prompt off выключает это; ! перед сообщением — пропустить один раз"));
    return written;
  }

  toolContext(): ToolContext {
    return {
      cwd: this.cwd,
      signal: this.abort?.signal ?? new AbortController().signal,
      depth: 0,
      confirm: (tool, args, preview) => this.broker.confirm(tool, args, preview),
      previewShown: (preview) => this.broker.previewShown(preview),
      snapshot: (opts) => recordWrite(this.session, opts),
      emit: (l) => this.progress(l),
      readFiles: this.readFiles,
      spill: this.spillStore(),
    };
  }

  /**
   * Where oversized tool output goes, per session. Rebuilt when the session
   * underneath changes (/new, /resume): artifacts belong to the history that
   * points at them, and so does the record of what has already been seen.
   */
  private spilled?: { id: string; store: SpillStore };

  private spillStore(): SpillStore {
    if (this.spilled?.id !== this.session.id) {
      this.spilled = { id: this.session.id, store: createSpillStore(this.cwd, this.session.id) };
    }
    return this.spilled.store;
  }

  /**
   * A line of progress from a running tool — the live tail of a build, a
   * subagent's last step. It goes into the bar rather than the transcript: a
   * `gradle compileDebugKotlin` prints for minutes, and a screen that shows
   * nothing while it does is indistinguishable from one that has hung. The
   * transcript keeps the result; the bar keeps the movement.
   */
  progress(text: string): void {
    if (!this.bar) return void padded(c.dim(text));
    this.activityLines.push(text);
    if (this.activityLines.length > 8) this.activityLines.shift();
    this.bar.setThinking([...this.activityLines]);
  }

  /**
   * A panel of models on one question: each answers alone, then reads the
   * others and revises, then one writes the result. The rounds are printed as
   * they happen — a panel that thinks in silence for two minutes is a panel
   * nobody trusts — and the result joins the history as an ordinary turn, so
   * the session can carry on from it.
   */
  async runBrain(question: string, panel: string[]): Promise<void> {
    userEcho(question);
    const { runBrain, attachReferenced } = await import("../agent/brain.js");
    // Three models spending a minute each to answer "you have not given me
    // anything" is the one outcome worth spending nothing on. The panel reads
    // the session and the files the question names; when there is neither,
    // that is worth knowing before the run, not after it.
    if (!this.session.messages.length && !attachReferenced(this.cwd, question)) {
      warn(
        tr(
          "The panel will see only this question: the session is empty and no file is named in it.",
          "Совет увидит только сам вопрос: сессия пуста, и файл в нём не назван.",
        ),
      );
      hint(tr("Name one: /brain discuss ideas/001.md", "Назовите файл: /brain обсудите ideas/001.md"));
    }
    this.abort = new AbortController();
    // The same bar an ordinary turn runs under, and for the same reasons: it
    // is what holds the input frame, the status line and the queue. A panel
    // that runs for minutes behind a bare spinner takes the box off the screen
    // exactly when the user most wants to type the next thing.
    const bar = new TurnBar({
      status: () => composeStatus({ ...this.status(), hint: "esc to interrupt · enter to queue" }),
      onInterrupt: () => this.abort?.abort(),
      onToggleMode: () => this.toggleAutoApprove(),
      history: this.history,
    });
    this.bar = bar;
    const spinner = {
      setLabel: (l: string) => bar.setLabel(l),
      start: () => {},
      stop: () => {},
    };
    const started = Date.now();
    this.usage.beginTurn();
    bar.start();
    try {
      const res = await runBrain({
        task: question,
        models: panel,
        // The configured main model when it sits on the panel — the session's
        // model otherwise, which is how it worked before the choice existed.
        finalModel:
          this.cfg.brainMainModel && panel.includes(this.cfg.brainMainModel)
            ? this.cfg.brainMainModel
            : this.session.model,
        cwd: this.cwd,
        // What the user is looking at while asking. A question put mid-session
        // is usually about the session — "обсудите идею" is a pronoun — and the
        // panel has no history of its own to resolve it in. The question itself
        // is not in here yet; it joins the history below, once it is answered.
        history: this.session.messages,
        catalog: this.catalog,
        effortFor: (m) => effortFor(m, this.effortOverride),
        usage: this.usage,
        signal: this.abort.signal,
        events: {
          onStart: (model, round) => {
            spinner.setLabel(
              tr(`${wireModelId(model)} — ${round}`, `${wireModelId(model)} — ${{ answer: "отвечает", critique: "разбирает чужое", final: "сводит итог" }[round]}`),
            );
            spinner.start();
          },
          onAnswer: (model, round, text) => {
            if (round === "final") return;
            spinner.stop();
            ensureBlank();
            padded(
              c.bold(c.brightBlue(wireModelId(model))) +
                c.gray(round === "answer" ? tr("  · answer", "  · ответ") : tr("  · after reading the others", "  · после чужих ответов")),
            );
            // The round is markdown like any other answer: dimmed so it reads
            // as working material rather than the result, but still rendered —
            // wrapText handed the user raw `##`, `**` and pipe-tables in grey.
            for (const l of renderMarkdownBlock(text, { width: contentWidth() - 2, dim: true })) padded(l);
            spinner.start();
          },
          onFailed: (model, reason) => {
            spinner.stop();
            warn(tr(`${wireModelId(model)} dropped out: ${reason}`, `${wireModelId(model)} выбыл: ${reason}`));
            spinner.start();
          },
        },
      });
      spinner.stop();
      if (!res.final) return void error(tr("The panel produced nothing.", "Совет ничего не выдал."));

      ensureBlank();
      assistantPrefix(this.session.model);
      for (const l of renderMarkdownBlock(res.final)) padded(l);
      // Kept as an ordinary exchange: the next turn continues from the answer,
      // not from a transcript of how it was reached.
      this.session.add({ role: "user", content: question });
      this.session.add({ role: "assistant", content: res.final, meta: { model: this.session.model } });
      this.session.save();
      this.statusLine(Date.now() - started, res.panel.length, "stop");
    } catch (err) {
      if ((err as Error)?.name === "AbortError") warn(tr("Interrupted.", "Прервано."));
      else error((err as Error).message);
      this.suggestAnotherHost(err);
    } finally {
      // Same hand-back as an ordinary turn: what was typed while the panel ran
      // is queued, and an interrupt gives it back instead of sending it.
      const { queued, draft } = bar.stop();
      this.bar = null;
      const interrupted = Boolean(this.abort?.signal.aborted);
      if (interrupted) {
        const held = [...queued, draft].filter(Boolean).join("\n");
        if (held) this.editor?.prefill(held);
      } else {
        this.pending.push(...queued);
        if (draft) this.editor?.prefill(draft);
      }
      this.abort = null;
    }
  }

  toolList(): ToolDef[] {
    return this.tools;
  }

  /** Remembers a submitted line for arrow-key recall, per session, across restarts. */
  private recordInput(text: string): void {
    // Repeating the same line twice adds nothing to recall.
    if (this.history[this.history.length - 1] === text) return;
    this.history.push(text);
    if (this.history.length > 500) this.history.shift();
    saveInputHistory(this.cwd, this.history, this.session.id);
  }

  /** Input history follows the session, so /new and /resume reload it. */
  reloadHistory(): void {
    this.history.splice(0, this.history.length, ...loadInputHistory(this.cwd, this.session.id));
  }

  effort(): Effort {
    return effortFor(this.session.model, this.effortOverride);
  }

  /**
   * Flips confirmations on and off. Bound to Shift+Tab, so it happens without
   * leaving the input line; the status row states which mode is on, and that
   * row is re-read on every redraw.
   */
  toggleAutoApprove(): boolean {
    this.broker.autoApprove = !this.broker.autoApprove;
    return this.broker.autoApprove;
  }

  /** Prints the header box from live state. The tip is a startup-only nudge. */
  showBanner(opts: { tip?: boolean; compact?: boolean } = {}): void {
    const badge = versionBadge();
    banner({
      provider: providerLabel(splitModelId(this.session.model).providerId),
      model: this.session.model,
      effort: this.effort(),
      cwdLabel: this.cwd,
      sessionId: this.session.id,
      version: c.yellow(badge.text),
      versionNote: badge.note,
      tip: opts.tip ? this.startupTip() : undefined,
      compact: opts.compact,
    });
  }

  /**
   * Reprints the header under the transcript — fields only, no logo or
   * welcome, so a reprint can never look like the session restarting.
   *
   * A box already on screen cannot be edited — it is output, not a live region
   * — so the only way for the header to state the current provider, model and
   * budget is to reprint it. A clear only happens when asked for (/clear):
   * wiping on every switch read as losing the session, when nothing but the
   * header had changed.
   */
  repaintHeader(opts: { clear?: boolean } = {}): void {
    if (opts.clear && process.stdout.isTTY) {
      process.stdout.write(ESC + "[2J" + ESC + "[H");
      process.stdout.write(ESC + "]0;TRCode" + ESC + "\\");
    }
    this.showBanner({ compact: true });
  }

  private status(): StatusInfo {
    const { used, window } = contextPressure(this.session, this.catalog);
    return {
      mode: this.broker.autoApprove ? "yolo" : undefined,
      provider: providerLabel(splitModelId(this.session.model).providerId),
      model: this.session.model,
      effort: this.effort(),
      effortIgnored: modelRejectsEffort(this.session.model),
      cwdLabel: shortPath(this.cwd),
      contextUsed: used,
      contextWindow: window,
      contextEstimated: !findModel(this.session.model, this.catalog)?.contextWindow,
    };
  }

  /** Points at the one setting most worth changing right now, or nothing. */
  private startupTip(): { title: string; detail: string } | undefined {
    const model = this.session.model;
    if (/free/.test(model)) {
      return {
        title: "The free model is slow — it waits in a shared queue",
        detail: "/model k3 switches to the full Kimi K3 · /model opens the catalog by vendor",
      };
    }
    if (this.effort() === "off") {
      return {
        title: "Reasoning budget is off",
        detail: "/effort high is markedly better on multi-step work · add save to make it the default",
      };
    }
    if (this.cfg.skillsEnabled && !this.skills.length) {
      return {
        title: "No skills yet — worth adding for work you repeat",
        detail: "/skills new <name> scaffolds one · /skills lists them",
      };
    }
    return {
      title: "A big task does not have to fit in one turn",
      detail: "/orchestrate <task> splits it into subtasks and runs them on subagents",
    };
  }

  // ── input loop ────────────────────────────────────────────────────────────

  async run(initialPrompt?: string): Promise<void> {
    if (process.stdout.isTTY) process.stdout.write(ESC + "]0;TRCode" + ESC + "\\");
    this.showBanner({ tip: true });
    if (!hasProvider()) {
      warn(tr("No provider connected. Run ", "Поставщик не подключён. Наберите ") + c.bold("/login") + tr(" or ", " или ") + c.bold("trc auth login") + ".");
      line();
    }
    if (this.session.messages.length) this.replayHistory();

    process.on("SIGINT", () => this.onSigint());

    if (initialPrompt?.trim()) await this.turn(initialPrompt.trim());

    while (!this.quitting) {
      // Messages typed while the previous turn was running go first.
      let text: string;
      if (this.pending.length) {
        text = (this.pending.shift() ?? "").trim();
      } else {
        const input = await this.readInput();
        if (input === null) break;
        text = input.trim();
      }
      if (!text) continue;
      this.recordInput(text);

      if (isCommand(text)) {
        try {
          const keepGoing = await runCommand(this, text);
          if (!keepGoing) break;
        } catch (err) {
          error((err as Error).message);
        }
        continue;
      }

      // The frame held tokens for whatever was pasted; the model gets the
      // text itself. Recall keeps the short form — that is the point of it.
      await this.turn(expandPastes(text));
    }

    this.session.save();
    line();
    hint("Session saved: " + this.session.id);
  }

  /**
   * Runs `fn` with sole ownership of stdin. The editor is idle while commands
   * run, so this only has to step aside for the turn-cancel key listener.
   */
  async exclusiveInput<T>(fn: () => Promise<T>): Promise<T> {
    const hadTurnKeys = Boolean(this.turnKeys);
    if (hadTurnKeys) this.detachTurnKeys();
    // A permission prompt draws its own rows; the bar has to get out of the
    // way or the two fight over the bottom of the screen.
    const bar = this.bar;
    bar?.pause();
    try {
      return await fn();
    } finally {
      bar?.resume();
      if (hadTurnKeys && this.abort && !this.abort.signal.aborted) this.attachTurnKeys();
    }
  }

  /**
   * A background message during a turn goes through the footer machinery and
   * prints cleanly; over the idle editor it would land inside the input frame
   * and desync it. Held lines come out right before the next prompt draw.
   */
  private notice(kind: "info" | "warn", text: string): void {
    if (this.bar) (kind === "info" ? info : warn)(text);
    else this.heldNotices.push({ kind, text });
  }

  private flushNotices(): void {
    for (const n of this.heldNotices) (n.kind === "info" ? info : warn)(n.text);
    this.heldNotices = [];
  }

  private readInput(): Promise<string | null> {
    this.flushNotices();
    if (!process.stdin.isTTY) {
      this.pipe ??= new PipeReader();
      return this.pipe.read();
    }
    this.editor ??= new InputEditor({
      status: () => composeStatus(this.status()),
      history: this.history,
      complete: (partial) => commandNames().filter((n) => n.startsWith(partial)),
      suggest: (buffer) => commandSuggestions(buffer),
      suggestRows: 6,
      onToggleMode: () => this.toggleAutoApprove(),
    });
    return this.editor.read();
  }

  private onSigint(): void {
    if (this.abort && !this.abort.signal.aborted) {
      this.abort.abort();
      return;
    }
    this.quitting = true;
    // Leaving the bar installed would keep repainting over the farewell.
    this.bar?.stop();
    this.bar = null;
    line();
    hint("Bye.");
    this.session.save();
    // Unblock the pending read so run() can unwind and restore the terminal.
    this.detachTurnKeys();
    this.editor?.cancel();
    process.exitCode = 0;
  }

  /**
   * Prints a restored conversation. Without this a resumed session looks empty
   * and indistinguishable from a lost one, even though the history is loaded.
   */
  replayHistory(maxTurns = 4): void {
    const msgs = this.session.messages;
    const userIdx: number[] = [];
    msgs.forEach((m, i) => {
      if (m.role === "user" && !m.meta?.hidden && !m.meta?.skill) userIdx.push(i);
    });
    const from = userIdx.length > maxTurns ? userIdx[userIdx.length - maxTurns] : 0;
    const skipped = userIdx.filter((i) => i < from).length;
    const { used, window } = contextPressure(this.session, this.catalog);
    const w = contentWidth();

    line();
    rule(c.gray(` resumed · ${this.session.id} `));
    padded(
      c.gray(
        `${msgs.length} ${plural(msgs.length, "message", "messages")} · ~${fmtTokens(used)} of ${fmtTokens(window)} tokens ` +
          `(${Math.round((used / window) * 100)}%) · ${this.session.model}` +
          (this.session.compactions
            ? tr(` · compacted ${this.session.compactions}×`, ` · сжатий: ${this.session.compactions}`)
            : ""),
      ),
    );
    // A bare "N prompts folded away" left the session unnavigable: one line
    // per earlier prompt is a table of contents, not a wall of text.
    if (skipped) {
      line();
      padded(c.gray(tr("Earlier in this session:", "Ранее в сессии:")));
      const folded = userIdx.filter((i) => i < from);
      const MAX_TOC = 30;
      if (folded.length > MAX_TOC) {
        padded(c.gray(`  … ${tr(`${folded.length - MAX_TOC} older prompts skipped`, `пропущено более ранних: ${folded.length - MAX_TOC}`)}`));
      }
      for (const i of folded.slice(-MAX_TOC)) {
        const m = msgs[i];
        const text = String(m.content ?? "");
        const label = /^<compacted-context>/.test(text)
          ? tr("(compacted context)", "(сжатый контекст)")
          : text.replace(/\s+/g, " ").trim();
        const ago = m.meta?.ts ? c.gray(` · ${fmtAgo(m.meta.ts)}`) : "";
        padded(c.gray("  ✦ ") + c.dim(truncate(label, Math.max(20, w - 16))) + ago);
      }
    }

    // The last answer is the one being continued from, so it is shown whole;
    // earlier ones are capped only to keep the scrollback usable.
    const lastAnswer = msgs.reduce((at, m, i) => (m.role === "assistant" && m.content ? i : at), -1);

    for (const [at, m] of msgs.slice(from).entries()) {
      const idx = from + at;
      if (m.meta?.hidden) continue;
      // An auto-loaded skill is a procedure for the model, not conversation.
      if (m.meta?.skill) {
        padded(c.gray(`  ⚡ skill ${m.meta.skill}`));
        continue;
      }

      if (m.role === "user") {
        const text = String(m.content ?? "");
        line();
        const digest = text.match(/^<compacted-context>\n?([\s\S]*?)\n?<\/compacted-context>$/);
        if (digest) {
          // The digest is the whole earlier history — show it as a labelled
          // block, not as a user prompt with XML tags around it.
          padded(c.brightBlue("▍") + " " + c.bold(c.brightBlue(tr("compacted context", "сжатый контекст"))));
          const body = digest[1].replace(/^The earlier part of this session[^\n]*\n+/, "");
          for (const l of renderMarkdownBlock(body, { width: w - 2, maxLines: 12, dim: true })) {
            padded(c.gray("▍ ") + l);
          }
          continue;
        }
        // Same rule as the live echo: five lines and a handle. A replayed
        // session that opens with a pasted log buries the conversation it is
        // supposed to be reminding you of.
        const rows = renderMarkdownBlock(text, { width: w - 2 });
        const cut = rows.length > 7;
        for (const [i, l] of (cut ? rows.slice(0, 5) : rows).entries()) {
          padded((i === 0 ? c.brightYellow("✦ ") : "  ") + c.bold(l));
        }
        if (cut) {
          rememberCollapsed(text);
          padded(
            "  " +
              c.gray(
                tr(
                  `… ${rows.length - 5} more lines · ctrl+o to see all of it`,
                  `… ещё строк: ${rows.length - 5} · ctrl+o — показать целиком`,
                ),
              ),
          );
        }
        continue;
      }

      if (m.role === "assistant") {
        if (m.content) {
          line();
          padded(c.brightMagenta("●") + " " + c.dim(m.meta?.model ?? this.session.model));
          // Same styling as a live answer — a replay that dims everything
          // reads as if the formatting had been thrown away.
          for (const l of renderMarkdownBlock(String(m.content), {
            width: w,
            maxLines: idx === lastAnswer ? 200 : 24,
          })) {
            padded(l);
          }
        }
        const calls = m.tool_calls ?? [];
        if (calls.length) ensureBlank();
        for (const tc of calls.slice(0, 3)) {
          padded("  " + c.brightCyan("⏺ ") + c.dim(tc.function.name) + c.gray(`(${truncate(tc.function.arguments, 54)})`));
        }
        if (calls.length > 3) {
          padded("    " + c.gray(`… ${calls.length - 3} more tool ${plural(calls.length - 3, "call", "calls")}`));
        }
        continue;
      }
      // Tool results are noise in a replay; the call above already says enough.
    }

    line();
    rule(c.gray(" continuing "));
    line();
  }

  // ── cancellation ──────────────────────────────────────────────────────────

  /** Esc (and Ctrl+C) cancel the running turn. */
  private attachTurnKeys(): void {
    if (!process.stdin.isTTY || this.turnKeys) return;
    // Same reading as the turn bar's: a chunk carrying an Esc keypress, not
    // only a chunk that is nothing but Esc — and not an escape sequence split
    // across two reads, which is a cursor key, not a cancel.
    const watch = new InterruptWatcher(() => this.abort?.abort());
    const release = pushConsumer((buf) => void watch.feed(buf.toString("utf8")));
    this.turnKeys = () => {
      watch.stop();
      release();
    };
  }

  private detachTurnKeys(): void {
    if (!this.turnKeys) return;
    this.turnKeys();
    this.turnKeys = null;
  }

  // ── one turn ──────────────────────────────────────────────────────────────

  /**
   * Puts a matching skill into the history before the model answers.
   *
   * The catalogue in the system prompt only invites the model to call the
   * `skill` tool, and the request where the procedure would have mattered is
   * exactly the one a hurried model answers straight away. Matching on the
   * skill's own trigger words is deterministic and costs a match, not a turn.
   * The body lands once per session: it stays in the history afterwards, so
   * re-sending it on every mention of the same word would be paying twice.
   */
  private autoLoadSkill(text: string): void {
    if (!this.cfg.skillsEnabled || this.cfg.skillAuto === false) return;
    const pick = pickSkill(this.skills, text, { exclude: this.loadedSkills });
    if (!pick) return;

    this.loadedSkills.add(pick.skill.name);
    this.session.add({
      role: "user",
      content: skillInjection(pick.skill),
      meta: { skill: pick.skill.name },
    });
    hint(`⚡ skill ${pick.skill.name} — ${pick.matched.slice(0, 3).join(", ")}`);
  }

  /** The reply just streamed, for the gate that reads the proposed entry form. */
  private lastAssistantText(): string {
    const msgs = this.session.history();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content;
    }
    return "";
  }

  /**
   * Confirm / edit / reject buttons for a proposed library entry, shown when
   * the capture or blend turn stops at the form instead of writing files.
   * Confirm re-sends the form as the user's own message — with corrections,
   * when any field was edited — so the model writes exactly what was approved.
   */
  async confirmUiEntry(proposal: string): Promise<void> {
    this.pendingUilibGate = null;
    if (!proposal) return;
    // A model that ignored "stop and wait" has already written the files;
    // confirming again would just bounce off an existing folder.
    const slug = /^\s*(?:[-*]\s*)?slug\s*[:=]\s*["'`]?([\w-]+)/im.exec(proposal)?.[1];
    if (slug && getEntry(slug)) {
      hint(t(`Already saved as ${slug}.`, `Уже сохранено как ${slug}.`));
      return;
    }
    line();
    padded(c.bold(t("Proposed library entry:", "Предложен макет для библиотеки:")));
    hint(c.gray(t("Confirm saves it; Edit lets you correct the fields first.", "Подтвердить — сохранить; Изменить — сначала поправить поля.")));

    const answer = await this.exclusiveInput(() =>
      choose<"confirm" | "edit" | "reject">(
        [
          { value: "confirm", label: t("Confirm", "Подтвердить"), key: "y", tone: "ok" },
          { value: "edit", label: t("Edit", "Изменить"), key: "e" },
          { value: "reject", label: t("Reject", "Отменить"), key: "n", tone: "danger" },
        ],
        { initial: "confirm", fallback: "reject", cancel: () => {} },
      ),
    );

    // The answer to the gate talks about a mockup and asks for none: without
    // the flag it goes back through the design matcher on its way out, and
    // the library offers to draw the very entry being saved. Armed at each
    // send, not once here, so an edit cancelled halfway leaves nothing armed.
    if (answer === "reject") {
      this.skipNextDesignMatch = true;
      this.queue(t("REJECTED — do not save anything to the UI library.", "ОТМЕНЕНО — ничего не сохраняй в библиотеку макетов."));
      return;
    }

    let form = extractEntryForm(proposal);
    if (answer === "edit") {
      const edited = await this.editEntryForm(form);
      if (!edited) return; // cancelled mid-edit
      form = edited;
    }
    this.skipNextDesignMatch = true;
    this.queue(`CONFIRMED — save it now.\n\n${form}`);
  }

  /** Steps through the four fields of the proposal, each prefilled. */
  private async editEntryForm(form: string): Promise<string | null> {
    const fields = ["slug", "title", "summary", "keywords"];
    const current: Record<string, string> = {};
    for (const f of fields) current[f] = "";
    const lines = form.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      const m = /^(slug|title|summary|keywords)\s*[:=]\s*(.*)$/i.exec(l);
      if (m) current[m[1].toLowerCase()] = m[2];
    }
    const out: string[] = [];
    for (const f of fields) {
      const v = await this.exclusiveInput(() => askLine(`${f}:`, current[f]));
      if (v === null) return null;
      out.push(`${f}: ${v}`);
    }
    return out.join("\n");
  }

  /**
   * The UI library's half of auto-selection: a request that asks for a design
   * gets the matching saved mockup injected as the visual reference — after
   * picking it in the library picker, unless there is exactly one hit and it
   * stands alone by a wide margin, in which case the pick is made for the user.
   *
   * An empty library only gets told about once per session: a notice that
   * repeats on every design request is noise, not discovery.
   */
  private async autoLoadDesign(text: string): Promise<void> {
    // A capture/blend prompt is about the library itself — offering its own
    // entries as the reference for saving a new one is circular.
    if (this.skipNextDesignMatch) {
      this.skipNextDesignMatch = false;
      return;
    }
    if (!this.cfg.uilibAuto) return;
    // Asking for a design is the gate, not merely mentioning words a saved
    // entry happens to be keyed on. Every message shares vocabulary with some
    // mockup — "dark", "saas", "terminal" — and matching on that alone put the
    // picker in front of conversations that had nothing to do with design.
    if (!isDesignRequest(text)) return;
    const entries = listEntries();
    if (!entries.length) {
      if (!this.uilibNoticeShown) {
        this.uilibNoticeShown = true;
        line();
        hint(
          tr(
            "Your UI library is empty — save a design once and every later \"нарисуй дизайн …\" request can reuse it:",
            "Ваша библиотека макетов пуста — сохраните дизайн один раз, и каждый следующий запрос «нарисуй дизайн …» сможет его использовать:",
          ),
        );
        hint(c.gray("  /uilib add <site-url>"));
      }
      return;
    }
    const matches = matchLibrary(text);
    if (!matches.length) return;
    const solo = matches[0].score >= 4 && (matches.length === 1 || matches[0].score >= matches[1].score * 2);
    let picked:
      | { entry: UiEntry; brief: string }
      | { entry: UiEntry; brief: string }[]
      | "none"
      | null = null;
    if (solo) {
      const got = getEntry(matches[0].entry.slug);
      if (got) {
        picked = got;
        success(tr(`design reference: ${got.entry.title}`, `дизайн-референс: ${got.entry.title}`));
      }
    } else {
      picked = await pickUiEntry(this, text);
    }
    if (!picked || picked === "none") return;
    // A blend arrives as several references in one injection; a single pick as one.
    const parts = Array.isArray(picked) ? picked : [picked];
    const single = !Array.isArray(picked) ? picked : null;
    this.session.add({
      role: "user",
      content: single
        ? designInjection(single.entry, single.brief, Boolean(solo))
        : blendInjection(parts),
      meta: { skill: `uilib:${parts.map((p) => p.entry.slug).join("+")}` },
    });
  }

  /**
   * The other half of auto-selection: the same match, run again at every step
   * boundary of the turn.
   *
   * The request is matched once, against what the user typed — and a task
   * announces maybe half of what it will need. "Почини баг" becomes a test for
   * the fix, a refactor of what the fix touched, a note in the README; each of
   * those has a procedure, and none of them was in the first sentence. Reading
   * the model's own plan as it goes is the only place that intent shows up
   * while there is still work left to apply it to.
   */
  private stepSkills(): ((assistant: Message, calls: ToolCall[]) => Message | null) | undefined {
    if (!this.cfg.skillsEnabled || this.cfg.skillAuto === false) return undefined;
    return skillInterjector(this.skills, {
      loaded: this.loadedSkills,
      // Two per turn. Each one is paid for on every remaining step, and a turn
      // that wants a third has changed subject enough to be its own turn.
      max: 2,
      onLoad: (skill, matched) => hint(`⚡ skill ${skill.name} — ${matched.slice(0, 3).join(", ")}`),
    });
  }

  async turn(text: string): Promise<void> {
    if (!hasProvider()) {
      error(tr("No provider connected. Run /login.", "Поставщик не подключён. Наберите /login."));
      return;
    }

    // Created before auto-compaction, not after: the compaction request has to
    // hang off the same signal, or Esc cannot reach it.
    this.abort = new AbortController();
    // The bar goes up before auto-compaction and the brief rewrite, not after:
    // either can run for minutes on a full window, and a missing input frame
    // for that long reads as the CLI having died.
    const bar = new TurnBar({
      status: () => composeStatus({ ...this.status(), hint: "esc to interrupt · enter to queue" }),
      onInterrupt: () => this.abort?.abort(),
      onToggleMode: () => this.toggleAutoApprove(),
      history: this.history,
    });
    this.bar = bar;
    const spinner = {
      setLabel: (l: string) => bar.setLabel(l),
      setTokens: (i: number, o: number, cached?: number) => bar.setTokens(i, o, cached),
      start: () => {},
      stop: () => {},
    };
    bar.start();

    await this.maybeAutoCompact();
    if (this.abort.signal.aborted) {
      warn(tr("Interrupted.", "Прервано."));
      this.abort = null;
      // Nothing went out — not the prompt, not whatever was typed into the
      // frame meanwhile. Hand all of it back instead of losing it.
      const { queued, draft } = bar.stop();
      this.bar = null;
      const held = [text, ...queued, draft].filter(Boolean).join("\n");
      if (held) this.editor?.prefill(held);
      return;
    }

    userEcho(text);
    // Rewriting happens after the echo: what the user typed stays on screen as
    // they typed it, with the brief under it. The bar stays up — a missing
    // frame here is the same bug as during auto-compaction.
    text = await this.maybeRewrite(text);
    this.coldCacheNudge();
    // Opened before the prompt joins the history, so /rewind can cut the
    // conversation exactly here as well as put the files back.
    markTurn(this.session, text);
    this.session.add({ role: "user", content: text });
    this.autoLoadSkill(text);
    await this.autoLoadDesign(text);

    this.usage.beginTurn();
    this.lastReasoning = "";
    this.orca?.busy(this.session.id);
    this.orca?.userPrompt(text, this.session.id);

    const started = Date.now();
    // The bar owns stdin for the duration of the turn: it interrupts on Esc
    // and keeps the input frame on screen. It was raised above, before the
    // compaction and rewrite that can each take minutes.
    let streaming = false;
    let inToolGroup = false;
    let lastTool = "";
    /** Models whose 429 was already reported this turn, so it is said once. */
    const ratedThisTurn = new Set<string>();
    /**
     * The rate-limit label counts down, and then has to go. It replaces the
     * running label mid-step, and nothing else repaints it until the next step
     * or the next tool — so without this it sat there claiming a wait that had
     * ended long ago, while the model was already answering.
     */
    let rateTicker: ReturnType<typeof setInterval> | null = null;
    const endRateWait = () => {
      if (!rateTicker) return;
      clearInterval(rateTicker);
      rateTicker = null;
      spinner.setLabel("thinking");
    };
    let md: MarkdownStream | null = null;
    let think: ThinkingStream | null = null;
    /** The answer so far, for Orca's pane preview. */
    let answer = "";

    // Live counters: input is known once the first usage lands, output grows
    // with the stream so a long silence still shows movement.
    const promptEstimate = contextPressure(this.session, this.catalog).used;
    let liveIn = promptEstimate;
    let liveOut = 0;
    const bumpOut = (delta: string) => {
      liveOut += estimateTokens(delta);
      spinner.setTokens(liveIn, liveOut);
    };
    spinner.setTokens(liveIn, 0);

    const stopStream = () => {
      // Thinking closes first: whatever comes next — the answer, a tool call —
      // belongs after the working-out, not inside it.
      if (think) {
        think.end();
        think = null;
      }
      if (md) {
        md.end();
        md = null;
      }
      streaming = false;
    };

    // A server that joins the registry after the first request has gone out
    // costs the whole session's cached prefix, because the tool block precedes
    // the history. The prompt never waited for MCP and still does not; only
    // the first send does, and only while something is genuinely coming up.
    if (mcpPendingCount()) {
      this.progress(tr("waiting for MCP servers…", "жду MCP-серверы…"));
      await mcpSettled();
    }

    try {
      const result = await this.runWithFailover({
        model: this.session.model,
        // activeSkills, not skills: the catalogue tells the model to call the
        // skill tool, and that tool is built from activeSkills too. Listing
        // what is switched off invited a call to a tool that is not there —
        // and cost 2.1k tokens on every request to do it. It also disagreed
        // with the failover path below, so continuing on another model quietly
        // rewrote the system prompt and voided the cache for the session.
        systemPrompt: buildSystemPrompt({ cwd: this.cwd, model: this.session.model, skills: this.activeSkills }),
        messages: this.session.messages,
        tools: this.tools,
        toolContext: this.toolContext(),
        catalog: this.catalog,
        usage: this.usage,
        maxSteps: this.cfg.maxSteps,
        signal: this.abort.signal,
        effort: this.effort(),
        toolConcurrency: this.cfg.toolConcurrency,
        interject: this.stepSkills(),
        projection: { cwd: this.cwd, sessionId: this.session.id },
        // A silent stream is a question, not a verdict: the user can see the
        // clock and decide whether the model is worth waiting for.
        onStall: async (idleMs) => {
          if (!process.stdin.isTTY) return false;
          warn(
            tr(
              `No data from the server for ~${fmtDuration(idleMs)} — could be long thinking, could be a dead connection.`,
              `Сервер молчит уже ~${fmtDuration(idleMs)} — возможно, модель долго думает, а возможно, соединение мертво.`,
            ),
          );
          const answer = await this.exclusiveInput(() =>
            choose<"wait" | "abort">(
              [
                { value: "wait", label: tr("Keep waiting", "Ждать дальше"), key: "w", tone: "ok" },
                { value: "abort", label: tr("Abort the request", "Прервать запрос"), key: "n", tone: "danger" },
              ],
              { initial: "wait", fallback: "abort" },
            ),
          );
          return answer === "wait";
        },
        // A held-back send looks like a hang unless the label says what is
        // being waited out.
        // Naming the model matters: a wait on the small model or a subagent's
        // looks identical otherwise, and a limit hit by one is not a reason to
        // believe the one on screen is metered.
        onRateWait: (waitMs, model, said) => {
          const name = wireModelId(model);
          // Said once per turn, in the transcript: a silent minute reads as the
          // client's own idea. It is the host's, and these are its words.
          if (!ratedThisTurn.has(model)) {
            ratedThisTurn.add(model);
            spinner.stop();
            warn(
              tr(
                `${name}: the host refused with 429 — ${said || "rate limit"}. Waiting ~${fmtDuration(waitMs)} before retrying.`,
                `${name}: хост ответил 429 — ${said || "лимит запросов"}. Жду ~${fmtDuration(waitMs)} и повторяю.`,
              ),
            );
          }
          const until = Date.now() + waitMs;
          const tick = () => {
            const left = until - Date.now();
            if (left <= 0) return endRateWait();
            spinner.setLabel(
              tr(`${name} rate limit — waiting ~${fmtDuration(left)}`, `${name} rate limit — ждём ~${fmtDuration(left)}`),
            );
          };
          if (rateTicker) clearInterval(rateTicker);
          tick();
          rateTicker = setInterval(tick, 1000);
          rateTicker.unref?.();
          spinner.start();
        },
        events: {
          onStep: (step) => {
            endRateWait();
            if (step > 0) spinner.setLabel("continuing");
            spinner.start();
          },
          onReasoning: (delta) => {
            endRateWait();
            bumpOut(delta);
            if (!think) {
              // The spinner would otherwise sit inside the block it announces.
              spinner.stop();
              // A blank line separates this block from the previous one when
              // /reasoning prints the whole turn.
              if (this.lastReasoning) this.lastReasoning += "\n\n";
              const rows = this.cfg.thinkingRows;
              think = new ThinkingStream(
                process.stdout.isTTY && rows > 0
                  ? { rows, onUpdate: (ls) => bar.setThinking(ls) }
                  : undefined,
              );
            }
            this.lastReasoning += delta;
            think.push(delta);
          },
          onText: (delta) => {
            endRateWait();
            bumpOut(delta);
            if (!streaming) {
              spinner.stop();
              ensureBlank();
              assistantPrefix(this.session.model);
              md = new MarkdownStream();
              streaming = true;
              inToolGroup = false;
              answer = "";
            }
            md?.push(delta);
            answer += delta;
            this.orca?.assistantText(answer, this.session.id);
          },
          onToolStart: (tool, args) => {
            endRateWait();
            stopStream();
            spinner.stop();
            // One blank line opens the group; calls inside it stay together.
            // A batch of subagent launches is its own block: separated from
            // plain tool calls on the way in and on the way out.
            if (!inToolGroup || (tool.name === "task") !== (lastTool === "task")) ensureBlank();
            inToolGroup = true;
            lastTool = tool.name;
            toolStart(tool.name, tool.summarize?.(args) ?? "");
          },
          onToolEnd: (tool, ok, display, _call, kind) => {
            // The live tail belonged to the tool that just finished; a
            // subagent still running keeps its own preview.
            if (!this.activityActive) {
              this.activityLines = [];
              bar.setThinking([]);
            }
            toolDone(ok, display || (ok ? "done" : "failed"), kind);
            spinner.setLabel("thinking");
            spinner.start();
          },
          onUsage: (_model, usage) => {
            endRateWait();
            if (!usage) return;
            liveIn = usage.prompt_tokens;
            liveOut = usage.completion_tokens;
            spinner.setTokens(liveIn, liveOut, usage.cached_tokens ?? 0);
          },
          onAssistantMessage: () => stopStream(),
          // A dropped connection is not a refusal: the step goes out again,
          // and the user is told why the wait just got longer. When part of
          // the answer was already on the screen, that block stays as it was
          // cut off — the resent step opens a fresh one below it.
          onReconnect: (reason, attempt, of, hadText) => {
            stopStream();
            if (!hadText) answer = "";
            spinner.stop();
            warn(
              tr(
                `Connection lost: ${reason}. Sending the same request again (${attempt}/${of}).`,
                `Соединение оборвалось: ${reason}. Отправляю тот же запрос заново (${attempt}/${of}).`,
              ),
            );
            spinner.start();
          },
        },
      });

      stopStream();
      this.session.save();
      this.statusLine(Date.now() - started, result.steps, result.stoppedBecause);
      if (process.env.TRCODE_DEBUG) {
        const t = this.usage.turnTotals();
        const per = t.requests ? Math.round(t.input / t.requests) : 0;
        padded(
          c.gray(
            `debug: ~${fmtTokens(per)} per request · last ↑ ${fmtTokens(this.usage.lastTurn.input)} · ` +
              `history est. ${fmtTokens(contextPressure(this.session, this.catalog).used)} ` +
              `(${this.session.messages.length} msgs)`,
          ),
        );
      }
    } catch (err) {
      stopStream();
      error((err as Error).message);
      this.suggestAnotherHost(err);
      this.session.save();
    } finally {
      // Take the bar down before anything else prints, then pick up whatever
      // was typed while the model worked.
      endRateWait();
      const { queued, draft } = bar.stop();
      this.bar = null;
      // The uilib capture/blend gate comes after the bar is gone: its buttons
      // are plain transcript rows, and drawing them over a live footer is what
      // printed the button row twice. The answer still goes out as the next
      // message — the queue below picks it up in the same breath.
      if (this.pendingUilibGate && !this.abort?.signal.aborted) {
        const gate = this.pendingUilibGate;
        this.pendingUilibGate = null;
        await gate(this.lastAssistantText());
      }
      // Esc means stop, including whatever was typed while waiting. Sending
      // the queue anyway starts a new turn in the same breath, which reads as
      // Esc having done nothing at all — the queued text is handed back to the
      // editor instead, where it can be sent again on purpose.
      const interrupted = Boolean(this.abort?.signal.aborted);
      if (interrupted) {
        const held = [...queued, draft].filter(Boolean).join("\n");
        if (held) this.editor?.prefill(held);
        if (queued.length) hint(tr("Queued messages were not sent.", "Сообщения из очереди не отправлены."));
      } else {
        this.pending.push(...queued);
        if (draft) this.editor?.prefill(draft);
      }
      this.abort = null;
      // Only "done" once nothing else is queued, or the pane would flash
      // finished between two messages of the same batch.
      if (!this.pending.length) await this.orca?.idle(this.session.id);
    }
  }

  /**
   * True when a host refused the conversation itself rather than the request:
   * its content filter read the history and said no. Sending it again — here,
   * or after any edit short of removing whatever tripped it — gets the same
   * answer, so the only move that continues the work is another host.
   */
  private isContentRefusal(err: unknown): err is ApiError {
    if (!(err instanceof ApiError) || err.status !== 400) return false;
    return /DataInspection|inappropriate content|content.?(filter|policy|moderation)/i.test(`${err.body ?? ""} ${err.message}`);
  }

  /**
   * Runs the turn, and when a content filter refuses the whole conversation,
   * offers to carry it on at another host that serves the same model.
   *
   * The history is untouched by a refusal — the request never reached the
   * model — so this is a clean re-run rather than a resumption, and the switch
   * sticks for the rest of the session: a host that refused this conversation
   * will refuse every later step of it too.
   *
   * It is asked rather than done: the conversation moves to a different vendor,
   * and that is the user's call, not a detail of error handling. Without a
   * terminal to ask at, the failure stands.
   */
  private async runWithFailover(opts: Parameters<typeof runAgent>[0]): Promise<Awaited<ReturnType<typeof runAgent>>> {
    const refused = new Set<string>();
    for (;;) {
      try {
        return await runAgent(opts);
      } catch (err) {
        if (!this.isContentRefusal(err) || !process.stdin.isTTY) throw err;
        refused.add(opts.model);
        const alt = sameModelElsewhere(opts.model, this.catalog).find((id) => !refused.has(id));
        if (!alt) throw err;

        // Short here on purpose: if the offer is declined the caller prints
        // the host's full message, and saying it twice helps nobody.
        warn(
          tr(
            `${providerLabel(splitModelId(opts.model).providerId)} refused this conversation — its content filter, not the request.`,
            `${providerLabel(splitModelId(opts.model).providerId)} отклонил этот диалог — сработал контент-фильтр, дело не в запросе.`,
          ),
        );
        const answer = await this.exclusiveInput(() =>
          choose<"move" | "stop">(
            [
              { value: "move", label: tr(`Continue on ${alt}`, `Продолжить на ${alt}`), key: "c", tone: "ok" },
              { value: "stop", label: tr("Stop here", "Остановиться"), key: "n", tone: "danger" },
            ],
            { initial: "move", fallback: "stop" },
          ),
        );
        if (answer !== "move") throw err;

        this.session.model = alt;
        this.session.save();
        opts.model = alt;
        opts.systemPrompt = buildSystemPrompt({ cwd: this.cwd, model: alt, skills: this.activeSkills, preset: this.preset });
        opts.effort = this.effort();
        this.rebuildTools();
        opts.tools = this.tools;
        info(tr(`Continuing on ${alt}.`, `Продолжаю на ${alt}.`));
      }
    }
  }

  /**
   * Some failures are the host's verdict on this conversation, not a hiccup:
   * a content filter refuses the same history every time, a lapsed plan pays
   * for nothing, a rate limit that survives the retries is not going to clear
   * this minute. In all three the way on is the same model at another host, so
   * say which — the alternative is the user typing "продолжи" into a wall.
   */
  private suggestAnotherHost(err: unknown): void {
    if (!(err instanceof ApiError)) return;
    const api: ApiError = err;
    const text = `${api.body ?? ""} ${api.message}`;
    const stuck =
      api.status === 402 ||
      api.status === 429 ||
      (api.status === 400 && /DataInspection|inappropriate content|content.?(filter|policy|moderation)/i.test(text));
    if (!stuck) return;
    const alts = sameModelElsewhere(this.session.model, this.catalog);
    if (!alts.length) return;
    hint(
      tr(
        `The same model elsewhere: ${alts.map((id) => `/model ${id}`).join(" · ")}`,
        `Та же модель на другом хосте: ${alts.map((id) => `/model ${id}`).join(" · ")}`,
      ),
    );
  }

  private async maybeAutoCompact(): Promise<void> {
    if (!shouldAutoCompact(this.session, this.catalog)) return;
    const { used, ratio } = contextPressure(this.session, this.catalog);
    info(tr(`History reached ~${fmtTokens(used)} tokens (${Math.round(ratio * 100)}% of the window) — compacting…`, `История доросла до ~${fmtTokens(used)} токенов (${Math.round(ratio * 100)}% окна) — сжимаю…`));
    // The turn bar is already up (raised before this ran), so the label lands
    // on it and the input frame stays on screen for the whole compaction.
    const bar = this.bar;
    bar?.setLabel(tr("compacting context", "сжимаю контекст"));
    try {
      const res = await compactSession(this.session, { catalog: this.catalog, signal: this.abort?.signal });
      if (res.summary) info(tr(`Compacted ${res.droppedMessages} messages, ${res.keptMessages} left.`, `Сжато ${nOf(res.droppedMessages, ["message", "messages"], ["сообщение", "сообщения", "сообщений"])}, осталось ${res.keptMessages}.`));
    } catch (err) {
      // The caller reports an interruption; here it is not a failure.
      if ((err as Error)?.name !== "AbortError") {
        warn(tr(`Could not compact the context: ${(err as Error).message}`, `Не удалось сжать контекст: ${(err as Error).message}`));
      }
    } finally {
      bar?.setLabel("thinking");
    }
  }

  /** Per-turn footer. Context share and session total live under the input. */
  statusLine(elapsedMs: number, steps: number, stopped: string): void {
    const t = this.usage.turnTotals();
    const effort = this.effort();

    const ignored = modelRejectsEffort(this.session.model);
    // Input is the sum over every request of the turn, not the last one: with
    // several steps the last request is a fraction of what was actually sent.
    const sent =
      `${c.gray("↑")} ${fmtTokens(t.input)}` +
      (t.requests > 1 ? c.gray(` in ${t.requests} requests`) : "") +
      (t.cached ? c.gray(` · ${fmtTokens(t.cached)} cached (${pctOf(t.cached, t.input)}%)`) : "");

    // Which parts of the line the user wants to see — /settings unticks them.
    const on = this.cfg.statusFields ?? {};
    const bits = [
      on.model !== false
        ? c.brightYellow(this.session.model) +
          (effort === "off" || ignored ? "" : c.gray(":") + c.brightMagenta(effort))
        : "",
      on.tokens !== false
        ? `${sent} ${c.gray("↓")} ${fmtTokens(t.output)}` +
          // Thinking is billed as output; without this the number looks absurd.
          (t.reasoning ? c.gray(` · ${fmtTokens(t.reasoning)} of it reasoning`) : "")
        : "",
      on.steps !== false ? c.gray(nOf(steps, ["step", "steps"], ["шаг", "шага", "шагов"])) : "",
      on.time !== false ? c.gray(fmtDuration(elapsedMs)) : "",
      on.speed !== false && elapsedMs > 1000 && t.output
        ? c.gray(`${fmtTokens(Math.round((t.output / elapsedMs) * 1000))} tok/s avg`)
        : "",
    ].filter(Boolean);

    line();
    if (bits.length) padded(bits.join(c.gray(" · ")));
    this.cacheNudge();
    this.contextNudge();

    if (stopped === "aborted") warn(tr("Interrupted.", "Прервано."));
    // Only reachable when a ceiling was configured: there is none by default.
    if (stopped === "max_steps") {
      warn(tr(`Hit the ${this.cfg.maxSteps}-step limit — say "continue" to resume, or set "maxSteps": 0 to remove it.`, `Достигнут предел в ${this.cfg.maxSteps} шагов — скажите «продолжай», или уберите ограничение: "maxSteps": 0.`));
    }
    if (stopped === "length") warn(tr("The answer was cut off by the model's token limit.", "Ответ обрезан лимитом токенов модели."));
  }

  /**
   * Provider caches expire within minutes to an hour of inactivity; after a
   * real pause the next request re-pays full price for the whole history. One
   * line before that happens, while /compact or /new can still make it cheap.
   */
  private coldCacheNudge(): void {
    const last = this.session.messages[this.session.messages.length - 1];
    const ts = last?.meta?.ts;
    if (!ts) return;
    const idleMs = Date.now() - ts;
    if (idleMs < 60 * 60 * 1000) return;
    const { used } = contextPressure(this.session, this.catalog);
    if (used < 8_000) return;
    padded(
      c.gray(
        tr(
          `Resuming after ~${fmtDuration(idleMs)} — the provider cache has expired, so the first request pays for all ~${fmtTokens(used)} history tokens again. If the old context is no longer needed, /compact or /new is cheaper.`,
          `Продолжение после паузы ~${fmtDuration(idleMs)} — кэш провайдера истёк, и первый запрос заново оплатит все ~${fmtTokens(used)} токенов истории. Если старый контекст уже не нужен, /compact или /new выйдет дешевле.`,
        ),
      ),
    );
  }

  /**
   * Once per session and model: the provider cache is not engaging, so every
   * step of a turn re-pays near-full price for the history. The cause is
   * host-side, but which model bleeds is worth one line here.
   */
  private cacheNudge(): void {
    const t = this.usage.turnTotals();
    if (t.requests < 3 || t.input < 50_000) return;
    const share = t.cached / t.input;
    if (share >= 0.3) return;
    const key = `${this.session.id}:${this.session.model}`;
    if (this.cacheMissNudged.has(key)) return;
    this.cacheMissNudged.add(key);
    padded(
      c.gray(
        tr(
          `Only ${Math.round(share * 100)}% of this turn's input hit the provider cache — each step re-paid for the history. That is on the host serving ${this.session.model}; shorter sessions and /compact limit the damage.`,
          `Лишь ${Math.round(share * 100)}% input этого хода попало в кэш провайдера — каждый шаг заново оплатил историю. Это на стороне хоста ${this.session.model}; короткие сессии и /compact ограничивают ущерб.`,
        ),
      ),
    );
  }

  /**
   * Says once, at each threshold, that the history is what the next turn will
   * cost. Auto-compaction eventually fires on its own, but by then several
   * turns have paid full price for a history the user was finished with.
   */
  private contextNudge(): void {
    // Compacting or switching sessions makes the advice relevant again.
    const key = `${this.session.id}:${this.session.compactions}`;
    if (key !== this.nudgeKey) {
      this.nudgeKey = key;
      this.nudgedAt = 0;
    }
    const { used, ratio } = contextPressure(this.session, this.catalog);
    const level = ratio >= 0.8 ? 80 : ratio >= 0.5 ? 50 : 0;
    if (!level || level <= this.nudgedAt) return;
    this.nudgedAt = level;
    padded(
      c.gray(
        `History is ~${fmtTokens(used)} tokens (${Math.round(ratio * 100)}% of the window) and every step re-sends it. ` +
          `${c.bold("/compact")} digests it, ${c.bold("/new")} starts clean.`,
      ),
    );
  }
}

export function shortPath(p: string): string {
  const home = os.homedir();
  const abs = path.resolve(p);
  return abs.startsWith(home) ? "~" + abs.slice(home.length).split(path.sep).join("/") : abs.split(path.sep).join("/");
}

export { truncate, printCommandIndex };
