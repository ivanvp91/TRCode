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

// ── prompt caching (anthropic asks for it explicitly or gets nothing) ─────
{
  // Small history: a breakpoint below the provider minimum only costs the 25%
  // cache-write surcharge, so it must not be sent at all.
  const small = buildAnthropicBody(
    { model: "anthropic/claude-opus-5", messages: history, tools: [{ name: "read", description: "d", parameters: {} }] },
    true,
  );
  ok("кэш: короткая история — без breakpoint", typeof small.system === "string" && !JSON.stringify(small).includes("cache_control"));

  const long = [
    { role: "system", content: "СИСТЕМА " + "и".repeat(4000) },
    { role: "user", content: "прочитай файл" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", name: "read", content: "x".repeat(9000) },
    { role: "user", content: "продолжай" },
  ];
  const cached = buildAnthropicBody(
    { model: "anthropic/claude-opus-5", messages: long, tools: [{ name: "read", description: "d", parameters: {} }, { name: "edit", description: "d", parameters: {} }] },
    true,
  );
  ok("кэш: system блоком с cache_control", Array.isArray(cached.system) && cached.system[0]?.cache_control?.type === "ephemeral", JSON.stringify(cached.system).slice(0, 80));
  ok("кэш: breakpoint на последнем инструменте", cached.tools.at(-1)?.cache_control?.type === "ephemeral" && cached.tools[0]?.cache_control === undefined);
  const lastMsg = cached.messages.at(-1);
  ok("кэш: breakpoint в конце истории", lastMsg.content.at(-1)?.cache_control?.type === "ephemeral", JSON.stringify(lastMsg).slice(0, 90));
  ok("кэш: ранние сообщения не помечены", cached.messages[0].content.every((b) => b.cache_control === undefined));
  ok("кэш: cache:false отключает", !JSON.stringify(buildAnthropicBody({ model: "anthropic/claude-opus-5", messages: long, cache: false }, true)).includes("cache_control"));
  // The breakpoint must be the only difference, or the prefix it caches moves.
  const a1 = buildAnthropicBody({ model: "anthropic/claude-opus-5", messages: long, cache: false }, true);
  const a2 = buildAnthropicBody({ model: "anthropic/claude-opus-5", messages: long }, true);
  ok(
    "кэш: тело не меняется, кроме пометок",
    JSON.stringify(a2).replace(/,?"cache_control":\{"type":"ephemeral"\}/g, "").replace(/"system":\[\{"type":"text","text":(".*?")\}\]/, '"system":$1') ===
      JSON.stringify(a1),
  );
}

// The moving breakpoint at the tail is one expiry away from a full re-prefill,
// so a second one is pinned where nothing moves for the rest of the turn: the
// last thing the user actually typed.
{
  const midTurn = [
    { role: "system", content: "СИСТЕМА " + "с".repeat(3000) },
    { role: "user", content: "прочитай файл" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", name: "read", content: "x".repeat(9000) },
    { role: "user", content: "продолжай" },
    { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c2", name: "read", content: "y".repeat(9000) },
  ];
  const body = buildAnthropicBody(
    { model: "anthropic/claude-opus-5", messages: midTurn, tools: [{ name: "read", description: "d", parameters: {} }] },
    true,
  );
  const marks = (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;
  ok("кэш: четыре пометки — потолок Anthropic", marks === 4, String(marks));

  const turnStart = body.messages[2];
  ok("кэш: якорь на реплике пользователя", turnStart.content[1]?.cache_control?.type === "ephemeral", JSON.stringify(turnStart).slice(0, 120));
  ok("кэш: а не на результате инструмента перед ней", turnStart.content[0]?.cache_control === undefined);
  ok("кэш: хвост тоже помечен", body.messages.at(-1).content.at(-1)?.cache_control?.type === "ephemeral");

  // The anchor holds still while the turn goes on: that is the whole point of
  // it, and a moving one would be a second tail.
  const next = buildAnthropicBody(
    {
      model: "anthropic/claude-opus-5",
      messages: [...midTurn, { role: "assistant", content: "готово" }],
      tools: [{ name: "read", description: "d", parameters: {} }],
    },
    true,
  );
  ok("кэш: якорь не двигается на следующем шаге", JSON.stringify(next.messages[2]) === JSON.stringify(turnStart));

  const ttl = buildAnthropicBody(
    { model: "anthropic/claude-opus-5", messages: midTurn, cacheTtl: "1h" },
    true,
  );
  ok("кэш: час запрашивается явно", JSON.stringify(ttl).includes('"ttl":"1h"'));
}

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

// Anthropic reports the cache beside the input, not inside it: counting only
// input_tokens made a turn look a tenth its size and "cached" exceed 100%.
{
  const cp = new AnthropicStreamParser();
  cp.handle({
    type: "message_start",
    message: { usage: { input_tokens: 800, cache_read_input_tokens: 6300, cache_creation_input_tokens: 400 } },
  });
  cp.handle({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } });
  const cRes = cp.result();
  ok("anthropic: кэш входит в prompt_tokens", cRes.usage.prompt_tokens === 7500, String(cRes.usage.prompt_tokens));
  ok("anthropic: доля кэша не выше 100%", cRes.usage.cached_tokens <= cRes.usage.prompt_tokens, `${cRes.usage.cached_tokens}/${cRes.usage.prompt_tokens}`);
}

// ── input-token trimming ──────────────────────────────────────────────────
const big = [];
for (let i = 0; i < 12; i++) {
  big.push({ role: "user", content: `запрос ${i}` });
  big.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: "{}" } }] });
  // Distinct on purpose: identical results are collapsed by the repeat pass,
  // and this section is about the budget one.
  big.push({ role: "tool", tool_call_id: `c${i}`, name: "read", content: `файл ${i} ` + "x".repeat(20000) });
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
ok("трим: свежий результат не тронут", lastTool.content.length > 20000, `${lastTool.content.length}`);
// Only the wire copy is shortened; the session keeps the full output so
// /resume and /compact still see what actually happened.
ok("трим: сохранённая история не тронута", big.filter((m) => m.role === "tool")[0].content.length > 20000);
ok("трим: на проводе — заглушка", trimmed.messages.filter((m) => m.role === "tool")[0].content.length < 20000);
// The stub must be byte-identical between steps, or the cached prefix moves.
const again = trimForRequest(big, { budget: 20000, keepRecent: 8 });
ok(
  "трим: заглушка детерминированна",
  JSON.stringify(again.messages) === JSON.stringify(trimmed.messages),
);

// ── per-result cap, independent of the budget ─────────────────────────────
{
  const mixed = [
    { role: "user", content: "старт" },
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", name: "read", content: "y".repeat(30000) },
    { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "b", name: "read", content: "z".repeat(3000) },
    { role: "user", content: "дальше" },
    { role: "assistant", content: "ок" },
  ];
  // Budget far above the history: only the cap can fire here.
  const capped = trimForRequest(mixed, { budget: 1_000_000, keepRecent: 2, maxResultBytes: 12000 });
  const tools = capped.messages.filter((m) => m.role === "tool");
  ok("cap: большой результат ужат", tools[0].content.length < 30000, String(tools[0].content.length));
  ok("cap: голова осталась осмысленной", tools[0].content.length > 1500, String(tools[0].content.length));
  ok("cap: мелкий результат не тронут", tools[1].content.length === 3000);
  ok("cap: без cap ничего не делает", trimForRequest(mixed, { budget: 1_000_000, keepRecent: 2 }).trimmed === 0);
  ok("cap: сохранённая история цела", mixed[2].content.length === 30000);

  // Running twice must produce the same bytes, or the cached prefix moves.
  const twice = trimForRequest(mixed, { budget: 1_000_000, keepRecent: 2, maxResultBytes: 12000 });
  ok("cap: результат детерминирован", JSON.stringify(twice.messages) === JSON.stringify(capped.messages));
  // And a second pass over an already-stubbed history must not re-stub it.
  const onStubs = trimForRequest(capped.messages, { budget: 1_000_000, keepRecent: 2, maxResultBytes: 12000 });
  ok("cap: заглушку не режет повторно", onStubs.trimmed === 0, String(onStubs.trimmed));
}

let failed = 0;
for (const t of results) {
  if (!t.ok) failed++;
  console.log(`${t.ok ? "  OK  " : "ПРОВАЛ"}  ${t.name}${t.ok || !t.detail ? "" : `  → ${t.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} пройдено`);
console.log(`экономия на трим-тесте: ${beforeSize} → ${afterSize} токенов (${Math.round((1 - afterSize / beforeSize) * 100)}%)`);
process.exit(failed ? 1 : 0);
