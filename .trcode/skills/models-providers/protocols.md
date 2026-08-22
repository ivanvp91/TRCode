# Wire protocols, reasoning, caching, refusals

Source: `src/provider/protocol.ts`, `client.ts`, `anthropic.ts`, `responses.ts`,
`schema.ts`.

## Three dialects

| protocol | path | who speaks it |
|---|---|---|
| `openai` | `/chat/completions` | most models, all of OpenRouter, Model Studio, Moonshot platform |
| `responses` | `/responses` | `openai/gpt-5.6-*`, `gpt-5.5-pro`, `gpt-5.4` (catalog `openai-response`) |
| `anthropic` | `/messages` | `anthropic/claude-*`, the Kimi coding host, Zen's Claude and Qwen, Go's Qwen and MiniMax |

There is a fourth outcome, `unsupported`: an endpoint type with no adapter here — image
and video generation, embeddings, Zen's Gemini on Google's own path. `isDrivable` is
false for it, `usableModels` drops the model and `incompatibleReason` says why.

`protocolOf(model)` reads `supported_endpoint_types` from the catalog; `registerProtocols`
rebuilds the map on every refresh; `protocolFor(id)` falls back to `openai` when the model
is unknown. A provider that serves exactly one shape states it outright
(`ProviderMode.protocol`), and one that serves several states them per model
(`ProviderMode.endpoints`, e.g. `ZEN_ENDPOINTS`) — guessing `openai` for a Claude-shaped
host fails every request. `protocolForModel` (registry) is the one to call: it prefers
what the provider states over the catalog, and works before any catalog is loaded.

`buildBodyFor` in `client.ts` is the single entry point. Before anything else it runs
`repairToolPairs`: every `tool_call` must be answered by a `tool` message with its id, and
every `tool` message must answer a call that is present. Hosts refuse both halves, and the
one that does not is worse — an unanswered call reads to the model as a command it never
ran, so it runs the ten-minute build again.

## Anthropic specifics (`anthropic.ts`)

- History is flattened into `system` + `messages`; tool results travel as `tool_result`
  blocks inside a **user** message. Consecutive same-role messages merge into one message
  with several content blocks, so an injected user message after tool results is safe.
- A history that starts with an assistant message gets a `(continued)` user message
  prepended.
- `max_tokens` is required: `DEFAULT_MAX_TOKENS` 8192, or `budget + 8192` with an explicit
  thinking budget.

## Reasoning effort

`Effort = off | minimal | low | medium | high`. Resolution order:
session override → `effortByModel[model]` → `effort` (default `high`).

Hosts spell the budget differently and reject a body carrying the wrong shape, so the
forms are **probed** and the winner is remembered per model in config → `effortForm`:

```
openai:     reasoning_effort  →  reasoning: { effort }
responses:  reasoning: { effort }
anthropic:  adaptive          →  budget
```

- adaptive → `thinking: { type: "adaptive" }` + `output_config: { effort }`
  (`minimal` is sent as `low`). Claude 5 rejects `{ type: "enabled" }`.
- budget → `thinking: { type: "enabled", budget_tokens }`, with
  `THINKING_BUDGET = { low: 2048, medium: 6144, high: 12288 }`. Extended thinking forbids a
  custom temperature, so `temperature` is dropped when a budget is set.
- Out of forms → `none`, remembered, and the model runs without a reasoning parameter.

A 400 counts as an effort complaint when the body matches
`/reasoning|effort|thinking|adaptive|budget/i` — hosts complain in their own vocabulary
(Model Studio's Token Plan says "adaptive thinking is not supported on this model" to a
`reasoning_effort` it does not take). Matching only our own spellings turned that into a
dead turn where dropping the parameter would have worked.

`/effort` and config `effortParam` pin a form; `resetEffortForm` clears what was learned.

## Prompt caching

Anthropic-shaped requests only (`cache_control: { type: "ephemeral" }`):

- Breakpoints: the `system` block, the last tool schema (covers the whole tool block), and
  the last message — which moves forward each step, so this request writes the cache and
  the next one reads it.
- Nothing is marked below `MIN_CACHEABLE_TOKENS` (2048): Anthropic ignores a breakpoint
  under ~1024 tokens (2048 on Haiku) and a cache write costs 25% more than plain input.
- A host that answers 400 about `cache_control` is remembered in `cacheRejected` and gets
  breakpoint-free bodies for the rest of the process — a proxy in front of Anthropic may
  simply not pass the field through.
- Switch off entirely with config `promptCache: false`.
- Cache hits come back as `cache_read_input_tokens` and are reported as `cached_tokens`.

## Sampling

A reasoning model is often fixed at temperature 1 and answers
`400 invalid temperature: only 1 is allowed for this model`, and `temperatureRejected`
drops the parameter for that model for the rest of the run. It is a preference, and losing
it costs nothing next to losing the answer — which is what used to happen, one model at a
time, in a `/brain` panel.

## Refusals and failures

| status | meaning here | handling |
|---|---|---|
| 400 | reasoning parameter | next form on the ladder, then `none` |
| 400 | `cache_control` | drop breakpoints for this model, resend |
| 400 | `temperature` | a model fixed at 1 (`only 1 is allowed for this model`) — drop the parameter for this model, resend |
| 400 | content filter (`DataInspection`, `content policy`) | a verdict on the conversation — offer another host serving the same model |
| 401 | credential missing/expired | `resolveAuth` renews an OAuth token; otherwise `/login` |
| 402 | lapsed plan | the catalog listing fails too — seeds carry the model list |
| 403 | missing header or entitlement | see the provider's required headers |
| 429 | real limit | wait out the window the host names, then retry |
| 408/409/425/5xx | transient | retried |

429s are handled where they happen and nowhere else: nothing is paced in advance. A limit
is a property of an account at a moment, the client cannot see when it lifts, and pacing
wrongly costs dead time on *every* step; being wrong the other way costs one refused
request. The window is parsed out of the host's own words ("Maximum 1 requests within 1
minutes"), or `Retry-After`, else a short default. The total wait is bounded by time, not
by a retry count.

A dropped connection is not an answer: while the model has said nothing yet the same
request is resent (3 attempts). Once text is on screen a silent resend would print the
answer twice, so it becomes an error instead. Node's undici closes a response that has
sent nothing for 5 minutes; the stall watchdog is set at 10, so undici gets there first —
that is what a long silent thinking phase dies of.
