#!/usr/bin/env node
/** Entry point: argument parsing, headless mode, subcommands. */
import process from "node:process";
import { c } from "./ui/ansi.js";
import { error, info, line, success, warn } from "./ui/render.js";
import { App } from "./ui/repl.js";
import { releaseStdin } from "./ui/stdin.js";
import {
  loadConfig,
  saveConfig,
  configPath,
  VERSION,
  DEFAULT_BASE_URL,
  EFFORT_LEVELS,
  type Effort,
} from "./config.js";
import { fetchModels, resolveModelId } from "./provider/models.js";
import { verifyKey } from "./provider/client.js";
import { askSecret } from "./ui/secret.js";
import { Session } from "./session/session.js";

interface Args {
  prompt?: string;
  model?: string;
  effort?: Effort;
  baseUrl?: string;
  cwd: string;
  headless: boolean;
  autoApprove: boolean;
  resume?: string;
  continueLast: boolean;
  json: boolean;
  rest: string[];
  command?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cwd: process.cwd(),
    headless: false,
    autoApprove: false,
    continueLast: false,
    json: false,
    rest: [],
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-p":
      case "--print":
        args.headless = true;
        break;
      case "-m":
      case "--model":
        args.model = argv[++i];
        break;
      case "-e":
      case "--effort":
        args.effort = argv[++i] as Effort;
        break;
      case "--base-url":
        args.baseUrl = argv[++i];
        break;
      case "-C":
      case "--cwd":
        args.cwd = argv[++i];
        break;
      case "-c":
      case "--continue":
        args.continueLast = true;
        break;
      case "-r":
      case "--resume":
        args.resume = argv[++i];
        break;
      case "--json":
        args.json = true;
        break;
      case "--yolo":
      case "--dangerously-allow-all":
        args.autoApprove = true;
        break;
      case "-h":
      case "--help":
        args.command = "help";
        break;
      case "-v":
      case "--version":
        args.command = "version";
        break;
      default:
        positional.push(a);
    }
  }

  const SUBCOMMANDS = ["auth", "models", "sessions", "run", "help", "version", "config"];
  if (positional.length && SUBCOMMANDS.includes(positional[0]) && !args.command) {
    args.command = positional[0];
    args.rest = positional.slice(1);
  } else if (positional.length) {
    args.prompt = positional.join(" ");
  }

  return args;
}

function printHelp(): void {
  line();
  line(c.bold("  trcode") + c.gray(` v${VERSION} — agentic CLI for TokenRouter models`));
  line();
  line(c.bold("  Usage"));
  line("    trc                          interactive mode");
  line("    trc \"fix the build\"          one task, then interactive");
  line("    trc -p \"what does src/x.ts do\"  headless: answer to stdout, then exit");
  line();
  line(c.bold("  Options"));
  line("    -m, --model <id|alias>       model for this session");
  line(`    -e, --effort <level>         reasoning budget: ${EFFORT_LEVELS.join("|")}`);
  line("    -C, --cwd <path>             working directory");
  line("    -c, --continue               continue the project's last session");
  line("    -r, --resume <id>            open a specific session");
  line("    -p, --print                  headless mode");
  line("        --json                   headless: JSON output");
  line("        --yolo                   no confirmation prompts (careful)");
  line("    -v, --version                version");
  line();
  line(c.bold("  Commands"));
  line("    trc auth login               save the API key");
  line("    trc auth login --base-url U  key for a different endpoint");
  line("    trc auth status              verify the key");
  line("    trc models                   list models");
  line("    trc sessions                 sessions for this project");
  line("    trc config                   config path and contents");
  line();
  line(c.gray(`  Config: ${configPath()}`));
  line(c.gray("  Env: TOKENROUTER_API_KEY, TOKENROUTER_BASE_URL, TRCODE_MODEL"));
  line();
}

async function cmdAuth(rest: string[]): Promise<number> {
  const sub = rest[0] ?? "status";
  const cfg = loadConfig();

  if (sub === "status") {
    if (!cfg.apiKey) {
      warn("No key configured. Run: trc auth login");
      return 1;
    }
    const res = await verifyKey(cfg.baseUrl, cfg.apiKey);
    if (res.ok) {
      success(`Key is valid — ${res.detail}`);
      line(c.gray(`  ${cfg.baseUrl} · ${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}`));
      return 0;
    }
    error(res.detail);
    return 1;
  }

  if (sub === "login") {
    const positional = rest.slice(1).filter((a) => !a.startsWith("--"));
    const force = rest.includes("--force");
    const urlFlagIdx = rest.indexOf("--base-url");
    const baseUrl = (
      (urlFlagIdx !== -1 ? rest[urlFlagIdx + 1] : undefined) ??
      cfg.baseUrl ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");

    const key = (positional[0] ?? process.env.TOKENROUTER_API_KEY ?? (await askSecret("  TokenRouter key (sk-…): "))).trim();
    if (!key) {
      error("No key entered.");
      return 1;
    }

    // A stale baseUrl saved from an earlier attempt would otherwise keep
    // failing forever, so fall back to the built-in host unless one was named.
    const candidates =
      urlFlagIdx !== -1 ? [baseUrl] : [...new Set([baseUrl, DEFAULT_BASE_URL].filter(Boolean))];

    let res = { ok: false, detail: "" };
    let chosenUrl = baseUrl;
    for (const url of candidates) {
      line(c.gray(`  Checking ${url}/models with ${maskKey(key)}…`));
      res = await verifyKey(url, key);
      if (res.ok) {
        chosenUrl = url;
        break;
      }
      warn(`${url} — ${res.detail}`);
    }

    if (!res.ok) {
      error("The key was rejected by every host tried.");
      line();
      line(c.gray("  Things to check:"));
      line(c.gray(`    · the whole key, no spaces or quotes — sent ${maskKey(key)} (${key.length} chars)`));
      line(c.gray(`    · hosts tried: ${candidates.join(", ")}`));
      line(c.gray("      another host: trc auth login --base-url https://your-host/v1"));
      line(c.gray("    · save without verifying: trc auth login --force"));
      if (!force) return 1;
      warn("--force: saving the key unverified.");
    } else if (chosenUrl !== baseUrl) {
      info(`Host changed: ${baseUrl} → ${chosenUrl}`);
    }
    saveConfig({ apiKey: key, baseUrl: chosenUrl });
    success(`Saved to ${configPath()}${res.ok ? ` — ${res.detail}` : " (unverified)"}`);

    // Switching endpoints usually renames every model; repoint a stale default
    // so the very next run does not 404.
    if (res.ok) {
      const catalog = await fetchModels({ force: true });
      const cfgNow = loadConfig();
      if (catalog.length > 1 && !catalog.some((m) => m.id === cfgNow.model)) {
        let next: string | undefined;
        try {
          next = resolveModelId("k3", catalog);
        } catch {
          next = catalog.find((m) => m.chatCapable !== false)?.id;
        }
        if (next) {
          saveConfig({ model: next });
          warn(`Model "${cfgNow.model}" does not exist on this host — the default is now ${next}.`);
        }
      }
    }
    return res.ok || force ? 0 : 1;
  }

  if (sub === "logout") {
    saveConfig({ apiKey: undefined });
    success("Key removed from the config.");
    return 0;
  }

  error(`Unknown subcommand: ${sub}. Available: login, status, logout`);
  return 1;
}

async function cmdModels(): Promise<number> {
  const cfg = loadConfig();
  const catalog = await fetchModels({ force: true });
  line();
  for (const m of catalog) {
    const cur = m.id === cfg.model ? c.brightCyan("❯ ") : "  ";
    const price = m.pricing ? c.gray(`$${m.pricing.input}/$${m.pricing.output} per 1M`) : "";
    line(`  ${cur}${m.id.padEnd(24)} ${c.dim((m.owner ?? "").padEnd(10))} ${price}`);
  }
  line();
  info(`Models: ${catalog.length} · current default: ${cfg.model}`);
  return 0;
}

function cmdSessions(cwd: string): number {
  const metas = Session.list(cwd);
  if (!metas.length) {
    info("No sessions for this directory.");
    return 0;
  }
  line();
  for (const m of metas) {
    line(
      `  ${c.bold(m.id)}  ${c.gray(new Date(m.updatedAt).toLocaleString())}  ` +
        `${c.dim(String(m.messageCount) + " msgs")}  ${m.title.slice(0, 60)}`,
    );
  }
  line();
  line(c.gray("  Open with: trc -r <id>"));
  return 0;
}

function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 3) + "…";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Headless: run one prompt, print the final answer, exit. */
async function headless(args: Args): Promise<number> {
  const app = new App({ cwd: args.cwd, model: args.model, autoApprove: args.autoApprove });
  app.broker.interactive = false;
  await app.init();
  if (args.effort) app.effortOverride = args.effort;

  if (!app.cfg.apiKey) {
    error("No API key. Run: trc auth login");
    return 1;
  }

  const prompt = args.prompt ?? (await readStdin());
  if (!prompt.trim()) {
    error("Empty prompt.");
    return 1;
  }

  // In headless mode the transcript is noise; capture the answer instead.
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  if (args.json) {
    process.stdout.write = ((s: any) => {
      chunks.push(String(s));
      return true;
    }) as any;
  }

  await app.turn(prompt);

  if (args.json) {
    process.stdout.write = origWrite;
    const last = [...app.session.messages].reverse().find((m) => m.role === "assistant" && m.content);
    const totals = app.usage.totals();
    origWrite(
      JSON.stringify(
        {
          session: app.session.id,
          model: app.session.model,
          answer: last?.content ?? "",
          usage: {
            input: totals.input,
            output: totals.output,
            requests: totals.requests,
            costUsd: totals.priceUnknown ? null : Number(totals.costUsd.toFixed(6)),
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
  return 0;
}

/**
 * Ends the process without calling process.exit(): on Windows, tearing down
 * undici's keep-alive sockets mid-flight trips a libuv assertion. Setting the
 * exit code and releasing stdin lets the loop drain on its own.
 */
function finish(code: number): void {
  process.exitCode = code;
  releaseStdin();
  process.stdin.pause();
  process.stdin.unref?.();

  // Backstop: a stray listener or handle must not leave the process resident.
  // The timer is unref'd, so it only fires if something really is holding the
  // loop open — a clean exit happens first and never reaches it.
  const bail = setTimeout(() => process.exit(code), 400);
  bail.unref();
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Must land before the first loadConfig(), which memoises.
  if (args.baseUrl) process.env.TOKENROUTER_BASE_URL = args.baseUrl;
  if (args.effort && !EFFORT_LEVELS.includes(args.effort)) {
    error(`Unknown effort "${args.effort}". Available: ${EFFORT_LEVELS.join(", ")}`);
    return finish(1);
  }

  if (args.command === "help") {
    printHelp();
    return;
  }
  if (args.command === "version") {
    line(`trcode ${VERSION}`);
    return;
  }
  if (args.command === "auth") return finish(await cmdAuth(args.rest));
  if (args.command === "models") return finish(await cmdModels());
  if (args.command === "sessions") return finish(cmdSessions(args.cwd));
  if (args.command === "config") {
    const cfg = loadConfig();
    line(c.gray(configPath()));
    line(JSON.stringify({ ...cfg, apiKey: cfg.apiKey ? "…hidden…" : null }, null, 2));
    return;
  }
  if (args.command === "run") {
    args.headless = true;
    args.prompt = args.rest.join(" ") || args.prompt;
  }

  try {
    process.chdir(args.cwd);
  } catch {
    error(`Cannot enter directory: ${args.cwd}`);
    return finish(1);
  }
  args.cwd = process.cwd();

  if (args.headless || (!process.stdin.isTTY && args.prompt)) {
    return finish(await headless(args));
  }

  // Interactive.
  let session: Session | undefined;
  if (args.resume) {
    session = Session.load(args.cwd, args.resume) ?? undefined;
    if (!session) {
      error(`Session not found: ${args.resume}`);
      return finish(1);
    }
  } else if (args.continueLast) {
    session = Session.latest(args.cwd) ?? undefined;
    if (!session) warn("No previous session — starting a new one.");
  }

  const app = new App({ cwd: args.cwd, model: args.model, autoApprove: args.autoApprove, session });
  await app.init();
  if (args.effort) app.effortOverride = args.effort;

  if (args.model) {
    try {
      app.session.model = resolveModelId(args.model, app.catalog);
    } catch (err) {
      warn((err as Error).message);
    }
  }

  await app.run(args.prompt);
}

main()
  .then(() => finish(process.exitCode ? Number(process.exitCode) : 0))
  .catch((err) => {
    line();
    error(err?.message ?? String(err));
    if (process.env.TRCODE_DEBUG) line(c.gray(String(err?.stack ?? "")));
    finish(1);
  });
