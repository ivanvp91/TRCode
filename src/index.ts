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
import { fetchModels, groupByModality, groupByVendor, resolveModelId } from "./provider/models.js";
import { fmtTokens } from "./usage.js";
import { verifyKey, verifyProvider } from "./provider/client.js";
import { askSecret } from "./ui/secret.js";
import { loginProvider } from "./ui/login.js";
import { Session } from "./session/session.js";
import {
  DEFAULT_PROVIDER,
  defaultProviderId,
  hasProvider,
  modeFor,
  providerById,
  providerLabel,
  providers,
  splitModelId,
} from "./provider/registry.js";
import { clearCredentials, importVendorCredentials, readCredentials } from "./provider/credentials.js";

interface Args {
  prompt?: string;
  model?: string;
  effort?: Effort;
  preset?: "standard" | "minimal";
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
  line(c.bold("  TRCode") + c.gray(` v${VERSION} — cross-platform agentic coding CLI`));
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
  line("    trc auth login               connect the provider in use");
  line("    trc auth login --provider kimi   connect a specific one");
  line("    trc auth login --base-url U  key for a different endpoint");
  line("    trc auth status              check every connected provider");
  line("    trc auth logout [--provider P]   disconnect");
  line("    trc models                   list models");
  line("    trc sessions                 sessions for this project");
  line("    trc config                   config path and contents");
  line();
  line(c.gray(`  Config: ${configPath()}`));
  line(c.gray("  Env: TOKENROUTER_API_KEY, TOKENROUTER_BASE_URL, TRCODE_MODEL"));
  line();
}

function flagValue(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i !== -1 ? rest[i + 1] : undefined;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

async function cmdAuthStatus(): Promise<number> {
  const cfg = loadConfig();
  line();
  let anyOk = false;
  // The column is as wide as the longest label, so adding a provider with a
  // longer name does not push its own row out of the grid.
  const width = Math.max(12, ...providers().map((p) => p.label.length));
  for (const def of providers()) {
    const mode = modeFor(def.id);
    if (!mode) {
      const inherited = def.importFrom ? importVendorCredentials(def.importFrom) : null;
      line(
        `  ${c.bold(def.label.padEnd(width))} ${c.gray("not connected")}` +
          (inherited ? c.gray(`  (a ${def.label} CLI login is available — run: trc auth login --provider ${def.id})`) : ""),
      );
      continue;
    }
    const res = def.id === DEFAULT_PROVIDER ? await verifyKey(cfg.baseUrl, cfg.apiKey!) : await verifyProvider(def.id);
    if (res.ok) anyOk = true;
    const tone = res.ok ? c.green("ok") : c.red("failed");
    line(`  ${c.bold(def.label.padEnd(width))} ${tone}  ${c.gray(`${mode} · ${res.detail}`)}`);
    line(c.gray(`  ${" ".repeat(width)} ${describeCredential(def.id)}`));
  }
  line();
  return anyOk ? 0 : 1;
}

function describeCredential(providerId: string): string {
  if (providerId === DEFAULT_PROVIDER) {
    const cfg = loadConfig();
    return `${cfg.baseUrl} · ${cfg.apiKey ? maskKey(cfg.apiKey) : "no key"}`;
  }
  const creds = readCredentials(providerId);
  if (!creds) return "no credential";
  const expiry = creds.expiresAt
    ? `expires ${new Date(creds.expiresAt).toLocaleString()}${creds.refreshToken ? ", auto-renewed" : ""}`
    : "does not expire";
  return `${maskKey(creds.accessToken)} · ${expiry}${creds.source ? ` · from ${creds.source}` : ""}`;
}

async function cmdAuth(rest: string[]): Promise<number> {
  const sub = rest[0] ?? "status";
  const cfg = loadConfig();
  // Unnamed means whichever provider is in use, the same as /login in a
  // session. `--provider tokenrouter` still reaches the router explicitly.
  const providerId = flagValue(rest, "--provider") ?? defaultProviderId();
  const def = providerById(providerId);
  if (!def) {
    error(`Unknown provider: ${providerId}. Available: ${providers().map((p) => p.id).join(", ")}`);
    return 1;
  }

  if (sub === "status") return cmdAuthStatus();

  if (sub === "login" && def.id !== DEFAULT_PROVIDER) {
    const positional = rest.slice(1).filter((a) => !a.startsWith("--") && a !== def.id);
    const flagUrl = flagValue(rest, "--base-url");
    const res = await loginProvider(def, {
      mode: rest.includes("--key") ? "apikey" : rest.includes("--oauth") ? "oauth" : undefined,
      fresh: rest.includes("--fresh"),
      // A URL among the positionals is the host, not the key: the two are never
      // confusable, and typing the flag for a one-word answer is a chore.
      key: positional.find((a) => !isUrl(a)),
      baseUrl: flagUrl ?? positional.find(isUrl),
    });
    // Connecting is what this command promises; an inactive plan is reported
    // but is not a failure of the login.
    return res.connected ? 0 : 1;
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
    if (def.id === DEFAULT_PROVIDER) {
      saveConfig({ apiKey: undefined });
      success("Key removed from the config.");
      return 0;
    }
    if (!clearCredentials(def.id)) {
      warn(`${def.label} was not connected.`);
      return 0;
    }
    success(`${def.label} disconnected.`);
    return 0;
  }

  error(`Unknown subcommand: ${sub}. Available: login, status, logout`);
  return 1;
}

async function cmdModels(): Promise<number> {
  const cfg = loadConfig();
  const catalog = await fetchModels({ force: true });
  // Names without the routing prefix; which host serves one is its own column.
  const bare = (id: string) => splitModelId(id).model;
  const hosts = new Set(catalog.map((m) => splitModelId(m.id).providerId));
  const width = Math.min(38, Math.max(12, ...catalog.map((m) => bare(m.id).length + 1)));
  // Grouped the way the catalog tags them — [Text], [Images], [Video],
  // [Audio] — and by vendor inside each, so a flat 125-line dump becomes a
  // list you can find something in.
  for (const type of groupByModality(catalog)) {
    line();
    line(`  ${c.bold(c.brightYellow(`[${type.label}]`))} ${c.gray(String(type.models.length))}`);
    for (const group of groupByVendor(type.models)) {
      line();
      line(`  ${c.bold(c.brightBlue(group.vendor))}`);
      for (const m of group.models) {
        const cur = m.id === cfg.model ? c.brightCyan("❯ ") : "  ";
        const ctxWin = m.contextWindow ? `ctx ${fmtTokens(m.contextWindow)}` : "";
        const host = hosts.size > 1 ? providerLabel(splitModelId(m.id).providerId) : "";
        const price = m.pricing ? `$${m.pricing.input}/$${m.pricing.output} per 1M` : "";
        line(`  ${cur}${bare(m.id).padEnd(width)} ${c.gray(ctxWin.padEnd(11))} ${c.dim(host.padEnd(14))} ${c.dim(price)}`);
      }
    }
  }
  line();
  info(
    `Models: ${catalog.length} · ${groupByModality(catalog)
      .map((g) => `${g.label}: ${g.models.length}`)
      .join(" · ")} · current default: ${cfg.model}`,
  );
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
  if (args.preset) app.presetOverride = args.preset;
  await app.init();
  if (args.effort) app.effortOverride = args.effort;

  if (!hasProvider()) {
    error("No provider connected. Run: trc auth login");
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
    line(`TRCode ${VERSION}`);
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
  if (args.preset) app.presetOverride = args.preset;
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
