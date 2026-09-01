/**
 * Self-update from GitHub Releases: version comparison against a mock
 * releases API, and a real download-extract-swap cycle against a fake tgz.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-update-"));
process.env.TRCODE_HOME = HOME;

const { REPO, isNewer, latestRelease, refreshCache, cachedUpdate, applyUpdate, versionBadge, markUpdateApplied } =
  await import("../dist/update.js");
const { VERSION } = await import("../dist/config.js");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "\n       " + detail : "")); }
};

// ── version comparison ──────────────────────────────────────────────────────
check("a higher minor is newer", isNewer("0.1.2", "0.2.0"));
check("a higher patch is newer", isNewer("0.1.2", "0.1.10"));
check("the v prefix does not matter", isNewer("0.1.2", "v0.1.3"));
check("equal versions are not newer", !isNewer("0.1.2", "0.1.2"));
check("an older version is not newer", !isNewer("0.1.2", "0.1.1"));
check("missing parts mean zero", isNewer("0.1", "0.1.1"));

// ── a local stand-in for api.github.com and the release asset ───────────────
const server = http.createServer((req, res) => {
  if (req.url === `/repos/${REPO}/releases/latest`) {
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
  if (req.url === "/pkg.tgz") {
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
