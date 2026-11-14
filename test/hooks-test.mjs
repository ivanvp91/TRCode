/**
 * Lifecycle hooks and the turn notification: the payload a hook sees, what an
 * exit code means, the matcher, the project settings layer, and the switches
 * that turn the whole thing off.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-hooks-home-"));
process.env.TRCODE_HOME = HOME;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "trc-hooks-proj-"));
fs.mkdirSync(path.join(ROOT, ".git"));
fs.mkdirSync(path.join(ROOT, ".trcode"));

const { runHook, runHookEvent, fireNotify, hookSettings, hooksFor, resetHookSettings, projectSettingsPath, trustProjectHooks } =
  await import("../dist/hooks.js");
const { checkProjectSettings } = await import("../dist/ui/commands/hooks.js");
const { saveConfig } = await import("../dist/config.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const scripts = path.join(HOME, "scripts");
fs.mkdirSync(scripts, { recursive: true });
const out = path.join(HOME, "out.json");

/** A hook that records its payload, prints a line, and exits with $HOOK_CODE. */
const recorder = path.join(scripts, "record.mjs");
fs.writeFileSync(
  recorder,
  `import fs from "node:fs";
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (body += d));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.HOOK_OUT, JSON.stringify({
    event: process.env.TRCODE_EVENT,
    tool: process.env.TRCODE_TOOL,
    cwd: process.env.TRCODE_CWD,
    session: process.env.TRCODE_SESSION_ID,
    payload: body,
  }));
  process.stdout.write("hook says hello\\n");
  process.stderr.write("hook refuses\\n");
  process.exit(Number(process.env.HOOK_CODE || 0));
});
`,
);
const slow = path.join(scripts, "slow.mjs");
fs.writeFileSync(slow, "setTimeout(() => process.exit(0), 5000);\n");

const hookCommand = (script = recorder) => `node "${script.replace(/\\/g, "/")}"`;

process.env.HOOK_OUT = out;

// ── the settings layers ────────────────────────────────────────────────────
saveConfig({
  hooks: { PreToolUse: [{ command: "user-hook" }] },
  notify: ["user-notify"],
});
fs.writeFileSync(
  projectSettingsPath(ROOT),
  JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "edit", command: "project-hook" }], Stop: [{ command: "stop-hook" }] },
    notify: ["project-notify"],
  }),
);
resetHookSettings();
let settings = hookSettings(ROOT);
check("a repository's hooks wait for a yes", settings.pending?.count === 3 && settings.hooks.PreToolUse.length === 1, JSON.stringify(settings.pending));
const trusted = trustProjectHooks(ROOT);
check("trusting the file takes it in", trusted.ok && trusted.count === 3, JSON.stringify(trusted));
settings = hookSettings(ROOT);
check("project hooks are added to the user's", settings.hooks.PreToolUse.length === 2, JSON.stringify(settings.hooks));
check("a project event the user never set is honoured", settings.hooks.Stop?.[0]?.command === "stop-hook");
check("project notify wins over the user's", settings.notify[0] === "project-notify", JSON.stringify(settings.notify));
check("both files are named as sources", settings.sources.length === 2, JSON.stringify(settings.sources));
check("an approved file has nothing pending", settings.pending === null);

check("a matcher filters by tool name", hooksFor("PreToolUse", ROOT, "edit").length === 2 && hooksFor("PreToolUse", ROOT, "shell").every((d) => !d.matcher));
fs.writeFileSync(projectSettingsPath(ROOT), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "[", command: "broken-pattern" }] } }));
resetHookSettings();
check("an edited file asks again before it runs", hookSettings(ROOT).pending !== null);
trustProjectHooks(ROOT);
resetHookSettings();
check("an invalid pattern matches nothing", hooksFor("PreToolUse", ROOT, "edit").length === 1);

// ── what a hook sees and what its exit code means ──────────────────────────
fs.rmSync(path.join(ROOT, ".trcode", "settings.json"));
resetHookSettings();
saveConfig({ hooks: { PreToolUse: [{ command: hookCommand(), timeoutMs: 4000 }], PostToolUse: [{ command: hookCommand() }] } }, { replace: ["hooks"] });
resetHookSettings();
process.env.HOOK_CODE = "0";
let verdict = await runHookEvent("PreToolUse", { cwd: ROOT, tool: "edit", args: { path: "a.ts" }, sessionId: "s1" });
let seen = JSON.parse(fs.readFileSync(out, "utf8"));
check("exit 0 does not block", !verdict.blocked);
check("stdout comes back as context", verdict.stdout.includes("hook says hello"), verdict.stdout);
check("the event reaches the hook", seen.event === "PreToolUse", seen.event);
check("the tool name and cwd reach the hook", seen.tool === "edit" && path.resolve(seen.cwd) === path.resolve(ROOT), JSON.stringify(seen));
check("the session id reaches the hook", seen.session === "s1");
const payload = JSON.parse(seen.payload);
check("the payload carries the arguments", payload.args?.path === "a.ts", seen.payload);

process.env.HOOK_CODE = "2";
verdict = await runHookEvent("PreToolUse", { cwd: ROOT, tool: "shell" });
check("exit 2 blocks", verdict.blocked);
check("the reason is the hook's stderr", verdict.reason.includes("hook refuses"), verdict.reason);

process.env.HOOK_CODE = "3";
verdict = await runHookEvent("PreToolUse", { cwd: ROOT, tool: "shell" });
check("any other exit code is ignored", !verdict.blocked);

process.env.HOOK_CODE = "0";
const slowResult = await runHook({ command: hookCommand(slow), timeoutMs: 300 }, "PreToolUse", { cwd: ROOT });
check("a hook that outlives its timeout is killed, not blocked", slowResult.code === -1, JSON.stringify(slowResult));

// ── notify ─────────────────────────────────────────────────────────────────
const notifyFile = path.join(HOME, "notify.json");
const notifier = path.join(scripts, "notify.mjs");
fs.writeFileSync(
  notifier,
  `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(notifyFile.replace(/\\/g, "/"))}, process.argv[process.argv.length - 1]);
`,
);
saveConfig({ notify: ["node", notifier.replace(/\\/g, "/")] }, { replace: ["notify"] });
resetHookSettings();
fireNotify({ cwd: ROOT, ok: true, stoppedBecause: "stop", lastMessage: "all done" });
const deadline = Date.now() + 5000;
while (!fs.existsSync(notifyFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
const notified = fs.existsSync(notifyFile) ? JSON.parse(fs.readFileSync(notifyFile, "utf8")) : null;
check("notify gets the payload as its last argument", notified?.ok === true && notified?.lastAssistantMessage === "all done", JSON.stringify(notified));

// ── what a project file may and may not set ────────────────────────────────
fs.writeFileSync(projectSettingsPath(ROOT), JSON.stringify({ hooks: {}, permissions: { shell: "allow" } }));
const refused = checkProjectSettings(ROOT);
check("a project may not set permissions", Boolean(refused.hint?.includes("permissions")), JSON.stringify(refused));
fs.writeFileSync(path.join(ROOT, ".trcode", "settings.json"), "{ not json");
check("a broken project file is reported", Boolean(checkProjectSettings(ROOT).warning));
fs.rmSync(path.join(ROOT, ".trcode", "settings.json"));

process.env.TRCODE_NO_HOOKS = "1";
resetHookSettings();
check("TRCODE_NO_HOOKS silences everything", hookSettings(ROOT).hooks.PreToolUse === undefined && hookSettings(ROOT).notify.length === 0);delete process.env.TRCODE_NO_HOOKS;
resetHookSettings();
check("…and returns when it is unset", hookSettings(ROOT).notify[0] === "node" && hookSettings(ROOT).notify.length === 2, JSON.stringify(hookSettings(ROOT).notify));

// Windows keeps a handle on the directory the hooks ran in for a moment.
for (const dir of [HOME, ROOT]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a killed hook's child still holds the cwd */
  }
}
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
