/**
 * Self-update from GitHub Releases: version comparison against a mock
 * releases API, and a real download-extract-swap cycle against a fake tgz.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-update-"));
process.env.TRCODE_HOME = HOME;

const { REPO, isNewer, latestRelease, refreshCache, cachedUpdate, applyUpdate, versionBadge, markUpdateApplied, passiveCheckEnabled } =
  await import("../dist/update.js");
const { VERSION } = await import("../dist/config.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// ── who may run the passive check ───────────────────────────────────────────
// One gate, shared by init() and the CLI: the interactive start used to keep
// its own copy, which honoured the config toggle and not the environment.
{
  const api = process.env.TRCODE_UPDATE_API;
  const off = process.env.TRCODE_NO_UPDATE_CHECK;
  delete process.env.TRCODE_UPDATE_API;
  delete process.env.TRCODE_NO_UPDATE_CHECK;
  check("a plain start checks", passiveCheckEnabled({}));
  check("updateCheck:false stops it", !passiveCheckEnabled({ updateCheck: false }));
  process.env.TRCODE_NO_UPDATE_CHECK = "1";
  check("TRCODE_NO_UPDATE_CHECK stops it", !passiveCheckEnabled({}));
  delete process.env.TRCODE_NO_UPDATE_CHECK;
  process.env.TRCODE_UPDATE_API = "http://127.0.0.1:1";
  check("a redirected API is a test, not a user", !passiveCheckEnabled({}));
  if (api === undefined) delete process.env.TRCODE_UPDATE_API;
  else process.env.TRCODE_UPDATE_API = api;
  if (off !== undefined) process.env.TRCODE_NO_UPDATE_CHECK = off;
}

// ── version comparison ──────────────────────────────────────────────────────
check("a higher minor is newer", isNewer("0.1.2", "0.2.0"));
check("a higher patch is newer", isNewer("0.1.2", "0.1.10"));
check("the v prefix does not matter", isNewer("0.1.2", "v0.1.3"));
check("equal versions are not newer", !isNewer("0.1.2", "0.1.2"));
check("an older version is not newer", !isNewer("0.1.2", "0.1.1"));
check("missing parts mean zero", isNewer("0.1", "0.1.1"));

// ── a local stand-in for api.github.com and the release asset ───────────────
let assetRequests = 0;
let releaseRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url === `/repos/${REPO}/releases/latest`) {
    releaseRequests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        tag_name: "v9.9.9",
        html_url: `https://github.com/${REPO}/releases/tag/v9.9.9`,
        assets: [{ name: "trcode-9.9.9.tgz", browser_download_url: `http://127.0.0.1:${port}/pkg.tgz` }],
      }),
    );
    return;
  }
  if (req.url === "/pkg-deps.tgz") {
    assetRequests++;
    // The same shape, but the release brings a dependency the install has to
    // already have: node_modules is not in the archive, and this updater only
    // swaps dist.
    const stage = path.join(HOME, "stage-deps");
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, "package", "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(stage, "package", "package.json"),
      '{"name":"trcode","version":"9.9.9","dependencies":{"sharp":"^0.35.0"}}',
    );
    fs.writeFileSync(path.join(stage, "package", "dist", "index.js"), "// new build with deps\n");
    execSync(`tar -czf pkg-deps.tgz -C "${stage}" package`, { cwd: HOME });
    res.writeHead(200);
    res.end(fs.readFileSync(path.join(HOME, "pkg-deps.tgz")));
    return;
  }
  if (req.url === "/pkg.tgz") {
    assetRequests++;
    // A minimal npm-pack-shaped archive: package/dist/index.js.
    const stage = path.join(HOME, "stage");
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, "package", "dist"), { recursive: true });
    fs.writeFileSync(path.join(stage, "package", "package.json"), '{"name":"trcode","version":"9.9.9"}');
    fs.writeFileSync(path.join(stage, "package", "dist", "index.js"), "// new build\n");
    // The archive name goes in relative, with HOME as the cwd: GNU tar reads a
    // "C:..." -f argument as host:path and goes looking for a machine called C.
    // Only -f is parsed that way, so the -C directory can stay absolute.
    execSync(`tar -czf pkg.tgz -C "${stage}" package`, { cwd: HOME });
    res.writeHead(200);
    res.end(fs.readFileSync(path.join(HOME, "pkg.tgz")));
    return;
  }
  res.writeHead(404);
  res.end("{}");
});
server.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const port = server.address().port;
process.env.TRCODE_UPDATE_API = `http://127.0.0.1:${port}`;

// The slash command must pass --check through without requesting an asset.
{
  const { runCommand } = await import("../dist/ui/commands.js");
  const before = assetRequests;
  const realWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    await runCommand({ exclusiveInput: async (fn) => fn(), repaintHeader() { throw new Error("unexpected install"); } }, "/update --check");
  } finally { process.stdout.write = realWrite; }
  check("/update --check reports the newer release", /9\.9\.9/.test(output), output);
  check("/update --check never downloads or installs", assetRequests === before, output);
  const checks = releaseRequests;
  process.stdout.write = () => true;
  try { await runCommand({}, "/update --unknown"); }
  finally { process.stdout.write = realWrite; }
  check("unknown update flags are rejected before making a request", releaseRequests === checks);
}

// ── check ───────────────────────────────────────────────────────────────────
{
  const rel = await latestRelease();
  check("the tag is read without the v", rel.version === "9.9.9", rel.version);
  check("the tgz asset wins over the source archive", /pkg\.tgz$/.test(rel.tarball), rel.tarball);

  const wrote = await refreshCache();
  check("a fresh check writes the cache", wrote);
  const again = await refreshCache();
  check("a second check inside maxAge is skipped", again === false);
  const upd = cachedUpdate();
  check("the cache reports an update over this build", upd?.version === "9.9.9", JSON.stringify(upd));
}

// ── apply ───────────────────────────────────────────────────────────────────
{
  const target = path.join(HOME, "install", "dist");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "index.js"), "// old build\n");
  fs.writeFileSync(path.join(target, "keep.js"), "// old extra\n");

  const rel = await latestRelease();
  const { to } = await applyUpdate(rel, { to: target });
  check("the swap lands in the target dir", to === target);
  check("the new index.js replaced the old one",
    fs.readFileSync(path.join(target, "index.js"), "utf8") === "// new build\n");
  check("old files that the release lacks are gone", !fs.existsSync(path.join(target, "keep.js")));
  check("no .old backup is left behind", !fs.existsSync(`${target}.old`));

  // A failed download must leave the working install exactly as it was.
  const broken = { ...rel, tarball: `http://127.0.0.1:${port}/missing.tgz` };
  let threw = false;
  try {
    await applyUpdate(broken, { to: target });
  } catch {
    threw = true;
  }
  check("a bad tarball aborts the update", threw);
  check("and the install still works",
    fs.readFileSync(path.join(target, "index.js"), "utf8") === "// new build\n");
}

// ── a release that adds a dependency ─────────────────────────────────────────
// The archive carries dist and a manifest, never node_modules; a swap that
// skipped this check would leave a build that cannot import its own tools.
{
  const install = path.join(HOME, "install-deps");
  const target = path.join(install, "dist");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "index.js"), "// old build\n");
  const rel = { version: "9.9.9", tarball: `http://127.0.0.1:${port}/pkg-deps.tgz` };

  // Stand-ins for npm-cli.js: one that cannot reach the registry, one that
  // "installs" each spec it is handed into the cwd's node_modules.
  const npmFail = path.join(HOME, "npm-fail.mjs");
  fs.writeFileSync(npmFail, 'console.error("npm error network ETIMEDOUT"); process.exit(1);\n');
  const npmOk = path.join(HOME, "npm-ok.mjs");
  fs.writeFileSync(
    npmOk,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'fs.writeFileSync(process.env.TRCODE_TEST_NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));',
      'for (const spec of process.argv.slice(3).filter((a) => !a.startsWith("--"))) {',
      '  const name = spec.replace(/(.)@.*$/, "$1");',
      '  fs.mkdirSync(path.join("node_modules", name), { recursive: true });',
      '  const version = spec.slice(spec.lastIndexOf("@") + 1).replace(/^[^0-9]*/, "");',
      '  fs.writeFileSync(path.join("node_modules", name, "package.json"), JSON.stringify({ name, version }));',
      "}",
    ].join("\n"),
  );

  process.env.TRCODE_UPDATE_NPM = npmFail;
  let message = "";
  try {
    await applyUpdate(rel, { to: target });
  } catch (err) {
    message = err.message;
  }
  check("a dependency npm cannot add stops the swap", /sharp/.test(message), message);
  check("and passes on why npm failed", /ETIMEDOUT/.test(message), message);
  check("and says what to run instead", /npm install "sharp@\^0\.35\.0" in /.test(message), message);
  check("the old build is still in place", fs.readFileSync(path.join(target, "index.js"), "utf8") === "// old build\n");
  check("with no backup left behind", !fs.existsSync(`${target}.old`));

  // With npm working, the updater fills the gap itself and the swap lands.
  process.env.TRCODE_UPDATE_NPM = npmOk;
  process.env.TRCODE_TEST_NPM_LOG = path.join(install, "npm-args.json");
  const steps = [];
  await applyUpdate(rel, { to: target, onStep: (m) => steps.push(m) });
  const { args, cwd } = JSON.parse(fs.readFileSync(path.join(install, "npm-args.json"), "utf8"));
  check("npm runs in staging with the release's range", args[0] === "install" && args.includes("sharp@^0.35.0") && cwd !== install && cwd.startsWith(install + path.sep), JSON.stringify({ args, cwd }));
  check("without touching the install's package.json", args.includes("--no-save"), JSON.stringify(args));
  check("and the step is reported", steps.some((s) => /sharp/.test(s)), JSON.stringify(steps));
  check(
    "the missing dependency is installed and the update lands",
    fs.existsSync(path.join(install, "node_modules", "sharp", "package.json")) &&
      fs.readFileSync(path.join(target, "index.js"), "utf8") === "// new build with deps\n",
  );

  // Already present, npm is not run at all.
  fs.rmSync(path.join(install, "npm-args.json"));
  fs.writeFileSync(path.join(target, "index.js"), "// old build\n");
  await applyUpdate(rel, { to: target });
  check("a dependency already there needs no npm", !fs.existsSync(path.join(install, "npm-args.json")));

  // An existing but incompatible version must trigger installation, too.
  const depFile = path.join(install, "node_modules", "sharp", "package.json");
  fs.writeFileSync(depFile, JSON.stringify({ name: "sharp", version: "0.34.0" }));
  fs.writeFileSync(path.join(target, "index.js"), "// old build\n");
  await applyUpdate(rel, { to: target });
  check("an incompatible dependency is upgraded", JSON.parse(fs.readFileSync(depFile, "utf8")).version === "0.35.0");
  check("an incompatible dependency really invoked npm", fs.existsSync(path.join(install, "npm-args.json")));

  // npm may leave a valid-looking manifest even when its native build failed.
  // Its exit status must abort; every change must stay inside staging.
  fs.writeFileSync(depFile, JSON.stringify({ name: "sharp", version: "0.34.0" }));
  fs.writeFileSync(path.join(target, "index.js"), "// old build\n");
  const npmPartial = path.join(HOME, "npm-partial.mjs");
  fs.writeFileSync(npmPartial, [
    'import fs from "node:fs";',
    'fs.mkdirSync("node_modules/sharp", { recursive: true });',
    'fs.writeFileSync("node_modules/sharp/package.json", JSON.stringify({name:"sharp",version:"0.35.0"}));',
    'console.error("native build failed"); process.exit(1);',
  ].join("\n"));
  process.env.TRCODE_UPDATE_NPM = npmPartial;
  message = "";
  try { await applyUpdate(rel, { to: target }); } catch (err) { message = err.message; }
  check("npm failure aborts even if it left a compatible manifest", /native build failed/.test(message), message);
  check("a failed npm leaves the live dependency unchanged", JSON.parse(fs.readFileSync(depFile, "utf8")).version === "0.34.0");
  check("a failed npm leaves the old dist unchanged", fs.readFileSync(path.join(target, "index.js"), "utf8") === "// old build\n");
  fs.writeFileSync(npmPartial, fs.readFileSync(npmPartial, "utf8").replace('version:"0.35.0"', 'version:"0.34.0"').replace('process.exit(1)', 'process.exit(0)'));
  message = "";
  try { await applyUpdate(rel, { to: target }); } catch (err) { message = err.message; }
  check("a successful npm must still provide a compatible version", /incompatible dependencies/.test(message), message);
  check("an incompatible staged install leaves the working build unchanged", fs.readFileSync(path.join(target, "index.js"), "utf8") === "// old build\n" && JSON.parse(fs.readFileSync(depFile, "utf8")).version === "0.34.0");
  delete process.env.TRCODE_UPDATE_NPM;
  delete process.env.TRCODE_TEST_NPM_LOG;
}

// Inject filesystem failures at each commit boundary. A locked live directory
// must never enter a copy-and-delete fallback; all earlier replacements roll back.
for (const fault of ["stage-copy", "old-dist", "new-dist", "new-deps", "marker", "rollback", "cleanup"]) {
  const install = path.join(HOME, "fault-" + fault);
  const target = path.join(install, "dist");
  const modules = path.join(install, "node_modules");
  const depFile = path.join(modules, "sharp", "package.json");
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(depFile), { recursive: true });
  fs.writeFileSync(path.join(target, "index.js"), "// original build\n");
  fs.writeFileSync(path.join(target, "keep.js"), "// original extra\n");
  fs.writeFileSync(depFile, JSON.stringify({ name: "sharp", version: "0.34.0" }));
  const markerFile = path.join(HOME, "update-applied.json");
  const oldMarker = JSON.stringify({ ts: 1, version: "previous" });
  fs.writeFileSync(markerFile, oldMarker);
  process.env.TRCODE_UPDATE_NPM = path.join(HOME, "npm-ok.mjs");
  process.env.TRCODE_TEST_NPM_LOG = path.join(install, "npm-args.json");
  const original = { rename: fs.renameSync, cp: fs.cpSync, rm: fs.rmSync, write: fs.writeFileSync };
  const locked = () => Object.assign(new Error("injected lock: " + fault), { code: "EPERM" });
  let touchedLiveDelete = false;
  fs.renameSync = (src, dst) => {
    if ((fault === "old-dist" && src === target)
      || ((fault === "new-dist" || fault === "rollback") && dst === target && path.basename(src) === "dist")
      || (fault === "new-deps" && dst === modules && path.basename(src) === "node_modules")
      || (fault === "rollback" && path.basename(src) === "old-dist")) throw locked();
    return original.rename(src, dst);
  };
  fs.cpSync = (src, dst, options) => {
    if (fault === "stage-copy" && path.basename(dst) === "dist") throw locked();
    return original.cp(src, dst, options);
  };
  fs.rmSync = (file, options) => {
    if (file === target || file === modules) touchedLiveDelete = true;
    if (fault === "cleanup" && path.basename(file).startsWith(".trc-update-")) throw locked();
    return original.rm(file, options);
  };
  fs.writeFileSync = (file, ...args) => {
    if (fault === "marker" && path.basename(file) === "update-applied.json") throw locked();
    return original.write(file, ...args);
  };
  let message = "";
  try {
    await applyUpdate({ version: "9.9.9", tarball: `http://127.0.0.1:${port}/pkg-deps.tgz` }, { to: target });
  } catch (err) { message = err.message; }
  finally {
    fs.renameSync = original.rename;
    fs.cpSync = original.cp;
    fs.rmSync = original.rm;
    fs.writeFileSync = original.write;
    delete process.env.TRCODE_UPDATE_NPM;
    delete process.env.TRCODE_TEST_NPM_LOG;
  }
  check(`no recursive deletion of live files (${fault})`, !touchedLiveDelete);
  if (fault === "cleanup") {
    check("cleanup failure does not report a committed update as failed", !message, message);
    check("cleanup failure keeps the new build", fs.readFileSync(path.join(target, "index.js"), "utf8") === "// new build with deps\n");
  } else if (fault === "rollback") {
    const recovery = fs.readdirSync(install).find((name) => name.startsWith(".trc-update-"));
    check("rollback failure explains where the backup was kept", /rollback failed.*Backups kept in/.test(message), message);
    check("rollback failure preserves the complete original backup", recovery && fs.readFileSync(path.join(install, recovery, "old-dist", "keep.js"), "utf8") === "// original extra\n");
    check("other replacements are restored despite a dist restore failure", JSON.parse(fs.readFileSync(depFile, "utf8")).version === "0.34.0");
  } else {
    check(`the filesystem failure is reported (${fault})`, /injected lock/.test(message), message);
    check(`the complete original build is restored (${fault})`, fs.readFileSync(path.join(target, "index.js"), "utf8") === "// original build\n" && fs.readFileSync(path.join(target, "keep.js"), "utf8") === "// original extra\n");
    check(`dependencies are restored with the old build (${fault})`, JSON.parse(fs.readFileSync(depFile, "utf8")).version === "0.34.0");
    check(`a failed transaction preserves the previous restart marker (${fault})`, fs.readFileSync(markerFile, "utf8") === oldMarker);
  }
}

// ── a missing native dependency must not stop the boot ──────────────────────
// Clients up to 0.1.9 swap dist without the guard above; whatever they land
// has to start without sharp, or /update — the way out — dies with it.
{
  const statics = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && /^\s*import\s[^;]*\sfrom\s+["']sharp["']/m.test(fs.readFileSync(p, "utf8"))) statics.push(p);
    }
  };
  walk(fileURLToPath(new URL("../dist", import.meta.url)));
  check("no module imports sharp at load time", statics.length === 0, statics.join(", "));
}

// ── the header badge and the restart bookkeeping ───────────────────────────
{
  // The apply section above left an installed-update marker behind and cleared
  // the release cache with it; a machine that has only *checked* has just the
  // cache, so restore that state.
  fs.rmSync(path.join(HOME, "update-applied.json"), { force: true });
  fs.writeFileSync(
    path.join(HOME, "update-check.json"),
    JSON.stringify({ ts: Date.now(), version: "9.9.9" }),
  );
  const badge = versionBadge();
  check("the badge stars the version when an update exists", badge.text === VERSION + String.fromCharCode(42), badge.text);
  check("and suggests /update while nothing is installed yet", /\/update/.test(badge.note ?? ""), badge.note);

  markUpdateApplied("9.9.9");
  const installed = versionBadge();
  check("after an install the badge still carries the star", installed.text === VERSION + String.fromCharCode(42), installed.text);
  check("and asks for a restart instead", /restart/i.test(installed.note ?? ""), installed.note);
  check("installing clears the newer-release cache", cachedUpdate() === null);

  // A start on the new build closes the wait.
  fs.writeFileSync(path.join(HOME, "update-applied.json"), JSON.stringify({ ts: Date.now(), version: VERSION }));
  const settled = versionBadge();
  check(
    "once restarted, the star goes away",
    settled.text === VERSION && !settled.note,
    JSON.stringify(settled),
  );
}

server.close();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
