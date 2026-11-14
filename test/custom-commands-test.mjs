/**
 * Slash commands defined as markdown files: where they are read from, how a
 * subdirectory becomes a namespace, argument substitution, and the !`cmd`
 * placeholders that put the state of the repository into the prompt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-cmd-home-"));
process.env.TRCODE_HOME = HOME;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "trc-cmd-proj-"));
fs.mkdirSync(path.join(ROOT, ".git"));
const PROJECT = path.join(ROOT, ".trcode", "commands");
fs.mkdirSync(path.join(PROJECT, "frontend"), { recursive: true });
fs.mkdirSync(path.join(HOME, "commands"), { recursive: true });

const { discoverCustomCommands, expandCustomCommand, findCustomCommand, resetCustomCommandCache, customCommandDirs } =
  await import("../dist/ui/commands/custom.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

fs.writeFileSync(
  path.join(PROJECT, "review.md"),
  ["---", "description: Review the current diff", "argument-hint: <branch>", "---", "Review $ARGUMENTS and report findings."].join("\n"),
);
fs.writeFileSync(
  path.join(PROJECT, "frontend", "component.md"),
  ["---", "description: Scaffold a component", "---", "Make a component named $ARGUMENTS."].join("\n"),
);
fs.writeFileSync(path.join(PROJECT, "plain.md"), "Report the branch: !`node -e \"console.log('main')\"` and stop.");
fs.writeFileSync(path.join(PROJECT, "block.md"), "Branches:\n\n```!\nnode -e \"console.log('one')\"\n```\n");
fs.writeFileSync(path.join(HOME, "commands", "user.md"), ["---", "description: A user-level command", "---", "Do the user thing."].join("\n"));
fs.writeFileSync(path.join(HOME, "commands", "review.md"), ["---", "description: User review (shadowed)", "---", "user version"].join("\n"));

resetCustomCommandCache();
const list = discoverCustomCommands(ROOT);
const names = list.map((cmd) => cmd.name).sort();
check("a file becomes a command", names.includes("/review"), JSON.stringify(names));
check("a subdirectory is a namespace", names.includes("/frontend:component"), JSON.stringify(names));
check("the user's own directory is read too", names.includes("/user"), JSON.stringify(names));
check("the project wins over the user for one name", list.filter((cmd) => cmd.name === "/review").length === 1);
const review = findCustomCommand(ROOT, "/review");
check("frontmatter description is used", review?.description === "Review the current diff", review?.description);
check("argument-hint is used", review?.argumentHint === "<branch>", String(review?.argumentHint));
check("the body is kept whole", review?.body.trim() === "Review $ARGUMENTS and report findings.", String(review?.body));
check("directories are project first", customCommandDirs(ROOT)[0] === PROJECT, customCommandDirs(ROOT).join(","));

const expanded = await expandCustomCommand(review, "feature/login", { cwd: ROOT, sessionId: "abc" });
check("$ARGUMENTS is substituted", expanded === "Review feature/login and report findings.", expanded);

const appended = await expandCustomCommand(findCustomCommand(ROOT, "frontend:component"), "Sidebar", { cwd: ROOT });
check("arguments are appended when the body has no placeholder", appended === "Make a component named Sidebar.", appended);

const plain = await expandCustomCommand(findCustomCommand(ROOT, "plain"), "", { cwd: ROOT });
check("!`cmd` is replaced by its output", plain === "Report the branch: main and stop.", JSON.stringify(plain));

const block = await expandCustomCommand(findCustomCommand(ROOT, "block"), "", { cwd: ROOT });
check("a ```! block is replaced by its output", block.trim() === "Branches:\n\none", JSON.stringify(block));

fs.writeFileSync(path.join(PROJECT, "cwd.md"), "In ${TRCODE_CWD} as ${TRCODE_SESSION_ID}.");
resetCustomCommandCache();
const cwdText = await expandCustomCommand(findCustomCommand(ROOT, "cwd"), "", { cwd: ROOT, sessionId: "s-9" });
check("placeholders for cwd and session are substituted", cwdText === `In ${ROOT} as s-9.`, cwdText);

// A command file added while the session runs shows up after the cache expires.
resetCustomCommandCache();
check("a missing name is not found", findCustomCommand(ROOT, "/nope") === undefined);

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed} passed`);
process.exit(failed ? 1 : 0);
