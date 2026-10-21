/**
 * The multi-provider layer: model-id routing, per-provider auth resolution and
 * the OAuth device flow. The flow runs against a throwaway HTTP server on
 * localhost, so this suite needs no account and no network.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-provider-"));
process.env.TRCODE_HOME = HOME;
// os.homedir() reads these, and the import path looks under it: a developer
// who really has Kimi Code installed must not change what this suite sees.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.TOKENROUTER_API_KEY;
delete process.env.TR_API_KEY;
// TRCODE_MODEL forces the model for the whole process, so a suite about which
// model a session lands on has to run without it. The runner sets one.
delete process.env.TRCODE_MODEL;

const { loadConfig, saveConfig } = await import("../dist/config.js");
const registry = await import("../dist/provider/registry.js");
const creds = await import("../dist/provider/credentials.js");
const oauth = await import("../dist/provider/oauth.js");
const imp_models = () => import("../dist/provider/models.js");

// Removed browser credentials must never be sent or refreshed as API keys.
async function rejectLegacyOpenCodeLogin(def) {
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("Unexpected network request for removed OAuth login");
  };
  try {
    for (const expiresAt of [Date.now() + 3600_000, Date.now() - 3600_000]) {
      creds.writeCredentials(def.id, { mode: "oauth", accessToken: "old-console-token", refreshToken: "old-refresh", expiresAt });
      ok(`${def.id}: старая OAuth-сессия не подключена`, registry.modeFor(def.id) === null);
      ok(`${def.id}: нет в подключённых провайдерах`, !registry.configuredProviders().some((p) => p.id === def.id));
      let message = "";
      try {
        await registry.resolveAuth(def.id);
      } catch (err) {
        message = err.message;
      }
      ok(`${def.id}: предлагается вход по ключу`, message.includes(`trc auth login --provider ${def.id} --key`), message);
      ok(`${def.id}: OAuth не обновляется`, (await registry.renewRejectedToken(def.id)) === false);
    }
    const { loginProvider } = await import("../dist/ui/login.js");
    const login = await loginProvider(def, { mode: "oauth" });
    ok(`${def.id}: явный OAuth-вход отклонён`, login.connected === false);
    ok(`${def.id}: ни одного сетевого запроса`, requests === 0, String(requests));
  } finally {
    globalThis.fetch = realFetch;
    creds.clearCredentials(def.id);
  }
}

// ── model id routing ──────────────────────────────────────────────────────
ok("id без префикса → TokenRouter", registry.splitModelId("moonshotai/kimi-k3").providerId === "tokenrouter");
ok("id с префиксом → провайдер", registry.splitModelId("kimi:kimi-for-coding").providerId === "kimi");
ok("на проводе префикс снят", registry.wireModelId("kimi:kimi-for-coding") === "kimi-for-coding");
ok("чужое двоеточие не префикс", registry.splitModelId("weird:thing").providerId === "tokenrouter");
ok("двоеточие в неизвестном id сохранено", registry.wireModelId("weird:thing") === "weird:thing");
ok("qualify по умолчанию не префиксует", registry.qualifyModelId("tokenrouter", "gpt") === "gpt");
ok("qualify префиксует чужого", registry.qualifyModelId("kimi", "m") === "kimi:m");

// Один хост под несколькими именами: Model Studio он же DashScope он же
// QwenCloud. Второй записью это был бы тот же каталог дважды.
ok("второе имя ведёт к тому же поставщику", registry.providerById("qwencloud")?.id === "alibabacloud");
ok("регистр не важен", registry.providerById("QwenCloud")?.id === "alibabacloud");
ok("и третье тоже", registry.providerById("dashscope")?.id === "alibabacloud");
ok("чужое имя по-прежнему неизвестно", registry.providerById("qwen") === undefined);
ok(
  "префикс-псевдоним схлопывается в канонический",
  registry.splitModelId("qwencloud:qwen3.8-max").providerId === "alibabacloud",
  JSON.stringify(registry.splitModelId("qwencloud:qwen3.8-max")),
);
ok(
  "двоеточие внутри id модели не путается с псевдонимом",
  registry.splitModelId("nvidia/nemotron:free").providerId === "tokenrouter",
);

// Grouping follows the provider, not the trainer: which plan pays for the call
// is the distinction that matters when picking a model.
const catalogModels = await imp_models();
ok("прямой провайдер — своя группа", catalogModels.vendorOf({ id: "kimi:kimi-for-coding" }) === "Kimi");
ok("через роутер — группа вендора", catalogModels.vendorOf({ id: "moonshotai/kimi-k3" }) === "MoonShot");

// ── nothing configured ────────────────────────────────────────────────────
ok("без ключей провайдеров нет", registry.hasProvider() === false);
let refused = "";
try {
  await registry.resolveAuth("kimi");
} catch (err) {
  refused = err.message;
}
ok("неподключённый провайдер объясняет себя", /auth login --provider kimi/.test(refused), refused);

// ── OAuth mode: Anthropic dialect against the coding host ─────────────────
creds.writeCredentials("kimi", {
  mode: "oauth",
  accessToken: "tok-abc-123456",
  refreshToken: "ref-xyz-123456",
  expiresAt: Date.now() + 3600_000,
});
ok("режим прочитан из файла", registry.modeFor("kimi") === "oauth");
ok("hasProvider видит kimi", registry.hasProvider() === true);
ok(
  "диалект форсирован, а не угадан",
  registry.protocolForModel("kimi:kimi-for-coding") === "anthropic",
  registry.protocolForModel("kimi:kimi-for-coding"),
);
ok("неизвестный id TokenRouter остаётся openai", registry.protocolForModel("что-угодно") === "openai");

const auth = await registry.resolveAuth("kimi");
ok("база — coding-хост", auth.baseUrl === "https://api.kimi.com/coding/v1", auth.baseUrl);
ok("Bearer из токена", auth.headers.Authorization === "Bearer tok-abc-123456");
ok("User-Agent подменён", /kimi-code/.test(auth.headers["User-Agent"]), auth.headers["User-Agent"]);
ok("anthropic-version отправляется", auth.headers["anthropic-version"] === "2023-06-01");
ok("device id проставлен", typeof auth.headers["X-Msh-Device-Id"] === "string" && auth.headers["X-Msh-Device-Id"].length > 8);
// The upstream validates x-api-key ahead of Authorization; sending both breaks.
ok(
  "x-api-key не отправляется",
  !Object.keys(auth.headers).some((h) => h.toLowerCase() === "x-api-key"),
);
const auth2 = await registry.resolveAuth("kimi");
ok("device id стабилен между вызовами", auth2.headers["X-Msh-Device-Id"] === auth.headers["X-Msh-Device-Id"]);

// ── the token never lands in config.json ──────────────────────────────────
saveConfig({ model: "kimi:kimi-for-coding" });
const configText = fs.readFileSync(path.join(HOME, "config.json"), "utf8");
ok("токен не попал в config.json", !configText.includes("tok-abc-123456") && !configText.includes("ref-xyz-123456"));
ok("токен лежит в auth/", fs.existsSync(path.join(HOME, "auth", "kimi.json")));

// ── API-key mode: the documented OpenAI-shaped platform ───────────────────
creds.writeCredentials("kimi", { mode: "apikey", accessToken: "sk-platform-key" });
ok("ключевой режим прочитан", registry.modeFor("kimi") === "apikey");
ok("ключ → openai-диалект", registry.protocolForModel("kimi:kimi-k2") === "openai");
const keyAuth = await registry.resolveAuth("kimi");
ok("ключ → платформенный хост", keyAuth.baseUrl === "https://api.moonshot.ai/v1", keyAuth.baseUrl);
ok("ключ не тянет device-заголовки", keyAuth.headers["X-Msh-Device-Id"] === undefined);

// ── config overrides a moved host and its identity ────────────────────────
saveConfig({ providers: { kimi: { baseUrl: "https://example.test/v9", headers: { "User-Agent": "custom/1" } } } });
const overridden = await registry.resolveAuth("kimi");
ok("baseUrl переопределяется", overridden.baseUrl === "https://example.test/v9", overridden.baseUrl);
saveConfig({ providers: {} }, { replace: ["providers"] });

// ── expiry ────────────────────────────────────────────────────────────────
ok("свежий токен не устарел", creds.isStale({ mode: "oauth", accessToken: "x", expiresAt: Date.now() + 3600_000 }) === false);
ok("токен на исходе считается устаревшим", creds.isStale({ mode: "oauth", accessToken: "x", expiresAt: Date.now() + 60_000 }) === true);
ok("бессрочный ключ не устаревает", creds.isStale({ mode: "apikey", accessToken: "x" }) === false);

// ── picking up the vendor CLI's own login ─────────────────────────────────
const vendorFile = path.join(HOME, "vendor.json");
fs.writeFileSync(
  vendorFile,
  JSON.stringify({ accounts: { default: { oauth: { access_token: "vendor-access-token", refresh_token: "vendor-refresh-token", expires_in: 900 } } } }),
);
const imported = creds.importVendorCredentials([vendorFile]);
ok("чужой логин найден в произвольной вложенности", imported?.accessToken === "vendor-access-token");
ok("refresh тоже подобран", imported?.refreshToken === "vendor-refresh-token");
ok("expires_in переведён в абсолютное время", imported.expiresAt > Date.now() && imported.expiresAt < Date.now() + 901_000);
ok("отсутствующий файл не роняет импорт", creds.importVendorCredentials([path.join(HOME, "нет.json")]) === null);

// ── the published model set, which the host will not enumerate ────────────
{
  creds.writeCredentials("kimi", { mode: "oauth", accessToken: "tok-abc-123456", expiresAt: Date.now() + 3600_000 });
  const seeded = registry.seedModels("kimi", "oauth");
  const ids = seeded.map((m) => m.id);
  ok(
    "у Kimi опубликованный набор моделей",
    JSON.stringify(ids) ===
      JSON.stringify(["kimi:k3", "kimi:k3-256k", "kimi:kimi-for-coding", "kimi:kimi-for-coding-highspeed"]),
    ids.join(", "),
  );
  ok("окно контекста k3 — 1M", seeded[0].contextWindow === 1_000_000);
  ok("окно контекста k3-256k — 256k", seeded[1].contextWindow === 256_000);
  ok("модели помечены как рабочие", seeded.every((m) => m.chatCapable));

  // The list is pinnable, because a vendor can add a model any day.
  saveConfig({ providers: { kimi: { models: ["own-1", "own-2"] } } });
  ok("список моделей переопределяется конфигом", registry.seedModels("kimi", "oauth").map((m) => m.id).join() === "kimi:own-1,kimi:own-2");
  saveConfig({ providers: {} }, { replace: ["providers"] });
}

// ── /provider, driven through the real command table ──────────────────────
{
  const { runCommand } = await import("../dist/ui/commands.js");
  creds.writeCredentials("kimi", { mode: "oauth", accessToken: "tok-abc-123456", expiresAt: Date.now() + 3600_000 });
  // Both providers connected: switching back is only offered for one that is.
  saveConfig({ apiKey: "sk-test-key", model: "moonshotai/kimi-k3", aliases: { kimi: "kimi:kimi-for-coding" } });
  saveConfig({ providerState: {} }, { replace: ["providerState"] });

  const app = {
    // Two projects, so what is remembered per worktree can be told apart.
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "trcode-proj-a-")),
    catalog: [
      { id: "moonshotai/kimi-k3", chatCapable: true },
      { id: "kimi:kimi-for-coding", chatCapable: true },
      { id: "kimi:k3", chatCapable: true },
    ],
    cfg: loadConfig(),
    session: { model: "moonshotai/kimi-k3", save() {} },
    effortOverride: undefined,
    effort: () => "medium",
    rebuildTools() {},
    exclusiveInput: (fn) => fn(),
    banners: 0,
    showBanner() { this.banners++; },
    repaintHeader() { this.banners++; },
  };

  await runCommand(app, "/provider kimi");
  ok("/provider переключает на алиас логина", app.session.model === "kimi:kimi-for-coding", app.session.model);
  // The header states provider, model and budget, and a printed box cannot be
  // edited — so each of the three switches reprints it.
  ok("переключение провайдера перерисовывает шапку", app.banners === 1, String(app.banners));
  // Choosing a provider is choosing it — the next session opens here too.
  ok("выбранный провайдер становится дефолтным", loadConfig().defaultProvider === "kimi", String(loadConfig().defaultProvider));
  app.banners = 0;
  await runCommand(app, "/model kimi:k3");
  ok("смена модели перерисовывает шапку", app.banners === 1, String(app.banners));
  app.banners = 0;
  await runCommand(app, "/effort high");
  ok("смена effort перерисовывает шапку", app.banners === 1, String(app.banners));

  // Where each provider was left is per provider, not per session.
  ok("модель запомнена за провайдером", loadConfig().providerState.kimi.model === "kimi:k3");
  ok("effort запомнен за провайдером", loadConfig().providerState.kimi.effort === "high");

  // …and separately per project: another checkout keeps its own model, which
  // is the point — switching repositories is switching tasks.
  {
    const { projectState } = await import("../dist/config.js");
    ok("модель запомнена за проектом", projectState(app.cwd).model === "kimi:k3", String(projectState(app.cwd).model));
    ok("effort запомнен за проектом", projectState(app.cwd).effort === "high", String(projectState(app.cwd).effort));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-proj-b-"));
    ok("другой проект не наследует модель", projectState(other).model === undefined, String(projectState(other).model));
    // A subdirectory is the same project: the key is the worktree root.
    fs.mkdirSync(path.join(app.cwd, ".git"), { recursive: true });
    const sub = path.join(app.cwd, "src", "ui");
    fs.mkdirSync(sub, { recursive: true });
    ok("подкаталог репозитория — тот же проект", projectState(sub).model === "kimi:k3", String(projectState(sub).model));
  }

  await runCommand(app, "/provider tokenrouter");
  ok("/provider возвращает к дефолтной модели", app.session.model === "moonshotai/kimi-k3", app.session.model);
  ok("дефолт следует за переключением обратно", loadConfig().defaultProvider === "tokenrouter", String(loadConfig().defaultProvider));
  ok("effort чужого провайдера не протекает", app.effortOverride === undefined, String(app.effortOverride));

  await runCommand(app, "/provider kimi");
  ok("возврат восстанавливает модель", app.session.model === "kimi:k3", app.session.model);
  ok("возврат восстанавливает effort", app.effortOverride === "high", String(app.effortOverride));

  await runCommand(app, "/provider kimi");
  ok("повторное переключение — не ошибка", app.session.model === "kimi:k3");

  // The default provider decides what a new session opens on.
  await runCommand(app, "/provider default kimi");
  ok("провайдер по умолчанию сохранён", loadConfig().defaultProvider === "kimi");
  ok("он же вычисляется как дефолтный", registry.defaultProviderId() === "kimi");
  saveConfig({ defaultProvider: undefined });
  ok("без явного дефолта его задаёт модель", registry.defaultProviderId() === "tokenrouter");

  await runCommand(app, "/provider logout kimi");
  ok("/provider logout удаляет учётку", creds.readCredentials("kimi") === null);
  // Leaving the session pointed at a disconnected provider only buys a 401.
  ok("после logout сессия уходит с провайдера", app.session.model === "moonshotai/kimi-k3", app.session.model);

  await runCommand(app, "/provider нет-такого");
  ok("неизвестное имя не меняет модель", app.session.model === "moonshotai/kimi-k3");

  // /login without a name means the provider in use — asking for a TokenRouter
  // key while the session runs on Kimi answers a question nobody asked.
  {
    creds.writeCredentials("kimi", { mode: "oauth", accessToken: "tok-abc-123456", expiresAt: Date.now() + 3600_000 });
    app.session.model = "kimi:k3";
    let askedFor = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => {
      askedFor += String(s);
      return true;
    };
    // Stop at the first interactive step: past it the OAuth flow would call
    // the real auth host, which a test suite has no business doing.
    const realExclusive = app.exclusiveInput;
    app.exclusiveInput = () => {
      throw new Error("STOP");
    };
    try {
      await runCommand(app, "/login");
    } catch (err) {
      if (err.message !== "STOP") throw err;
    } finally {
      process.stdout.write = realWrite;
      app.exclusiveInput = realExclusive;
    }
    ok("/login без имени берёт текущего провайдера", /Connect Kimi/.test(askedFor), askedFor.slice(0, 120));
    ok("и не спрашивает ключ TokenRouter", !/TokenRouter key/.test(askedFor));
  }

  // Nothing to switch to without a credential, and saying so beats a 401 later.
  saveConfig({ apiKey: undefined });
  app.session.model = "kimi:kimi-for-coding";
  await runCommand(app, "/provider tokenrouter");
  ok("неподключённый провайдер не выбирается", app.session.model === "kimi:kimi-for-coding");
}

// ── the status line names the provider ────────────────────────────────────
{
  const { composeStatus } = await import("../dist/ui/inputbox.js");
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const status = (model) =>
    strip(
      composeStatus({
        provider: registry.providerLabel(registry.splitModelId(model).providerId),
        model,
        effort: "high",
        cwdLabel: "~/p",
        contextUsed: 1,
        contextWindow: 100,
        contextEstimated: false,
      }).left,
    );

  const kimi = status("kimi:k3");
  ok("в строке статуса виден провайдер", kimi.includes("Kimi"), kimi);
  // The label already says Kimi; repeating it in the id is noise.
  ok("маршрутный префикс не дублируется", kimi.includes(" k3") && !kimi.includes("kimi:k3"), kimi);
  const router = status("moonshotai/kimi-k3");
  ok("для роутера тоже назван провайдер", router.includes("TokenRouter"), router);
  ok("id роутера не урезан", router.includes("moonshotai/kimi-k3"), router);

  // A level the host drops is not state: "thinking: high" beside a model that
  // never receives the parameter reads as if the turn runs at high effort. The
  // real session showed exactly that (deepseek-v4.1-flash, learned as refusing
  // the parameter, footer still advertising high), so the segment goes.
  const ignored = strip(
    composeStatus({
      provider: "Kimi",
      model: "kimi:k3",
      effort: "high",
      effortIgnored: true,
      cwdLabel: "~/p",
      contextUsed: 1,
      contextWindow: 100,
      contextEstimated: false,
    }).left,
  );
  ok("неисполнимый уровень в строке не показан", !ignored.includes("thinking") && ignored.includes("k3"), ignored);

  const { banner } = await import("../dist/ui/render.js");
  const shot = (effortIgnored) => {
    let out = "";
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      out += String(chunk);
      return true;
    };
    try {
      banner({ provider: "Kimi", model: "kimi:k3", effort: "high", effortIgnored, cwdLabel: "~/p", sessionId: "s1", version: "0.1.0" });
    } finally {
      process.stdout.write = real;
    }
    return strip(out);
  };
  ok("и в шапке тоже", !shot(true).includes("thinking:"), shot(true).slice(0, 120));
  ok("а на обычной модели уровень остался", shot(false).includes("thinking: high"), shot(false).slice(0, 120));
}

// ── Claude: a console key, and deliberately nothing else ──────────────────
{
  const def = registry.providerById("claude");
  ok("Claude есть в реестре", Boolean(def));
  // The subscription path was removed on purpose: Anthropic's terms scope
  // Pro/Max to their own applications.
  ok("подписочного режима нет", def.modes.oauth === undefined);
  ok("и OAuth-потока тоже", def.oauth === undefined);

  creds.writeCredentials("claude", { mode: "apikey", accessToken: "sk-ant-key" });
  const key = await registry.resolveAuth("claude");
  ok("ключ идёт на api.anthropic.com", key.baseUrl === "https://api.anthropic.com/v1", key.baseUrl);
  // Anthropic reads x-api-key for its own keys and rejects a request carrying
  // both credentials, so Authorization must stay absent.
  ok("ключ идёт через x-api-key", key.headers["x-api-key"] === "sk-ant-key");
  ok("и без Authorization", key.headers.Authorization === undefined);
  // Один beta-заголовок всё же нужен: он открывает часовой кэш вместо
  // пятиминутного — агентный ход живёт заметно дольше пяти минут.
  ok("beta-заголовок только про кэш", key.headers["anthropic-beta"] === "extended-cache-ttl-2025-04-11", key.headers["anthropic-beta"]);
  ok("диалект anthropic", registry.protocolForModel("claude:claude-opus-4-5") === "anthropic");

  creds.clearCredentials("claude");
}

// ── Meta: ключ Model API, Muse на /responses ──────────────────────────────
{
  const def = registry.providerById("meta");
  ok("Meta есть в реестре", Boolean(def));
  ok("модельное имя ведёт к тому же поставщику", registry.providerById("muse")?.id === "meta");
  ok("и второе тоже", registry.providerById("metaai")?.id === "meta");
  ok("префикс-псевдоним схлопывается", registry.splitModelId("muse:muse-spark-1.2").providerId === "meta");
  // Подписка у Meta есть, но она привязана к их собственному CLI: «Your
  // subscription only works through the Muse Code CLI», а любой ключ на том же
  // аккаунте оплачивается по факту. Тот же случай, что Claude Pro/Max, —
  // поэтому режим ровно один.
  ok("подписочного режима нет", def.modes.oauth === undefined);
  ok("и OAuth-потока тоже", def.oauth === undefined);

  creds.writeCredentials("meta", { mode: "apikey", accessToken: "LLM|123|key" });
  const auth = await registry.resolveAuth("meta");
  ok("ключ идёт на api.meta.ai/v1", auth.baseUrl === "https://api.meta.ai/v1", auth.baseUrl);
  ok("Bearer из ключа", auth.headers.Authorization === "Bearer LLM|123|key", auth.headers.Authorization);
  ok("x-api-key не отправляется", auth.headers["x-api-key"] === undefined);

  const dialect = (m) => registry.protocolForModel(`meta:${m}`);
  ok("Muse Spark → /responses", dialect("muse-spark-1.2") === "responses", dialect("muse-spark-1.2"));
  ok("и контрибьюторская сборка туда же", dialect("muse-spark-1.2-contributor") === "responses");
  // Картиночный эндпоинт этот клиент не водит: сказать об этом в списке лучше,
  // чем упасть на первом запросе.
  ok("muse-image помечен как неведомый", dialect("muse-image-1.0") === "unsupported", dialect("muse-image-1.0"));

  const seeded = registry.seedModels("meta", "apikey");
  ok(
    "опубликованный набор моделей",
    seeded.map((m) => m.id).join() ===
      "meta:muse-wonder-1.0,meta:muse-spark-1.3,meta:muse-spark-1.3-contributor,meta:muse-spark-1.2,meta:muse-spark-1.2-contributor,meta:muse-spark-1.1",
    seeded.map((m) => m.id).join(),
  );
  ok("окно — 1M на всю линейку", seeded.every((m) => m.contextWindow === 1_048_576));
  ok("модели помечены как рабочие", seeded.every((m) => m.chatCapable));
  // Каталог Meta цен не отдаёт, а контрибьюторский SKU дешевле в десять раз —
  // разница должна быть видна в /cost до выбора модели. Цены ищутся по id, а
  // не по позиции: ростер пополняется, и порядок — не контракт.
  const priced = (id) => seeded.find((m) => m.id === `meta:${id}`);
  const standard = priced("muse-spark-1.2");
  ok("цена стандартной сборки проставлена", standard?.pricing?.input === 1.25 && standard?.pricing?.output === 4.25, JSON.stringify(standard?.pricing));
  ok("кэш-цена тоже", standard?.pricing?.cachedInput === 0.15);
  const contributor = priced("muse-spark-1.2-contributor");
  ok("контрибьюторская дешевле", contributor?.pricing?.input === 0.1 && contributor?.pricing?.output === 0.2, JSON.stringify(contributor?.pricing));

  // Чья это модель — читается из имени, у какого бы хоста её ни взяли.
  ok("Muse у Meta — Meta", catalogModels.vendorOf({ id: "meta:muse-spark-1.2" }) === "Meta");
  ok("Muse у шлюза — тоже Meta", catalogModels.vendorOf({ id: "opencode:muse-spark-1.2" }) === "Meta");
  ok("окно известно и без каталога", catalogModels.knownContextFor("meta:muse-spark-1.1") === 1_048_576);

  creds.clearCredentials("meta");
}

// ── OpenCode Zen: один хост, три диалекта ─────────────────────────────────
{
  const def = registry.providerById("opencode");
  ok("Zen есть в реестре", Boolean(def));
  ok("шлюз откликается на своё второе имя", registry.providerById("zen")?.id === "opencode");
  ok("Zen подключается только по ключу", def.modes.oauth === undefined && def.oauth === undefined);
  await rejectLegacyOpenCodeLogin(def);
  creds.writeCredentials("opencode", { mode: "apikey", accessToken: "sk-zen-key", orgId: "wrk_1" });
  ok("ключу workspace не нужен", (await registry.resolveAuth("opencode")).headers["x-org-id"] === undefined);

  creds.writeCredentials("opencode", { mode: "apikey", accessToken: "sk-zen-key" });
  const auth = await registry.resolveAuth("opencode");
  ok("ключ идёт на opencode.ai/zen/v1", auth.baseUrl === "https://opencode.ai/zen/v1", auth.baseUrl);
  // /messages у Zen читает только x-api-key, а /chat/completions и /responses —
  // только Bearer, и на «не свой» заголовок отвечают «Missing API key». Так что
  // едут оба: каждый эндпоинт находит тот, который знает.
  ok("Bearer отправлен", auth.headers.Authorization === "Bearer sk-zen-key", auth.headers.Authorization);
  ok("и x-api-key тоже", auth.headers["x-api-key"] === "sk-zen-key", auth.headers["x-api-key"]);
  // Той же половине нужна версия; остальным она безразлична, поэтому едет со
  // всеми запросами, а не выбирается по модели.
  ok("anthropic-version едет всегда", auth.headers["anthropic-version"] === "2023-06-01");
  // Anthropic у себя отвергает запрос с двумя учётками сразу — «оба» это
  // отдельный случай шлюза, а не новое умолчание.
  const kimiAuth = await (async () => {
    creds.writeCredentials("kimi", { mode: "apikey", accessToken: "sk-platform-key" });
    const a = await registry.resolveAuth("kimi");
    creds.clearCredentials("kimi");
    return a;
  })();
  ok("другим провайдерам ничего не добавилось", kimiAuth.headers["x-api-key"] === undefined);

  // Каталог Zen отдаёт голые id и больше ничего, так что диалект каждой модели
  // знает реестр, а не хост.
  const dialect = (m) => registry.protocolForModel(`opencode:${m}`);
  ok("GPT → /responses", dialect("gpt-5.5") === "responses", dialect("gpt-5.5"));
  ok("GPT-5.3-сборки туда же", dialect("gpt-5.3-codex") === "responses", dialect("gpt-5.3-codex"));
  ok("Grok туда же", dialect("grok-4.6") === "responses", dialect("grok-4.6"));
  ok("Claude → /messages", dialect("claude-opus-5") === "anthropic", dialect("claude-opus-5"));
  ok("Qwen у Zen тоже /messages", dialect("qwen3.7-max") === "anthropic", dialect("qwen3.7-max"));
  ok(
    "остальное → /chat/completions",
    dialect("kimi-k3") === "openai" && dialect("glm-5.2") === "openai" && dialect("big-pickle") === "openai",
    [dialect("kimi-k3"), dialect("glm-5.2"), dialect("big-pickle")].join(", "),
  );
  // Gemini у Zen живёт на собственном эндпоинте Google, которого этот клиент
  // не знает: лучше сказать об этом в списке, чем упасть на первом запросе.
  ok("Gemini помечен как неведомый", dialect("gemini-3.7-flash") === "unsupported", dialect("gemini-3.7-flash"));

  // Тот же разбор виден и в списке моделей, а не только в маршруте запроса.
  saveConfig({ providers: { opencode: { models: ["gpt-5.5", "claude-opus-5", "kimi-k3", "gemini-3-flash"] } } });
  const seeded = registry.seedModels("opencode", "apikey");
  const ep = Object.fromEntries(seeded.map((m) => [m.id, m.endpoints.join()]));
  ok(
    "эндпоинты проставлены по правилам провайдера",
    ep["opencode:gpt-5.5"] === "openai-response" &&
      ep["opencode:claude-opus-5"] === "anthropic" &&
      ep["opencode:kimi-k3"] === "openai",
    JSON.stringify(ep),
  );
  ok("Gemini не выдаётся за рабочую модель", seeded.find((m) => m.id === "opencode:gemini-3-flash").chatCapable === false);
  ok("остальные рабочие", seeded.filter((m) => !m.id.includes("gemini")).every((m) => m.chatCapable));
  saveConfig({ providers: {} }, { replace: ["providers"] });
}

// ── живой каталог Zen: id и ничего больше ─────────────────────────────────
{
  // Хост перечисляет модели, но ни окна, ни цен, ни типов эндпоинтов в списке
  // нет — значит их проставляет клиент, и проверяется именно это.
  const probes = [];
  const sentHeaders = [];
  const zen = http.createServer((req, res) => {
    if (req.method === "POST") {
      // Хост, отдающий каталог всем подряд: подтвердить ключ может только
      // эндпоинт запроса, и заголовок он читает свой для каждого пути.
      const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      probes.push(req.url);
      sentHeaders.push({ ua: req.headers["user-agent"], session: req.headers["x-opencode-session"] });
      const good = key === "sk-zen-key";
      res.writeHead(good ? 400 : 401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: good ? "messages must not be empty" : "Invalid API key." } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: ["gpt-5.5", "claude-opus-5", "kimi-k3", "gemini-3-flash"].map((id) => ({
          id,
          object: "model",
          owned_by: "opencode",
        })),
      }),
    );
  });
  await new Promise((r) => zen.listen(0, "127.0.0.1", r));

  // Каталог собирается со всех подключённых хостов; остальные здесь пришлось
  // бы звать по сети, а этот набор офлайновый.
  creds.clearCredentials("kimi");
  const savedKey = loadConfig().apiKey;
  // OpenCode receives TRCode's own identity on verification requests too.
  saveConfig({
    apiKey: "",
    providers: { opencode: { baseUrl: `http://127.0.0.1:${zen.address().port}` } },
  });

  const models = await imp_models();
  const catalog = (await models.fetchModels({ force: true })).filter((m) => m.id.startsWith("opencode:"));
  const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
  ok("живой список подхвачен", catalog.length === 4, String(catalog.length));
  ok(
    "диалекты проставлены и в каталоге",
    byId["opencode:gpt-5.5"].endpoints.join() === "openai-response" &&
      byId["opencode:claude-opus-5"].endpoints.join() === "anthropic" &&
      byId["opencode:kimi-k3"].endpoints.join() === "openai",
    catalog.map((m) => `${m.id}=${m.endpoints.join()}`).join(" "),
  );
  // Окон хост не публикует, так что они приходят из семейных правил.
  ok("окно Claude 5 — миллион", byId["opencode:claude-opus-5"].contextWindow === 1_000_000, String(byId["opencode:claude-opus-5"].contextWindow));
  ok("окно kimi-k3 — миллион", byId["opencode:kimi-k3"].contextWindow === 1_048_576, String(byId["opencode:kimi-k3"].contextWindow));
  ok("Gemini выпал из рабочих", models.usableModels(catalog).some((m) => m.id === "opencode:gemini-3-flash") === false);
  ok("и объясняет, почему", models.incompatibleReason(byId["opencode:gemini-3-flash"]) === "native Gemini endpoint", models.incompatibleReason(byId["opencode:gemini-3-flash"]));
  // Вендор читается из имени модели: хост-перепродавец — не ответ на вопрос
  // «чья это модель».
  ok("вендор берётся из имени", models.vendorOf({ id: "opencode:claude-opus-5" }) === "Anthropic", models.vendorOf({ id: "opencode:claude-opus-5" }));

  // Каталог здесь публичный, так что успешный листинг ничего не доказывает:
  // логин, отрапортовавший «63 модели» на опечатку в ключе, не проверил ничего.
  const client = await import("../dist/provider/client.js");
  const good = await client.verifyProvider("opencode");
  ok("верный ключ принят", good.ok === true, good.detail);
  ok("проверка ушла на эндпоинт первой модели", probes[0] === "/responses", probes.join());
  ok("и называет себя TRCode", /^trcode\/\d/.test(sentHeaders[0]?.ua ?? ""), JSON.stringify(sentHeaders[0]));
  ok("и сессионный заголовок", Boolean(sentHeaders[0]?.session), JSON.stringify(sentHeaders[0]));
  // Free-тир Zen читает сам id: не свой формат `ses_<12 hex><14 base62>` —
  // и отказ, каким бы ни был ключ и тело.
  ok(
    "и в формате сессии opencode",
    /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(String(sentHeaders[0]?.session)),
    String(sentHeaders[0]?.session),
  );

  const { loginProvider } = await import("../dist/ui/login.js");
  const keyLogin = await loginProvider(registry.providerById("opencode"), {
    key: "sk-zen-key",
    exclusive: async () => { throw new Error("API-key login must not ask for an OAuth mode"); },
  });
  ok("Zen по умолчанию входит по ключу без выбора OAuth", keyLogin.connected && keyLogin.usable);
  ok("после входа сохранён режим API-ключа", creds.readCredentials("opencode")?.mode === "apikey");

  creds.writeCredentials("opencode", { mode: "apikey", accessToken: "sk-wrong" });
  const bad = await client.verifyProvider("opencode");
  ok("а неверный не принят", bad.ok === false && bad.status === 401, JSON.stringify(bad));

  zen.close();
  creds.clearCredentials("opencode");
  saveConfig({ apiKey: savedKey, providers: {} }, { replace: ["providers"] });
}

// ── OpenCode Go: тот же шлюз, другой ростер и другой раскол ───────────────
{
  const def = registry.providerById("opencode-go");
  ok("Go есть в реестре", Boolean(def));
  ok("короткое имя ведёт к нему", registry.providerById("go")?.id === "opencode-go");
  // Отдельная подписка с отдельным ключом — значит отдельный провайдер, иначе
  // одна из двух учёток вытеснила бы другую из файла.
  ok("Zen и Go — разные провайдеры", registry.providerById("zen")?.id === "opencode");

  creds.writeCredentials("opencode-go", { mode: "apikey", accessToken: "sk-go-key" });
  const auth = await registry.resolveAuth("opencode-go");
  ok("свой префикс пути", auth.baseUrl === "https://opencode.ai/zen/go/v1", auth.baseUrl);
  ok("оба заголовка и здесь", auth.headers.Authorization === "Bearer sk-go-key" && auth.headers["x-api-key"] === "sk-go-key");

  ok("Go подключается только по ключу", def.modes.oauth === undefined && def.oauth === undefined);
  await rejectLegacyOpenCodeLogin(def);
  creds.writeCredentials("opencode-go", { mode: "apikey", accessToken: "sk-go-key" });

  const go = (m) => registry.protocolForModel(`opencode-go:${m}`);
  ok("GPT и Grok → /responses", go("gpt-5.6-luna") === "responses" && go("grok-4.5") === "responses");
  ok("Qwen → /messages", go("qwen3.8-max") === "anthropic", go("qwen3.8-max"));
  ok("GLM, Kimi, DeepSeek → /chat/completions", go("glm-5.3") === "openai" && go("kimi-k3") === "openai" && go("deepseek-v4-pro") === "openai");
  // Ровно ради этого таблица живёт при режиме, а не одна на провайдера:
  // одна и та же модель у Go и у Zen приезжает по разным путям.
  creds.writeCredentials("opencode", { mode: "apikey", accessToken: "sk-zen-key" });
  ok(
    "MiniMax у Go и у Zen разведены",
    go("minimax-m3") === "anthropic" && registry.protocolForModel("opencode:minimax-m3") === "openai",
    `${go("minimax-m3")} / ${registry.protocolForModel("opencode:minimax-m3")}`,
  );
  creds.clearCredentials("opencode");

  // Лимиты плана считаются в долларах, так что опубликованные цены — это то,
  // чем /cost меряет подписку, а не украшение.
  saveConfig({ providers: { "opencode-go": { models: ["kimi-k3", "mimo-v2.5", "glm-5"] } } });
  const seeded = registry.seedModels("opencode-go", "apikey");
  const price = Object.fromEntries(seeded.map((m) => [m.id, m.pricing]));
  ok("цена kimi-k3 проставлена", price["opencode-go:kimi-k3"]?.output === 15, JSON.stringify(price["opencode-go:kimi-k3"]));
  // Кэшированный ввод у агентного хода — основная статья, и он считается по
  // своей цене, а не по цене свежего.
  ok("кэш считается отдельно", price["opencode-go:kimi-k3"]?.cachedInput === 0.3, String(price["opencode-go:kimi-k3"]?.cachedInput));
  ok("дешёвая модель дешёвая", price["opencode-go:mimo-v2.5"]?.input === 0.14, String(price["opencode-go:mimo-v2.5"]?.input));
  // Каталог отдаёт модели, которых нет в прайсе вендора: лучше не знать цену,
  // чем выдумать её.
  ok("непрайсованное остаётся без цены", price["opencode-go:glm-5"] === undefined, JSON.stringify(price["opencode-go:glm-5"]));
  saveConfig({ providers: {} }, { replace: ["providers"] });

  creds.clearCredentials("opencode-go");
}

// ── x-opencode-session: шлюз отказывает без него ──────────────────────────
// «Request is missing x-opencode-session and cannot be routed efficiently» —
// живой 400 от Go. Заголовок нужен ему, чтобы держать один разговор на одном
// бэкенде и попадать в прогретый там кэш префикса, так что проверяется не
// только наличие, но и стабильность значения.
{
  const seen = [];
  const go = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const session = req.headers["x-opencode-session"];
      seen.push({ session, ua: req.headers["user-agent"] });
      if (!session) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: { message: "Request is missing x-opencode-session and cannot be routed efficiently." },
          }),
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ок" } }] }));
    });
  });
  await new Promise((r) => go.listen(0, "127.0.0.1", r));

  const savedKey = loadConfig().apiKey;
  creds.writeCredentials("opencode-go", { mode: "apikey", accessToken: "sk-go-key" });
  saveConfig({ apiKey: "", providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${go.address().port}` } } });

  const client = await import("../dist/provider/client.js");
  const ask = (conversationId, first = "первый вопрос") =>
    client.complete({
      model: "opencode-go:kimi-k3",
      conversationId,
      messages: [
        { role: "system", content: "системный промпт" },
        { role: "user", content: first },
      ],
    });

  const first = await ask("sess-A");
  ok("запрос прошёл, а не упал на 400", first.content === "ок", JSON.stringify(first));
  ok("заголовок отправлен", Boolean(seen[0].session), String(seen[0].session));
  // Хосту незачем знать локальный id — он несёт в себе локальную дату.
  ok("но это не сам id сессии", seen[0].session !== "sess-A", seen[0].session);
  ok("клиент называет себя и версию", /^trcode\/\d/.test(seen[0].ua ?? ""), seen[0].ua);

  // Весь смысл — в стабильности: каждый шаг одного разговора должен попадать
  // на тот же бэкенд.
  await ask("sess-A", "второй вопрос");
  ok("тот же разговор — тот же тег", seen[1].session === seen[0].session, `${seen[0].session} / ${seen[1].session}`);

  await ask("sess-B");
  ok("другой разговор — другой тег", seen[2].session !== seen[0].session, seen[2].session);

  // Субагенту, компакту и генератору заголовка id никто не передаёт: их
  // различает собственный префикс промпта, который у каждого свой.
  await ask(undefined, "задача субагента");
  await ask(undefined, "задача субагента");
  await ask(undefined, "задача другого субагента");
  ok("без id тег берётся из префикса", seen[3].session === seen[4].session, `${seen[3].session} / ${seen[4].session}`);
  ok("и разные префиксы разводятся", seen[5].session !== seen[3].session, seen[5].session);
  ok("а с явным id не путаются", seen[3].session !== seen[0].session, seen[3].session);

  go.close();
  creds.clearCredentials("opencode-go");
  saveConfig({ apiKey: savedKey, providers: {} }, { replace: ["providers"] });
}

// ── tool-результат не несёт на провод поле name ───────────────────────────
// Живой 400 от Console Go: «messages[3]: "name" is not supported by this
// endpoint». Имя инструмента нужно нам самим — интерфейсу, trim и компакту, —
// но схема tool-сообщения его не знает, и строгий шлюз роняет весь запрос.
{
  let sent = null;
  const host = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      sent = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ок" } }] }));
    });
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));

  const savedKey = loadConfig().apiKey;
  creds.writeCredentials("opencode-go", { mode: "apikey", accessToken: "sk-go-key" });
  saveConfig({ apiKey: "", providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${host.address().port}` } } });

  const client = await import("../dist/provider/client.js");
  await client.complete({
    model: "opencode-go:kimi-k3",
    conversationId: "sess-name",
    messages: [
      { role: "user", content: "посмотри нагрузку" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", name: "bash", content: "load average: 12" },
    ],
  });

  const tool = sent.messages.find((m) => m.role === "tool");
  ok("tool-сообщение дошло", Boolean(tool), JSON.stringify(sent.messages));
  ok("но без поля name", tool && !("name" in tool), JSON.stringify(tool));
  ok("tool_call_id на месте", tool?.tool_call_id === "c1", JSON.stringify(tool));
  ok("ни одно сообщение не несёт name", sent.messages.every((m) => !("name" in m)), JSON.stringify(sent.messages));

  host.close();
  creds.clearCredentials("opencode-go");
  saveConfig({ apiKey: savedKey, providers: {} }, { replace: ["providers"] });
}

// ── 422 от строгой схемы тоже считается отказом от картинок ──────────────
// Живой ответ шлюза на tool-сообщение с content-массивом (read_image принёс
// скриншот): «HTTP 422 — [invalid_request_error] Input should be a valid
// string». Схема требует строку и до слова «image» не доходит — матчить надо
// статус, иначе ход умирает вместо того, чтобы уйти без пикселей.
{
  const seen = [];
  const host = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      if (!imageRefused) {
        imageRefused = true;
        res.writeHead(422, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "invalid_request_error", message: "Input should be a valid string" } }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ок" } }] }));
    });
  });
  let imageRefused = false;
  await new Promise((r) => host.listen(0, "127.0.0.1", r));

  const savedKey = loadConfig().apiKey;
  creds.writeCredentials("opencode-go", { mode: "apikey", accessToken: "sk-go-key" });
  saveConfig({ apiKey: "", providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${host.address().port}` } } });

  const client = await import("../dist/provider/client.js");
  const res = await client.complete({
    model: "opencode-go:kimi-k3",
    conversationId: "sess-422",
    messages: [
      { role: "user", content: "вот скрин" },
      {
        role: "tool",
        tool_call_id: "c9",
        content: "гифка в приложении",
        images: [{ data: "aW1n", mime: "image/png", width: 4, height: 4 }],
      },
    ],
  });

  ok("ход пережил 422", res.content === "ок", JSON.stringify(res.content));
  ok("запросов было два", seen.length === 2, String(seen.length));
  ok("пикселей во втором нет", !JSON.stringify(seen[1]).includes("aW1n"), "aW1n leaked");
  ok("и модель запомнена как брезгующая", client.modelStripsImages("opencode-go:kimi-k3"));

  host.close();
  creds.clearCredentials("opencode-go");
  saveConfig({ apiKey: savedKey, providers: {} }, { replace: ["providers"] });
}

// ── 400 «only text parts on the gRPC path» — пиксели режем только из tool ──
// Живой ответ шлюза на tool-сообщение с content-массивом: «HTTP 400 —
// Upstream request failed: [invalid_request_error] tool message content part 1
// is not text; only text parts are supported on the gRPC path». Слов «image» в
// нём нет, зато сказано, где именно: шлюз принимает скриншот, вставленный в
// чат, и отказывает только результату инструмента. Поэтому первый откат —
// снять пиксели с tool-сообщений, оставив историю пользователя нетронутой.
{
  const seen = [];
  let refused = false;
  const host = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      if (!refused) {
        refused = true;
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: {
              code: "invalid_request_error",
              message:
                "Upstream request failed: [invalid_request_error] tool message content part 1 is not text; only text parts are supported on the gRPC path (request_id: gw-7000a4e4d1bd-bc526)",
            },
          }),
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ок" } }] }));
    });
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));

  const savedKey = loadConfig().apiKey;
  creds.writeCredentials("opencode-go", { mode: "apikey", accessToken: "sk-go-key" });
  saveConfig({ apiKey: "", providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${host.address().port}` } } });

  const client = await import("../dist/provider/client.js");
  const model = "opencode-go:glm-5.3-flash";
  const pasted = { data: "dXNlcg", mime: "image/png", width: 4, height: 4 };
  const shot = { data: "dG9vbA", mime: "image/png", width: 4, height: 4 };
  const messages = [
    { role: "user", content: "вот скрин", images: [pasted] },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c10", type: "function", function: { name: "read_image", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c10", name: "read_image", content: "гифка в приложении", images: [shot] },
  ];

  const res = await client.complete({ model, conversationId: "sess-grpc", messages });
  const second = seen[1] ?? {};
  const secondJson = JSON.stringify(second);
  const toolMsgs = (second.messages ?? []).filter((m) => m.role === "tool");
  const hoisted = (second.messages ?? []).find(
    (m) => m.role === "user" && JSON.stringify(m.content ?? "").includes("dG9vbA"),
  );

  ok("ход пережил 400 gRPC-пути", res.content === "ок", JSON.stringify(res.content));
  ok("запросов было два", seen.length === 2, String(seen.length));
  ok("tool-сообщение стало чистым текстом", toolMsgs.length > 0 && toolMsgs.every((m) => typeof m.content === "string"), JSON.stringify(toolMsgs[0]?.content));
  ok("пиксели инструмента не потеряны, а перенесены", Boolean(hoisted), secondJson.slice(0, 160));
  ok("перенос подписан именем инструмента", /Output of|tool result/i.test(JSON.stringify(hoisted?.content ?? "")), JSON.stringify(hoisted?.content));
  ok("вставленный скриншот остался", secondJson.includes("dXNlcg"), "dXNlcg stripped");
  ok("модель не сочли слепой: пиксели дошли", !client.modelStripsImages(model));

  const again = await client.complete({ model, conversationId: "sess-grpc", messages });
  const third = seen[2] ?? {};
  ok("следующий ход не платит за 400", again.content === "ок" && seen.length === 3, String(seen.length));
  ok(
    "перенос работает и в следующем ходе",
    (third.messages ?? []).filter((m) => m.role === "tool").every((m) => typeof m.content === "string") &&
      JSON.stringify(third).includes("dG9vbA") &&
      JSON.stringify(third).includes("dXNlcg"),
    JSON.stringify(third).slice(0, 160),
  );

  host.close();
  creds.clearCredentials("opencode-go");
  saveConfig({ apiKey: savedKey, providers: {} }, { replace: ["providers"] });
}

// ── 400 про reasoning_content — не повод выключать бюджет навсегда ───────
// Отказ DeepSeek-овского thinking mode на проводе звучит как «The
// `reasoning_content` в thinking mode должен быть возвращён» и содержит слово
// reasoning. Прочитанный как жалоба на параметр бюджета, он записывал в конфиг
// «модель не берёт reasoning-параметр» — и после этого бюджет молча не
// отправлялся никогда, а футер продолжал показывать уровень.
{
  const seen = [];
  const host = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "invalid_request_error",
            message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
          },
        }),
      );
    });
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));

  const savedKey = loadConfig().apiKey;
  creds.writeCredentials("opencode-go", { mode: "apikey", accessToken: "sk-go-key" });
  saveConfig({ apiKey: "", providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${host.address().port}` } } });

  const client = await import("../dist/provider/client.js");
  const model = "opencode-go:passback-probe";
  let thrown = null;
  try {
    await client.complete({ model, conversationId: "sess-passback", effort: "high", messages: [{ role: "user", content: "hi" }] });
  } catch (err) {
    thrown = err;
  }

  ok("отказ всё равно возвращается наверх", thrown?.status === 400, String(thrown?.status));
  // Один ресенд на обучение passback — и всё: второй отказ не считается
  // жалобой на бюджет и не превращается в третью попытку без параметра.
  ok("лишних запросов не было", seen.length === 2, String(seen.length));
  ok(
    "бюджет уходил в каждом запросе",
    seen.every((b) => b.reasoning_effort === "high"),
    JSON.stringify(seen.map((b) => b.reasoning_effort)),
  );
  ok("и модель не записана как брезгующая", !client.modelRejectsEffort(model));

  host.close();
  creds.clearCredentials("opencode-go");
  saveConfig({ apiKey: savedKey, providers: {} }, { replace: ["providers"] });
}

// ── the authorize URL has to survive the shell ────────────────────────────
{
  const { browserCommand } = await import("../dist/ui/login.js");
  const url = "https://claude.ai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz";

  const win = browserCommand(url, "win32");
  ok("Windows открывает через cmd start", win.cmd === "cmd" && win.args.slice(0, 3).join(" ") === "/c start ");
  // cmd treats a bare & as a statement separator: the URL would arrive cut at
  // ?code=true and the page would report a missing client_id.
  ok("амперсанды экранированы для cmd", !/[^^]&/.test(win.args[3]), win.args[3]);
  ok("сам URL не искажён", win.args[3].replace(/\^&/g, "&") === url, win.args[3]);

  ok("macOS — open", browserCommand(url, "darwin").args[0] === url);
  ok("остальные — xdg-open", browserCommand(url, "linux").cmd === "xdg-open");

  // On Windows the claim is checkable: run the escaped argument through cmd.
  if (process.platform === "win32") {
    const { spawnSync } = await import("node:child_process");
    const back = spawnSync("cmd", ["/c", "echo", win.args[3]], { encoding: "utf8" }).stdout.trim();
    ok("cmd отдаёт URL целиком", back === url, back);
    const naive = spawnSync("cmd", ["/c", "echo", url], { encoding: "utf8" }).stdout.trim();
    ok("без экранирования cmd его резал", naive !== url && naive.endsWith("code=true"), naive);
  }
}

// ── device flow, end to end ───────────────────────────────────────────────
const seen = [];
let polls = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    seen.push({ url: req.url, contentType: req.headers["content-type"], params, ua: req.headers["user-agent"] });
    const send = (code, payload) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/device") {
      return send(200, {
        device_code: "dev-code",
        user_code: "WXYZ-1234",
        verification_uri: "https://auth.test/activate",
        verification_uri_complete: "https://auth.test/activate?code=WXYZ-1234",
        expires_in: 600,
        interval: 1,
      });
    }
    if (params.grant_type === "refresh_token") {
      return send(200, { access_token: "refreshed-token", expires_in: 900 });
    }
    // First poll: the user has not approved yet.
    if (polls++ === 0) return send(400, { error: "authorization_pending" });
    return send(200, { access_token: "granted-token", refresh_token: "granted-refresh", expires_in: 900 });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const flow = {
  clientId: "test-client",
  deviceAuthUrl: `${base}/device`,
  tokenUrl: `${base}/token`,
  headers: { "User-Agent": "kimi-code/test" },
};

const code = await oauth.requestDeviceCode(flow);
ok("device code получен", code.deviceCode === "dev-code" && code.userCode === "WXYZ-1234");
ok("предзаполненная ссылка сохранена", code.verificationUriComplete.includes("WXYZ-1234"));
ok("интервал уважается", code.interval === 1);
ok("тело формой, как в RFC 8628", seen[0].contentType === "application/x-www-form-urlencoded", seen[0].contentType);
ok("client_id отправлен", seen[0].params.client_id === "test-client");
ok("заголовки флоу дошли", seen[0].ua === "kimi-code/test");

// Relative device-flow links are resolved against the issuing host.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        device_code: "d",
        user_code: "TRKG-HPRJ",
        verification_uri: "/device",
        verification_uri_complete: "/device?user_code=TRKG-HPRJ&client_id=test-client",
        expires_in: 600,
        interval: 5,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  try {
    let sent = "";
    const fetchRel = globalThis.fetch;
    globalThis.fetch = async (url, init) => ((sent = String(init?.body ?? "")), fetchRel(url, init));
    const rel = await oauth.requestDeviceCode({ ...flow, deviceAuthUrl: "https://example.test/auth/device", params: { extra: "value" } });
    globalThis.fetch = fetchRel;
    ok("дополнительные параметры переданы", new URLSearchParams(sent).get("extra") === "value", sent);
    ok("относительная ссылка достроена до хоста", rel.verificationUri === "https://example.test/device", rel.verificationUri);
    ok(
      "и предзаполненная тоже",
      rel.verificationUriComplete === "https://example.test/device?user_code=TRKG-HPRJ&client_id=test-client",
      rel.verificationUriComplete,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

const granted = await oauth.pollForToken(flow, code);
ok("authorization_pending не считается ошибкой", polls === 2, `опросов: ${polls}`);
ok("токен получен", granted.accessToken === "granted-token" && granted.refreshToken === "granted-refresh");
ok("срок жизни абсолютный", granted.expiresAt > Date.now() + 800_000);
ok("grant_type по RFC", seen[1].params.grant_type === "urn:ietf:params:oauth:grant-type:device_code");

const rolled = await oauth.refreshToken(flow, granted);
ok("refresh отдаёт новый access", rolled.accessToken === "refreshed-token");
// Hosts that do not rotate the refresh token expect the old one to keep working.
ok("старый refresh сохранён, если новый не прислан", rolled.refreshToken === "granted-refresh");

let denied = "";
try {
  await oauth.refreshToken(flow, { mode: "oauth", accessToken: "x" });
} catch (err) {
  denied = err.code;
}
ok("refresh без токена — внятная ошибка", denied === "no_refresh_token", denied);

server.close();

// ── renewRejectedToken: хост отозвал токен до срока ───────────────────────
// По часам токен свежий, isStale его не тронет — обновить может только
// принудительный путь, который дергается после 401 от хоста.
creds.writeCredentials("kimi", {
  mode: "oauth",
  accessToken: "revoked-token",
  refreshToken: "still-good-refresh",
  expiresAt: Date.now() + 3600_000,
});
const realFetch = globalThis.fetch;
let refreshCalls = 0;
globalThis.fetch = async () => {
  refreshCalls++;
  return new Response(JSON.stringify({ access_token: "renewed-token", expires_in: 900 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
try {
  const renewed = await registry.renewRejectedToken("kimi");
  ok("отозванный до срока токен обновлён принудительно", renewed === true);
  ok("refresh сходил на token-endpoint один раз", refreshCalls === 1, String(refreshCalls));
  const after = creds.readCredentials("kimi");
  ok("новый access сохранён на диск", after?.accessToken === "renewed-token", after?.accessToken);
  ok("refresh-токен не потерян", after?.refreshToken === "still-good-refresh");
} finally {
  globalThis.fetch = realFetch;
}

// Когда обновлять нечем, ответ — false без похода в сеть: 401 остаётся 401.
creds.writeCredentials("kimi", { mode: "apikey", accessToken: "sk-platform-key" });
ok("api-ключ не «обновляется»", (await registry.renewRejectedToken("kimi")) === false);
ok("tokenrouter без oauth — false", (await registry.renewRejectedToken("tokenrouter")) === false);

// ── Google Gemini: public API keys only ──────────────────────────────────
{
  const def = registry.providerById("gemini");
  ok("Gemini uses API keys only", def.modes.oauth === undefined && def.oauth === undefined);
  ok("Gemini does not import vendor sessions", def.importFrom === undefined);
  ok("Gemini uses the public compatibility endpoint", def.modes.apikey.baseUrl === "https://generativelanguage.googleapis.com/v1beta/openai");
  creds.writeCredentials("gemini", { mode: "oauth", accessToken: "legacy-gemini", refreshToken: "legacy-refresh", expiresAt: Date.now() - 1 });
  ok("Legacy Gemini sessions are disconnected", registry.modeFor("gemini") === null);
  let error = "";
  try { await registry.resolveAuth("gemini"); } catch (err) { error = err.message; }
  ok("Legacy Gemini login asks for an API key", error.includes("auth login --provider gemini --key"), error);
  ok("Gemini never refreshes vendor OAuth", (await registry.renewRejectedToken("gemini")) === false);
  creds.writeCredentials("gemini", { mode: "apikey", accessToken: "gemini-api-key" });
  const auth = await registry.resolveAuth("gemini");
  ok("Gemini key is sent as Bearer", auth.headers.Authorization === "Bearer gemini-api-key");
  ok("Gemini does not impersonate Gemini CLI", auth.headers["User-Agent"] === undefined);
  ok("Gemini uses chat completions", registry.protocolForModel("gemini:gemini-3.8-flash") === "openai");
  creds.clearCredentials("gemini");
}

// ── OpenAI: public API and its own ChatGPT client registration ────────────
{
  const def = registry.providerById("openai");
  ok("OpenAI and ChatGPT share one provider", registry.providerById("chatgpt")?.id === "openai");
  ok("Both OpenAI modes use the public API", def.modes.apikey.baseUrl === "https://api.openai.com/v1" && def.modes.oauth.baseUrl === "https://api.openai.com/v1");
  ok("ChatGPT registers the actual app", def.oauth.clientId === "dynamic_agent_client");
  ok("ChatGPT uses a free loopback port", def.oauth.redirectUri === "http://127.0.0.1:{port}/auth/callback");
  ok("ChatGPT requests direct plan permission", def.oauth.scope.includes("chatgpt.tokens.use.direct"));
  creds.writeCredentials("openai", { mode: "oauth", accessToken: "legacy-codex", refreshToken: "legacy-refresh", expiresAt: Date.now() - 1 });
  ok("Legacy Codex tokens are disconnected", registry.modeFor("openai") === null);
  let error = "";
  try { await registry.resolveAuth("openai"); } catch (err) { error = err.message; }
  ok("Legacy Codex tokens require TRCode sign-in", error.includes("TRCode's own registration"), error);
  creds.writeCredentials("openai", { mode: "apikey", accessToken: "openai-api-key" });
  const auth = await registry.resolveAuth("openai");
  ok("OpenAI API key still works", auth.headers.Authorization === "Bearer openai-api-key");
  ok("OpenAI API key uses Responses", registry.protocolForModel("openai:gpt-6.1-sol") === "responses");
  creds.clearCredentials("openai");
}

// ── 503 «Endpoint is unavailable» переживается сам ─────────────────────────
// Живой случай: прокси на минуту отдал 503 Upstream request failed, а клиент
// сдался через три быстрых попытки и вернул ошибку — человеку пришлось вручную
// повторять тот же промпт. Теперь попыток десять с паузой в десять секунд, и
// каждая пауза объявляется в колбэк, чтобы терминал не выглядел зависшим.
{
  const cfgNow = loadConfig();
  ok(
    "по умолчанию десять попыток по десять секунд",
    cfgNow.upstreamRetries === 10 && cfgNow.upstreamRetryDelayMs === 10_000,
    `${cfgNow.upstreamRetries}/${cfgNow.upstreamRetryDelayMs}`,
  );

  const realFetch = globalThis.fetch;
  const savedKey = loadConfig().apiKey;
  const waits = [];
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts <= 3) {
      return new Response(
        JSON.stringify({ error: { message: "Upstream request failed: Endpoint is unavailable." } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ок" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  saveConfig({ apiKey: "sk-test", upstreamRetries: 10, upstreamRetryDelayMs: 1 });
  try {
    const client = await import("../dist/provider/client.js");
    const res = await client.complete({
      model: "gpt-5.3-codex",
      messages: [{ role: "user", content: "привет" }],
      onRetryWait: (waitMs, attempt, of, said) => waits.push({ waitMs, attempt, of, said }),
    });
    ok("503 переживается сам, ответ доходит", res.content === "ок", JSON.stringify(res));
    ok("четыре запроса: отказ и три повтора", attempts === 4, String(attempts));
    ok("пауза объявлена трижды", waits.length === 3, JSON.stringify(waits));
    ok("номера попыток по порядку", waits.map((w) => w.attempt).join(",") === "1,2,3", JSON.stringify(waits));
    ok("счётчик знает предел", waits.every((w) => w.of === 10), JSON.stringify(waits[0]));
    ok("причина названа", /Endpoint is unavailable/.test(waits[0].said), waits[0].said);
  } finally {
    globalThis.fetch = realFetch;
    saveConfig({ apiKey: savedKey, upstreamRetries: 10, upstreamRetryDelayMs: 10_000 });
  }

  // Исчерпанные попытки — это по-прежнему ошибка, а не бесконечное ожидание.
  attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(JSON.stringify({ error: { message: "Upstream request failed: Endpoint is unavailable." } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  };
  saveConfig({ apiKey: "sk-test", upstreamRetries: 2, upstreamRetryDelayMs: 1 });
  try {
    const client = await import("../dist/provider/client.js");
    let failed = null;
    try {
      await client.complete({ model: "gpt-5.3-codex", messages: [{ role: "user", content: "привет" }] });
    } catch (err) {
      failed = err;
    }
    ok("после лимита ошибка возвращается", failed?.status === 503, String(failed?.status));
    ok("и запросов ровно на одну попытку больше", attempts === 3, `${attempts} / ${failed?.message}`);
  } finally {
    globalThis.fetch = realFetch;
    saveConfig({ apiKey: savedKey, upstreamRetries: 10, upstreamRetryDelayMs: 10_000 });
  }
}

// ── cleanup ───────────────────────────────────────────────────────────────
try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* Windows may hold the directory briefly; the temp dir is disposable */
}

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok || !t.detail ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
process.exit(failed ? 1 : 0);
