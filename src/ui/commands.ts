/** Slash commands, grouped from everyday to occasional. */
import path from "node:path";
import { spawn } from "node:child_process";
import { c } from "./ansi.js";
import { contentWidth } from "./layout.js";
import { error, info, line, padded, rule, Spinner, success, truncate, warn } from "./render.js";
import { pick } from "./picker.js";
import { pickModel } from "./modelpicker.js";
import { askSecret } from "./secret.js";
import { scanKeys } from "./keyscan.js";
import { setExtraNewlineKeys } from "./editor.js";
import { loadConfig, saveConfig, configPath, VERSION, EFFORT_LEVELS, type Effort } from "../config.js";
import {
  fetchModels,
  resolveModelId,
  findModel,
  usableModels,
  incompatibleReason,
  groupByVendor,
  MODALITIES,
} from "../provider/models.js";
import { verifyKey, modelRejectsEffort, resetEffortLearning } from "../provider/client.js";
import { Session } from "../session/session.js";
import { compactSession, contextPressure } from "../session/compact.js";
import { fmtTokens } from "../usage.js";
import { runSwarm } from "../agent/swarm.js";
import { runOrchestration } from "../agent/orchestrator.js";
import { createSkill } from "../skills/loader.js";
import type { App } from "./repl.js";

type Group = "main" | "session" | "settings" | "other";

const GROUP_ORDER: Group[] = ["main", "session", "settings", "other"];

const EFFORT_HINTS: Record<Effort, string> = {
  off: "send no parameter — the model's own default",
  minimal: "barely any reasoning — fastest and cheapest",
  low: "brief reasoning",
  medium: "a balance of speed and quality",
  high: "maximum reasoning — slower and pricier",
};

interface Command {
  name: string;
  group: Group;
  args?: string;
  help: string;
  /** Returns false to exit the REPL. */
  run(app: App, rest: string): Promise<boolean | void>;
}

/** Says so plainly when a chosen model cannot be driven through this client. */
function warnIfIncompatible(app: App, id: string): void {
  const m = findModel(id, app.catalog);
  const why = m ? incompatibleReason(m) : null;
  if (!why) return;
  warn(`${id} cannot be driven through /v1/chat/completions — ${why}. Requests to it will fail.`);
}

const COMMANDS: Command[] = [
  // ── main ────────────────────────────────────────────────────────────────
  {
    name: "/model",
    group: "main",
    args: "[name|alias]",
    help: "switch model — grouped by vendor, with Text/Images/Video/Audio tabs",
    async run(app, rest) {
      if (rest.trim()) {
        const id = resolveModelId(rest.trim(), app.catalog);
        app.session.model = id;
        app.rebuildTools();
        app.session.save();
        success(`Model: ${c.brightYellow(id)}`);
        warnIfIncompatible(app, id);
        return;
      }
      const cfg = loadConfig();
      const chosen = await app.exclusiveInput(() =>
        pickModel({ catalog: app.catalog, current: app.session.model, defaultModel: cfg.model }),
      );
      if (!chosen) return;
      app.session.model = chosen;
      app.rebuildTools();
      app.session.save();
      success(`Model: ${c.brightYellow(chosen)}`);
      warnIfIncompatible(app, chosen);
      const aliasFor = Object.entries(cfg.aliases).find(([, v]) => v === chosen)?.[0];
      if (aliasFor) padded(c.gray(`alias: /model ${aliasFor}`));
      if (chosen !== cfg.model) padded(c.gray("make it the default: /default"));
    },
  },
  {
    name: "/effort",
    group: "main",
    args: "[off|minimal|low|medium|high] [save] | reset",
    help: "reasoning budget",
    async run(app, rest) {
      const cfg = loadConfig();
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const persist = parts.includes("save");
      const wanted = parts.find((p) => (EFFORT_LEVELS as string[]).includes(p)) as Effort | undefined;

      if (parts[0] === "reset") {
        const target = parts[1] === "all" ? undefined : app.session.model;
        resetEffortLearning(target);
        success(
          target
            ? `Forgot that ${target} rejects the reasoning budget — it will be probed again on the next request.`
            : "Cleared what was learned about reasoning support for every model.",
        );
        return;
      }

      if (parts.length && !wanted && !persist) {
        error(`Unknown level "${parts[0]}". Available: ${EFFORT_LEVELS.join(", ")}`);
        padded(c.gray("Also: /effort reset re-probes support for the current model."));
        return;
      }

      const level =
        wanted ??
        ((await app.exclusiveInput(() =>
          pick({
            title: `Reasoning budget (now: ${app.effort()})`,
            items: EFFORT_LEVELS.map((l) => ({
              value: l,
              label: l.padEnd(10),
              hint: c.gray(EFFORT_HINTS[l]),
            })),
            initial: app.effort(),
          }),
        )) as Effort | null);

      if (!level) return;

      app.effortOverride = level;
      if (persist) {
        saveConfig({ effort: level });
        app.cfg = loadConfig();
        success(`Effort: ${c.brightMagenta(level)} — saved as the default.`);
      } else {
        success(`Effort: ${c.brightMagenta(level)} (this session; add save to keep it)`);
      }
      if (level !== "off" && modelRejectsEffort(app.session.model)) {
        warn(`${app.session.model} rejected this parameter before — it is being omitted.`);
        padded(c.gray("Re-check with: /effort reset"));
      }
      if (level !== "off") {
        padded(
          c.gray(
            `Sent as ${cfg.effortParam === "both" ? "the shape this model accepts" : cfg.effortParam}; ` +
              "dropped automatically if the model rejects it.",
          ),
        );
      }
    },
  },
  {
    name: "/yolo",
    group: "main",
    help: "skip confirmations — tools run immediately",
    async run(app, rest) {
      const arg = rest.trim().toLowerCase();
      const next = arg ? ["on", "1", "true"].includes(arg) : !app.broker.autoApprove;
      app.broker.autoApprove = next;
      if (next) {
        warn("YOLO on — file writes and shell commands run without asking.");
        padded(c.gray("Turn it off with: /yolo off"));
      } else {
        success("YOLO off — confirmations are back.");
      }
    },
  },
  {
    name: "/orchestrate",
    group: "main",
    args: "<task>",
    help: "split a task into subtasks and run them on subagents",
    async run(app, rest) {
      const task = rest.trim();
      if (!task) {
        warn("Name the task: /orchestrate <what to do>");
        padded(c.gray("The task is split into steps with dependencies; independent ones run in parallel."));
        padded(c.gray("Unlike /swarm, which sends one whole task to several models."));
        return;
      }
      await runOrchestration(app, task);
    },
  },
  {
    name: "/swarm",
    group: "main",
    args: "<task>",
    help: "swarm: several models solve it in parallel, then a synthesis pass",
    async run(app, rest) {
      const task = rest.trim();
      if (!task) return warn("Name the task: /swarm <what to solve>");
      await runSwarm(app, task);
    },
  },
  {
    name: "/compact",
    group: "main",
    args: "[what to focus on]",
    help: "compact the history into a digest",
    async run(app, rest) {
      if (app.session.messages.length < 4) return info("The history is too short to compact.");
      const before = contextPressure(app.session, app.catalog);
      const sp = new Spinner("compacting context");
      sp.start();
      try {
        const res = await compactSession(app.session, {
          instructions: rest.trim() || undefined,
          catalog: app.catalog,
        });
        sp.stop();
        if (!res.summary) return info("Nothing to compact.");
        const after = contextPressure(app.session, app.catalog);
        success(
          `Compacted ${res.droppedMessages} messages into a digest. ` +
            `Context ${Math.round(before.ratio * 100)}% → ${Math.round(after.ratio * 100)}%.`,
        );
        line();
        for (const l of res.summary.split("\n").slice(0, 20)) padded(c.dim(l));
        if (res.summary.split("\n").length > 20) padded(c.gray("…"));
        line();
      } catch (err) {
        sp.stop();
        error((err as Error).message);
      }
    },
  },
  {
    name: "/new",
    group: "main",
    help: "start a new session",
    async run(app) {
      app.session.save();
      const fresh = new Session({ cwd: app.cwd, model: app.session.model });
      app.session = fresh;
      app.usage = fresh.usage;
      app.readFiles.clear();
      app.broker.reset();
      app.todo.replace([]);
      app.rebuildTools();
      success("New session: " + fresh.id);
    },
  },

  // ── session ─────────────────────────────────────────────────────────────
  {
    name: "/sessions",
    group: "session",
    help: "sessions for this project",
    async run(app) {
      const metas = Session.list(app.cwd);
      if (!metas.length) return info("No saved sessions.");
      line();
      for (const m of metas) {
        const cur = m.id === app.session.id ? c.brightCyan("❯ ") : "  ";
        padded(
          `${cur}${c.bold(m.id)}  ${c.gray(new Date(m.updatedAt).toLocaleString())}  ` +
            `${c.dim(String(m.messageCount) + " msgs")}  ${truncate(m.title, 44)}`,
        );
      }
      line();
      padded(c.gray("Restore with: /resume <id>"));
    },
  },
  {
    name: "/resume",
    group: "session",
    args: "[id]",
    help: "restore a session",
    async run(app, rest) {
      let id = rest.trim();
      if (!id) {
        const metas = Session.list(app.cwd);
        if (!metas.length) return info("No saved sessions.");
        const chosen = await app.exclusiveInput(() =>
          pick({
            title: "Pick a session",
            items: metas.map((m) => ({
              value: m.id,
              label: truncate(m.title, 46).padEnd(48),
              hint: c.gray(`${new Date(m.updatedAt).toLocaleString()} · ${m.messageCount} msgs`),
            })),
            initial: app.session.id,
          }),
        );
        if (!chosen) return;
        id = chosen;
      }
      const loaded = Session.load(app.cwd, id);
      if (!loaded) return error(`Session not found: ${id}`);
      app.session.save();
      app.session = loaded;
      app.usage = loaded.usage;
      app.readFiles.clear();
      app.rebuildTools();
      success(`Restored ${loaded.id} — ${loaded.messages.length} messages, model ${loaded.model}`);
      if (loaded.messages.length) app.replayHistory();
    },
  },
  {
    name: "/context",
    group: "session",
    help: "how full the context window is",
    async run(app) {
      const { used, window, ratio } = contextPressure(app.session, app.catalog);
      const m = findModel(app.session.model, app.catalog);
      const barWidth = Math.min(40, contentWidth() - 10);
      const filled = Math.min(barWidth, Math.round(ratio * barWidth));
      line();
      padded(c.brightCyan("█".repeat(filled)) + c.gray("░".repeat(barWidth - filled)) + ` ${Math.round(ratio * 100)}%`);
      padded(
        c.gray(
          `~${fmtTokens(used)} of ${fmtTokens(window)} tokens · ${app.session.messages.length} messages` +
            (app.session.compactions ? ` · compactions: ${app.session.compactions}` : ""),
        ),
      );
      if (!m?.contextWindow) {
        padded(c.gray(`The API does not report the window size — this is an estimate. Pin it in config.json → "contextWindows".`));
      }
      line();
    },
  },
  {
    name: "/cost",
    group: "session",
    help: "session token usage by model",
    async run(app) {
      const rows = app.usage.all();
      const t = app.usage.totals();
      line();
      rule(c.brightCyan(" session tokens "));
      if (!rows.length) {
        padded(c.gray("No requests yet."));
        line();
        return;
      }
      padded(
        `${c.gray("model".padEnd(34))} ${c.gray("reqs".padStart(6))} ${c.gray("input".padStart(10))} ` +
          `${c.gray("output".padStart(10))} ${c.gray("reasoning".padStart(10))}`,
      );
      for (const r of rows) {
        padded(
          `${r.model.padEnd(34)} ${String(r.requests).padStart(6)} ${fmtTokens(r.input).padStart(10)} ` +
            `${fmtTokens(r.output).padStart(10)} ${(r.reasoning ? fmtTokens(r.reasoning) : "—").padStart(10)}`,
        );
      }
      padded(c.gray("─".repeat(Math.min(68, contentWidth()))));
      padded(
        `${c.bold("total".padEnd(34))} ${String(t.requests).padStart(6)} ${c.bold(fmtTokens(t.input).padStart(10))} ` +
          `${c.bold(fmtTokens(t.output).padStart(10))} ${(t.reasoning ? fmtTokens(t.reasoning) : "—").padStart(10)}`,
      );
      if (t.reasoning > t.output * 0.5) {
        line();
        padded(
          c.gray(
            "More than half the output is the model thinking. It is billed as output;" +
              " lower it with /effort medium or /effort low.",
          ),
        );
      }

      line();
    },
  },

  // ── settings ────────────────────────────────────────────────────────────
  {
    name: "/default",
    group: "settings",
    args: "[name|alias]",
    help: "pin the default model",
    async run(app, rest) {
      const cfg = loadConfig();
      const target = rest.trim() ? resolveModelId(rest.trim(), app.catalog) : app.session.model;
      if (target === cfg.model) return info(`The default model is already ${c.brightYellow(target)}.`);
      saveConfig({ model: target });
      app.cfg = loadConfig();
      app.session.model = target;
      app.rebuildTools();
      app.session.save();
      success(`Default model: ${c.brightYellow(target)}`);
      padded(c.gray(`Written to ${configPath()}. Applies to this session too.`));
    },
  },
  {
    name: "/models",
    group: "settings",
    args: "[all]",
    help: "catalog from the server, by vendor",
    async run(app, rest) {
      const showAll = /^all$/i.test(rest.trim());
      const sp = new Spinner("fetching the model catalog");
      sp.start();
      app.catalog = await fetchModels({ force: true });
      sp.stop();
      app.rebuildTools();

      const usable = usableModels(app.catalog);
      const shown = showAll ? app.catalog : usable.filter((m) => (m.modality ?? "text") === "text");
      const width = Math.min(34, Math.max(...shown.map((m) => m.id.length)) + 1);

      for (const group of groupByVendor(shown)) {
        line();
        padded(c.gray("──── ") + c.bold(c.brightBlue(group.vendor)) + c.gray(" " + "─".repeat(Math.max(2, 30 - group.vendor.length))));
        for (const m of group.models) {
          const cur = m.id === app.session.model ? c.brightCyan("❯ ") : "  ";
          const why = incompatibleReason(m);
          const ctxWin = m.contextWindow ? c.gray(`ctx ${fmtTokens(m.contextWindow)}`) : "";
          const tail = why ? c.red(why) : "";
          padded(`${cur}${m.id.padEnd(width)} ${ctxWin.padEnd(12)} ${tail}`);
        }
      }

      line();
      const hidden = app.catalog.length - shown.length;
      info(`Showing ${shown.length} of ${app.catalog.length}`);
      if (hidden > 0 && !showAll) {
        const byType = MODALITIES.map((mo) => {
          const n = app.catalog.filter((m) => (m.modality ?? "text") === mo.key).length;
          return n ? `${mo.label}: ${n}` : "";
        })
          .filter(Boolean)
          .join(", ");
        padded(c.gray(`${hidden} hidden — by type: ${byType}. All of them: /models all · pick by type: /model`));
      }
    },
  },
  {
    name: "/aliases",
    group: "settings",
    help: "short names for models",
    async run() {
      const cfg = loadConfig();
      line();
      for (const [k, v] of Object.entries(cfg.aliases)) padded(`${c.brightGreen(k.padEnd(10))} → ${v}`);
      line();
      padded(c.gray(`Edit them in ${configPath()} → "aliases".`));
    },
  },
  {
    name: "/permissions",
    group: "settings",
    args: "[class] [ask|allow|deny]",
    help: "confirmation rules",
    async run(_app, rest) {
      const cfg = loadConfig();
      const [risk, mode] = rest.trim().split(/\s+/);
      if (!risk) {
        line();
        for (const [k, v] of Object.entries(cfg.permissions)) {
          const color = v === "allow" ? c.green : v === "deny" ? c.red : c.yellow;
          padded(`${k.padEnd(10)} ${color(v)}`);
        }
        line();
        padded(c.gray("Change with: /permissions shell allow"));
        return;
      }
      if (!["read", "write", "shell", "network", "agent"].includes(risk)) return error(`Unknown class: ${risk}`);
      if (!["ask", "allow", "deny"].includes(mode)) return error("Mode must be ask, allow or deny");
      saveConfig({ permissions: { ...cfg.permissions, [risk]: mode } as any });
      success(`${risk} → ${mode}`);
    },
  },
  {
    name: "/login",
    group: "settings",
    help: "save the API key",
    async run(app) {
      const key = await app.exclusiveInput(() => askSecret("  Paste the key (sk-…): "));
      if (!key) return warn("Cancelled.");
      const cfg = loadConfig();
      const sp = new Spinner("verifying the key");
      sp.start();
      const check = await verifyKey(cfg.baseUrl, key);
      sp.stop();
      if (!check.ok) return error(`Key rejected: ${check.detail}`);
      saveConfig({ apiKey: key });
      app.cfg = loadConfig();
      app.catalog = await fetchModels({ force: true });
      app.rebuildTools();
      success(`Key saved to ${configPath()} — ${check.detail}`);
    },
  },
  {
    name: "/config",
    group: "settings",
    help: "current configuration",
    async run(app) {
      const cfg = loadConfig();
      const shown = { ...cfg, apiKey: cfg.apiKey ? cfg.apiKey.slice(0, 6) + "…" + cfg.apiKey.slice(-4) : null };
      line();
      padded(c.gray(configPath()));
      for (const l of JSON.stringify(shown, null, 2).split("\n")) padded(c.dim(l));
      line();
      padded(c.gray(`Directory: ${app.cwd}`));
    },
  },
  {
    name: "/cwd",
    group: "settings",
    args: "[path]",
    help: "change the working directory",
    async run(app, rest) {
      if (!rest.trim()) return info(app.cwd);
      const next = path.resolve(app.cwd, rest.trim());
      try {
        process.chdir(next);
      } catch (err) {
        return error(`Failed: ${(err as Error).message}`);
      }
      app.cwd = next;
      app.readFiles.clear();
      app.reloadHistory();
      app.rebuildTools();
      success(`Working directory: ${next}`);
    },
  },

  // ── other ───────────────────────────────────────────────────────────────
  {
    name: "/keys",
    group: "other",
    help: "show what the terminal sends; pin your own newline key",
    async run(app) {
      const seen = await app.exclusiveInput(() => scanKeys());
      line();
      if (!seen.length) {
        warn("The terminal sent nothing at all.");
        padded(c.gray("It most likely swallows those combinations as its own shortcuts — the CLI never sees them."));
        padded(c.gray("Use Ctrl+Enter, Alt+Enter, or a trailing backslash instead."));
        return;
      }

      // Anything that is not already a newline key is a candidate to become one.
      const candidates = seen.filter(
        (k) => !k.meaning.startsWith("insert a newline") && k.raw !== "\r" && k.raw.length > 1,
      );
      if (!candidates.length) {
        success("Every key you pressed is already recognised.");
        return;
      }

      const last = candidates[candidates.length - 1];
      const chosen = await app.exclusiveInput(() =>
        pick({
          title: "Pin this as a newline key?",
          items: [
            { value: last.raw, label: last.readable.padEnd(22), hint: c.gray(last.hex) },
            { value: "", label: "do not pin".padEnd(22), hint: "" },
          ],
        }),
      );
      if (!chosen) return;

      const cfg = loadConfig();
      const keys = [...new Set([...(cfg.newlineKeys ?? []), chosen])];
      saveConfig({ newlineKeys: keys });
      setExtraNewlineKeys(keys);
      app.cfg = loadConfig();
      success("Pinned — that combination now inserts a newline.");
      padded(c.gray(`Written to ${configPath()} → "newlineKeys".`));
    },
  },
  {
    name: "/tools",
    group: "other",
    help: "tools available to the model",
    async run(app) {
      line();
      for (const t of app.toolList()) {
        const risk = t.risk === "shell" ? c.red(t.risk) : t.risk === "write" ? c.yellow(t.risk) : c.gray(t.risk);
        padded(`${c.bold(t.name.padEnd(10))} ${risk.padEnd(16)} ${c.dim(truncate(t.description, contentWidth() - 32))}`);
      }
      line();
    },
  },
  {
    name: "/skills",
    group: "other",
    args: "[new <name> [description] | gen <task> | edit <name> | global]",
    help: "skills: list, create, edit",
    async run(app, rest) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (sub === "new") {
        const global = parts.includes("global");
        const args = parts.slice(1).filter((p) => p !== "global");
        const name = args[0];
        if (!name) return error("Name it: /skills new code-review [description]");
        const { file, existed } = createSkill({
          cwd: app.cwd,
          name,
          description: args.slice(1).join(" "),
          scope: global ? "user" : "project",
        });
        app.rebuildTools();
        if (existed) warn(`That skill already exists: ${file}`);
        else success(`Created ${file}`);
        padded(c.gray("Open the file and write the procedure. The description line is what matters:"));
        padded(c.gray("the model decides whether to load the skill from it."));
        padded(c.gray(`Edit it with: /skills edit ${name}`));
        return;
      }

      if (sub === "edit") {
        const name = parts[1];
        const skill = app.skills.find((s) => s.name === name);
        if (!skill) return error(`Skill not found: ${name ?? "(no name given)"}`);
        const file = path.join(skill.dir, "SKILL.md");
        const editor = process.env.VISUAL || process.env.EDITOR;
        if (!editor) {
          info(file);
          padded(c.gray("EDITOR is not set — open the file in your own editor."));
          return;
        }
        await app.exclusiveInput(
          () =>
            new Promise<void>((resolve) => {
              const child = spawn(editor, [file], { stdio: "inherit" });
              child.on("close", () => resolve());
              child.on("error", (err: Error) => {
                error(`Could not launch ${editor}: ${err.message}`);
                resolve();
              });
            }),
        );
        app.rebuildTools();
        success("Skills reloaded.");
        return;
      }

      if (sub === "gen") {
        const task = parts.slice(1).join(" ");
        if (!task) return error("Describe the task: /skills gen review pull requests");
        await app.turn(
          `Write a trcode skill for this task: "${task}".\n\n` +
            `A skill is a folder .trcode/skills/<name>/SKILL.md with frontmatter:\n` +
            `---\nname: <short-name>\ndescription: <WHEN to apply it, one sentence>\n---\n\n` +
            `Study the repository first so the procedure rests on this project's real commands and files ` +
            `rather than generalities. The body is a concrete procedure, what not to do, and the answer format. ` +
            `Keep it under 50 lines. Create the file with write.`,
        );
        app.rebuildTools();
        return;
      }

      app.rebuildTools();
      if (!app.skills.length) {
        info("No skills yet.");
        padded(c.gray("Scaffold one: /skills new <name> [description]"));
        padded(c.gray("Or let the agent write it: /skills gen <task to automate>"));
        return;
      }
      line();
      for (const s of app.skills) {
        const scope = s.scope === "project" ? c.brightGreen("project") : c.gray("global");
        padded(`${c.bold(s.name.padEnd(22))} ${scope.padEnd(20)} ${c.dim(truncate(s.description, contentWidth() - 46))}`);
      }
      line();
      padded(c.gray("The model loads a skill by itself when the task matches its description."));
      padded(c.gray("New: /skills new <name> · Edit: /skills edit <name> · Generate: /skills gen <task>"));
    },
  },
  {
    name: "/todo",
    group: "other",
    help: "current plan",
    async run(app) {
      line();
      line(app.todo.render());
      line();
    },
  },
  {
    name: "/init",
    group: "other",
    help: "write AGENTS.md from the repository",
    async run(app) {
      await app.turn(
        "Study this repository and write AGENTS.md at its root — a short briefing for an agent working here. " +
          "Cover: what the project is, the stack, the directory layout, the build/test/lint commands (taken from real files, not invented), " +
          "and the conventions the code follows. Write densely, no filler, under 60 lines. If AGENTS.md already exists, update it.",
      );
    },
  },
  {
    name: "/clear",
    group: "other",
    help: "clear the screen",
    async run() {
      process.stdout.write(String.fromCharCode(27) + "[2J" + String.fromCharCode(27) + "[H");
    },
  },
  {
    name: "/version",
    group: "other",
    help: "version",
    async run() {
      info(`trcode ${VERSION} · node ${process.version} · ${process.platform}`);
    },
  },
  {
    name: "/help",
    group: "other",
    help: "full help",
    async run() {
      line();
      rule(c.brightCyan(" commands "));
      for (const g of GROUP_ORDER) {
        const inGroup = COMMANDS.filter((cmd) => cmd.group === g);
        if (!inGroup.length) continue;
        line();
        padded(c.bold(c.brightBlue(g.toUpperCase())));
        for (const cmd of inGroup) {
          const label = `${cmd.name}${cmd.args ? " " + cmd.args : ""}`;
          padded(`  ${c.bold(label.padEnd(34))} ${c.gray(cmd.help)}`);
        }
      }
      line();
      padded(c.gray("Plain text is a task for the agent."));
      padded(c.gray("Ctrl+Enter inserts a newline (so does a trailing backslash)."));
      padded(c.gray("Esc interrupts the current turn. Ctrl+C exits."));
      line();
    },
  },
  {
    name: "/exit",
    group: "other",
    help: "exit",
    async run() {
      return false;
    },
  },
];

const ALIASES: Record<string, string> = {
  "/quit": "/exit",
  "/q": "/exit",
  "/?": "/help",
  "/h": "/help",
  "/orch": "/orchestrate",
};

export function commandNames(): string[] {
  return [...COMMANDS.map((cmd) => cmd.name), ...Object.keys(ALIASES)].sort();
}

/**
 * Rows for the editor dropdown. Opens on a leading "/" and stays open only
 * while the first word is still being typed.
 */
export function commandSuggestions(buffer: string): { value: string; hint: string }[] {
  if (!buffer.startsWith("/")) return [];
  if (/\s/.test(buffer)) return [];
  const q = buffer.toLowerCase();
  const ordered = GROUP_ORDER.flatMap((g) => COMMANDS.filter((cmd) => cmd.group === g));
  return ordered
    .filter((cmd) => cmd.name.startsWith(q))
    .map((cmd) => ({ value: cmd.name, hint: cmd.args ? `${cmd.args}  —  ${cmd.help}` : cmd.help }));
}

export function isCommand(text: string): boolean {
  return text.startsWith("/");
}

/** Compact grouped listing shown when the user types just "/". */
export function printCommandIndex(): void {
  line();
  padded(c.bold("Commands") + c.gray("   /help for details"));
  for (const g of GROUP_ORDER) {
    const names = COMMANDS.filter((cmd) => cmd.group === g).map((cmd) => cmd.name);
    if (!names.length) continue;
    padded(c.gray(g.padEnd(11)) + names.map((n) => c.brightCyan(n)).join(c.gray(" · ")));
  }
  line();
}

/** Returns false when the REPL should exit. */
export async function runCommand(app: App, text: string): Promise<boolean> {
  if (text.trim() === "/") {
    printCommandIndex();
    return true;
  }
  const space = text.indexOf(" ");
  const rawName = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : text.slice(space + 1);
  const name = ALIASES[rawName] ?? rawName;

  const cmd = COMMANDS.find((x) => x.name === name);
  if (!cmd) {
    const near = commandNames().filter((n) => n.startsWith(rawName.slice(0, 3)));
    error(`Unknown command ${rawName}${near.length ? ` — did you mean: ${near.join(", ")}` : ""}`);
    return true;
  }
  const res = await cmd.run(app, rest);
  return res !== false;
}
