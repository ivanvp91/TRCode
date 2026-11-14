/**
 * Permission gate for risky tools. Prompts are serialised through a queue so
 * parallel subagents never fight over stdin.
 */
import readline from "node:readline";
import { t } from "../i18n.js";
import { c } from "./ansi.js";
import { clip, line, padded, rule, truncate } from "./render.js";
import { contentWidth } from "./layout.js";
import { choose } from "./choice.js";
import { loadConfig, type PermissionMode } from "../config.js";
import { evaluateRules } from "../permissionRules.js";
import type { ToolDef } from "../types.js";

const CTRL_C = "\u0003";
const ESC = "\u001b";

export class PermissionBroker {
  /** Tool names granted for the rest of the session. */
  private sessionAllow = new Set<string>();
  /**
   * Tools granted for calls that reach another machine. Kept apart from the set
   * above so a grant given for ordinary work never silently covers ssh: the
   * prompt for such a call asks its own question, in its own words.
   */
  private sessionAllowRemote = new Set<string>();
  /** Serialises prompts. */
  private chain: Promise<unknown> = Promise.resolve();
  /** When true, everything is auto-approved (--yolo). */
  autoApprove = false;
  /** When false, risky tools are refused without asking (headless default). */
  interactive = true;
  /** Where relative paths in permission rules are resolved. */
  cwd?: string;
  /** Hands the prompt sole ownership of stdin; set by the REPL. */
  private exclusive: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn();
  /** Told when a prompt is up, so a pane can show "needs attention". */
  onWaiting: ((tool: string, detail: string) => void) | null = null;
  /** Told when it has been answered, so the pane goes back to working. */
  onAnswered: (() => void) | null = null;
  /** Esc at the prompt: the user is stopping the turn, not denying one tool. */
  onCancel: (() => void) | null = null;
  /** Preview bodies already on screen, waiting to be claimed by their result. */
  private shown = new Set<string>();

  constructor(
    opts: {
      autoApprove?: boolean;
      interactive?: boolean;
      cwd?: string;
      exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
    } = {},
  ) {
    this.autoApprove = opts.autoApprove ?? false;
    this.interactive = opts.interactive ?? true;
    this.cwd = opts.cwd;
    if (opts.exclusive) this.exclusive = opts.exclusive;
  }

  allowForSession(toolName: string, remote = false): void {
    if (remote) this.sessionAllowRemote.add(toolName);
    else this.sessionAllow.add(toolName);
  }

  isAllowed(toolName: string, remote = false): boolean {
    return remote ? this.sessionAllowRemote.has(toolName) : this.sessionAllow.has(toolName);
  }

  reset(): void {
    this.sessionAllow.clear();
    this.sessionAllowRemote.clear();
    this.shown.clear();
  }

  /** Records a preview body as being on screen, for previewShown() to claim. */
  noteShown(preview: string): void {
    this.shown.add(preview);
  }

  /**
   * True when this exact body was printed by the prompt the caller just
   * answered — the tool result then prints its summary alone instead of the
   * same diff again. One claim per prompt: an auto-approved call never
   * matches, so its diff still shows.
   */
  previewShown(preview: string): boolean {
    if (!preview || !this.shown.has(preview)) return false;
    this.shown.delete(preview);
    return true;
  }

  private mode(tool: ToolDef): PermissionMode {
    const cfg = loadConfig();
    return (tool.paidMedia ? cfg.permissions.paidMedia : cfg.permissions[tool.risk]) ?? "ask";
  }

  async confirm(tool: ToolDef, args: Record<string, any>, preview?: string, signal?: AbortSignal, force = false): Promise<boolean> {
    if (signal?.aborted) return false;
    // Rules are consulted before anything automatic: a refusal is a refusal
    // even under --yolo, and a permission written for one command silences the
    // question the class mode would have asked.
    const verdict = evaluateRules(loadConfig().permissionRules, tool, args, this.cwd);
    if (verdict?.action === "deny") return false;
    if (this.autoApprove && !force) return true;
    const mode = this.mode(tool);
    if (mode === "allow" && !force) return true;
    if (mode === "deny") return false;
    // An allow rule is a statement about this call, not about the whole class:
    // it applies to ordinary calls only, never to one that reaches another
    // machine.
    if (verdict?.action === "allow" && !force) return true;
    // A remote call is refused every automatic path: mode, --yolo and a grant
    // made for local work all fall through to the prompt. Its own grant does not.
    if (force ? this.sessionAllowRemote.has(tool.name) : this.sessionAllow.has(tool.name)) return true;
    if (!this.interactive) return false;

    // Queue: one prompt at a time, in arrival order.
    const run = this.chain.then(() => this.prompt(tool, args, preview, signal, force));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private prompt(tool: ToolDef, args: Record<string, any>, preview?: string, signal?: AbortSignal, force = false): Promise<boolean> {
    return this.exclusive(() => signal?.aborted ? Promise.resolve(false) : this.showPrompt(tool, args, preview, force));
  }

  private async showPrompt(tool: ToolDef, args: Record<string, any>, preview?: string, force = false): Promise<boolean> {
    const title =
      tool.risk === "shell"
        ? t("Run this command?", "Выполнить эту команду?")
        : tool.name === "write"
          ? t("Write this file?", "Записать этот файл?")
          : tool.name === "edit"
            ? t("Apply this edit?", "Применить эту правку?")
            : t("Allow {name}?", "Разрешить {name}?", { name: tool.name });

    line();
    rule(c.brightYellow(t(" permission required ", " нужно подтверждение ")));
    padded(`${c.bold(title)}  ${c.gray(tool.name)}`);
    const target = args.path ?? args.command ?? tool.summarize?.(args) ?? "";
    // A prompt nobody sees is a turn that never finishes: tell the host that
    // this pane is blocked on a human.
    this.onWaiting?.(tool.name, String(target || title));
    if (target) padded(c.dim(truncate(String(target), 100)));
    if (force) {
      padded(c.gray(t("This command reaches another machine — it is confirmed even with YOLO on.", "Команда уходит на другую машину — подтверждение нужно даже при включённом YOLO.")));
    }
    if (preview) {
      line();
      this.noteShown(preview);
      const lines = preview.split("\n");
      // A diff arrives already laid out and clipped; anything else is raw text
      // that would otherwise wrap in column 1, outside the margins.
      const styled = preview.includes(ESC);
      for (const l of lines.slice(0, 30)) {
        line("  " + (styled ? l : c.dim(clip(l, contentWidth() - 2))));
      }
      if (lines.length > 30) line(c.gray(t("  … {rest} more lines", "  … ещё строк: {rest}", { rest: lines.length - 30 })));
    }
    line();

    const answer = await choose<"once" | "always" | "reject">(
      [
        { value: "once", label: t("Allow", "Разрешить"), key: "y", tone: "ok" },
        {
          value: "always",
          label: force
            ? t("Always allow remote commands this session", "Всегда разрешать команды на другие машины в этой сессии")
            : t("Always allow {name} this session", "Всегда разрешать {name} в этой сессии", { name: tool.name }),
          key: "a",
          tone: "warn",
        },
        { value: "reject", label: t("Reject", "Отклонить"), key: "n", tone: "danger" },
      ],
      { initial: "once", fallback: "reject", cancel: () => this.onCancel?.() },
    );
    line();
    this.onAnswered?.();

    if (answer === "always") {
      this.allowForSession(tool.name, force);
      return true;
    }
    return answer === "once";
  }
}

/** Reads a single keypress (falls back to a line read when not a TTY). */
export function askChar(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question(promptText, (a) => {
        rl.close();
        resolve(a.trim().toLowerCase().charAt(0) || "n");
      });
      return;
    }
    process.stdout.write(promptText);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (buf: Buffer) => {
      const ch = buf.toString("utf8");
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      process.stdout.write(ch === "\r" || ch === "\n" ? "\n" : ch + "\n");
      // Ctrl+C and Esc both read as a rejection.
      if (ch === CTRL_C || ch === ESC) return resolve("n");
      resolve(ch.toLowerCase());
    };
    stdin.on("data", onData);
  });
}
