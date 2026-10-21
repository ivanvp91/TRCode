/**
 * Gemini through Code Assist.
 *
 * The account path is not the public Gemini API: it is the host Gemini CLI
 * talks to, with its wrapper body ({model, project, request}) and its SSE frames
 * ({response: {candidates, usageMetadata}}). These tests pin the translation in
 * both directions, the streamed function calls, and the project discovery that
 * a fresh login needs before any request can be sent.
 */
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trc-gemini-"));
process.env.TRCODE_HOME = HOME;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
};

// ── перевод истории в форму Gemini ─────────────────────────────────────────
{
  const { toGeminiContents, buildGeminiBody } = await import("../dist/provider/gemini.js");
  const { systemInstruction, contents } = toGeminiContents([
    { role: "system", content: "Ты агент." },
    { role: "user", content: "Прочитай a.txt" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "c1", name: "read", content: "содержимое" },
    { role: "user", content: "А теперь картинка", images: [{ mime: "image/png", data: "AAA" }] },
  ]);

  check("system уходит отдельным блоком", systemInstruction?.parts?.[0]?.text === "Ты агент.");
  check(
    "роли и порядок сохранены",
    contents.map((c) => c.role).join(",") === "user,model,user",
    contents.map((c) => c.role).join(","),
  );
  check("вызов инструмента стал functionCall", contents[1].parts[0].functionCall?.name === "read");
  check("аргументы разобраны в объект", contents[1].parts[0].functionCall?.args?.path === "a.txt");
  check("результат стал functionResponse", contents[2].parts[0].functionResponse?.name === "read");
  check("и несёт output", contents[2].parts[0].functionResponse?.response?.output === "содержимое");
  check(
    "следующая реплика слилась в тот же ход",
    contents[2].parts.some((p) => p.text === "А теперь картинка"),
    JSON.stringify(contents[2].parts),
  );
  check("картинка стала inlineData", contents[2].parts.some((p) => p.inlineData?.mimeType === "image/png"));

  const body = buildGeminiBody({
    model: "gemini-3.1-pro-preview",
    project: "proj-1",
    messages: [{ role: "user", content: "привет" }],
    tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    maxTokens: 100,
    temperature: 0.2,
  });
  check("обёртка Code Assist на месте", body.model === "gemini-3.1-pro-preview" && body.project === "proj-1" && Boolean(body.request));
  check("tools стали functionDeclarations", body.request.tools?.[0]?.functionDeclarations?.[0]?.name === "read");
  check("generationConfig собран", body.request.generationConfig?.maxOutputTokens === 100 && body.request.generationConfig?.temperature === 0.2);

  // Gemini 3 refuses a replayed function call whose thought signature is gone.
  const replay = buildGeminiBody({
    model: "gemini-3.1-pro-preview",
    messages: [
      { role: "user", content: "прочитай" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' }, signature: "sig-1" }] },
    ],
  });
  const replayedCall = replay.request.contents[1].parts[0];
  check("подпись возвращается в историю", replayedCall.thoughtSignature === "sig-1", JSON.stringify(replayedCall));
}

// ── провод: SSE-кадры Code Assist через настоящий клиент ──────────────────
{
  const { saveConfig } = await import("../dist/config.js");
  const creds = await import("../dist/provider/credentials.js");
  const client = await import("../dist/provider/client.js");
  const gemini = await import("../dist/provider/gemini.js");

  const calls = [];
  let hasProject = true;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ url: req.url, headers: req.headers, body });
      const send = (json) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.url.startsWith("/v1internal:streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "При" }] } }] } })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                { content: { parts: [{ functionCall: { name: "read", args: { path: "a.txt" } }, thoughtSignature: "sig-1" }] }, finishReason: "STOP" },
              ],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
            },
          })}\n\n`,
        );
        res.end();
        return;
      }
      if (req.url.startsWith("/v1internal:generateContent")) {
        send({
          response: {
            candidates: [{ content: { parts: [{ text: "ок" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
          },
        });
        return;
      }
      if (req.url.startsWith("/v1internal:loadCodeAssist")) {
        send(hasProject ? { currentTier: { id: "free" }, cloudaicompanionProject: "proj-a" } : { currentTier: { id: "free" } });
        return;
      }
      if (req.url.startsWith("/v1internal:onboardUser")) {
        send({ done: true, response: { cloudaicompanionProject: { id: "proj-b" } } });
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1internal`;
  saveConfig({ apiKey: "", providers: { gemini: { baseUrl: base, project: "proj-1" } } });
  creds.writeCredentials("gemini", { mode: "oauth", accessToken: "tok-gem", expiresAt: Date.now() + 3600_000 });

  try {
    const res = await client.complete({
      model: "gemini:gemini-3.1-pro-preview",
      messages: [
        { role: "system", content: "система" },
        { role: "user", content: "привет" },
      ],
    });
    check("нестримовый ответ разобран", res.content === "ок", JSON.stringify(res));
    check("usage пришёл", res.usage?.prompt_tokens === 7 && res.usage?.total_tokens === 9, JSON.stringify(res.usage));
    check("путь — :generateContent", calls[0].url === "/v1internal:generateContent", calls[0].url);
    check("Bearer-токен ушёл", calls[0].headers.authorization === "Bearer tok-gem", calls[0].headers.authorization);
    check("UA назван Gemini CLI", /^GeminiCLI\//.test(String(calls[0].headers["user-agent"])), calls[0].headers["user-agent"]);
    check("проект попал в тело", calls[0].body.project === "proj-1", JSON.stringify(calls[0].body).slice(0, 120));
    check("systemInstruction собрался", calls[0].body.request.systemInstruction?.parts?.[0]?.text === "система");

    const events = [];
    for await (const ev of client.streamChat({
      model: "gemini:gemini-3.1-pro-preview",
      messages: [{ role: "user", content: "привет" }],
      tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    })) {
      events.push(ev);
    }
    const streamCall = calls.find((c) => c.url.startsWith("/v1internal:streamGenerateContent"));
    check("стрим идёт на :streamGenerateContent", Boolean(streamCall), calls.map((c) => c.url).join(", "));
    check("alt=sse запрошен", /alt=sse/.test(streamCall.url));
    check("текст отдан дельтой", events.some((e) => e.type === "text" && e.text === "При"));
    const done = events.find((e) => e.type === "done");
    check("инструмент собран из functionCall", done?.toolCalls?.[0]?.function?.name === "read", JSON.stringify(done?.toolCalls));
    check("аргументы — JSON-строка", done?.toolCalls?.[0]?.function?.arguments === '{"path":"a.txt"}');
    check("finishReason — tool_calls", done?.finishReason === "tool_calls", done?.finishReason);
    check("подпись вызова сохранена", done?.toolCalls?.[0]?.signature === "sig-1", JSON.stringify(done?.toolCalls));
    check("usage из кадра", done?.usage?.total_tokens === 14, JSON.stringify(done?.usage));

    // ── проект: готовый из loadCodeAssist ───────────────────────────────────
    const found = await gemini.discoverProject("tok-gem", { baseUrl: base });
    check("проект берётся из loadCodeAssist", found.projectId === "proj-a" && found.tier === "free", JSON.stringify(found));

    hasProject = false;
    const onboarded = await gemini.discoverProject("tok-gem", { baseUrl: base });
    check("без проекта аккаунт онбордится", onboarded.projectId === "proj-b", JSON.stringify(onboarded));
  } finally {
    creds.clearCredentials("gemini");
    await new Promise((r) => server.close(r));
  }
}

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* Windows may hold the directory briefly */
}

console.log(`\n${passed}/${passed + failed} passed`);
// Not process.exit(): the fetch agent keeps sockets briefly, and tearing the
// loop down under it trips a libuv assertion on Windows. The code is the verdict.
process.exitCode = failed ? 1 : 0;
