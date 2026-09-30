/**
 * Media generation across providers, against one local stand-in that answers
 * as OpenRouter, TokenRouter (new-api), xAI and Z.AI under separate prefixes:
 * which models each offers, how an id is spelled, and that image, video and
 * audio each reach the right route with the right shape. No network.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const results = [];
const ok = (name, cond, detail = "") => results.push({ name, ok: Boolean(cond), detail });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trcode-media-"));
process.env.TRCODE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.TOKENROUTER_API_KEY;
delete process.env.TR_API_KEY;
delete process.env.TOKENROUTER_BASE_URL;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MP4 = Buffer.from("....ftypisom-fake-video");
const PCM = Buffer.alloc(4800, 7);
const seen = [];
let pollCount = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = req.url;
    seen.push({ method: req.method, url: u, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const base = `http://127.0.0.1:${port}`;
    // ── OpenRouter
    if (u === "/or/api/v1/images/models") return json(200, { data: [{ id: "bytedance-seed/seedream-4.5", supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9"] } } }] });
    if (u === "/or/api/v1/videos/models") return json(200, { data: [{ id: "bytedance/seedance-2.5", supported_durations: [5, 10] }] });
    if (u === "/or/api/v1/images") return json(200, { data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }], usage: { cost: 0.03 } });
    if (u === "/or/api/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const b64 = PCM.toString("base64");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: b64.slice(0, 400), transcript: "Привет" } } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: b64.slice(400), transcript: ", мир" } } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    // ── TokenRouter (new-api)
    if (u === "/tr/v1/images/generations") return json(200, { data: [{ url: `${base}/cdn/pic.png` }] });
    if (u === "/tr/v1/video/generations") return json(200, { task_id: "tr-task-1", status: "queued" });
    if (u === "/tr/v1/video/generations/tr-task-1") {
      pollCount++;
      return pollCount < 2
        ? json(200, { code: "success", data: { task_id: "tr-task-1", status: "IN_PROGRESS" } })
        : json(200, { code: "success", data: { task_id: "tr-task-1", status: "SUCCESS", result_url: `${base}/cdn/clip.mp4` } });
    }
    // ── xAI
    if (u === "/xai/v1/images/edits") return json(200, { data: [{ url: `${base}/cdn/pic.png` }] });
    if (u === "/xai/v1/videos/generations") return json(200, { request_id: "x-1" });
    if (u === "/xai/v1/videos/x-1") return json(200, { status: "done", video: { url: `${base}/cdn/clip.mp4` } });
    // ── Z.AI (media on the open-platform path, not the coding one)
    if (u === "/zai/api/paas/v4/images/generations") return json(200, { data: [{ url: `${base}/cdn/pic.png` }] });
    if (u === "/zai/api/paas/v4/videos/generations") return json(200, { id: "z-1", task_status: "PROCESSING" });
    if (u === "/zai/api/paas/v4/async-result/z-1") return json(200, { task_status: "FAIL", error: { message: "sensitive content" } });
    // ── CDN
    if (u === "/cdn/pic.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PNG);
    }
    if (u === "/cdn/clip.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      return res.end(MP4);
    }
    json(404, { error: { message: `no route ${u}` } });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const B = `http://127.0.0.1:${port}`;

const { saveConfig } = await import("../dist/config.js");
const creds = await import("../dist/provider/credentials.js");
creds.writeCredentials("openrouter", { mode: "apikey", accessToken: "sk-or" });
creds.writeCredentials("xai", { mode: "apikey", accessToken: "xai-key" });
creds.writeCredentials("zai", { mode: "apikey", accessToken: "zai-key" });
saveConfig({
  apiKey: "tr-key",
  baseUrl: `${B}/tr/v1`,
  providers: {
    openrouter: { baseUrl: `${B}/or/api/v1` },
    xai: { baseUrl: `${B}/xai/v1` },
    zai: { baseUrl: `${B}/zai/api/coding/paas/v4` },
  },
});

const mm = await import("../dist/tools/mediamodels.js");
const { makeGenerateImageTool } = await import("../dist/tools/imagegen.js");
const { makeGenerateVideoTool } = await import("../dist/tools/video.js");
const audio = await import("../dist/tools/audiogen.js");
const { buildTools, TodoStore } = await import("../dist/tools/index.js");

const ctx = () => ({
  cwd: HOME, signal: new AbortController().signal, depth: 0,
  confirm: async () => true, emit: () => {}, readFiles: new Set(),
});
const tools = () => buildTools({ skills: [], todo: new TodoStore(), onTodoChange: () => {} }).map((t) => t.name);
const last = (frag) => [...seen].reverse().find((r) => r.url.includes(frag));

// ── ids ───────────────────────────────────────────────────────────────────
{
  ok("id с провайдером разбирается", JSON.stringify(mm.parseMediaId("tokenrouter:kling-v3")) === JSON.stringify({ providerId: "tokenrouter", model: "kling-v3" }));
  ok("голый id — OpenRouter (как раньше)", mm.parseMediaId("bytedance/seedance-2.5").providerId === "openrouter");
  ok("алиас провайдера понимается", mm.parseMediaId("grok:grok-imagine-video").providerId === "xai");
  ok("пул ↔ хранение: TokenRouter", mm.toPoolId("tokenrouter:kling-v3") === "kling-v3" && mm.fromPoolId("kling-v3") === "tokenrouter:kling-v3");
  ok("видео по умолчанию — Seedance на OpenRouter", mm.mediaModelId("video") === "openrouter:bytedance/seedance-2.5");
  ok("без выбора картинок и звука инструментов нет", !tools().includes("generate_image") && !tools().includes("generate_audio"));
}

// ── pools ─────────────────────────────────────────────────────────────────
{
  const catalog = [
    { id: "gpt-5", endpoints: ["openai"], modality: "text", chatCapable: true },
    { id: "kling-v3", endpoints: ["video-generation", "video-fetch"], modality: "video", modalities: ["video"], chatCapable: false },
    { id: "bytedance-seed/seedream-4.5", endpoints: ["image-generation"], modality: "image", modalities: ["image"], chatCapable: false },
    { id: "openai/gpt-audio", endpoints: ["audio-chat"], modality: "audio", modalities: ["text", "audio"], chatCapable: false },
    { id: "openrouter:openai/gpt-audio-mini", modality: "audio", modalities: ["text", "audio"], chatCapable: false },
  ];
  const img = await mm.mediaPool("image", catalog);
  const ids = img.models.map((m) => m.id);
  ok("картинки: OpenRouter из его каталога", ids.includes("openrouter:bytedance-seed/seedream-4.5"), ids.join(","));
  ok("картинки: TokenRouter по типу эндпоинта", ids.includes("bytedance-seed/seedream-4.5"));
  ok("картинки: xAI и Z.AI из списка", ids.includes("xai:grok-imagine-image-2.0") && ids.includes("zai:glm-image"));
  ok("возможности в подсказке", img.hints.get("openrouter:bytedance-seed/seedream-4.5") === "1:1 16:9", img.hints.get("openrouter:bytedance-seed/seedream-4.5"));
  const vid = (await mm.mediaPool("video", catalog)).models.map((m) => m.id);
  ok("видео: все четыре хоста", ["openrouter:bytedance/seedance-2.5", "kling-v3", "xai:grok-imagine-video-1.5", "zai:cogvideox-3"].every((x) => vid.includes(x)), vid.join(","));
  const aud = (await mm.mediaPool("audio", catalog)).models.map((m) => m.id);
  ok("аудио: TokenRouter и OpenRouter", aud.includes("openai/gpt-audio") && aud.includes("openrouter:openai/gpt-audio-mini"), aud.join(","));
  ok("текстовые модели в пул не попадают", !vid.includes("gpt-5") && !ids.includes("gpt-5"));

  creds.writeCredentials("xai", { mode: "oauth", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
  const noX = (await mm.mediaPool("image", catalog)).models.map((m) => m.id);
  ok("подписка Grok (OAuth) медиа не даёт", !noX.some((x) => x.startsWith("xai:")));
  creds.writeCredentials("xai", { mode: "apikey", accessToken: "xai-key" });
}

// ── images ────────────────────────────────────────────────────────────────
{
  saveConfig({ imageModel: "openrouter:bytedance-seed/seedream-4.5" });
  ok("с выбранной моделью инструмент в чате", tools().includes("generate_image"));
  let r = await makeGenerateImageTool().run({ prompt: "a fox", aspect_ratio: "16:9", quality: "high", out: "img/or.png" }, ctx());
  ok("OpenRouter: картинка сохранена", !r.isError && fs.readFileSync(path.join(HOME, "img/or.png")).equals(PNG), r.output);
  ok("OpenRouter: неподдержанное отброшено с пометкой", !("quality" in last("/or/api/v1/images").body) && /Ignored.*quality/.test(r.output), r.output);
  r = await makeGenerateImageTool().run({ prompt: "x", aspect_ratio: "4:3" }, ctx());
  ok("OpenRouter: недопустимое значение — ошибка со списком", r.isError && /use one of: 1:1, 16:9/.test(r.output), r.output);

  saveConfig({ imageModel: "tokenrouter:bytedance-seed/seedream-4.5" });
  r = await makeGenerateImageTool().run({ prompt: "a fox", size: "2K", out: "img/tr.png" }, ctx());
  const tr = last("/tr/v1/images/generations");
  ok("TokenRouter: /images/generations с его ключом", tr?.auth === "Bearer tr-key" && tr.body.model === "bytedance-seed/seedream-4.5" && tr.body.size === "2K", JSON.stringify(tr));
  ok("TokenRouter: ссылка скачана без ключа", !r.isError && last("/cdn/pic.png").auth === undefined, r.output);

  saveConfig({ imageModel: "xai:grok-imagine-image-2.0" });
  fs.writeFileSync(path.join(HOME, "src.png"), PNG);
  r = await makeGenerateImageTool().run({ prompt: "make it blue", references: ["src.png"], size: "1024x1024" }, ctx());
  const xe = last("/xai/v1/images/edits");
  ok("xAI: правка идёт на /images/edits с картинкой", !r.isError && /^data:image\/png;base64,/.test(xe?.body?.image?.url ?? ""), r.output);
  ok("xAI: чего хост не берёт, то отброшено", !("size" in xe.body) && /Ignored.*size/.test(r.output), r.output);

  saveConfig({ imageModel: "zai:glm-image" });
  r = await makeGenerateImageTool().run({ prompt: "a fox", quality: "hd" }, ctx());
  ok("Z.AI: запрос на open-platform путь", !r.isError && last("/zai/api/paas/v4/images/generations")?.body?.quality === "hd", r.output);
  r = await makeGenerateImageTool().run({ prompt: "x", references: ["src.png"] }, ctx());
  ok("Z.AI: референсы не принимаются", r.isError && /reference/.test(r.output), r.output);
}

// ── video ─────────────────────────────────────────────────────────────────
{
  saveConfig({ videoModel: "tokenrouter:kling-v3" });
  let r = await makeGenerateVideoTool({ pollMs: 5 }).run({ prompt: "a fox runs", duration: 5, aspect_ratio: "9:16", first_frame: "src.png", out: "v/tr.mp4" }, ctx());
  const sub = [...seen].reverse().find((r) => r.url === "/tr/v1/video/generations");
  ok("TokenRouter: задача через /video/generations", sub?.body?.model === "kling-v3" && sub.body.metadata?.aspect_ratio === "9:16" && /^data:image\/png/.test(sub.body.image ?? ""), JSON.stringify(sub?.body)?.slice(0, 200));
  ok("TokenRouter: дождался SUCCESS и скачал", !r.isError && fs.readFileSync(path.join(HOME, "v/tr.mp4")).equals(MP4) && pollCount >= 2, r.output);

  saveConfig({ videoModel: "xai:grok-imagine-video-1.5" });
  r = await makeGenerateVideoTool({ pollMs: 5 }).run({ prompt: "a fox", duration: 6, last_frame: "src.png", out: "v/x.mp4" }, ctx());
  ok("xAI: done → video.url скачан", !r.isError && fs.existsSync(path.join(HOME, "v/x.mp4")), r.output);
  ok("xAI: last_frame честно не поддержан", /last_frame is not supported/.test(r.output), r.output);

  saveConfig({ videoModel: "zai:cogvideox-3" });
  r = await makeGenerateVideoTool({ pollMs: 5 }).run({ prompt: "a fox", generate_audio: true }, ctx());
  ok("Z.AI: FAIL с причиной", r.isError && /sensitive content/.test(r.output), r.output);
  ok("Z.AI: with_audio передан", last("/zai/api/paas/v4/videos/generations")?.body?.with_audio === true);
}

// ── audio ─────────────────────────────────────────────────────────────────
{
  saveConfig({ audioModel: "openrouter:openai/gpt-audio-mini" });
  ok("аудио в чате после выбора", tools().includes("generate_audio"));
  const r = await audio.makeGenerateAudioTool().run({ text: "Привет, мир", voice: "nova", instructions: "бодро" }, ctx());
  const req = last("/or/api/v1/chat/completions");
  ok("речь: поток с modalities и голосом", req?.body?.stream === true && req.body.modalities.includes("audio") && req.body.audio?.voice === "nova", JSON.stringify(req?.body)?.slice(0, 200));
  ok("речь: системная строка делает модель голосом", /Speak the user's text exactly/.test(req.body.messages[0].content) && /бодро/.test(req.body.messages[0].content));
  const file = /Saved (.+?\.wav)/.exec(r.output)?.[1];
  const wav = file ? fs.readFileSync(file) : Buffer.alloc(0);
  ok("PCM собран из кусков и обёрнут в WAV", !r.isError && wav.toString("ascii", 0, 4) === "RIFF" && wav.length === 44 + PCM.length, r.output);
  ok("транскрипт склеен", /Transcript: Привет, мир/.test(r.output), r.output);
  ok("музыкальная модель распознаётся", audio.isMusicModel("google/lyria-3-pro-preview") && !audio.isMusicModel("openai/gpt-audio"));
  ok("mp3 узнаётся по сигнатуре", audio.sniffAudio(Buffer.from("ID3\x04\x00")).ext === "mp3" && audio.sniffAudio(PCM).raw);
}

server.closeAllConnections();
await new Promise((r) => server.close(r));
try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* Windows may hold the directory briefly */
}

let failed = 0;
for (const r of results) {
  if (r.ok) console.log("  ok   " + r.name);
  else { failed++; console.log("  FAIL " + r.name + (r.detail ? "\n       " + r.detail : "")); }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
