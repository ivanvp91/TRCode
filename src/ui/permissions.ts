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
import type { ToolDef } from "../types.js";

const CTRL_C = "\u0003";
const ESC = "\u001b";

export class PermissionBroker {
  /** Tool names granted for the rest of the session. */
  private sessionAllow = new Set<string>();
  /** Serialises prompts. */
  private chain: Promise<unknown> = Promise.resolve();
  /** When true, everything is auto-approved (--yolo). */
  autoApprove = false;
  /** When false, risky tools are refused without asking (headless default). */
  interactive = true;
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
      exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
    } = {},
  ) {
    this.autoApprove = opts.autoApprove ?? false;
    this.interactive = opts.interactive ?? true;
    if (opts.exclusive) this.exclusive = opts.exclusive;
  }

  allowForSession(toolName: string): void {
    this.sessionAllow.add(toolName);
  }

  isAllowed(toolName: string): boolean {
    return this.sessionAllow.has(toolName);
  }

  reset(): void {
    this.sessionAllow.clear();
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
    return cfg.permissions[tool.risk] ?? "ask";
  }

  async confirm(tool: ToolDef, args: Record<string, any>, preview?: string): Promise<boolean> {
    if (this.autoApprove) return true;
    const mode = this.mode(tool);
    if (mode === "allow") return true;
    if (mode === "deny") return false;
    if (this.sessionAllow.has(tool.name)) return true;
    if (!this.interactive) return false;

    // Queue: one prompt at a time, in arrival order.
    const run = this.chain.then(() => this.prompt(tool, args, preview));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async prompt(tool: ToolDef, args: Record<string, any>, preview?: string): Promise<boolean> {
    const title =
      tool.risk === "shell"
        ? t("Run this command?", "Выполнить эту команду?")
        : tool.name === "write"
          ? t("Write this file?", "Записать этот файл?")
          : tool.name === "edit"
            ? t("Apply this edit?", "Применить эту правку?")
            : t(`Allow ${tool.name}?`, `Разрешить ${tool.name}?`);

    line();
    rule(c.brightYellow(t(" permission required ", " нужно подтверждение ")));
    padded(`${c.bold(title)}  ${c.gray(tool.name)}`);
    const target = args.path ?? args.command ?? tool.summarize?.(args) ?? "";
    // A prompt nobody sees is a turn that never finishes: tell the host that
    // this pane is blocked on a human.
    this.onWaiting?.(tool.name, String(target || title));
    if (target) padded(c.dim(truncate(String(target), 100)));
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
      if (lines.length > 30) line(c.gray(t(`  … ${lines.length - 30} more lines`, `  … ещё строк: ${lines.length - 30}`)));
    }
    line();

    const answer = await this.exclusive(() =>
      choose<"once" | "always" | "reject">(
        [
          { value: "once", label: t("Allow", "Разрешить"), key: "y", tone: "ok" },
          { value: "always", label: t(`Always allow ${tool.name} this session`, `Всегда разрешать ${tool.name} в этой сессии`), key: "a", tone: "warn" },
          { value: "reject", label: t("Reject", "Отклонить"), key: "n", tone: "danger" },
        ],
        { initial: "once", fallback: "reject", cancel: () => this.onCancel?.() },
      ),
    );
    line();
    this.onAnswered?.();

    if (answer === "always") {
      this.sessionAllow.add(tool.name);
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
