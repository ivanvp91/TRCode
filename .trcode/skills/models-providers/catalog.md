# The catalog: what a model is, how big, how much

Source: `src/provider/models.ts`. Config: `src/config.ts`. Picker: `src/ui/modelpicker.ts`.

## Where the list comes from

`fetchModels()` asks every **connected** provider in parallel and merges the results; a
host being down costs that host's entries and nothing else.

```
live GET {baseUrl}/models   →  cache (6h, ~/.trcode/models.cache.json, keyed by provider+baseUrl)
        ↓ fails                 ↓ stale
   stale cache                seed list (ProviderMode.seed, or SEED in models.ts for TokenRouter)
```

`normalize()` reads whatever metadata the host happens to expose, defensively:
`context_window | context_length | max_context_tokens | top_provider.context_length`,
pricing under `pricing | price` in `$/token` **or** `$/1M` (values under `0.001` are
scaled up), `supported_endpoint_types`, `tags`, `architecture.output_modalities`.

`decorate()` then overlays, in this order: user config → live value → seed → derived.

## Context windows

Not published in any stable shape, so:

1. `config.contextWindows[id]` — pinned by the user (`/context 500k`, `/context auto` to
   clear). Always wins.
2. Whatever the catalog reported.
3. The seed entry.
4. `KNOWN_CONTEXT[id]` — exact ids only.
5. `CONTEXT_RULES` — family rules matched against the **bare** name (provider prefix and
   vendor namespace stripped), with an optional `from` version: a family that grew its
   window at a release keeps the old number behind the new rule
   (`qwen…max` is 1M from 3.7, 262k before; `claude` is 1M from 5, 200k before; `kimi` is
   1M from K3, 262k before; `gpt-5` is 1M from 5.4, 400k before; `glm` 1M from 5.2;
   `deepseek` 1M from 4; `minimax-m` 1M from 3).
6. `ASSUMED_CONTEXT` = 128k, and `/context` says so.

Never guess upward. An overstated window is not caught until a host rejects a request;
an understated one only compacts the session earlier than it had to. `contextWindowFor()`
is what the loop trims against (half the window unless `maxRequestTokens` is pinned).

## Prices

`config.pricing[id]` → catalog → seed. Normalised to `$/1M` in and out. `/cost` reports
the session from these numbers, so a missing price makes a turn look free rather than
expensive — pin it rather than leaving it blank when it matters.

## What can actually be driven

`chatCapable` is false for image/video/audio/embedding models and for native-Gemini
endpoints — there is no adapter for those. `/model` hides them while
`hideIncompatibleModels` is on (the default); `incompatibleReason()` explains a specific
one. Modality is read from endpoints, then tags, then output modalities, then the name
(`NAME_MODALITY`) for catalogs that state nothing at all.

## Names: aliases, prefixes, vendors

`resolveModelId(input, catalog)` in order: config alias → exact id → provider-alias
normalised id → exact tail match on the bare name → unique prefix → unique substring;
several candidates raise an "Ambiguous" error rather than picking one. Defaults in
`config.aliases`:

```
k3 free smart code fast deep cheap qwen glm grok sol terra luna opus fable sonnet gpt oss mini
```

`/aliases` lists them, `/default` pins the default model, `/model` switches this session,
`/models [all]` prints the catalog by vendor.

`vendorOf()` files a model under *whose model it is*, read from the id, not under the host
that resells it — a reseller's catalog is a hundred vendors deep, and filing all of it
under the reseller is a list nobody can navigate. `VENDOR_RANK` pins Kimi, MoonShot,
Anthropic, OpenAI, Qwen, xAI to the top; inside a vendor, newest `created` first with
dated snapshots (`-2026-05-17`, `-2512`) sunk below the undated id.

## Which model runs what

| setting | what it drives |
|---|---|
| `model` | the default model of a new session |
| `smallModel` | cheap side work |
| `promptModels` / `modelPrompts` / `promptMode` | the prompt rewriter |
| `subagentModels` | models offered to `task` |
| `brainModels` | the `/brain` panel |
| `providerState[id]` / `projectState[cwd]` | the model and effort remembered per provider and per project |

`sameModelElsewhere(id, catalog)` finds the same bare name at another connected provider —
that is the failover offered when a host's content filter refuses the conversation.
