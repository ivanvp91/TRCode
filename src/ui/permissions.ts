/**
 * Permission gate for risky tools. Prompts are serialised through a queue so
 * parallel subagents never fight over stdin.
 */
import readline from "node:readline";
import { c } from "./ansi.js";
import { line, rule, truncate } from "./render.js";
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
        ? "Run this command?"
        : tool.name === "write"
          ? "Write this file?"
          : tool.name === "edit"
            ? "Apply this edit?"
            : `Allow ${tool.name}?`;

    line();
    rule(c.brightYellow(" permission required "));
    line(`  ${c.bold(title)}  ${c.gray(tool.name)}`);
    const target = args.path ?? args.command ?? tool.summarize?.(args) ?? "";
    if (target) line(`  ${c.dim(truncate(String(target), 100))}`);
    if (preview) {
      line();
      const lines = preview.split("\n");
      for (const l of lines.slice(0, 30)) line("  " + l);
      if (lines.length > 30) line(c.gray(`  … ${lines.length - 30} more lines`));
    }
    line();

    const answer = await this.exclusive(() =>
      choose<"once" | "always" | "reject">(
        [
          { value: "once", label: "Allow", key: "y", tone: "ok" },
          { value: "always", label: `Always allow ${tool.name} this session`, key: "a", tone: "warn" },
          { value: "reject", label: "Reject", key: "n", tone: "danger" },
        ],
        { initial: "once", fallback: "reject" },
      ),
    );
    line();

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
