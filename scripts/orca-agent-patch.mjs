#!/usr/bin/env node
/**
 * Makes a local Orca install recognise trcode as a first-class agent, icon included.
 *
 * Orca's list of agents is compiled into `resources/app.asar`, and it answers
 * 404 to any hook route it does not know — `trcode` is not on the list. Adding
 * an entry is impossible without repacking the archive: asar is a header of
 * offsets followed by concatenated files, so inserting a byte shifts
 * everything after it. Replacing bytes with the *same number* of bytes is
 * safe, which leaves exactly one move: take over the slot of an agent you do
 * not use. This script takes `cursor`, whose binary name (`cursor-agent`) is
 * exactly as long as ours.
 *
 * What changes, all inside the archive:
 *   out/preload/index.js        detectCmd  : "cursor-agent" → "trcode-agent"
 *                               (launchCmd and expectedProcess default to it)
 *   out/{renderer,web}/assets/agent-catalog-*.js
 *                               label      : "Cursor"       → "Trcode"
 *                               icon       : Cursor's inline 64×64 PNG replaced
 *                                            by the trcode mark, padded back to
 *                                            the very same byte count
 *
 * The internal id stays `cursor`, so the hook route, the pane icon slot and
 * everything keyed by that id keep working. trcode reports its status through
 * /hook/opencode either way — Orca applies status by pane, not by route.
 *
 * Reversible (`--revert`, from the backup this makes) and re-runnable: every
 * Orca update replaces app.asar and undoes the patch, so run it again after.
 *
 *   node scripts/orca-agent-patch.mjs --check
 *   node scripts/orca-agent-patch.mjs
 *   node scripts/orca-agent-patch.mjs --revert
 */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const BACKUP_SUFFIX = ".trcode-backup";
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
/** Position of EnableEmbeddedAsarIntegrityValidation in the fuse wire. */
const INTEGRITY_FUSE_INDEX = 4;
/** 64×64 mark drawn for the agent slot; smaller than the icon it replaces. */
const ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "branding", "trcode-app-icon-64-indexed.png");
/** Orca's desktop renderer inlines its 64×64 agent icons as data URIs in this chunk. */
const CATALOG = /^\/out\/renderer\/assets\/agent-catalog-[\w-]+\.js$/;
const PRELOAD = "/out/preload/index.js";

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

/** The archive: a pickle header with a JSON directory, then the files back to back. */
function openAsar(file) {
  const fd = fs.openSync(file, "r+");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  fs.readSync(fd, json, 0, jsonSize, 16);
  return { fd, header: JSON.parse(json.toString("utf8")), headerText: json.toString("latin1"), dataOffset: 8 + headerSize };
}

function listEntries(node, prefix = "", out = []) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) listEntries(child, `${prefix}/${name}`, out);
  } else {
    out.push({ path: prefix, entry: node });
  }
  return out;
}

function readEntry(asar, entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(asar.fd, buf, 0, entry.size, asar.dataOffset + Number(entry.offset));
  return buf;
}

function writeEntry(asar, entry, buf) {
  if (buf.length !== entry.size) throw new Error(`size changed (${entry.size} → ${buf.length})`);
  fs.writeSync(asar.fd, buf, 0, buf.length, asar.dataOffset + Number(entry.offset));
}

/**
 * Every file in the header carries the SHA-256 of its bytes, twice: as the
 * entry hash and as its only block. A same-length edit leaves the offsets
 * valid but the hashes stale, so they are rewritten too — same 64 hex
 * characters, so the header keeps its size.
 */
function rewriteHash(asar, entry, buf) {
  const oldHash = entry.integrity?.hash;
  if (!oldHash) return false;
  const found = asar.headerText.split(oldHash).length - 1;
  if (found !== 2) return false;
  asar.headerText = asar.headerText.split(oldHash).join(crypto.createHash("sha256").update(buf).digest("hex"));
  return true;
}

/**
 * A PNG that occupies exactly `target` bytes: an ancillary tEXt chunk carries
 * the difference, which painters, decoders and Chromium all ignore. Base64 of
 * a fixed byte count is a fixed character count, so the surrounding JS can be
 * swapped in place.
 */
function padPng(png, target) {
  if (png.length === target) return png;
  if (png.subarray(1, 4).toString() !== "PNG") throw new Error("the icon is not a PNG");
  const free = target - png.length;
  if (free < 15) throw new Error(`the icon is ${png.length} bytes, the slot takes ${target} — too big`);
  if (free === 13 || free === 14) throw new Error("cannot pad by 1–2 bytes");
  const iend = png.length - 12;
  if (png.subarray(iend + 4, iend + 8).toString() !== "IEND") throw new Error("the icon has no IEND chunk");
  const dataLen = free - 12;
  const data = Buffer.alloc(dataLen, 0x20);
  data[0] = 0x70; // "p", the shortest legal tEXt keyword
  data[1] = 0;
  const type = Buffer.from("tEXt", "latin1");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(dataLen);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0);
  return Buffer.concat([png.subarray(0, iend), size, type, data, crc, png.subarray(iend)]);
}

/** Bytes a base64 payload of `chars` characters decodes to, padding included. */
function bytesFor(chars, pad) {
  return (chars / 4) * 3 - pad;
}

/** detectCmd is the one name Orca looks for; launch and process default to it. */
function renameBinary(text) {
  const table = text.indexOf("TUI_AGENT_CONFIG_SOURCE");
  if (table < 0) return { error: "TUI_AGENT_CONFIG_SOURCE not found — Orca's layout changed" };
  const entry = /cursor:\s*\{[\s\S]{0,600}?\}/.exec(text.slice(table, table + 20_000));
  if (!entry) return { error: "the cursor entry is not where it used to be" };
  const from = table + entry.index;
  const to = from + entry[0].length;
  let block = text.slice(from, to);
  let changed = 0;
  for (const field of ["detectCmd", "launchCmd", "expectedProcess"]) {
    const re = new RegExp(`(${field}:\\s*)"cursor-agent"`);
    if (re.test(block)) {
      block = block.replace(re, '$1"trcode-agent"');
      changed++;
    }
  }
  if (!changed) return { error: 'the cursor entry no longer names "cursor-agent"' };
  return { text: text.slice(0, from) + block + text.slice(to), changed };
}

/** The catalog entry carries the label shown in pickers and on the pane. */
function renameAgentLabel(text) {
  const at = text.indexOf("id:`cursor`,label:i(");
  if (at < 0) return { error: "the cursor catalog entry is not where it used to be" };
  const window = text.slice(at, at + 200);
  const m = /,`Cursor`\)/.exec(window);
  if (!m) return { error: "the cursor label is not \"Cursor\" any more" };
  const start = at + m.index;
  return { text: text.slice(0, start) + ",`Trcode`)" + text.slice(start + m[0].length), changed: 1 };
}

/**
 * `K` maps an agent id to its inline icon; the cursor slot keeps its own key,
 * so only the data URI behind it has to change.
 */
function replaceIcon(text) {
  const map = /\bcursor:([A-Za-z$_][\w$]*)/.exec(text);
  if (!map) return { error: "the cursor icon binding is not where it used to be" };
  const binding = map[1];
  const start = text.indexOf(`${binding}=\`data:image/png;base64,`);
  if (start < 0) return { error: `icon binding ${binding} is not an inline PNG` };
  const open = start + binding.length + "=`data:image/png;base64,".length;
  const close = text.indexOf("`", open);
  if (close < 0) return { error: "the icon data URI is unterminated" };
  const payload = text.slice(open, close);
  const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const target = bytesFor(payload.length, pad);
  if (!Number.isInteger(target)) return { error: "unexpected icon payload length" };
  const png = padPng(fs.readFileSync(ICON), target);
  const next = png.toString("base64");
  if (next.length !== payload.length) return { error: "the padded icon does not fit the slot" };
  return { text: text.slice(0, open) + next + text.slice(close), changed: 1, bytes: target };
}

function main() {
  const mode = process.argv.includes("--revert") ? "revert" : process.argv.includes("--check") ? "check" : "apply";
  const asarPath = findAsar();
  if (!asarPath) {
    console.error("Orca's app.asar was not found. Pass its path in ORCA_ASAR.");
    process.exit(1);
  }
  const backup = asarPath + BACKUP_SUFFIX;
  const fuse = integrityFuse(asarPath);
  const asar = openAsar(asarPath);
  const entries = listEntries(asar.header);
  const patched = isPatched(asar, entries);

  console.log(`asar:      ${asarPath}`);
  console.log(`state:     ${patched ? "patched" : "original"}`);
  console.log(`backup:    ${fs.existsSync(backup) ? backup : "none yet"}`);
  console.log(`integrity: ${fuse}${fuse === "enabled" ? "  ← patching would stop Orca from starting" : ""}`);

  if (mode === "revert") {
    fs.closeSync(asar.fd);
    if (!fs.existsSync(backup)) {
      console.error("\nNo backup to restore from.");
      process.exit(1);
    }
    fs.copyFileSync(backup, asarPath);
    console.log("\nRestored from the backup. Restart Orca for it to take effect.");
    return;
  }

  if (fuse === "enabled") {
    fs.closeSync(asar.fd);
    console.error("\nRefusing: asar integrity validation is on, a patched file would not load.");
    process.exit(1);
  }

  if (patched) {
    fs.closeSync(asar.fd);
    console.log("\nAlready patched — nothing to do.");
    return;
  }

  const plan = [];
  for (const item of entries) {
    if (item.path !== PRELOAD && !CATALOG.test(item.path)) continue;
    let text = readEntry(asar, item.entry).toString("latin1");
    const steps = [];
    if (item.path === PRELOAD) {
      steps.push(["agent name", renameBinary, "detectCmd \"cursor-agent\" → \"trcode-agent\""]);
    } else {
      steps.push(["label", renameAgentLabel, "\"Cursor\" → \"Trcode\""]);
      steps.push(["icon", replaceIcon, "inline 64×64 mark"]);
    }
    const notes = [];
    for (const [what, fn, note] of steps) {
      const result = fn(text);
      if (result.error) {
        fs.closeSync(asar.fd);
        console.error(`\nRefusing: ${what} in ${item.path} — ${result.error}`);
        console.error("Orca's bundle changed; the patch needs updating before it can run.");
        process.exit(1);
      }
      text = result.text;
      notes.push(note);
    }
    if (text.length !== item.entry.size) {
      fs.closeSync(asar.fd);
      console.error(`\nRefusing: ${item.path} would change size — nothing was written.`);
      process.exit(1);
    }
    plan.push({ item, text, notes });
  }

  if (!plan.length) {
    fs.closeSync(asar.fd);
    console.error("\nNothing to patch: no preload or agent catalog found in the archive.");
    process.exit(1);
  }

  for (const step of plan) console.log(`file:      ${step.item.path}\n           ${step.notes.join(", ")}`);

  if (mode === "check") {
    fs.closeSync(asar.fd);
    console.log(`\nWould patch ${plan.length} files, same total size.`);
    return;
  }

  // Refresh the backup from the current original: after an Orca update this
  // is a different file, and restoring last month's build would be worse
  // than not having a backup at all.
  fs.closeSync(asar.fd);
  fs.copyFileSync(asarPath, backup);
  const writable = openAsar(asarPath);
  const headerSize = Buffer.byteLength(writable.headerText, "latin1");
  try {
    for (const step of plan) {
      const buf = Buffer.from(step.text, "latin1");
      writeEntry(writable, step.item.entry, buf);
      if (!rewriteHash(writable, step.item.entry, buf)) {
        console.error(`\nCould not refresh the integrity hash of ${step.item.path}.`);
        console.error("Restore the backup with --revert and report this.");
        process.exit(1);
      }
    }
    const header = Buffer.from(writable.headerText, "latin1");
    if (header.length !== headerSize) throw new Error("the header changed size");
    fs.writeSync(writable.fd, header, 0, header.length, 16);
  } catch (err) {
    console.error(`\nCould not write: ${err.message}`);
    console.error("Close Orca and run it again.");
    process.exit(1);
  } finally {
    fs.closeSync(writable.fd);
  }

  console.log(`\nPatched ${plan.length} files. Orca will look for a "trcode-agent" command, label the pane "Trcode" and draw its icon.`);
  console.log("Restart Orca to pick it up. Every Orca update replaces app.asar — run this again after one.");
  console.log(`Undo: node ${path.relative(process.cwd(), process.argv[1])} --revert`);
}

/** The preload is the smallest place to look: it either names our command or it does not. */
function isPatched(asar, entries) {
  const preload = entries.find((e) => e.path === PRELOAD);
  return preload ? readEntry(asar, preload.entry).toString("latin1").includes('"trcode-agent"') : false;
}

main();
