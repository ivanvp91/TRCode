/** Interactive REPL: input loop, turn execution, live transcript. */
import path from "node:path";
import os from "node:os";
import { c } from "./ansi.js";
import {
  MarkdownStream,
  Spinner,
  assistantPrefix,
  banner,
  ensureBlank,
  error,
  info,
  line,
  padded,
  plural,
  renderMarkdownBlock,
  toolDone,
  rule,
  toolStart,
  truncate,
  userEcho,
  warn,
} from "./render.js";
import { contentWidth, fmtDuration } from "./layout.js";
import { composeStatus, type StatusInfo } from "./inputbox.js";
import { InputEditor, PipeReader, setExtraNewlineKeys } from "./editor.js";
import { TurnBar } from "./turnbar.js";
import { pushConsumer } from "./stdin.js";
import { PermissionBroker } from "./permissions.js";
import { loadConfig, VERSION, type Config, type Effort } from "../config.js";
import { fetchModels, effortFor, usableModels, resolveModelId, findModel } from "../provider/models.js";
import { modelRejectsEffort } from "../provider/client.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { runAgent } from "../agent/loop.js";
import { buildTools, TodoStore } from "../tools/index.js";
import { discoverSkills, type Skill } from "../skills/loader.js";
import { Session } from "../session/session.js";
import { loadInputHistory, saveInputHistory } from "../session/history.js";
import { compactSession, contextPressure, shouldAutoCompact } from "../session/compact.js";
import { UsageTracker, estimateTokens, fmtTokens } from "../usage.js";
import type { ModelInfo, ToolContext, ToolDef } from "../types.js";
import { runCommand, isCommand, commandNames, commandSuggestions, printCommandIndex } from "./commands.js";

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

export class App {
  cwd: string;
  cfg: Config;
  catalog: ModelInfo[] = [];
  session: Session;
  skills: Skill[];
  todo = new TodoStore();
  broker: PermissionBroker;
  usage: UsageTracker;
  readFiles = new Set<string>();
  effortOverride?: Effort;

  private abort: AbortController | null = null;
  private quitting = false;
  private tools: ToolDef[] = [];

  private editor: InputEditor | null = null;
  private pipe: PipeReader | null = null;
  private history: string[] = [];
  /** Messages queued from the turn bar while the model was working. */
  private pending: string[] = [];
  /** The bottom bar of the running turn, so prompts can step around it. */
  private bar: TurnBar | null = null;
  /** Releases the turn-cancel key listener; null when no turn is running. */
  private turnKeys: (() => void) | null = null;

  constructor(opts: { cwd: string; model?: string; autoApprove?: boolean; session?: Session }) {
    this.cwd = opts.cwd;
    this.cfg = loadConfig();
    this.skills = discoverSkills(this.cwd);
    this.broker = new PermissionBroker({
      autoApprove: opts.autoApprove,
      interactive: process.stdin.isTTY,
      exclusive: (fn) => this.exclusiveInput(fn),
    });
    this.history = loadInputHistory(this.cwd);
    setExtraNewlineKeys(this.cfg.newlineKeys ?? []);
    this.session = opts.session ?? new Session({ cwd: this.cwd, model: opts.model ?? this.cfg.model });
    if (opts.model) this.session.model = opts.model;
    this.usage = this.session.usage;
  }

  async init(): Promise<void> {
    Session.pruneEmpty(this.cwd);
    this.catalog = await fetchModels();
    this.reconcileModel();
    this.rebuildTools();
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
    warn(`Model "${stale}" is not in the ${this.cfg.baseUrl} catalog — switched to ${fallback}.`);
  }

  rebuildTools(): void {
    this.skills = discoverSkills(this.cwd);
    this.tools = buildTools({
      skills: this.skills,
      todo: this.todo,
      onTodoChange: () => {},
      subagentDeps: {
        cwd: this.cwd,
        catalog: this.catalog,
        skills: this.skills,
        tools: () => this.tools,
        defaultModel: this.session.model,
        effortFor: (model) => effortFor(model, this.effortOverride),
        maxSteps: this.cfg.maxSteps,
        usage: this.usage,
      },
    });
  }

  toolContext(): ToolContext {
    return {
      cwd: this.cwd,
      signal: this.abort?.signal ?? new AbortController().signal,
      depth: 0,
      confirm: (tool, args, preview) => this.broker.confirm(tool, args, preview),
      emit: (l) => padded(c.dim(l)),
      readFiles: this.readFiles,
    };
  }

  toolList(): ToolDef[] {
    return this.tools;
  }

  /** Remembers a submitted line for arrow-key recall, across restarts. */
  private recordInput(text: string): void {
    // Repeating the same line twice adds nothing to recall.
    if (this.history[this.history.length - 1] === text) return;
    this.history.push(text);
    if (this.history.length > 500) this.history.shift();
    saveInputHistory(this.cwd, this.history);
  }

  /** Input history follows the project, so /cwd reloads it. */
  reloadHistory(): void {
    this.history.splice(0, this.history.length, ...loadInputHistory(this.cwd));
  }

  effort(): Effort {
    return effortFor(this.session.model, this.effortOverride);
  }

  private status(): StatusInfo {
    const { used, window } = contextPressure(this.session, this.catalog);
    return {
      mode: this.broker.autoApprove ? "yolo" : undefined,
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
    if (!this.skills.length) {
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
    banner({
      model: this.session.model,
      defaultModel: this.cfg.model,
      effort: this.effort(),
      cwdLabel: this.cwd,
      sessionId: this.session.id,
      version: VERSION,
      tip: this.startupTip(),
    });
    if (!this.cfg.apiKey) {
      warn("No API key. Run " + c.bold("/login") + " or " + c.bold("trc auth login") + ".");
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

      await this.turn(text);
    }

    this.session.save();
    line();
    padded(c.gray("Session saved: " + this.session.id));
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

  private readInput(): Promise<string | null> {
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
    padded(c.gray("Bye."));
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
      if (m.role === "user" && !m.meta?.hidden) userIdx.push(i);
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
            ? ` · compacted ${this.session.compactions}×`
            : ""),
      ),
    );
    if (skipped) padded(c.gray(`${skipped} earlier ${plural(skipped, "prompt", "prompts")} folded away`));

    // The last answer is the one being continued from, so it is shown whole;
    // earlier ones are capped only to keep the scrollback usable.
    const lastAnswer = msgs.reduce((at, m, i) => (m.role === "assistant" && m.content ? i : at), -1);

    for (const [at, m] of msgs.slice(from).entries()) {
      const idx = from + at;
      if (m.meta?.hidden) continue;

      if (m.role === "user") {
        const text = String(m.content ?? "");
        line();
        const digest = text.match(/^<compacted-context>\n?([\s\S]*?)\n?<\/compacted-context>$/);
        if (digest) {
          // The digest is the whole earlier history — show it as a labelled
          // block, not as a user prompt with XML tags around it.
          padded(c.brightBlue("▍") + " " + c.bold(c.brightBlue("compacted context")));
          const body = digest[1].replace(/^The earlier part of this session[^\n]*\n+/, "");
          for (const l of renderMarkdownBlock(body, { width: w - 2, maxLines: 12, dim: true })) {
            padded(c.gray("▍ ") + l);
          }
          continue;
        }
        for (const [i, l] of renderMarkdownBlock(text, { width: w - 2, maxLines: 12 }).entries()) {
          padded((i === 0 ? c.brightYellow("✦ ") : "  ") + c.bold(l));
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
    this.turnKeys = pushConsumer((buf) => {
      const s = buf.toString("utf8");
      if (s === ESC || s === CTRL_C) this.abort?.abort();
    });
  }

  private detachTurnKeys(): void {
    if (!this.turnKeys) return;
    this.turnKeys();
    this.turnKeys = null;
  }

  // ── one turn ──────────────────────────────────────────────────────────────

  async turn(text: string): Promise<void> {
    if (!this.cfg.apiKey) {
      error("No API key. Run /login.");
      return;
    }

    await this.maybeAutoCompact();

    userEcho(text);
    this.session.add({ role: "user", content: text });

    this.abort = new AbortController();
    this.usage.beginTurn();

    const started = Date.now();
    // The bar owns stdin for the duration of the turn: it interrupts on Esc
    // and keeps the input frame on screen, so no separate key listener.
    const bar = new TurnBar({
      status: () => composeStatus({ ...this.status(), hint: "esc to interrupt · enter to queue" }),
      onInterrupt: () => this.abort?.abort(),
    });
    this.bar = bar;
    const spinner = {
      setLabel: (l: string) => bar.setLabel(l),
      setTokens: (i: number, o: number) => bar.setTokens(i, o),
      start: () => {},
      stop: () => {},
    };
    let streaming = false;
    let inToolGroup = false;
    let md: MarkdownStream | null = null;

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
      if (md) {
        md.end();
        md = null;
      }
      streaming = false;
    };

    bar.start();

    try {
      const result = await runAgent({
        model: this.session.model,
        systemPrompt: buildSystemPrompt({ cwd: this.cwd, model: this.session.model, skills: this.skills }),
        messages: this.session.messages,
        tools: this.tools,
        toolContext: this.toolContext(),
        catalog: this.catalog,
        usage: this.usage,
        maxSteps: this.cfg.maxSteps,
        signal: this.abort.signal,
        effort: this.effort(),
        toolConcurrency: 4,
        events: {
          onStep: (step) => {
            if (step > 0) spinner.setLabel("continuing");
            spinner.start();
          },
          onReasoning: (delta) => {
            spinner.setLabel("reasoning");
            bumpOut(delta);
          },
          onText: (delta) => {
            bumpOut(delta);
            if (!streaming) {
              spinner.stop();
              ensureBlank();
              assistantPrefix(this.session.model);
              md = new MarkdownStream();
              streaming = true;
              inToolGroup = false;
            }
            md?.push(delta);
          },
          onToolStart: (tool, args) => {
            stopStream();
            spinner.stop();
            // One blank line opens the group; calls inside it stay together.
            if (!inToolGroup) ensureBlank();
            inToolGroup = true;
            toolStart(tool.name, tool.summarize?.(args) ?? "");
          },
          onToolEnd: (tool, ok, display) => {
            toolDone(ok, display || (ok ? "done" : "failed"));
            spinner.setLabel("thinking");
            spinner.start();
          },
          onUsage: (_model, usage) => {
            if (!usage) return;
            liveIn = usage.prompt_tokens;
            liveOut = usage.completion_tokens;
            spinner.setTokens(liveIn, liveOut);
          },
          onAssistantMessage: () => stopStream(),
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
            `debug: ~${fmtTokens(per)} per request · last ↑${fmtTokens(this.usage.lastTurn.input)} · ` +
              `history est. ${fmtTokens(contextPressure(this.session, this.catalog).used)} ` +
              `(${this.session.messages.length} msgs)`,
          ),
        );
      }
    } catch (err) {
      stopStream();
      error((err as Error).message);
      this.session.save();
    } finally {
      // Take the bar down before anything else prints, then pick up whatever
      // was typed while the model worked.
      const { queued, draft } = bar.stop();
      this.bar = null;
      this.pending.push(...queued);
      if (draft) this.editor?.prefill(draft);
      this.abort = null;
    }
  }

  private async maybeAutoCompact(): Promise<void> {
    if (!shouldAutoCompact(this.session, this.catalog)) return;
    const { used, ratio } = contextPressure(this.session, this.catalog);
    info(`History reached ~${fmtTokens(used)} tokens (${Math.round(ratio * 100)}% of the window) — compacting…`);
    const spinner = new Spinner("compacting context");
    spinner.start();
    try {
      const res = await compactSession(this.session, { catalog: this.catalog, signal: this.abort?.signal });
      spinner.stop();
      if (res.summary) info(`Compacted ${res.droppedMessages} messages, ${res.keptMessages} left.`);
    } catch (err) {
      spinner.stop();
      warn(`Could not compact the context: ${(err as Error).message}`);
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
      `${c.gray("↑")}${fmtTokens(t.input)}` +
      (t.requests > 1 ? c.gray(` in ${t.requests} requests`) : "") +
      (t.cached ? c.gray(` · ${fmtTokens(t.cached)} cached`) : "");

    const bits = [
      c.brightYellow(this.session.model) +
        (effort === "off" || ignored ? "" : c.gray(":") + c.brightMagenta(effort)),
      `${sent} ${c.gray("↓")}${fmtTokens(t.output)}` +
        // Thinking is billed as output; without this the number looks absurd.
        (t.reasoning ? c.gray(` · ${fmtTokens(t.reasoning)} of it reasoning`) : ""),
      c.gray(`${steps} ${plural(steps, "step", "steps")}`),
      c.gray(fmtDuration(elapsedMs)),
    ].filter(Boolean);

    line();
    padded(bits.join(c.gray(" · ")));

    if (stopped === "aborted") warn("Interrupted.");
    if (stopped === "max_steps") warn(`Hit the ${this.cfg.maxSteps}-step limit — say "continue" to resume.`);
    if (stopped === "length") warn("The answer was cut off by the model's token limit.");
  }
}

export function shortPath(p: string): string {
  const home = os.homedir();
  const abs = path.resolve(p);
  return abs.startsWith(home) ? "~" + abs.slice(home.length).split(path.sep).join("/") : abs.split(path.sep).join("/");
}

export { truncate, printCommandIndex };
