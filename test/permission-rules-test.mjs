/**
 * Permission rules: patterns that answer a confirmation for one command, one
 * path or one host, checked deny → ask → allow so a specific refusal always
 * outvotes a broad permission.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-rules-"));
process.env.TRCODE_HOME = HOME;

const { parseRule, evaluateRules, ruleText, validateRuleText } = await import("../dist/permissionRules.js");
const { PermissionBroker } = await import("../dist/ui/permissions.js");
const { saveConfig, loadConfig } = await import("../dist/config.js");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "trc-rules-proj-"));
let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const tool = (name, risk) => ({
  name,
  risk,
  description: "",
  parameters: { type: "object", properties: {} },
  run: async () => ({ output: "" }),
});

const shell = tool("shell", "shell");
const edit = tool("edit", "write");
const write = tool("write", "write");
const read = tool("read", "read");
const fetchTool = tool("fetch", "network");

const rule = (action, text) => ({ action, rule: text });
const decide = (rules, t, args) => evaluateRules(rules, t, args, ROOT)?.action ?? null;

// ── parsing ────────────────────────────────────────────────────────────────
check("a bare tool name parses", !("error" in parseRule("shell")));
const parsed = parseRule("shell(git status:*)");
check("tool and specifier are split", !("error" in parsed) && parsed.tool === "shell" && parsed.specifier === "git status:*");
check("a missing bracket is an error", "error" in parseRule("shell(git status"));
check("an empty specifier is an error", "error" in parseRule("shell()"));
check("validateRuleText reports the problem", typeof validateRuleText("shell(") === "string");

// ── a command prefix ───────────────────────────────────────────────────────
const prefix = [rule("allow", "shell(git status:*)")];
check("the prefix matches the bare command", decide(prefix, shell, { command: "git status" }) === "allow");
check("…and the command with arguments", decide(prefix, shell, { command: "git status --short" }) === "allow");
check("…but not a neighbouring command", decide(prefix, shell, { command: "git stash" }) === null, String(decide(prefix, shell, { command: "git stash" })));

const glob = [rule("deny", "shell(rm -rf *)")];
check("a command glob matches arguments", decide(glob, shell, { command: "rm -rf build" }) === "deny");
check("…and does not match something else", decide(glob, shell, { command: "npm run build" }) === null);
const exact = [rule("ask", "shell(npm test)")];
check("a bare command is exact", decide(exact, shell, { command: "npm test" }) === "ask");
check("…and an extension of it is not", decide(exact, shell, { command: "npm test --watch" }) === null);

// ── paths ──────────────────────────────────────────────────────────────────
const src = [rule("allow", "edit(src/**)")];
check("a path glob matches a nested file", decide(src, edit, { path: "src/ui/repl.ts" }) === "allow");
check("…and an absolute path inside the project", decide(src, edit, { path: path.join(ROOT, "src", "a.ts") }) === "allow");
check("…but not another directory", decide(src, edit, { path: "test/a.ts" }) === null);
check("a path rule names one tool", decide(src, write, { path: "src/a.ts" }) === null);
check("a write rule is the same shape", decide([rule("allow", "write(src/**)")], write, { path: "src/a.ts" }) === "allow");

const dotenv = [rule("deny", "read(./.env)")];
check("a literal path matches the relative form", decide(dotenv, read, { path: ".env" }) === "deny");
check("…and the absolute form", decide(dotenv, read, { path: path.join(ROOT, ".env") }) === "deny");
check("…and nothing else", decide(dotenv, read, { path: ".env.example" }) === null);

check("one star stays inside a segment", decide([rule("allow", "read(*.ts)")], read, { path: "a.ts" }) === "allow");
check("…which is what makes src/a.ts a miss", decide([rule("allow", "read(*.ts)")], read, { path: "src/a.ts" }) === null);

// ── domains ────────────────────────────────────────────────────────────────
const host = [rule("allow", "fetch(domain:github.com)")];
check("a domain rule matches the host", decide(host, fetchTool, { url: "https://github.com/a/b" }) === "allow");
check("…and its subdomains", decide(host, fetchTool, { url: "https://api.github.com/repos" }) === "allow");
check("…and not a lookalike", decide(host, fetchTool, { url: "https://github.com.evil.net/" }) === null);

// ── precedence ─────────────────────────────────────────────────────────────
const mixed = [rule("allow", "shell(git:*)"), rule("deny", "shell(git push:*)")];
check("a refusal outvotes a broad permission", decide(mixed, shell, { command: "git push origin main" }) === "deny");
check("the permission still covers the rest", decide(mixed, shell, { command: "git status" }) === "allow");
const asked = [rule("allow", "shell(npm:*)"), rule("ask", "shell(npm publish:*)")];
check("a question outvotes a permission", decide(asked, shell, { command: "npm publish" }) === "ask");

check("a wildcard tool matches everything", decide([rule("deny", "*")], edit, { path: "x" }) === "deny");
check("a rule for another tool is ignored", decide([rule("deny", "write(**)")], edit, { path: "a.ts" }) === null);
check("a broken rule is skipped, not fatal", decide([rule("deny", "shell("), rule("allow", "shell(ls:*)")], shell, { command: "ls -la" }) === "allow");
check("no rules means no verdict", evaluateRules([], shell, { command: "ls" }) === null);
check("ruleText trims", ruleText({ action: "allow", rule: "  shell(ls:*) " }) === "shell(ls:*)");

// ── the broker honours them ────────────────────────────────────────────────
saveConfig(
  { permissionRules: [rule("deny", "shell(rm -rf:*)"), rule("allow", "shell(git status:*)")] },
  { replace: ["permissionRules"] },
);
const yolo = new PermissionBroker({ autoApprove: true, interactive: false, cwd: ROOT });
check("a deny rule holds even under YOLO", (await yolo.confirm(shell, { command: "rm -rf build" })) === false);
check("an ordinary command is still allowed", (await yolo.confirm(shell, { command: "make" })) === true);

const strict = new PermissionBroker({ autoApprove: false, interactive: false, cwd: ROOT });
check("an allow rule silences the prompt without a terminal", (await strict.confirm(shell, { command: "git status -s" })) === true);
check("a command outside the rules still needs a terminal", (await strict.confirm(shell, { command: "npm install" })) === false);
check("a remote call is not covered by an allow rule", (await strict.confirm(shell, { command: "git status" }, undefined, undefined, true)) === false);

const remoteDeny = new PermissionBroker({ autoApprove: true, interactive: false, cwd: ROOT });
saveConfig({ permissionRules: [rule("deny", "shell(git:*)")] }, { replace: ["permissionRules"] });
check("a deny rule covers a remote call as well", (await remoteDeny.confirm(shell, { command: "git push" }, undefined, undefined, true)) === false);
check("the sessions grant is untouched by rules", strict.isAllowed("shell") === false);
check("rules survive a save round-trip", loadConfig().permissionRules.length === 1, JSON.stringify(loadConfig().permissionRules));

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
