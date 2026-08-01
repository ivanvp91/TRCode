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
];

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

    // Visible to the test: what reasoning params actually arrived.
    log(
      `REQ model=${payload.model} reasoning_effort=${payload.reasoning_effort ?? "-"} ` +
        `reasoning=${payload.reasoning ? JSON.stringify(payload.reasoning) : "-"}\n`,
    );

    // mock-noeffort rejects the reasoning budget, like a model that lacks it.
    if (payload.model === "mock-noeffort" && (payload.reasoning_effort || payload.reasoning)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: reasoning_effort" } }));
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: isPlanner ? JSON.stringify(plan) : "СЖАТАЯ ВЫЖИМКА (мок)" },
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
  log(`ANTHROPIC model=${payload.model} cache=${asked ? "yes" : "no"}\n`);

  if (asked && payload.model === "mock-nocache") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Unexpected field: cache_control" } }));
    return;
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
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock listening on ${port}\n`);
});
