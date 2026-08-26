/**
 * Minimal OpenAI-compatible mock used by the smoke test. It answers /v1/models
 * and streams a two-step conversation: first a tool call, then a text answer.
 */
import http from "node:http";
import fs from "node:fs";

/** Request log: to stdout, and to MOCK_LOG when a test needs to read it back. */
function log(lineText) {
  process.stdout.write(lineText);
  if (process.env.MOCK_LOG) {
    try { fs.appendFileSync(process.env.MOCK_LOG, lineText); } catch {}
  }
}

const MODELS = [
  { id: "mock-smart", owned_by: "mock", context_window: 200000, pricing: { input: 1.5, output: 6 } },
  { id: "mock-fast", owned_by: "mock", context_window: 128000, pricing: { input: 0.2, output: 0.8 } },
  { id: "mock-noeffort", owned_by: "mock", context_window: 64000 },
  // Speaks /v1/messages: exercises the Anthropic adapter and prompt caching.
  { id: "mock-claude", owned_by: "mock", context_window: 200000, supported_endpoint_types: ["anthropic"] },
  // Same, but its host strips cache_control and 400s on it.
  { id: "mock-nocache", owned_by: "mock", context_window: 200000, supported_endpoint_types: ["anthropic"] },
  { id: "mock-nottl", owned_by: "mock", context_window: 200000, supported_endpoint_types: ["anthropic"] },
  // Speaks /v1/messages but only the older thinking shape, and says so in its
  // own words rather than in the client's.
  { id: "mock-oldthinking", owned_by: "mock", context_window: 200000, supported_endpoint_types: ["anthropic"] },
  // Allows one request per 1.5s and phrases its 429 like a real host does.
  { id: "mock-limited", owned_by: "mock", context_window: 64000 },
  // Refuses once and then never again: a burst, a busy minute, a neighbour on
  // the same account — the limit a client must stop paying for afterwards.
  { id: "mock-burst", owned_by: "mock", context_window: 64000 },
  // Always refuses: for the paths where one model of several has to fail.
  { id: "mock-broken", owned_by: "mock", context_window: 8000 },
  // Fixed at temperature 1 and 400s on anything else, the way a reasoning
  // model behind OpenCode Go does. The client has to give the parameter up.
  { id: "mock-fixedtemp", owned_by: "mock", context_window: 64000 },
  // Streams reasoning forever and never finishes: the hung turn Esc must cut.
  { id: "mock-slow", owned_by: "mock", context_window: 64000 },
  // Hangs up in the middle of the answer the first time, then behaves: the
  // dropped connection a client has to resend rather than report.
  { id: "mock-drop", owned_by: "mock", context_window: 64000 },
  // Same, but the hang-up comes after part of the visible text: the resend
  // has to start a fresh block instead of gluing onto the cut-off one.
  { id: "mock-drop-mid", owned_by: "mock", context_window: 64000 },
  // Same, but its router says so in words inside the still-open stream
  // ("Upstream idle timeout exceeded") instead of closing the socket.
  { id: "mock-upstream-timeout", owned_by: "mock", context_window: 64000 },
];

/** The mock-limited window, in ms; attempts closer together get a 429. */
const LIMIT_GAP_MS = 1500;
let lastLimitedAt = 0;
/** Every attempt at the limited model, so a test can read back the spacing. */
const rateLog = [];
let burstRefused = false;
const dropped = new Set();

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    model: "mock-smart",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: MODELS }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const messages = payload.messages ?? [];

    if (req.url.endsWith("/messages")) return anthropic(payload, res);

    // Speaks a real-world rate limit: one request per window, and the 429
    // spells out what that window is. Both attempts are logged, so a test can
    // check that the client waited the window out instead of hammering.
    if (payload.model === "mock-limited") {
      const now = Date.now();
      const ok = now - lastLimitedAt >= LIMIT_GAP_MS;
      lastLimitedAt = now;
      rateLog.push({ at: now, ok });
      if (!ok) {
        log(`RATE model=mock-limited status=429\n`);
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "You have reached the request limit: Maximum 1 requests within 1 seconds." } }),
        );
        return;
      }
      log(`RATE model=mock-limited status=200\n`);
    }

    if (payload.model === "mock-burst" && !burstRefused) {
      burstRefused = true;
      log(`RATE model=mock-burst status=429\n`);
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "You have reached the request limit: Maximum 1 requests within 1 seconds." } }),
      );
      return;
    }

    // Visible to the test: what reasoning params actually arrived.
    log(
      `REQ model=${payload.model} reasoning_effort=${payload.reasoning_effort ?? "-"} ` +
        `reasoning=${payload.reasoning ? JSON.stringify(payload.reasoning) : "-"} ` +
        `usage_asked=${payload.usage ? JSON.stringify(payload.usage) : "-"}\n`,
    );

    if (payload.model === "mock-broken") {
      log("REQ model=mock-broken status=400\n");
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "this model is not available" } }));
      return;
    }

    // mock-fixedtemp is a model that cannot be steered: sampling is fixed and
    // anything else is a 400, phrased the way OpenCode Go phrases it.
    if (payload.model === "mock-fixedtemp") {
      if (payload.temperature !== undefined && payload.temperature !== 1) {
        log("REQ model=mock-fixedtemp rejected=temperature\n");
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { type: "invalid_request_error", message: "invalid temperature: only 1 is allowed for this model" },
          }),
        );
        return;
      }
      log(`REQ model=mock-fixedtemp temperature=${payload.temperature ?? "-"}\n`);
    }

    // mock-noeffort rejects the reasoning budget, like a model that lacks it.
    if (payload.model === "mock-noeffort" && (payload.reasoning_effort || payload.reasoning)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: reasoning_effort" } }));
      return;
    }
    // mock-cache-split reports the cache beside the prompt instead of inside
    // it, the way xAI does through TokenRouter: 800 fresh tokens next to a
    // 6300-token cache read.
    if (payload.model === "mock-cache-split") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "ок" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 800,
            completion_tokens: 10,
            total_tokens: 810,
            prompt_tokens_details: { cached_tokens: 6300 },
          },
        }),
      );
      return;
    }

    // A connection that dies mid-answer: headers and a first chunk arrive, then
    // the socket is destroyed. Node reports that as `TypeError: terminated`, and
    // the second attempt has to succeed for the client to be doing its job.
    if (payload.model === "mock-drop") {
      if (!dropped.has("mock-drop")) {
        dropped.add("mock-drop");
        log("DROP model=mock-drop first" + "\n");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sse(res, chunk({ reasoning_content: "думаю" }));
        setTimeout(() => res.socket?.destroy(), 50);
        return;
      }
      log("DROP model=mock-drop retry" + "\n");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, chunk({ role: "assistant", content: "" }));
      sse(res, chunk({ content: "ПОСЛЕ ОБРЫВА" }));
      sse(res, chunk({}, "stop"));
      sse(res, { ...chunk({}), usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } });
      res.write("data: [DONE]" + "\n\n");
      res.end();
      return;
    }

    // The hang-up after visible text: the first attempt streams a few chunks
    // of the answer, then the socket dies. The resent step has to arrive as a
    // complete answer of its own, with nothing glued onto the cut-off part.
    if (payload.model === "mock-drop-mid") {
      if (!dropped.has("mock-drop-mid")) {
        dropped.add("mock-drop-mid");
        log("DROP model=mock-drop-mid first\n");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sse(res, chunk({ role: "assistant", content: "" }));
        sse(res, chunk({ content: "НАЧАЛО ОТВ" }));
        setTimeout(() => res.socket?.destroy(), 50);
        return;
      }
      log("DROP model=mock-drop-mid retry\n");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, chunk({ role: "assistant", content: "" }));
      sse(res, chunk({ content: "ОТВЕТ ПОСЛЕ ОБРЫВА" }));
      sse(res, chunk({}, "stop"));
      sse(res, { ...chunk({}), usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } });
      res.write("data: [DONE]" + "\n\n");
      res.end();
      return;
    }

    // The same hang-up in a router's words: the stream is fine until the
    // upstream behind it goes quiet, and the router answers with a JSON error
    // inside the still-open SSE instead of closing the socket. A client that
    // only recognises dead sockets reports an answer as if the host had judged
    // the request and never resends.
    if (payload.model === "mock-upstream-timeout") {
      if (!dropped.has("mock-upstream-timeout")) {
        dropped.add("mock-upstream-timeout");
        log("DROP model=mock-upstream-timeout first\n");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sse(res, chunk({ reasoning_content: "думаю" }));
        setTimeout(() => {
          sse(res, { error: { message: "Upstream idle timeout exceeded" } });
          setTimeout(() => res.socket?.destroy(), 50);
        }, 50);
        return;
      }
      log("DROP model=mock-upstream-timeout retry\n");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sse(res, chunk({ role: "assistant", content: "" }));
      sse(res, chunk({ content: "ПОСЛЕ ОБРЫВА" }));
      sse(res, chunk({}, "stop"));
      sse(res, { ...chunk({}), usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } });
      res.write("data: [DONE]" + "\n\n");
      res.end();
      return;
    }

    // A model that thinks for a very long time and never finishes: what Esc
    // has to be able to cut through. The response is left open on purpose —
    // the client must abort it rather than wait for an end that never comes.
    if (payload.model === "mock-slow") {
      log(`SLOW model=mock-slow open\n`);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const tick = setInterval(() => sse(res, chunk({ reasoning_content: "…" })), 200);
      req.on("close", () => {
        clearInterval(tick);
        log(`SLOW model=mock-slow closed\n`);
      });
      return;
    }

    const sawToolResult = messages.some((m) => m.role === "tool");
    const stream = payload.stream !== false;

    if (!stream) {
      const isPlanner = messages.some(
        (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("планировщик"),
      );
      // A plan with one parallel pair and one dependent writer.
      const plan = {
        steps: [
          { id: "s1", title: "Разведка структуры", prompt: "Прочитай package.json", deps: [], writes: false },
          { id: "s2", title: "Разведка тестов", prompt: "Прочитай package.json ещё раз", deps: [], writes: false },
          { id: "s3", title: "Свести выводы", prompt: "Сведи выводы s1 и s2", deps: ["s1", "s2"], writes: false },
        ],
        final: "краткий отчёт",
      };
      // The panel answers in markdown, and each round is recognisable by the
      // system prompt it was sent under — that is what lets a UI test tell the
      // final answer apart from the rounds that led to it.
      const sys = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join(" ");
      const brain = /Write the final answer for the user/.test(sys)
        ? "## ИТОГ\n\n| ключ | значение |\n| --- | --- |\n| скорость | вдвое |\n\n- **вывод** готов\n"
        : /answering the same question|You answered a question/.test(sys)
          ? "## РАУНД\n\n- пункт про `build`\n"
          : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: isPlanner ? JSON.stringify(plan) : (brain ?? "СЖАТАЯ ВЫЖИМКА (мок)") },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
      );
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const wantsWrite = messages.some((m) => typeof m.content === "string" && m.content.includes("MOCKWRITE"));

    if (!sawToolResult && wantsWrite) {
      // Exercises the permission gate.
      sse(res, chunk({ role: "assistant", content: "" }));
      sse(
        res,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_w",
              type: "function",
              function: { name: "write", arguments: JSON.stringify({ path: "mock-output.txt", content: "hello\n" }) },
            },
          ],
        }),
      );
      sse(res, chunk({}, "tool_calls"));
      sse(res, { ...chunk({}), usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (!sawToolResult) {
      // Step 1: emit a fragmented tool call, exactly like a real provider.
      sse(res, chunk({ role: "assistant", content: "" }));
      sse(res, chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"pack' } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: 'age.json"}' } }] }));
      sse(res, chunk({}, "tool_calls"));
      sse(res, { ...chunk({}), usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 } });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Step 2: stream a normal answer.
    const text = "Файл прочитан. Это пакет **trcode** версии 0.1.0.\n\n- имя: trcode\n- бинарь: trc\n";
    for (const piece of text.match(/.{1,7}/gs) ?? []) sse(res, chunk({ content: piece }));
    sse(res, chunk({}, "stop"));
    sse(res, { ...chunk({}), usage: { prompt_tokens: 1500, completion_tokens: 40, total_tokens: 1540 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

/**
 * Anthropic Messages endpoint. Reports what it saw so the test can assert on
 * caching, and lets `mock-nocache` reject cache_control the way a proxy that
 * does not forward the field would.
 */
function anthropic(payload, res) {
  const raw = JSON.stringify(payload);
  const asked = raw.includes('"cache_control"');
  const ttl = /"ttl":"1h"/.test(raw) ? "1h" : asked ? "5m" : "-";
  const marks = (raw.match(/"cache_control"/g) ?? []).length;
  log(`ANTHROPIC model=${payload.model} cache=${asked ? "yes" : "no"} ttl=${ttl} marks=${marks}\n`);

  // A proxy that forwards cache_control but has not caught up with the hour:
  // the client has to give up the lifetime before it gives up caching.
  if (ttl === "1h" && payload.model === "mock-nottl") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "cache_control.ttl: Extra inputs are not permitted" } }));
    return;
  }

  if (asked && payload.model === "mock-nocache") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Unexpected field: cache_control" } }));
    return;
  }

  // A host that only knows the older thinking shape, phrased the way Model
  // Studio phrases it: no "reasoning", no "effort", nothing the client calls
  // the parameter it just sent.
  if (payload.model === "mock-oldthinking" && payload.thinking?.type === "adaptive") {
    log(`ANTHROPIC model=mock-oldthinking rejected=adaptive\n`);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "adaptive thinking is not supported on this model" } }));
    return;
  }
  if (payload.model === "mock-oldthinking") {
    log(`ANTHROPIC model=mock-oldthinking thinking=${payload.thinking?.type ?? "-"}\n`);
  }

  const cached = asked ? 900 : 0;
  if (payload.stream === false) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Готово." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, cache_read_input_tokens: cached, output_tokens: 12 },
      }),
    );
    return;
  }

  const events = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 1000, cache_read_input_tokens: cached } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Готово." } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

const port = Number(process.env.MOCK_PORT || 8787);
server.on("error", (err) => {
  // A taken port must be a loud failure, not a process that lingers doing
  // nothing while every suite times out against whoever actually holds it.
  process.stderr.write(`mock: cannot listen on ${port}: ${err?.code ?? err}\n`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock listening on ${port}\n`);
});

// Nobody waits on this process: the suite that spawned it may be SIGKILLed on
// a timeout, or the whole run interrupted, and its cleanup never reached. An
// orphaned mock keeps the port and stalls every later run — so when the
// parent is gone, so is the reason to stay up.
const ppid = process.ppid;
setInterval(() => {
  try {
    process.kill(ppid, 0);
  } catch {
    process.exit(0);
  }
}, 2000).unref();
