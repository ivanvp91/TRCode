#!/usr/bin/env node
/**
 * browser.mjs - drive a real Chrome/Edge page over the DevTools Protocol.
 *
 *   node browser.mjs open <url|file> [--headed] [--port 9222]
 *   node browser.mjs nav <url>
 *   node browser.mjs tabs
 *   node browser.mjs use <index|id|substring>
 *   node browser.mjs text [selector]
 *   node browser.mjs html [selector]
 *   node browser.mjs click <selector>
 *   node browser.mjs type <selector> <text>
 *   node browser.mjs press <key> [selector]
 *   node browser.mjs eval <js>
 *   node browser.mjs wait <ms>
 *   node browser.mjs waitfor <selector> [timeoutMs]
 *   node browser.mjs shot [path]
 *   node browser.mjs close
 *   node browser.mjs quit
 *   node browser.mjs batch <scenario.json> [--headed] [--port 9222]
 *
 * `batch` runs a whole scenario inside one process and one page connection, so
 * a model does not spend a turn's thinking time between clicks: the file holds
 * {"steps": [{"open": "https://example.com"}, {"waitfor": {"selector": "h1"}},
 * {"text": "h1"}, {"quit": true}]}. Steps run in order, each contributes a
 * small JSON result, and the run stops at the first failure with a non-zero exit
 * that names the step. `open` is optional: without it the steps use the browser
 * already answering on the port, and never one this script did not start.
 * Screenshots happen only where a `shot` step asks for them.
 *
 * No npm dependencies: Node's global WebSocket (Node 22+) speaks CDP directly.
 *
 * Ownership: `open` launches its own browser with a fresh profile per run
 * (<tmp>/trcode-chrome-<random>) and a random --trcode-browser-token, and
 * records pid/profile/token/port/headed in the state file. `quit` stops that
 * browser and deletes the profile. An endpoint this script did not start is
 * never adopted, driven or closed: ownership needs both the profile and the
 * token from Browser.getBrowserCommandLine, otherwise the command fails and
 * asks for --port. Only `open` — the action or a scenario's first step — ever
 * starts a browser; `--headed` shows it instead of running it headless.
 *
 * `--` ends flag parsing, so data may look like a flag (`type "#x" -- --verbose`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const USAGE =
  "usage: browser.mjs <open|nav|tabs|use|text|html|click|type|press|eval|wait|waitfor|shot|close|quit|batch> [args]";
const ACTIONS = new Set([
  "open",
  "nav",
  "tabs",
  "use",
  "text",
  "html",
  "click",
  "type",
  "press",
  "eval",
  "wait",
  "waitfor",
  "shot",
  "close",
  "quit",
  "batch",
]);
/** Steps a scenario file may carry; every one of them maps onto a primitive below. */
const BATCH_STEPS = new Set(["open", "nav", "wait", "waitfor", "click", "type", "press", "eval", "text", "shot", "close", "quit"]);
const BOOL_FLAGS = new Set(["headed"]);
const VALUE_FLAGS = new Set(["port"]);
const DATA_ACTIONS = new Set(["type", "eval"]);
const LOAD_TIMEOUT_MS = 30000;
const FALLBACK_LOAD_MS = 5000;
const SAME_DOCUMENT_WAIT_MS = 1000;

class ReportedError extends Error {}

/** A batch run already printed its report; the exit code is the only signal left. */
class SilentExit extends Error {}

/**
 * Booleans never consume the next token and value flags require one. `--` ends
 * flag parsing; an unknown --x is an error, except for the data actions type and
 * eval, where it is payload (`type "#x" "--verbose"`).
 */
function parseArgv(argv) {
  const flags = {};
  const positional = [];
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (literal) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      literal = true;
      continue;
    }
    if (!a.startsWith("--") || a.length <= 2) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = (eq > 2 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
    if (BOOL_FLAGS.has(key)) {
      flags[key] = eq > 2 ? a.slice(eq + 1) !== "false" : true;
      continue;
    }
    if (VALUE_FLAGS.has(key)) {
      if (eq > 2) {
        flags[key] = a.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next === "--" || (next.startsWith("--") && next.length > 2)) {
        throw new ReportedError(`--${key} needs a value`);
      }
      flags[key] = next;
      i++;
      continue;
    }
    const seen = positional[0] ?? "";
    if (DATA_ACTIONS.has(seen)) {
      positional.push(a);
      continue;
    }
    throw new ReportedError(`unknown flag ${a}${seen ? ` for ${seen}` : ""} (use -- if it is data)`);
  }
  return { flags, positional };
}

let flags = {};
let positional = [];
try {
  ({ flags, positional } = parseArgv(process.argv.slice(2)));
} catch (err) {
  console.log(`error ${err?.message ?? String(err)}`);
  process.exit(1);
}

const [action = "", ...args] = positional;
const port = Number(flags.port || process.env.TRCODE_CDP_PORT || 9222);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.log(`error invalid port ${flags.port ?? process.env.TRCODE_CDP_PORT}`);
  process.exit(1);
}
const stateFile = path.join(os.tmpdir(), `trcode-browser-${port}.json`);

const OPEN = new Set();
const ok = (msg) => {
  console.log(`ok ${msg}`);
};
const fail = (msg) => {
  throw new ReportedError(msg);
};
const json = (obj) => console.log(JSON.stringify(obj));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireWebSocket() {
  if (typeof WebSocket === "undefined") fail("browser.mjs needs Node 22+ (global WebSocket)");
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function writeState(patch) {
  const next = { ...(readState() ?? {}), ...patch, port };
  fs.writeFileSync(stateFile, JSON.stringify(next), "utf8");
}
function dropState() {
  try {
    fs.rmSync(stateFile, { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** True only for a per-run profile directory this script creates. */
function isOurProfile(dir) {
  if (!dir) return false;
  const resolved = path.resolve(dir);
  return path.basename(resolved).indexOf("trcode-chrome-") === 0 && path.dirname(resolved) === path.resolve(os.tmpdir());
}

/** Only a per-run profile directory we created is ever deleted. */
function removeProfile(dir) {
  if (!isOurProfile(dir)) return false;
  try {
    fs.rmSync(path.resolve(dir), { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

function cleanupStale(state) {
  if (!state?.profile) {
    dropState();
    return true;
  }
  if (removeProfile(state.profile)) {
    dropState();
    return true;
  }
  // Keep the state so the next command can retry instead of losing the only
  // pointer to a locked profile.
  console.log(`note profile left at ${state.profile} (could not remove it)`);
  return false;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** Kill a browser we launched, with its children, so it cannot hold the port or the profile. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already gone */
  }
}

function httpJson(route, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, agent: false, headers: { connection: "close" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${route}`));
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch {
          resolve(body);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error(`timeout on ${route}`)));
    req.end();
  });
}

function chromePath() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) fail(`CHROME_PATH does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const candidates =
    process.platform === "win32"
      ? [
          `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

async function alive() {
  try {
    await httpJson("/json/version");
    return true;
  } catch {
    return false;
  }
}

/** True when something already listens on the port, browser or not. */
function portInUse(p) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: p });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function commandLineInfo(cl) {
  if (!Array.isArray(cl)) return null;
  const dirArg = cl.find((a) => a.startsWith("--user-data-dir="));
  if (!dirArg) return null;
  const tokenArg = cl.find((a) => a.startsWith("--trcode-browser-token="));
  return {
    profile: dirArg.slice("--user-data-dir=".length).replace(/^"|"$/g, ""),
    token: tokenArg ? tokenArg.slice("--trcode-browser-token=".length) : "",
    headed: !cl.some((a) => a.startsWith("--headless")),
  };
}

/** Browser.getBrowserCommandLine proves whose process answers on the port. */
async function browserCommandLine() {
  try {
    const version = await httpJson("/json/version");
    if (!version?.webSocketDebuggerUrl) return null;
    const browser = await Cdp.connect(version.webSocketDebuggerUrl, { page: false });
    try {
      const res = await browser.send("Browser.getBrowserCommandLine", {}, 5000);
      return Array.isArray(res?.arguments) ? res.arguments : null;
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Reports whether the endpoint on this port belongs to a browser we started.
 * Ownership is proven only by Browser.getBrowserCommandLine: the command line
 * must carry both the profile and the random token from our state file. A live
 * pid alone is never enough, and an unreadable command line means "not ours".
 */
async function ownership() {
  const state = readState() ?? {};
  if (!(await alive())) return { alive: false, state, owned: false, headed: false };
  const cl = await browserCommandLine();
  const info = commandLineInfo(cl);
  const owned = Boolean(
    info && state.profile && state.token && info.token === state.token && samePath(info.profile, state.profile),
  );
  const headed = info ? info.headed : state.headed === true;
  return { alive: true, state, owned, headed, commandLine: cl };
}

async function requireBrowser() {
  const own = await ownership();
  if (!own.alive) {
    cleanupStale(own.state);
    fail(`no browser on port ${port} — run \`open <url>\` first`);
  }
  if (!own.owned) fail(`port ${port} is already used by another browser; pass --port`);
  return own;
}

async function ensureBrowser() {
  requireWebSocket();
  const own = await ownership();
  if (own.alive) {
    if (!own.owned) fail(`port ${port} is already used by another browser; pass --port`);
    if (flags.headed === true && !own.headed) {
      fail(`the browser on port ${port} is running headless; run \`quit\` and then \`open --headed <url>\``);
    }
    return { launched: false, state: own.state, headed: own.headed };
  }
  if (!cleanupStale(own.state)) fail(`could not remove the old browser profile ${own.state.profile}; close the browser holding it and retry`);
  return launchBrowser();
}

async function launchBrowser() {
  const exe = chromePath();
  if (!exe) fail(`no Chrome/Edge found — set CHROME_PATH, or free port ${port} and run \`open <url>\``);
  if (await portInUse(port)) fail(`port ${port} is already in use; pass --port`);
  const token = randomUUID();
  const profile = path.join(os.tmpdir(), `trcode-chrome-${token}`);
  const headed = flags.headed === true;
  try {
    fs.mkdirSync(profile, { recursive: true });
  } catch (err) {
    fail(`could not create the profile directory ${profile}: ${err?.message ?? err}`);
  }
  const launchArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--trcode-browser-token=${token}`,
    // Browser.getBrowserCommandLine — the only proof of ownership — answers
    // "Command line not returned because --enable-automation not set" without
    // this flag, so every command after `open` would call the browser foreign.
    "--enable-automation",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "about:blank",
  ];
  if (!headed) launchArgs.unshift("--headless=new");
  let spawnError = null;
  const child = spawn(exe, launchArgs, { detached: true, stdio: "ignore" });
  child.once("error", (err) => {
    spawnError = err;
  });
  child.unref();
  for (let i = 0; i < 150; i++) {
    if (spawnError) {
      killTree(child.pid);
      await sleep(300);
      removeProfile(profile);
      fail(`could not start ${exe}: ${spawnError.message}`);
    }
    await sleep(100);
    if (await alive()) {
      writeState({ browserPid: child.pid ?? null, profile, headed, startedByUs: true, token, launchedAt: new Date().toISOString() });
      return { launched: true, state: readState() ?? {}, headed };
    }
  }
  killTree(child.pid);
  await sleep(300);
  removeProfile(profile);
  fail(`the browser did not come up on port ${port}`);
}

async function pages() {
  const list = await httpJson("/json");
  if (!Array.isArray(list)) fail("the browser returned no target list");
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

async function currentPage() {
  const list = await pages();
  if (!list.length) fail("no page targets — run `open <url>` first");
  const want = readState()?.targetId;
  return list.find((t) => t.id === want) ?? list[0];
}

class Cdp {
  static async connect(wsUrl, { page = true } = {}) {
    requireWebSocket();
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        done(new Error("timeout while opening the websocket"));
      }, 10000);
      const done = (err) => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        if (err) reject(err);
        else resolve();
      };
      const onOpen = () => done(null);
      const onError = () => done(new Error("websocket failed"));
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
    const client = new Cdp(ws);
    OPEN.add(client);
    if (page) {
      await client.send("Page.enable");
      await client.send("Runtime.enable");
    }
    return client;
  }
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closedReason = null;
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const set = this.listeners.get(msg.method);
        if (!set) return;
        for (const fn of [...set]) {
          try {
            fn(msg.params ?? {});
          } catch {
            /* a listener must not break the socket */
          }
        }
      }
    });
    ws.addEventListener("close", () => this.abortPending("the browser connection closed"));
    ws.addEventListener("error", () => this.abortPending("the browser connection failed"));
  }
  abortPending(reason) {
    this.closedReason ??= reason;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(this.closedReason));
    }
    this.pending.clear();
  }
  on(method, fn) {
    const set = this.listeners.get(method) ?? new Set();
    set.add(fn);
    this.listeners.set(method, set);
    return () => set.delete(fn);
  }
  send(method, params = {}, timeoutMs = 20000) {
    if (this.closedReason) return Promise.reject(new Error(this.closedReason));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout on ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { timer, resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result?.value;
  }
  close() {
    OPEN.delete(this);
    const ws = this.ws;
    if (ws.readyState === 2 || ws.readyState === 3) {
      this.abortPending("the browser connection closed");
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.abortPending("the browser connection closed");
        resolve();
      };
      const timer = setTimeout(finish, 500);
      ws.addEventListener("close", finish, { once: true });
      try {
        ws.close();
      } catch {
        finish();
      }
    });
  }
}

/**
 * Resolves on Page.loadEventFired (a full load) or on
 * Page.navigatedWithinDocument (fragment / hash routing, which never fires a
 * load event), or on timeout. cancel() detaches both listeners.
 */
function loadWatcher(client, timeoutMs) {
  let settle;
  let settled = false;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const offLoad = client.on("Page.loadEventFired", () => finish({ ok: true }));
  const offWithin = client.on("Page.navigatedWithinDocument", () => finish({ ok: true, sameDocument: true }));
  const detach = () => {
    offLoad();
    offWithin();
  };
  function finish(result) {
    if (settled) return;
    settled = true;
    detach();
    clearTimeout(timer);
    settle(result);
  }
  const timer = setTimeout(() => finish({ ok: false, error: `the page did not finish loading within ${timeoutMs}ms` }), timeoutMs);
  return {
    done,
    cancel: () => {
      if (settled) return;
      settled = true;
      detach();
      clearTimeout(timer);
      settle({ ok: false, error: "navigation was cancelled" });
    },
  };
}

const isContextError = (err) =>
  /Cannot find context|context was destroyed|Execution context|Inspected target navigated|cannot find default execution context/i.test(String(err?.message ?? err));

async function timeOriginOf(client) {
  try {
    return await client.eval("performance.timeOrigin");
  } catch {
    return null;
  }
}

/**
 * Fallback for a missed load event: poll until a document that is complete and
 * (when known) newer than the one seen before the navigation reports ready.
 * Context-switch errors during navigation are expected and retried.
 */
async function waitForDocument(client, { beforeTimeOrigin = null, timeoutMs = FALLBACK_LOAD_MS } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const st = await client.eval("({ ready: document.readyState, origin: performance.timeOrigin })");
      if (st && st.ready === "complete" && (beforeTimeOrigin === null || st.origin !== beforeTimeOrigin)) return { ok: true };
    } catch (err) {
      if (!isContextError(err)) throw err;
    }
    await sleep(120);
  }
  return { ok: false, error: `the page did not finish loading within ${timeoutMs}ms` };
}

/** Navigates and waits for the new document; never trusts the previous readyState. */
async function navigate(client, url, timeoutMs = LOAD_TIMEOUT_MS) {
  const before = await timeOriginOf(client);
  const watcher = loadWatcher(client, timeoutMs);
  let res;
  try {
    res = await client.send("Page.navigate", { url });
  } catch (err) {
    watcher.cancel();
    throw err;
  }
  if (res?.errorText) {
    watcher.cancel();
    return { ok: false, error: res.errorText };
  }
  if (!res?.loaderId) {
    // Same-document navigation (fragment, hash routing): the document is the
    // same one, so no load event is guaranteed. Wait briefly for the event and
    // accept the navigation either way — Page.navigate reported no error.
    await Promise.race([watcher.done, sleep(SAME_DOCUMENT_WAIT_MS)]);
    watcher.cancel();
    return { ok: true, sameDocument: true };
  }
  const loaded = await watcher.done;
  if (loaded.ok) return loaded;
  const fallback = await waitForDocument(client, { beforeTimeOrigin: before, timeoutMs: Math.min(timeoutMs, FALLBACK_LOAD_MS) });
  return fallback.ok ? fallback : { ok: false, error: loaded.error ?? fallback.error };
}

async function createBlankTarget() {
  try {
    const target = await httpJson(`/json/new?${encodeURIComponent("about:blank")}`, "PUT");
    if (target?.webSocketDebuggerUrl) return target;
  } catch {
    /* older browsers have no PUT /json/new */
  }
  const version = await httpJson("/json/version");
  if (!version?.webSocketDebuggerUrl) fail("the browser did not expose a DevTools endpoint");
  const browser = await Cdp.connect(version.webSocketDebuggerUrl, { page: false });
  try {
    const created = await browser.send("Target.createTarget", { url: "about:blank" });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const hit = (await pages()).find((t) => t.id === created.targetId);
      if (hit) return hit;
    }
  } finally {
    await browser.close();
  }
  fail("the new tab never appeared");
}

const PUNCTUATION = {
  ".": { key: ".", code: "Period", vk: 190 },
  ",": { key: ",", code: "Comma", vk: 188 },
  "/": { key: "/", code: "Slash", vk: 191 },
  ";": { key: ";", code: "Semicolon", vk: 186 },
  "'": { key: "'", code: "Quote", vk: 222 },
  "[": { key: "[", code: "BracketLeft", vk: 219 },
  "]": { key: "]", code: "BracketRight", vk: 221 },
  "\\": { key: "\\", code: "Backslash", vk: 220 },
  "-": { key: "-", code: "Minus", vk: 189 },
  "=": { key: "=", code: "Equal", vk: 187 },
  "`": { key: "`", code: "Backquote", vk: 192 },
};
const SHIFTED = {
  "!": { code: "Digit1", vk: 49 },
  "@": { code: "Digit2", vk: 50 },
  "#": { code: "Digit3", vk: 51 },
  "$": { code: "Digit4", vk: 52 },
  "%": { code: "Digit5", vk: 53 },
  "^": { code: "Digit6", vk: 54 },
  "&": { code: "Digit7", vk: 55 },
  "*": { code: "Digit8", vk: 56 },
  "(": { code: "Digit9", vk: 57 },
  ")": { code: "Digit0", vk: 48 },
  "_": { code: "Minus", vk: 189 },
  "+": { code: "Equal", vk: 187 },
  "{": { code: "BracketLeft", vk: 219 },
  "}": { code: "BracketRight", vk: 221 },
  "|": { code: "Backslash", vk: 220 },
  ":": { code: "Semicolon", vk: 186 },
  '"': { code: "Quote", vk: 222 },
  "<": { code: "Comma", vk: 188 },
  ">": { code: "Period", vk: 190 },
  "?": { code: "Slash", vk: 191 },
  "~": { code: "Backquote", vk: 192 },
};

const KEY_NAMES = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

/** DOM key/code/vk triples; a lone printable character carries text. */
function keySpec(raw) {
  const name = String(raw ?? "");
  const lower = name.toLowerCase();
  if (Object.hasOwn(KEY_NAMES, lower)) return KEY_NAMES[lower];
  if (name.length === 1 && name >= " " && name <= "~") {
    if (Object.hasOwn(PUNCTUATION, name)) return { ...PUNCTUATION[name], text: name };
    if (Object.hasOwn(SHIFTED, name)) return { key: name, ...SHIFTED[name], modifiers: 8, text: name };
    const upper = name.toUpperCase();
    if (/[a-z]/i.test(name)) {
      const shifted = name !== name.toLowerCase();
      return { key: name, code: `Key${upper}`, vk: upper.charCodeAt(0), modifiers: shifted ? 8 : 0, text: name };
    }
    if (/[0-9]/.test(name)) return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0), text: name };
  }
  return null;
}

/* ---- page primitives shared by the one-shot actions and `batch` ---- */

async function readText(client, sel) {
  const value = await client.eval(`(() => { const el = document.querySelector(${q(sel)}); return el ? el.innerText : null; })()`);
  if (value === null) fail(`nothing matches ${sel}`);
  return value;
}

async function readHtml(client, sel) {
  const value = await client.eval(`(() => { const el = document.querySelector(${q(sel)}); return el ? el.outerHTML : null; })()`);
  if (value === null) fail(`nothing matches ${sel}`);
  return value;
}

/** Clicks through the page's own el.click(), so a script handler runs as for a user. */
async function clickElement(client, sel) {
  const res = await client.eval(`(() => {
    const el = document.querySelector(${q(sel)});
    if (!el) return { error: "no element" };
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus?.();
    el.click();
    return { text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80) };
  })()`);
  if (res?.error) fail(`click: ${res.error} for ${sel}`);
  return res.text;
}

/** Native setter plus input/change events, so React-owned inputs keep their state. */
async function typeInto(client, sel, text) {
  const res = await client.eval(`(() => {
    const el = document.querySelector(${q(sel)});
    if (!el) return { error: "no element" };
    const text = ${q(text)};
    const tag = el.tagName;
    const fire = (type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    if (tag === "SELECT") {
      const want = String(text).trim().toLowerCase();
      const opt = Array.prototype.slice.call(el.options).find((o) => String(o.value).toLowerCase() === want || (o.textContent || "").trim().toLowerCase() === want);
      if (!opt) return { error: "no option matches " + JSON.stringify(text) };
      el.focus();
      el.value = opt.value;
      fire("input");
      fire("change");
      return { kind: "select", length: String(el.value).length };
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (tag === "INPUT" && /^(checkbox|radio|file|submit|button|image|reset|range|color|hidden)$/i.test(el.type)) {
        return { error: "cannot type into <input type=" + el.type + ">" };
      }
      const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      el.focus();
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      fire("input");
      fire("change");
      return { kind: "value", length: String(el.value).length };
    }
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text });
      if (!el.dispatchEvent(before)) return { error: "the page cancelled beforeinput" };
      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch (err) {
        inserted = false;
      }
      if (!inserted) {
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        const tail = document.createRange();
        tail.selectNodeContents(el);
        tail.collapse(false);
        sel.removeAllRanges();
        sel.addRange(tail);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      return { kind: "contenteditable", length: String(el.textContent || "").length };
    }
    return { error: "cannot type into <" + String(tag).toLowerCase() + ">" };
  })()`);
  if (res?.error) fail(`type: ${res.error} for ${sel}`);
  return res;
}

async function pressKey(client, key, sel) {
  const spec = keySpec(key);
  if (!spec) fail(`unknown key "${key}" (known: ${Object.keys(KEY_NAMES).join(", ")}, or a single printable character)`);
  if (sel) {
    const focused = await client.eval(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return "missing"; el.focus(); return "ok"; })()`);
    if (focused !== "ok") fail(`press: nothing matches ${sel}`);
  }
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers: spec.modifiers ?? 0,
  };
  const withText = spec.text ? { ...base, text: spec.text, unmodifiedText: spec.text } : base;
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...withText });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return spec.key;
}

async function waitForSelector(client, sel, timeout) {
  const until = Date.now() + timeout;
  let found = false;
  while (Date.now() < until) {
    try {
      found = await client.eval(`!!document.querySelector(${q(sel)})`);
      if (found) break;
    } catch (err) {
      if (!isContextError(err)) throw err;
    }
    await sleep(150);
  }
  if (!found) fail(`${sel} never appeared within ${timeout}ms`);
}

async function captureShot(client, out) {
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  if (!shot?.data) fail("the browser returned no screenshot data");
  const file = out ?? path.join(os.tmpdir(), `browser-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  return file;
}

/**
 * The one `open` flow: prove/launch the owned browser, pick or create a tab,
 * record it, and load the url through the caller's connection factory so that a
 * batch keeps a single websocket for the whole scenario.
 */
async function openTarget(url, useClient) {
  const { launched, state, headed } = await ensureBrowser();
  let target = launched ? ((await pages())[0] ?? null) : null;
  if (!target) target = await createBlankTarget();
  writeState({ targetId: target.id, headed: headed === true, startedByUs: state.startedByUs === true });
  const client = await useClient(target);
  const loaded = await navigate(client, url);
  if (!loaded.ok) fail(`open ${url} failed: ${loaded.error}`);
  return { target, client, launched };
}

/** Closes the current tab of the owned browser; null means there was no browser. */
async function closeTab() {
  const own = await ownership();
  if (!own.alive) {
    if (!cleanupStale(own.state)) fail(`the old browser profile ${own.state.profile} is still locked; close the browser holding it and retry`);
    return null;
  }
  if (!own.owned) fail(`port ${port} is used by a browser this script did not start; not closing it`);
  const target = await currentPage();
  try {
    await httpJson(`/json/close/${target.id}`);
  } catch (err) {
    fail(`could not close ${target.id}: ${err?.message ?? err}`);
  }
  let gone = false;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const left = await pages().catch(() => []);
    if (!left.some((t) => t.id === target.id)) {
      gone = true;
      break;
    }
  }
  if (!gone) fail(`tab ${target.id} did not close`);
  if (readState()?.targetId === target.id) writeState({ targetId: null });
  return target.title || target.url || target.id;
}

/** Stops the browser we launched and removes its profile; returns what happened. */
async function quitBrowser() {
  const own = await ownership();
  if (!own.alive) {
    if (!cleanupStale(own.state)) fail(`the old browser profile ${own.state.profile} is still locked; close the browser holding it and retry`);
    return `no browser on port ${port}`;
  }
  if (!own.owned) fail(`port ${port} is used by a browser this script did not start; not closing it`);
  const version = await httpJson("/json/version");
  if (!version?.webSocketDebuggerUrl) fail("the browser did not expose a DevTools endpoint");
  const browser = await Cdp.connect(version.webSocketDebuggerUrl, { page: false });
  try {
    await browser.send("Browser.close");
  } catch {
    /* the socket dies together with the browser */
  }
  await browser.close();
  let gone = false;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (!(await alive())) {
      gone = true;
      break;
    }
  }
  if (!gone) fail(`the browser on port ${port} is still running after Browser.close`);
  for (let i = 0; i < 20 && pidAlive(own.state.browserPid); i++) await sleep(100);
  const profileDir = own.state.profile;
  let cleaned = true;
  if (isOurProfile(profileDir)) {
    let removed = removeProfile(profileDir);
    for (let i = 0; i < 10 && !removed; i++) {
      await sleep(300);
      removed = removeProfile(profileDir);
    }
    cleaned = removed;
    if (!removed) console.log(`note profile left at ${profileDir} (could not remove it)`);
  }
  // Keep the state when the profile survived, so the next command retries the cleanup.
  if (cleaned) dropState();
  return "browser closed";
}

/* ---- batch: a whole scenario in one process, one page connection ---- */

/** Reads {"steps": [...]} from a file; a bare array of steps is accepted too. */
function readScenario(file) {
  const target = path.resolve(String(file ?? ""));
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (err) {
    fail(`cannot read ${file}: ${err?.message ?? err}`);
  }
  let doc;
  try {
    // A BOM is what PowerShell's UTF8 writer leaves behind.
    doc = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    fail(`${file} is not valid JSON: ${err?.message ?? err}`);
  }
  const steps = Array.isArray(doc) ? doc : doc?.steps;
  if (!Array.isArray(steps)) fail(`${file} needs a "steps" array`);
  if (!steps.length) fail(`${file} has no steps`);
  return steps;
}

/** A step value is either the selector itself or an object carrying `selector`. */
function selectorOf(value) {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object" && typeof value.selector === "string") return value.selector.trim() || undefined;
  return undefined;
}

/**
 * One batch step. Each branch is thin: the work lives in the primitives above,
 * which the one-shot actions also call, so `batch` cannot drift from them.
 */
async function runStep(name, value, io) {
  switch (name) {
    case "open": {
      const url = resolveUrlArg(value);
      const opened = await openTarget(url, io.connectFor);
      return { url, launched: opened.launched === true };
    }
    case "nav": {
      const url = resolveUrlArg(value);
      const loaded = await navigate(await io.page(), url);
      if (!loaded.ok) fail(`nav ${url} failed: ${loaded.error}`);
      return { url, sameDocument: loaded.sameDocument === true };
    }
    case "wait": {
      const ms = Number(value ?? 500);
      if (!Number.isFinite(ms) || ms < 0) fail("wait needs a non-negative number of milliseconds");
      await sleep(ms);
      return { ms };
    }
    case "waitfor": {
      const spec = typeof value === "string" ? { selector: value } : value;
      const sel = spec && typeof spec === "object" ? selectorOf(spec) : undefined;
      if (!sel) fail('waitfor needs {"selector": "css", "timeoutMs": 10000}');
      const timeout = Number(spec.timeoutMs ?? 10000);
      if (!Number.isFinite(timeout) || timeout < 0) fail("waitfor needs a non-negative timeout in milliseconds");
      await waitForSelector(await io.page(), sel, timeout);
      return { selector: sel, timeoutMs: timeout };
    }
    case "click": {
      const sel = selectorOf(value);
      if (!sel) fail('click needs a selector: {"click": "#go"}');
      return { selector: sel, text: await clickElement(await io.page(), sel) };
    }
    case "type": {
      const spec = value && typeof value === "object" ? value : {};
      if (!spec.selector) fail('type needs {"selector": "css", "text": "words"}');
      if (typeof spec.text !== "string") fail("type needs a text string after the selector");
      const info = await typeInto(await io.page(), spec.selector, spec.text);
      return { selector: spec.selector, kind: info.kind, chars: spec.text.length };
    }
    case "press": {
      const spec = typeof value === "string" ? { key: value } : value && typeof value === "object" ? value : {};
      if (!spec.key) fail('press needs {"key": "enter", "selector": "css"}');
      const key = await pressKey(await io.page(), spec.key, spec.selector);
      return { key, selector: spec.selector ?? null };
    }
    case "eval": {
      if (typeof value !== "string" || !value.trim()) fail("eval needs javascript");
      const out = await (await io.page()).eval(value);
      return { value: out === undefined ? null : out };
    }
    case "text": {
      const sel = selectorOf(value) ?? "body";
      return { selector: sel, text: await readText(await io.page(), sel) };
    }
    case "shot": {
      const out = typeof value === "string" && value ? value : null;
      return { path: await captureShot(await io.page(), out) };
    }
    case "close": {
      if (value !== true) fail('close takes {"close": true}');
      await io.drop();
      return { closed: (await closeTab()) ?? "no browser" };
    }
    case "quit": {
      if (value !== true) fail('quit takes {"quit": true}');
      await io.drop();
      return { message: await quitBrowser() };
    }
    default:
      fail(`unknown step "${name}"`);
  }
}

/**
 * Runs the steps in order against one page connection and returns the report.
 * The first failure ends the run: no step is ever retried, and the report names
 * the step that failed.
 */
async function runBatch(file) {
  const steps = readScenario(file);
  const results = [];
  let client = null;
  let connectedId = null;
  const connectFor = async (target) => {
    if (client && connectedId === target.id) return client;
    if (client) await client.close();
    client = await Cdp.connect(target.webSocketDebuggerUrl);
    connectedId = target.id;
    return client;
  };
  const io = {
    connectFor,
    page: async () => {
      if (client) return client;
      await requireBrowser();
      return connectFor(await currentPage());
    },
    drop: async () => {
      if (client) await client.close();
      client = null;
      connectedId = null;
    },
  };
  for (let i = 0; i < steps.length; i++) {
    const label = `step ${i + 1}`;
    const raw = steps[i];
    let actionName = null;
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label}: a step must be an object like {"click": "#go"}`);
      const names = Object.keys(raw);
      if (names.length !== 1) fail(`${label}: a step carries exactly one key, got ${names.length ? names.join(", ") : "none"}`);
      actionName = names[0].toLowerCase();
      if (!BATCH_STEPS.has(actionName)) fail(`${label}: unknown step "${names[0]}" (known: ${[...BATCH_STEPS].join(", ")})`);
      const result = await runStep(actionName, raw[names[0]], io);
      results.push({ step: i + 1, action: actionName, ok: true, ...result });
    } catch (err) {
      const message = err instanceof ReportedError ? err.message : (err?.message ?? String(err));
      return {
        ok: false,
        completed: results.length,
        failedStep: i + 1,
        action: actionName,
        error: message.startsWith(label) ? message : `${label}: ${message}`,
        results,
      };
    }
  }
  await io.drop();
  return { ok: true, completed: results.length, results };
}

function validateArgs() {
  switch (action) {
    case "nav":
      if (!args[0]) fail("nav needs a url");
      break;
    case "use":
      if (!args[0]) fail("use needs a tab index, id or title substring");
      break;
    case "click":
      if (!args[0]) fail("click needs a selector");
      break;
    case "type":
      if (!args[0]) fail("type needs a selector and text");
      if (args.length < 2 || args[1] === "") fail("type needs text after the selector");
      break;
    case "press":
      if (!args[0]) fail("press needs a key");
      break;
    case "eval":
      if (!args.join(" ").trim()) fail("eval needs javascript");
      break;
    case "waitfor":
      if (!args[0]) fail("waitfor needs a selector");
      break;
    case "wait": {
      const ms = Number(args[0] ?? 500);
      if (!Number.isFinite(ms) || ms < 0) fail("wait needs a non-negative number of milliseconds");
      break;
    }
    case "batch":
      if (!args[0]) fail('batch needs a scenario file holding {"steps": [...]}');
      break;
    default:
      break;
  }
}

async function main() {
  requireWebSocket();
  if (!action) fail(USAGE);
  if (!ACTIONS.has(action)) fail(`unknown action "${action}"\n${USAGE}`);
  validateArgs();

  if (action === "open") {
    const url = args[0] ? resolveUrlArg(args[0]) : "about:blank";
    let held = null;
    try {
      const { launched } = await openTarget(url, async (target) => (held = await Cdp.connect(target.webSocketDebuggerUrl)));
      ok(`open ${url}${launched ? " (browser launched)" : ""}`);
    } finally {
      if (held) await held.close();
    }
    return;
  }

  if (action === "tabs") {
    await requireBrowser();
    const list = await pages();
    const cur = readState()?.targetId;
    json(list.map((t, i) => ({ index: i, id: t.id, title: t.title, url: t.url, current: t.id === cur })));
    return;
  }

  if (action === "use") {
    await requireBrowser();
    const want = String(args[0]);
    const list = await pages();
    const byIndex = /^\d+$/.test(want) ? list[Number(want)] : undefined;
    const hit =
      byIndex ??
      list.find((t) => t.id === want) ??
      list.find((t) => `${t.title ?? ""} ${t.url ?? ""}`.toLowerCase().includes(want.toLowerCase()));
    if (!hit) fail(`no tab matches "${want}"`);
    writeState({ targetId: hit.id });
    ok(`use ${hit.title || hit.url}`);
    return;
  }

  if (action === "close") {
    const label = await closeTab();
    ok(label === null ? "no browser" : `tab closed ${label}`);
    return;
  }

  if (action === "quit") {
    ok(await quitBrowser());
    return;
  }

  if (action === "batch") {
    const report = await runBatch(args[0]);
    json(report);
    // The report is the whole answer: exit code carries the failure, so the
    // lead does not get a second `error` line to parse.
    if (!report.ok) throw new SilentExit(report.error);
    return;
  }

  await requireBrowser();
  const target = await currentPage();
  const client = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    switch (action) {
      case "nav": {
        const url = resolveUrlArg(args[0]);
        const loaded = await navigate(client, url);
        if (!loaded.ok) fail(`nav ${url} failed: ${loaded.error}`);
        ok(`nav ${url}`);
        break;
      }
      case "text": {
        const sel = args[0] ?? "body";
        json({ selector: sel, text: await readText(client, sel) });
        break;
      }
      case "html": {
        const sel = args[0] ?? "body";
        json({ selector: sel, html: await readHtml(client, sel) });
        break;
      }
      case "click": {
        const sel = args[0];
        ok(`click ${sel} (${await clickElement(client, sel)})`);
        break;
      }
      case "type": {
        const [sel, ...rest] = args;
        const text = rest.join(" ");
        await typeInto(client, sel, text);
        ok(`type ${sel} (${String(text).length} chars)`);
        break;
      }
      case "press": {
        ok(`press ${await pressKey(client, args[0], args[1])}`);
        break;
      }
      case "eval": {
        json({ value: await client.eval(args.join(" ")) });
        break;
      }
      case "wait": {
        const ms = Number(args[0] ?? 500);
        await sleep(ms);
        ok(`wait ${ms}ms`);
        break;
      }
      case "waitfor": {
        const sel = args[0];
        const timeout = Number(args[1] ?? 10000);
        if (!Number.isFinite(timeout) || timeout < 0) fail("waitfor needs a non-negative timeout in milliseconds");
        await waitForSelector(client, sel, timeout);
        ok(`waitfor ${sel}`);
        break;
      }
      case "shot": {
        ok(`shot ${await captureShot(client, args[0])}`);
        break;
      }
      default:
        fail(`unknown action "${action}"`);
    }
  } finally {
    await client.close();
  }
}

const q = (s) => JSON.stringify(String(s));

/** Windows drive paths are paths, not URL schemes; a missing path is an error. */
function resolveUrlArg(raw) {
  const s = String(raw ?? "");
  if (!s) fail("a url or file path is required");
  if (/^file:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return `https:${s}`;
  const drive = /^[a-z]:[\\/]/i.test(s);
  const unc = /^\\\\/.test(s);
  const abs = s.startsWith("/");
  const rel = s.startsWith("./") || s.startsWith("../") || s.startsWith(".\\") || s.startsWith("..\\");
  const scheme = !drive && /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (scheme) return s;
  if (drive || unc || abs || rel || /\.html?$/i.test(s)) {
    if (fs.existsSync(s)) return pathToFileURL(path.resolve(s)).href;
    fail(`file not found: ${s}`);
  }
  if (fs.existsSync(s)) return pathToFileURL(path.resolve(s)).href;
  if (s.includes("/") || s.includes("\\")) fail(`file not found: ${s}`);
  return s;
}

async function closeAll() {
  await Promise.all([...OPEN].map((client) => client.close()));
}

main()
  .then(async () => {
    await closeAll();
    process.exitCode = 0;
  })
  .catch(async (err) => {
    // A failed batch already printed its report, whose `error` field carries the
    // message; only the exit code is still owed.
    if (!(err instanceof SilentExit)) {
      const message = err instanceof ReportedError ? err.message : (err?.message ?? String(err));
      console.log(`error ${message}`);
    }
    await closeAll();
    process.exitCode = 1;
  });

