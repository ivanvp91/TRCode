# Checklists

## Adding a provider

1. **Find out what it really is.** Base URL, dialect, auth header, whether
   `GET {baseUrl}/models` returns anything usable, and whether the host is the same for
   every account. A per-account host is a question at login (`hostHint` + `hosts`), not a
   constant. A gateway may serve **several** dialects on one base URL — check the vendor's
   own model table before assuming `/chat/completions` covers it; Zen does not.
2. `PROVIDERS` in `src/provider/registry.ts` — one `ProviderDef`:
   - `id` (lowercase, never collides with a model alias — that is why Alibaba's entry is
     not called `qwen`), `label`, `keyHint`.
   - `aka` for other names the same platform is sold under.
   - `modes`: `apikey` and/or `oauth`. Per mode: `baseUrl`, `protocol` (only when the host
     serves exactly one shape), `endpoints` (per-model rules when it serves several — see
     `ZEN_ENDPOINTS`), `listModels`, `seed`, `authHeader`, `headers`.
   - `oauth` (device flow config), `importFrom`, `deviceIdFrom` when the vendor ships its
     own CLI whose login can be reused.
   - `publicCatalog` when `GET /models` answers without a credential — otherwise the login
     verifies nothing and accepts a typo.
   - `prices` only when the host serves a catalog without them **and** the number changes
     what the user does — a plan whose limits are counted in dollars. Vendor's published
     figures, with the date, and nothing guessed for the ids they left out.
3. **Seed list** only when the host will not enumerate (subscription endpoints answer 402
   when a plan lapses). Ids and windows as the vendor publishes them.
4. Nothing else needs touching: `resolveAuth`, the catalog merge, the picker, `/login`,
   `/provider` and the `provider:model` syntax all read the registry.
5. Tests: `test/provider-test.mjs` (registry shape, id splitting, overrides) and
   `test/protocol-test.mjs` (dialect selection). Add the new host to whichever asserts the
   behaviour you relied on.
6. README lists the connected providers — update it.

## Adding or correcting a model family window

1. Prefer a rule in `CONTEXT_RULES` (`models.ts`) over an entry in `KNOWN_CONTEXT`:
   catalogs rename models faster than a table can follow.
2. Match against the bare, lowercased name. Put the newer, larger rule **before** the
   older one and give it `from: <version>`; `versionOf` reads the first number in the name.
3. Only the vendor's published figure, and only when you are sure — the fallback is 128k
   and it is safe.
4. `NAME_VENDOR` / `VENDOR_LABELS` if the family's vendor would otherwise read wrong in
   the picker.

## Adding a dialect

1. `Protocol` in `protocol.ts`, plus the endpoint name the catalog uses in `protocolOf`
   and in `isChatCapable` (`models.ts`).
2. A builder module beside `anthropic.ts` / `responses.ts`: request body, message
   conversion, an SSE parser producing the shared `StreamEvent`s, and usage extraction.
3. `buildBodyFor` and the streaming dispatch in `client.ts`.
4. An effort ladder entry in `EFFORT_LADDER` — an empty one means the dialect takes no
   reasoning parameter.
5. `test/protocol-test.mjs` and the mock server (`test/mock-server.mjs`) need to speak it.

## Diagnosing a failing host

```
/model                 → what is actually selected, and at which provider
/models all            → whether the catalog even lists it
/context               → window in use and where the number came from
/effort                → the reasoning form learned for this model
/cost                  → whether prices are known for the session
TRCODE_DEBUG=1         → per-request token counts in the status line
```

Then read the status: 401 credential, 402 plan, 403 header/entitlement, 400 reasoning or
cache or content filter, 429 window. `protocols.md` has the handling for each. A refusal
that repeats identically on the same history is a verdict, not a hiccup — switch hosts
(`sameModelElsewhere`) instead of retrying.

## Before you finish

```
npm run typecheck && npm test
```

Everything runs against the local mock server: no key, no network.
