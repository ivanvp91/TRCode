# Providers

Source of truth: `src/provider/registry.ts`. Credentials: `src/provider/credentials.ts`,
OAuth device flow: `src/provider/oauth.ts`. Login UI: `src/ui/login.ts`.

A provider decides three things and nothing else: the base URL, the headers, and — when
the host does not publish it — the dialect, either one for the whole host (`protocol`) or
one per model (`endpoints`, for a gateway that serves several). Everything downstream
(retries, effort probing, caching, trimming) is shared.

Model ids carry the provider as a prefix; the default one carries none:

```
moonshotai/kimi-k3            → tokenrouter (default, unprefixed)
kimi:k3                       → kimi, subscription host
claude:claude-opus-4-5        → claude (Anthropic console key)
openrouter:z-ai/glm-5.2       → openrouter
opencode:claude-opus-5        → OpenCode Zen (aka zen)
opencode-go:kimi-k3           → OpenCode Go subscription (aka go, zen-go)
alibabacloud:qwen3.8-max      → Alibaba (aka qwencloud, modelstudio, dashscope)
```

## tokenrouter (default)

| | |
|---|---|
| base URL | `https://api.tokenrouter.com/v1`, repointable with `--base-url` / config `baseUrl` |
| auth | `Authorization: Bearer <config.apiKey>` |
| catalog | `GET /models`, live; carries **no** `context_window`, so windows come from the tables in `models.ts` |
| dialects | all three — the catalog's `supported_endpoint_types` decides per model |

Serves other vendors' models under vendor namespaces (`moonshotai/…`, `anthropic/…`,
`openai/…`), and mixes image, video, audio and embedding models into the same list. Only
`chatCapable` ones can be driven from here; `/model` hides the rest unless
`hideIncompatibleModels` is off.

## kimi

Two modes, two different hosts, two different dialects.

**oauth — the Kimi Code subscription**
- base URL `https://api.kimi.com/coding/v1`, protocol **anthropic** (forced, not sniffed).
- Seeded ids: `k3` (1M), `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed`.
- Required headers (`KIMI_HEADERS`): `User-Agent: kimi-code/0.27.0`,
  `X-Msh-Platform: cli`, `anthropic-version: 2023-06-01`. The host answers **403** without
  them. Undocumented — overridable in config → `providers.kimi.headers`.
- Device flow: `auth.kimi.com/api/oauth/{device_authorization,token}`. Tokens refresh
  automatically; a burst of parallel requests refreshes once (`refreshing` map).
- A login the vendor's own CLI already did is reused: `~/.kimi-code/credentials/*.json`,
  device id from `~/.kimi-code/device_id`.

**apikey — pay per token**
- base URL `https://api.moonshot.ai/v1`, protocol **openai**, live catalog, no seed.

## claude

- base URL `https://api.anthropic.com/v1`, protocol **anthropic**.
- Auth header is `x-api-key` (not Bearer) — Anthropic rejects a request carrying both.
- `anthropic-version: 2023-06-01` on every request.
- Live `GET /v1/models`; seed (`CLAUDE_MODELS`) is the cold start and the fallback when a
  lapsed plan makes the listing fail: opus/sonnet/haiku 4.5, 200k each.
- Console key only. Pro/Max OAuth is deliberately absent: those plans are scoped to
  Anthropic's own applications.

## openrouter

- base URL `https://openrouter.ai/api/v1`, everything through `/chat/completions`
  (protocol **openai**), including models whose vendor has a native dialect.
- The best catalog of the lot: real windows and prices under `top_provider`, modalities
  under `architecture.output_modalities`. Nothing is seeded — the listing beats any table.
- Attribution headers `HTTP-Referer` + `X-Title: trcode`; without them calls show up
  anonymously.
- A hundred namespaces deep; `VENDOR_LABELS` + `prettyNamespace` keep the picker readable.

## opencode (aka zen, opencode-zen, opencodezen)

OpenCode Zen — the gateway the `opencode` agent buys its models through. One key, a
curated list (~60 ids), no subscription mode.

- base URL `https://opencode.ai/zen/v1`, key from `opencode.ai/auth`.
- **`authHeader: "both"`.** `/messages` reads only `x-api-key`; `/chat/completions` and
  `/responses` read only `Authorization: Bearer`. Each answers `401 Missing API key` to
  the header it is not looking at, so one credential goes out as both. (Anthropic itself
  refuses a request carrying both — that is why this is a per-mode setting.)
- `anthropic-version: 2023-06-01` on every request — required by the `/messages` half of
  the host, ignored by the rest, so it is not decided per model.
- Live `GET /zen/v1/models` — but it carries **ids only**: no windows, no prices, no
  endpoint types. Nothing is seeded; windows come from `CONTEXT_RULES`, which read the
  bare names Zen publishes (`claude-opus-5`, `kimi-k3`).
- **`publicCatalog: true`.** That listing is served to anyone, key or not, so a listing
  that succeeds proves nothing about the credential — a mistyped key would log in and
  report "63 models available". `verifyProvider` sends `probeAuth` instead: a POST to the
  first listed model with an empty message list, in that model's dialect. Nothing is
  billed, nothing is waited for, and only `401` counts as a failure — `402`/`403` mean the
  key is real and the plan or the entitlement is not, which the login must not delete it
  over.

**The one provider here that serves several dialects on one host.** Zen keeps each model
on its vendor's own shape, and its catalog says which for none of them, so the split is
carried in `ZEN_ENDPOINTS` (`registry.ts`) and applied per model:

| models | endpoint type | path |
|---|---|---|
| `gpt-*`, `grok-*`, `muse-spark-*` | `openai-response` | `/responses` |
| `claude-*`, `qwen*` | `anthropic` | `/messages` |
| `gemini-*` | `gemini` | Google's `/models/<id>:generateContent` — **not drivable** |
| everything else (kimi, glm, deepseek, minimax, big-pickle, the `-free` ones) | `openai` | `/chat/completions` |

This is what `ProviderMode.endpoints` exists for: a list of `{ match, endpoint }` matched
against the bare model name, first hit wins, anything unmatched falling back to
`ProviderMode.protocol`. It is stated as endpoint **types** rather than protocols because
that is the vocabulary the catalogs use, and because it also covers endpoints this client
cannot drive at all — `gemini` reaches `incompatibleReason` as *native Gemini endpoint*
and `usableModels` drops it, instead of the model being offered and failing on the first
request.

Two places read the rules, through `endpointFor(mode, model)`:
- `protocolForModel` — the dialect for a request, without the catalog having to be loaded.
- `stampProviderFacts` (`models.ts`) — fills `endpoints`, and `pricing` from
  `ProviderMode.prices`, on live catalog entries that arrived bare; the endpoints are what
  fix `chatCapable` and the picker. Only for providers that declared rules, and only where
  the host itself said nothing.

## opencode-go (aka go, opencodego, zen-go, zengo)

The $10/month subscription half of the same console — ~27 open models, on
`https://opencode.ai/zen/go/v1`. Same auth shape as Zen (`authHeader: "both"`,
`anthropic-version`, `publicCatalog`, ids-only listing).

**A separate provider, not a second mode.** It is a different subscription with a
different key, and credentials are one file per provider — a second mode would mean the
two keys evict each other. Two providers also give `kimi-k3` two ids
(`opencode:kimi-k3`, `opencode-go:kimi-k3`), which is what `sameModelElsewhere` needs to
move a session from one to the other.

`GO_ENDPOINTS` is **not** `ZEN_ENDPOINTS`:

| models | endpoint type | path |
|---|---|---|
| `gpt-*`, `grok-*`, `muse-spark-*` | `openai-response` | `/responses` |
| `qwen*`, `minimax*` | `anthropic` | `/messages` |
| everything else (glm, kimi, deepseek, mimo, hy3) | `openai` | `/chat/completions` |

MiniMax is the tell: `/messages` here, `/chat/completions` on Zen. No Claude and no Gemini
in the roster at all. That is why the table lives per mode rather than per vendor.

**Prices** (`GO_PRICES`, `ProviderMode.prices`) are carried because the plan's limits are
denominated in dollars — $12/5h, $30/week, $60/month — so `/cost` is the meter for the
subscription, not a curiosity. Published by OpenCode 2026-08-20 (`opencode.ai/docs/go`),
`cachedInput` included: on an agent turn the cached read is most of the bill (their own
figures: 50–86k cached against ~1k fresh per request). Tiered models are carried at their
base tier — DeepSeek off-peak (peak doubles, 01:00–04:00 and 06:00–10:00 UTC), Qwen `-plus`
short-context. Six ids the listing has and the table does not price (`kimi-k2.5`, `glm-5`,
`qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`, `hy3-preview`) are left unpriced. Merged by
`stampProviderFacts`, so a price the host states and a price the user pinned both win.

## alibabacloud (aka qwencloud, modelstudio, dashscope)

The same platform sold under several names, on several hosts — a key issued for one host
is rejected by the others, so the login asks which:

| host | url |
|---|---|
| Model Studio · international | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Model Studio · China | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Token Plan · Singapore | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| workspace / other region | `https://<workspace-id>.<region>.maas.aliyuncs.com/compatible-mode/v1` |

- Protocol **openai**. Keys: `sk-…` pay-as-you-go, `sk-sp-…` Token Plan.
- Seeded `QWEN_MODELS` (max / plus / flash / turbo / coder) because the listing is scoped
  to the workspace.
- **Content filter**: ordinary source code can come back as `400 DataInspectionFailed`.
  The `X-DashScope-DataInspection` header that disables it is entitlement-gated — an
  account without the entitlement gets `403 Header.AccessDenied` on *every* request, which
  is worse. An account that has it puts the header in
  config → `providers.alibabacloud.headers`. A refusal like this is a verdict on the whole
  conversation, so the client offers to continue at another host that serves the same
  model (`sameModelElsewhere`).
- Token Plan is also the host that complains about "adaptive thinking" when it means the
  reasoning parameter — see `protocols.md`.

## Per-provider config

```jsonc
// ~/.trcode/config.json
"providers": {
  "alibabacloud": {
    "baseUrl": "https://…/compatible-mode/v1",   // pinned host
    "headers": { "X-DashScope-DataInspection": "…" },
    "models": ["qwen3.8-max", "qwen3-coder-plus"] // replaces the seed list
  }
},
"defaultProvider": "kimi",
"providerState": { "kimi": { "model": "k3", "effort": "high" } }
```

`modeConfig(providerId, mode)` merges these over the built-in definition; nothing else
should read the overrides directly.

## Adding aliases, not entries

A host rebranded is not a second provider: add the name to `aka` and it resolves
everywhere (`/login`, `/provider`, `-m name:model`). A second entry would list the same
catalogue twice under two names and split the remembered model and credential.
