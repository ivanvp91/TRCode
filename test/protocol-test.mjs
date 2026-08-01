/**
 * Checks the two extra wire dialects and the input-token trimming, without
 * touching the network: bodies are built and stream events are fed in by hand.
 */
const ok = (name, cond, detail = "") => {
  results.push({ name, ok: Boolean(cond), detail });
};
const results = [];

const { toResponsesInput, buildResponsesBody, ResponsesStreamParser } = await import("../dist/provider/responses.js");
const { toAnthropicMessages, buildAnthropicBody, AnthropicStreamParser } = await import("../dist/provider/anthropic.js");
const { protocolOf } = await import("../dist/provider/protocol.js");
const { trimForRequest, historySize } = await import("../dist/session/trim.js");

// A history with a full tool round-trip.
const history = [
  { role: "system", content: "СИСТЕМА" },
  { role: "user", content: "прочитай файл" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
  { role: "tool", tool_call_id: "c1", name: "read", content: "содержимое файла" },
  { role: "assistant", content: "готово" },
];

// ── protocol detection ────────────────────────────────────────────────────
ok("openai определяется", protocolOf({ id: "x", endpoints: ["openai"] }) === "openai");
ok("responses определяется", protocolOf({ id: "x", endpoints: ["openai-response"] }) === "responses");
ok("anthropic определяется", protocolOf({ id: "x", endpoints: ["anthropic"] }) === "anthropic");
ok("anthropic-compatible тоже", protocolOf({ id: "x", endpoints: ["anthropic-compatible"] }) === "anthropic");
ok("gemini не поддержан", protocolOf({ id: "x", endpoints: ["gemini"] }) === "unsupported");

// ── Responses API ─────────────────────────────────────────────────────────
const r = toResponsesInput(history);
ok("responses: system → instructions", r.instructions === "СИСТЕМА");
ok("responses: вызов инструмента → function_call", r.input.some((i) => i.type === "function_call" && i.call_id === "c1"));
ok("responses: результат → function_call_output", r.input.some((i) => i.type === "function_call_output" && i.call_id === "c1"));

const rBody = buildResponsesBody({ model: "openai/gpt-5.6-sol", messages: history, tools: [{ name: "read", description: "d", parameters: { type: "object" } }], effort: "high" }, true);
ok("responses: инструменты плоские", rBody.tools?.[0]?.type === "function" && rBody.tools?.[0]?.name === "read");
ok("responses: reasoning.effort", JSON.stringify(rBody.reasoning) === '{"effort":"high"}');
ok("responses: без messages", rBody.messages === undefined && Array.isArray(rBody.input));

const rp = new ResponsesStreamParser();
const rText = [];
for (const ev of rp.handle({ type: "response.output_text.delta", delta: "При" })) rText.push(ev.text);
for (const ev of rp.handle({ type: "response.output_text.delta", delta: "вет" })) rText.push(ev.text);
rp.handle({ type: "response.output_item.added", item: { type: "function_call", id: "i1", call_id: "call_9", name: "read" } });
rp.handle({ type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"path":' });
rp.handle({ type: "response.function_call_arguments.delta", item_id: "i1", delta: '"a.ts"}' });
rp.handle({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 100, output_tokens: 20 } } });
const rRes = rp.result();
ok("responses: текст собран", rText.join("") === "Привет", rText.join(""));
ok("responses: tool-call собран", rRes.toolCalls[0]?.function?.arguments === '{"path":"a.ts"}', JSON.stringify(rRes.toolCalls));
ok("responses: usage", rRes.usage?.prompt_tokens === 100 && rRes.usage?.completion_tokens === 20);

// ── Anthropic ─────────────────────────────────────────────────────────────
const a = toAnthropicMessages(history);
ok("anthropic: system отдельно", a.system === "СИСТЕМА");
ok("anthropic: tool_use в assistant", a.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use" && b.id === "c1")));
ok("anthropic: tool_result в user", a.messages.some((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "c1")));
ok("anthropic: роли не повторяются подряд", a.messages.every((m, i) => i === 0 || m.role !== a.messages[i - 1].role));
ok("anthropic: начинается с user", a.messages[0].role === "user");

const aBody = buildAnthropicBody({ model: "anthropic/claude-opus-5", messages: history, tools: [{ name: "read", description: "d", parameters: { type: "object" } }], effort: "high" }, true);
ok("anthropic: max_tokens обязателен", typeof aBody.max_tokens === "number" && aBody.max_tokens > 0);
ok("anthropic: input_schema у инструментов", aBody.tools?.[0]?.input_schema !== undefined);
// Claude 5 rejects {type:"enabled"} — the gateway asks for adaptive + effort.
ok("anthropic: thinking adaptive по умолчанию", aBody.thinking?.type === "adaptive", JSON.stringify(aBody.thinking));
ok("anthropic: output_config.effort", aBody.output_config?.effort === "high", JSON.stringify(aBody.output_config));
ok("anthropic: temperature не шлётся с thinking", aBody.temperature === undefined);

const aBudget = buildAnthropicBody({ model: "anthropic/claude-sonnet-4", messages: history, effort: "high", thinkingForm: "budget" }, true);
ok("anthropic: budget-форма для 4.x", aBudget.thinking?.type === "enabled" && aBudget.thinking?.budget_tokens > 0);
ok("anthropic: max_tokens больше бюджета", aBudget.max_tokens > aBudget.thinking.budget_tokens);

const aOff = buildAnthropicBody({ model: "anthropic/claude-opus-5", messages: history, effort: "high", thinkingForm: "none" }, true);
ok("anthropic: форма none снимает thinking", aOff.thinking === undefined && aOff.output_config === undefined);

const ap = new AnthropicStreamParser();
ap.handle({ type: "message_start", message: { usage: { input_tokens: 250 } } });
ap.handle({ type: "content_block_start", index: 0, content_block: { type: "text" } });
const aText = [];
for (const ev of ap.handle({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Да" } })) aText.push(ev.text);
ap.handle({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "read" } });
ap.handle({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path"' } });
ap.handle({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"b.ts"}' } });
ap.handle({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } });
const aRes = ap.result();
ok("anthropic: текст собран", aText.join("") === "Да");
ok("anthropic: tool_use собран", aRes.toolCalls[0]?.function?.arguments === '{"path":"b.ts"}', JSON.stringify(aRes.toolCalls));
ok("anthropic: usage", aRes.usage.prompt_tokens === 250 && aRes.usage.completion_tokens === 30);

// ── input-token trimming ──────────────────────────────────────────────────
const big = [];
for (let i = 0; i < 12; i++) {
  big.push({ role: "user", content: `запрос ${i}` });
  big.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: "{}" } }] });
  big.push({ role: "tool", tool_call_id: `c${i}`, name: "read", content: "x".repeat(20000) });
  big.push({ role: "assistant", content: `ответ ${i}` });
}
const beforeSize = historySize(big);
const trimmed = trimForRequest(big, { budget: 20000, keepRecent: 8 });
const afterSize = historySize(trimmed.messages);

ok("трим: размер упал", afterSize < beforeSize, `${beforeSize} → ${afterSize}`);
ok("трим: уложились в бюджет", afterSize <= 20000, `${afterSize}`);
ok("трим: сообщения не потеряны", trimmed.messages.length === big.length);
ok("трим: роли и id сохранены", trimmed.messages.every((m, i) => m.role === big[i].role && m.tool_call_id === big[i].tool_call_id));
const lastTool = trimmed.messages.filter((m) => m.role === "tool").at(-1);
ok("трим: свежий результат не тронут", lastTool.content.length === 20000, `${lastTool.content.length}`);
ok("трим: исходный массив не изменён", big.filter((m) => m.role === "tool")[0].content.length === 20000);

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok || !t.detail ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
console.log(`экономия на трим-тесте: ${beforeSize} → ${afterSize} токенов (${Math.round((1 - afterSize / beforeSize) * 100)}%)`);
process.exit(failed ? 1 : 0);
