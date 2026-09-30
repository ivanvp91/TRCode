/**
 * generate_video against a local stand-in for OpenRouter's /videos API:
 * submit → pending → in_progress → completed → download, plus the failure,
 * refusal and no-key paths. No network, no account.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-video-"));
process.env.TRCODE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { saveConfig } = await import("../dist/config.js");
const creds = await import("../dist/provider/credentials.js");
const { makeGenerateVideoTool, videoAvailable, apiMessage, fetchVideoModels } = await import("../dist/tools/video.js");
const vm = await import("../dist/agent/videomode.js");
const { buildSystemPrompt } = await import("../dist/agent/prompt.js");
const { buildTools, TodoStore } = await import("../dist/tools/index.js");

const MP4 = Buffer.from("fake-mp4-bytes");
const seen = { submit: null, auth: [], polls: 0 };
let failNext = false;

const server = http.createServer((req, res) => {
  seen.auth.push(req.headers.authorization);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "POST" && req.url === "/api/v1/videos") {
      seen.submit = JSON.parse(body);
      seen.polls = 0;
      return json(202, { id: failNext ? "bad1" : "job1", status: "pending" });
    }
    if (req.url === "/api/v1/videos/job1") {
      seen.polls++;
      if (seen.polls < 2) return json(200, { id: "job1", status: "in_progress" });
      return json(200, {
        id: "job1",
        status: "completed",
        unsigned_urls: [`http://127.0.0.1:${port}/api/v1/videos/job1/content?index=0`],
        usage: { cost: 0.42 },
      });
    }
    if (req.url === "/api/v1/videos/models") {
      return json(200, { data: [
        { id: "bytedance/seedance-2.5", name: "Seedance 2.5", supported_durations: [4, 5, 6, 7, 8, 9, 10], supported_resolutions: ["480p", "720p"],
          supported_aspect_ratios: ["16:9", "9:16"], supported_frame_images: ["first_frame", "last_frame"], generate_audio: true,
          pricing_skus: { duration_seconds_480p: "0.05", duration_seconds_720p: "0.1" } },
        { id: "google/veo-3.1", supported_durations: [4, 6, 8], pricing_skus: { cents_per_second_output: "40" } },
      ] });
    }
    if (req.url === "/api/v1/videos/bad1") return json(200, { id: "bad1", status: "failed", error: "Content policy violation" });
    if (req.url === "/api/v1/videos/job1/content?index=0") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      return res.end(MP4);
    }
    json(404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const ctx = (allow = true) => ({
  cwd: HOME, signal: new AbortController().signal, depth: 0,
  confirm: async () => allow, emit: () => {}, readFiles: new Set(),
});
const tool = makeGenerateVideoTool({ pollMs: 10 });
const registry = () => buildTools({ skills: [], todo: new TodoStore(), onTodoChange: () => {} }).map((t) => t.name);

// ── no key: the tool is not offered, and a direct call explains why ────────
ok("без ключа OpenRouter инструмента нет", !videoAvailable() && !registry().includes("generate_video"));
{
  const r = await tool.run({ prompt: "x" }, ctx());
  ok("без ключа — понятная ошибка", r.isError && /auth login --provider openrouter/.test(r.output), r.output);
}

creds.writeCredentials("openrouter", { mode: "apikey", accessToken: "sk-or-test" });
saveConfig({ providers: { openrouter: { baseUrl: `http://127.0.0.1:${port}/api/v1` } } });
ok("с ключом инструмент в наборе", registry().includes("generate_video"), registry().join(","));

// ── refusal sends nothing ─────────────────────────────────────────────────
{
  const r = await tool.run({ prompt: "a fox" }, ctx(false));
  ok("отказ не отправляет задачу", r.isError && seen.submit === null, r.output);
}

// ── happy path, with a local first frame ──────────────────────────────────
{
  fs.writeFileSync(path.join(HOME, "frame.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = await tool.run(
    { prompt: "A red fox in snow", duration: 8, aspect_ratio: "9:16", first_frame: "frame.png", out: "out/fox.mp4" },
    ctx(),
  );
  ok("успех", !r.isError, r.output);
  ok("модель по умолчанию — seedance-2.5", seen.submit?.model === "bytedance/seedance-2.5", JSON.stringify(seen.submit));
  ok("параметры дошли", seen.submit?.duration === 8 && seen.submit?.aspect_ratio === "9:16", JSON.stringify(seen.submit));
  ok("непрошенное не подставляется", !("resolution" in (seen.submit ?? {})) && !("generate_audio" in (seen.submit ?? {})));
  const f = seen.submit?.frame_images?.[0];
  ok("первый кадр как data URL", f?.frame_type === "first_frame" && /^data:image\/png;base64,/.test(f?.image_url?.url ?? ""), JSON.stringify(f));
  ok("ключ в каждом запросе", seen.auth.every((a) => a === "Bearer sk-or-test"), seen.auth.join(","));
  const saved = path.join(HOME, "out", "fox.mp4");
  ok("mp4 скачан", fs.existsSync(saved) && fs.readFileSync(saved).equals(MP4));
  ok("стоимость в ответе", /\$0\.420/.test(r.output), r.output);
}

// ── failed job ────────────────────────────────────────────────────────────
{
  failNext = true;
  const r = await tool.run({ prompt: "x" }, ctx());
  ok("failed → ошибка с причиной", r.isError && /Content policy violation/.test(r.output), r.output);
  failNext = false;
}

// ── configured video model is the default ─────────────────────────────────
{
  saveConfig({ videoModel: "google/veo-3.1" });
  const t2 = makeGenerateVideoTool({ pollMs: 10 });
  ok("описание называет выбранную модель", t2.description.includes("google/veo-3.1"), t2.description.slice(0, 120));
  await t2.run({ prompt: "x", out: "v2.mp4" }, ctx());
  ok("по умолчанию берётся модель из конфига", seen.submit?.model === "google/veo-3.1", seen.submit?.model);
  saveConfig({ videoModel: "" });
}

// ── nested provider error is unwrapped ────────────────────────────────────
{
  const raw = JSON.stringify({ error: { message: 'HTTP 400: {"error":{"code":"InvalidParameter","message":"The parameter resolution is invalid"}}' } });
  const m = apiMessage(raw);
  ok("вложенная ошибка развёрнута", m === "InvalidParameter: The parameter resolution is invalid", m);
  ok("не-JSON остаётся как есть", apiMessage("Bad Gateway") === "Bad Gateway");
}

// ── catalogue, capabilities, system-prompt section ────────────────────────
{
  const models = await fetchVideoModels(true);
  ok("каталог прочитан", models.length === 2 && models[0].id === "bytedance/seedance-2.5", JSON.stringify(models.map((m) => m.id)));
  ok("возможности одной строкой", vm.capsLine(models[0]) === "4–10 s · 480p/720p · 16:9 9:16 · frames: first_frame+last_frame · audio", vm.capsLine(models[0]));
  ok("цена за секунду", vm.priceLine(models[0]) === "from $0.05/s" && vm.priceLine(models[1]) === "$0.40/s", vm.priceLine(models[0]) + " | " + vm.priceLine(models[1]));

  const plain = buildSystemPrompt({ cwd: HOME, model: "m", skills: [] });
  ok("без режима секции нет", !plain.includes("<video-mode>"));
  vm.enterVideoMode({ previousModel: "old", caps: models[0] });
  const on = buildSystemPrompt({ cwd: HOME, model: "m", skills: [] });
  ok("в режиме секция есть", on.includes("<video-mode>") && on.includes("Video model: openrouter:bytedance/seedance-2.5"));
  ok("допустимые значения переданы", on.includes("duration (s): 4, 5, 6, 7, 8, 9, 10; resolution: 480p, 720p"));
  ok("субагент секцию не получает", !buildSystemPrompt({ cwd: HOME, model: "m", skills: [], subagent: true }).includes("<video-mode>"));
  ok("выход возвращает прежнюю модель", vm.leaveVideoMode() === "old" && !vm.isVideoMode());
}

// ── bad frame path ────────────────────────────────────────────────────────
{
  const r = await tool.run({ prompt: "x", last_frame: "nope.png" }, ctx());
  ok("несуществующий кадр отклонён", r.isError && /last_frame: file not found/.test(r.output), r.output);
}

// fetch keeps sockets alive; exiting over them trips a libuv assert on Windows.
server.closeAllConnections();
await new Promise((r) => server.close(r));
fs.rmSync(HOME, { recursive: true, force: true });

let failed = 0;
for (const r of results) {
  if (r.ok) console.log("  ok   " + r.name);
  else { failed++; console.log("  FAIL " + r.name + (r.detail ? "\n       " + r.detail : "")); }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
