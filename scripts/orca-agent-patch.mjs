#!/usr/bin/env node
/**
 * Makes a local Orca install recognise trcode as a first-class agent.
 *
 * Orca's list of agents is compiled into `resources/app.asar`, and it answers
 * 404 to any hook route it does not know — `trcode` is not on the list. Adding
 * an entry is impossible without repacking the archive: asar is a header of
 * offsets followed by concatenated files, so inserting a byte shifts
 * everything after it. Replacing bytes with the *same number* of bytes is
 * safe, which leaves exactly one move: take over the slot of an agent you do
 * not use. This script takes `cursor`, whose binary name (`cursor-agent`) and
 * label (`Cursor`) happen to be the same length as ours.
 *
 * What changes, all inside Orca's TUI agent table:
 *   detectCmd / launchCmd / expectedProcess : "cursor-agent" → "trcode-agent"
 *   display name                            : "Cursor"       → "Trcode"
 *
 * What does not change: the internal id stays `cursor`, so the hook route,
 * the pane icon and everything keyed by that id keep working. trcode reports
 * its status through /hook/opencode either way — Orca applies status by pane,
 * not by route.
 *
 * Reversible (`--revert`, from the backup this makes) and re-runnable: every
 * Orca update replaces app.asar and undoes the patch, so run it again after.
 *
 *   node scripts/orca-agent-patch.mjs --check
 *   node scripts/orca-agent-patch.mjs
 *   node scripts/orca-agent-patch.mjs --revert
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BACKUP_SUFFIX = ".trcode-backup";
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
/** Position of EnableEmbeddedAsarIntegrityValidation in the fuse wire. */
const INTEGRITY_FUSE_INDEX = 4;

function candidates() {
  const fromEnv = process.env.ORCA_ASAR;
  if (fromEnv) return [fromEnv];
  const home = os.homedir();
  return [
    path.join(home, "AppData", "Local", "Programs", "orca", "resources", "app.asar"),
    path.join(home, "AppData", "Local", "Programs", "Orca", "resources", "app.asar"),
    "/Applications/Orca.app/Contents/Resources/app.asar",
    path.join(home, "Applications", "Orca.app", "Contents", "Resources", "app.asar"),
    "/opt/Orca/resources/app.asar",
  ];
}

function findAsar() {
  for (const p of candidates()) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * With this fuse on, Electron checks app.asar against a hash embedded in the
 * executable and refuses to start if it was touched. Patching is then off the
 * table — better to say so than to leave a broken install behind.
 */
function integrityFuse(asarPath) {
  const dir = path.dirname(path.dirname(asarPath));
  const exe = ["Orca.exe", "orca", "Orca"].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!exe) return "unknown";
  try {
    const buf = fs.readFileSync(exe);
    const at = buf.indexOf(FUSE_SENTINEL);
    if (at < 0) return "unknown";
    const count = buf[at + FUSE_SENTINEL.length + 1];
    const first = at + FUSE_SENTINEL.length + 2;
    if (INTEGRITY_FUSE_INDEX >= count) return "unknown";
    return String.fromCharCode(buf[first + INTEGRITY_FUSE_INDEX]) === "1" ? "enabled" : "disabled";
  } catch {
    return "unknown";
  }
}

/**
 * The edits, as (find, replace) pairs of equal length. Each is anchored so it
 * cannot match somewhere else in a 40MB bundle: the agent table for the
 * binary names, the display-name map for the label.
 */
function edits(text) {
  const out = [];

  const table = text.indexOf("TUI_AGENT_CONFIG =");
  if (table < 0) return { error: "TUI_AGENT_CONFIG not found — Orca's layout changed" };
  const entry = /cursor:\s*\{[\s\S]{0,400}?promptInjectionMode/.exec(text.slice(table, table + 60_000));
  if (!entry) return { error: "the cursor entry is not where it used to be" };
  const from = table + entry.index;
  const to = from + entry[0].length;
  for (const field of ["detectCmd", "launchCmd", "expectedProcess"]) {
    const re = new RegExp(`${field}:\\s*"cursor-agent"`);
    const m = re.exec(text.slice(from, to));
    if (!m) return { error: `${field} is not "cursor-agent" any more` };
    out.push({ at: from + m.index, find: m[0], replace: m[0].replace("cursor-agent", "trcode-agent") });
  }

  const label = /cursor:\s*"Cursor"/.exec(text);
  if (!label) return { error: 'the display name cursor: "Cursor" was not found' };
  out.push({ at: label.index, find: label[0], replace: label[0].replace('"Cursor"', '"Trcode"') });

  return { out };
}

function apply(text) {
  const { out, error } = edits(text);
  if (error) return { error };
  let patched = text;
  for (const e of out) {
    const before = patched.slice(0, e.at);
    const after = patched.slice(e.at + e.find.length);
    if (patched.slice(e.at, e.at + e.find.length) !== e.find) {
      return { error: "an anchor moved while patching — nothing was written" };
    }
    patched = before + e.replace + after;
  }
  // The one invariant that keeps the archive readable: every offset in the
  // asar header must still point where it did.
  if (patched.length !== text.length) return { error: "length changed — refusing to write" };
  return { patched, count: out.length };
}

function main() {
  const mode = process.argv.includes("--revert") ? "revert" : process.argv.includes("--check") ? "check" : "apply";
  const asar = findAsar();
  if (!asar) {
    console.error("Orca's app.asar was not found. Pass its path in ORCA_ASAR.");
    process.exit(1);
  }
  const backup = asar + BACKUP_SUFFIX;
  const text = fs.readFileSync(asar, "latin1");
  const patched = text.includes('"trcode-agent"');

  console.log(`asar:      ${asar}`);
  console.log(`state:     ${patched ? "patched" : "original"}`);
  console.log(`backup:    ${fs.existsSync(backup) ? backup : "none yet"}`);
  const fuse = integrityFuse(asar);
  console.log(`integrity: ${fuse}${fuse === "enabled" ? "  ← patching would stop Orca from starting" : ""}`);

  if (mode === "check") {
    if (!patched) {
      const { error, count } = apply(text);
      console.log(error ? `would fail:  ${error}` : `would change ${count} strings, same total size`);
    }
    return;
  }

  if (mode === "revert") {
    if (!fs.existsSync(backup)) {
      console.error("\nNo backup to restore from.");
      process.exit(1);
    }
    fs.copyFileSync(backup, asar);
    console.log("\nRestored from the backup. Restart Orca for it to take effect.");
    return;
  }

  if (fuse === "enabled") {
    console.error("\nRefusing: asar integrity validation is on, a patched file would not load.");
    process.exit(1);
  }
  if (patched) {
    console.log("\nAlready patched — nothing to do.");
    return;
  }

  const { patched: next, error, count } = apply(text);
  if (error) {
    console.error(`\nRefusing: ${error}`);
    process.exit(1);
  }

  // Refresh the backup from the current original: after an Orca update this
  // is a different file, and restoring last month's build would be worse
  // than not having a backup at all.
  fs.copyFileSync(asar, backup);
  try {
    fs.writeFileSync(asar, Buffer.from(next, "latin1"));
  } catch (err) {
    console.error(`\nCould not write: ${err.message}`);
    console.error("Close Orca and run it again.");
    process.exit(1);
  }

  console.log(`\nPatched ${count} strings. Orca will look for a "trcode-agent" command and label the pane "Trcode".`);
  console.log("Restart Orca to pick it up. Every Orca update replaces app.asar — run this again after one.");
  console.log(`Undo: node ${path.relative(process.cwd(), process.argv[1])} --revert`);
}

main();
