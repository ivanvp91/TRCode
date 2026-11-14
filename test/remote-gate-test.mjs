/**
 * A command that reaches another machine is confirmed even when the permission
 * mode, --yolo or a session-wide allow given for ordinary work would have let
 * it through: the base prompt asks the model to stay local, this is what holds
 * when it does not. The one way to silence it is the grant offered at that very
 * prompt ("Always allow remote commands this session").
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-remote-"));
process.env.TRCODE_HOME = HOME;

const { shellTool } = await import("../dist/tools/shell.js");
const { PermissionBroker } = await import("../dist/ui/permissions.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

const seen = [];
const ctx = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  depth: 0,
  confirm: async (_tool, args, _preview, force) => {
    seen.push({ command: args.command, force });
    return false;
  },
  emit: () => {},
  readFiles: new Set(),
};

/** Runs the command through the tool and returns the `force` its confirm got. */
const forceOf = async (command) => {
  seen.length = 0;
  const res = await shellTool.run({ command }, ctx);
  return { force: seen[0]?.force, ran: !res.isError };
};

for (const command of [
  "ssh gw.example.com 'ls /var/www'",
  "scp build.zip user@gw.example.com:/var/www/",
  "rsync -e ssh -a ./dist user@host:/var/www/app",
  "rsync -a ./dist user@host:/var/www/app",
  "mysql -h db.example.com -u root -e 'select 1'",
  "mysqldump --host=db.example.com virtirio > dump.sql",
  "mosh host",
]) {
  const { force, ran } = await forceOf(command);
  check(`${command.slice(0, 34)} is forced`, force === true && !ran, JSON.stringify({ force, ran }));
}

for (const command of [
  "git status",
  "ls -la src",
  "ssh-keygen -l -f id_rsa.pub",
  "mysql -h 127.0.0.1 -u root -e 'select 1'",
  "mysql -h127.0.0.1 -u root -e 'select 1'",
  "mysql -h 127.0.0.1:3306 -u root -e 'select 1'",
  "mysqldump --host=localhost virtirio > dump.sql",
  "curl -s http://localhost:8080/health",
]) {
  const { force } = await forceOf(command);
  check(`${command.slice(0, 34)} stays ordinary`, force === false, JSON.stringify({ force }));
}

const yolo = new PermissionBroker({ autoApprove: true, interactive: false });
check("auto approve keeps a local command silent", (await yolo.confirm(shellTool, { command: "ls" })) === true);
check("auto approve does not cover a forced one", (await yolo.confirm(shellTool, { command: "ssh x ls" }, undefined, undefined, true)) === false);

const headless = new PermissionBroker({ autoApprove: false, interactive: false });
check("headless says no to a forced one", (await headless.confirm(shellTool, { command: "ssh x ls" }, undefined, undefined, true)) === false);

// The prompt for a forced call wording is its own grant: a session-wide allow
// given for ordinary work never covers ssh, one given at that prompt does.
const granted = new PermissionBroker({ autoApprove: false, interactive: false });
granted.allowForSession("shell");
check("a grant made for local work leaves a forced call asking", (await granted.confirm(shellTool, { command: "ssh x ls" }, undefined, undefined, true)) === false);
check("…and still lets an ordinary command through", (await granted.confirm(shellTool, { command: "ls" })) === true);
granted.allowForSession("shell", true);
check("its own grant silences a forced call", (await granted.confirm(shellTool, { command: "ssh x ls" }, undefined, undefined, true)) === true);
const reset = new PermissionBroker({ autoApprove: false, interactive: false });
reset.allowForSession("shell", true);
reset.reset();
check("/new drops the remote grant too", (await reset.confirm(shellTool, { command: "ssh x ls" }, undefined, undefined, true)) === false);

fs.rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
