---
name: models-providers
description: Everything this CLI knows about models and providers — which host serves a model, which wire dialect it speaks, how reasoning effort, prompt caching, context windows and prices are decided, and how to add a provider or a model family. Use for any work on src/provider/*, for "which model should I use", pricing and context questions, and for 400/401/403/429 from a host.
description_ru: Всё, что этот CLI знает о моделях и провайдерах — какой хост отдаёт модель, на каком диалекте говорит, как выбираются reasoning effort, кэш, окно контекста и цены, как добавить провайдера или семейство моделей. Для любой правки в src/provider/*, вопросов «какую модель взять», про цены и окно, и для 400/401/403/429 от хоста.
triggers: провайдер, провайдера, провайдеры, provider, providers, модель, модели, моделей, моделью, model, models, каталог моделей, model catalog, tokenrouter, openrouter, opencode, opencode zen, zen, opencode go, moonshot, kimi, dashscope, model studio, alibabacloud, qwencloud, окно контекста, context window, цена токенов, цены на модели, pricing, стоимость модели, reasoning effort, thinking budget, prompt caching, кэш промпта, cache_control, chat completions, responses api, anthropic messages, протокол модели, wire protocol, api key, base url, oauth провайдера, лимит запросов, rate limit, добавить провайдера, add a provider, сменить модель, какую модель
---

# Models and providers in trcode

## When to apply
Any work that touches `src/provider/*`, `/model`, `/login`, `/context`, `/effort`, model
aliases or prices — and any question about which model to run, what it costs, how much
context it holds, or why a host answered 400/401/403/429.

## Procedure

### 1. Read the map before the file
The reference files ship next to this skill. Open the one the task is about — do not
reconstruct the rules from the code every time, and do not answer from memory about a
vendor's ids or prices:

- `providers.md` — every provider, its hosts, auth modes, required headers, quirks.
- `protocols.md` — the three wire dialects, reasoning effort, prompt caching, errors.
- `catalog.md` — how the model list, context windows, prices and aliases are decided.
- `adding.md` — checklists for a new provider, a new model family, a new dialect.

### 2. Establish which model and which host you are talking about
A model id carries its provider: `kimi:k3`, `alibabacloud:qwen3.8-max`. No prefix means
TokenRouter. Same bare name at two hosts is the same model reached two ways — that is what
failover uses. `splitModelId` / `qualifyModelId` / `wireModelId` in `registry.ts` are the
only places that should parse an id.

### 3. Never hardcode what the catalog can answer
Windows, prices, capabilities come from the live catalog first, the user's config second,
the tables in `models.ts` third. Adding a number to a table is a last resort, and it goes
in with the vendor's published figure and the date it was published.

### 4. When a host refuses
Read the status and the body before changing the payload — each has one meaning here:
401 credential, 402 lapsed plan, 403 missing header or entitlement, 400 either the
reasoning parameter, the cache field, or the content filter, 429 a real limit with a
window in its text. `protocols.md` has the exact handling for each; the client already
degrades on most of them, so the fix is usually to widen a matcher, not to add a retry.

### 5. Verify with the offline suites
`npm run typecheck && npm test`. Provider work is covered by `test/provider-test.mjs`,
`protocol-test.mjs`, `cache-test.mjs`, `ratelimit-test.mjs` — all against the local mock
server, no key and no network. A change to a wire body that no suite notices needs a case
adding to one of them.

## What not to do
- Do not invent model ids, prices or windows. If it is not in the catalog, the config or
  the reference files, say it is unknown and how to find out.
- Do not send a vendor-specific field through the shared path. Anthropic-only fields
  (`cache_control`, `thinking`) live in `anthropic.ts`, Responses-only ones in
  `responses.ts`.
- Do not add a retry loop for a refusal that is a verdict — a content filter and a lapsed
  plan answer the same way every time.
- Do not pin `contextWindow` per model when the family rule in `CONTEXT_RULES` covers it.
- Do not assume a host lists its models; `listModels: false` providers exist and are
  served from `seed`.

## Answer format
State the model, the provider it resolves to, the dialect and the window when any of them
matter to the answer. For a code change, name the file and the function; for a "which
model" question, give one recommendation with the trade-off in a sentence, not a table of
every option.
