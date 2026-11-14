/**
 * Several credentials per provider: the book that names them, the operations
 * behind the panel, and what a refusal does to them.
 *
 * The rule under test: a book keeps every key and login, one of them active,
 * and switching is always the user's move — a 429 is reported, never answered
 * by quietly changing who pays for the turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-accounts-"));
process.env.TRCODE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.TOKENROUTER_API_KEY;
delete process.env.TR_API_KEY;
delete process.env.TRCODE_MODEL;

const { loadConfig, saveConfig } = await import("../dist/config.js");
const creds = await import("../dist/provider/credentials.js");
const accounts = await import("../dist/provider/accounts.js");
const client = await import("../dist/provider/client.js");

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
};

const KEY_A = "sk-aaaaaaaaaaaaaaaa1111";
const KEY_B = "sk-bbbbbbbbbbbbbbbb2222";

// ── the book ──────────────────────────────────────────────────────────────
{
  const a = accounts.registerAccount("opencode-go", { mode: "apikey", accessToken: KEY_A, source: "pasted key" }, "work");
  ok("первый ключ получил имя", a.name === "work", a.name);
  ok("он стал активным", accounts.activeAccountId("opencode-go") === a.id);
  ok("ключ записан туда, где его читают", creds.readCredentials("opencode-go")?.accessToken === KEY_A);

  const again = accounts.registerAccount("opencode-go", { mode: "apikey", accessToken: KEY_A }, "renamed");
  ok("тот же ключ не заводит вторую запись", accounts.accountsOf("opencode-go").length === 1, String(accounts.accountsOf("opencode-go").length));
  ok("и переименовывается", again.name === "renamed" && again.id === a.id, again.name);

  const b = accounts.registerAccount("opencode-go", { mode: "apikey", accessToken: KEY_B }, "personal");
  ok("второй ключ добавился", accounts.accountsOf("opencode-go").length === 2);
  ok("и стал активным", accounts.activeAccountId("opencode-go") === b.id);
  ok("активный ключ на диске — второй", creds.readCredentials("opencode-go")?.accessToken === KEY_B);
  ok("маска не выдаёт ключ", accounts.maskSecret(KEY_A) === "sk-aaa…1111", accounts.maskSecret(KEY_A));
}

// A refreshed OAuth token is the same account, not a new one.
{
  accounts.registerAccount("gemini", { mode: "oauth", accessToken: "old-token", clientId: "reg-1" }, "google");
  accounts.storeCredential("gemini", { mode: "oauth", accessToken: "new-token", clientId: "reg-1" });
  const list = accounts.accountsOf("gemini");
  ok("обновлённый токен не добавил аккаунт", list.length === 1, String(list.length));
  ok("и обновил сохранённую копию", accounts.accountCreds("gemini", list[0])?.accessToken === "new-token");
}

// Switching is explicit.
{
  const list = accounts.accountsOf("opencode-go");
  const first = list.find((e) => e.name === "renamed");
  accounts.activateAccount("opencode-go", first.id);
  ok("аккаунт переключается вручную", accounts.activeAccountId("opencode-go") === first.id);
  ok("и файл следует за ним", creds.readCredentials("opencode-go")?.accessToken === KEY_A);
}

// Deleting the active account passes the session to the next one.
{
  const list = accounts.accountsOf("opencode-go");
  const active = list.find((e) => e.id === accounts.activeAccountId("opencode-go"));
  accounts.removeAccount("opencode-go", active.id);
  const rest = accounts.accountsOf("opencode-go");
  ok("удаление убирает запись", rest.length === 1 && !rest.some((e) => e.id === active.id));
  ok("активным стал оставшийся", accounts.activeAccountId("opencode-go") === rest[0].id);
  ok("его ключ записан на диск", creds.readCredentials("opencode-go")?.accessToken === rest[0].creds.accessToken);
  accounts.registerAccount("opencode-go", { mode: "apikey", accessToken: KEY_A }, "renamed");
}

// ── a rejected key never stays in the book ────────────────────────────────
{
  const registry = await import("../dist/provider/registry.js");
  const { loginProvider } = await import("../dist/ui/login.js");
  const badHost = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    });
  });
  await new Promise((r) => badHost.listen(0, "127.0.0.1", r));
  const saved = loadConfig();
  saveConfig({ apiKey: "", providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${badHost.address().port}` } } });

  const before = accounts.activeAccountId("opencode-go");
  const res = await loginProvider(registry.providerById("opencode-go"), { mode: "apikey", key: "sk-rejected-0000000000", name: "dead" });
  ok("отклонённый вход считается неудачей", res.connected === false);
  ok("и не остаётся в книге", !accounts.accountsOf("opencode-go").some((a) => a.name === "dead"), JSON.stringify(accounts.accountsOf("opencode-go").map((a) => a.name)));
  ok("прежний аккаунт остаётся активным", accounts.activeAccountId("opencode-go") === before);
  ok("и его ключ не стёрт", Boolean(creds.readCredentials("opencode-go")?.accessToken));

  badHost.closeAllConnections?.();
  badHost.close();
  saveConfig({ apiKey: saved.apiKey, providers: saved.providers ?? {} }, { replace: ["providers"] });
}

// ── the client ────────────────────────────────────────────────────────────
const seen = [];
const host = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const auth = String(req.headers.authorization ?? "");
    seen.push(auth);
    if (auth.includes(KEY_A)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(2 * 24 * 3600) });
      res.end(JSON.stringify({ error: { message: "OpenCode Go usage limit reached (weekly, resets in 2d 6h)" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise((r) => host.listen(0, "127.0.0.1", r));

const savedKey = loadConfig().apiKey;
saveConfig({ apiKey: "", providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${host.address().port}` } } });

const ask = (opts = {}) =>
  client.complete({
    model: "opencode-go:glm-5.3-flash",
    messages: [{ role: "user", content: "hi" }],
    ...opts,
  });

// A refused request is reported and the book is left alone: which credential
// pays for a turn is the user's call, never a retry's.
{
  const limited = accounts.accountsOf("opencode-go").find((e) => e.name === "renamed");
  accounts.activateAccount("opencode-go", limited.id);
  const before = accounts.activeAccountId("opencode-go");
  let thrown = null;
  const at = Date.now();
  try {
    await ask();
  } catch (err) {
    thrown = err;
  }
  ok("429 возвращается ошибкой, а не высиживается", thrown?.status === 429, String(thrown?.status));
  ok("и это быстро", Date.now() - at < 3000, `${Date.now() - at}ms`);
  ok("аккаунт не сменился сам", accounts.activeAccountId("opencode-go") === before);
  ok("ошибка подсказывает /accounts", /switch with \/accounts/.test(thrown?.message ?? ""), thrown?.message);
}

// A host that serves the second key proves the switch is what the user does:
// activate it by hand and the same request goes through.
{
  const other = accounts.accountsOf("opencode-go").find((e) => e.name === "personal");
  accounts.activateAccount("opencode-go", other.id);
  const res = await ask();
  ok("ручное переключение даёт ответ", res.content === "ok", JSON.stringify(res.content));
}

// Logout clears the book with the credential.
{
  accounts.clearAccounts("opencode-go");
  ok("logout стирает книгу", accounts.accountsOf("opencode-go").length === 0);
}

// Keep-alive sockets from the requests above outlive the server; an explicit
// process.exit with one still open trips a libuv assertion on Windows.
host.closeAllConnections?.();
host.close();
saveConfig({ apiKey: savedKey, providers: {} }, { replace: ["providers"] });
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
