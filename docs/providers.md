# Provider reference

[Back to README](../README.md)

- [The key](#the-key)
- [Other providers](#other-providers)

## The key

```bash
trc auth login --provider tokenrouter   # asks for the TokenRouter key and verifies it
trc auth status
```

If you get **401 "Invalid API key"**:

```bash
trc auth status                                  # shows the host and a masked key
trc auth login --provider tokenrouter --base-url https://your-host/v1   # another endpoint
trc auth login --provider tokenrouter --force     # save without verifying
```

Unless `--force` is used, the key is saved only after it verifies. A pasted key is stripped of bracketed-paste markers, whitespace
and quotes, so invisible terminal noise never ends up inside it.

## Other providers

TokenRouter is the default, but the platform is cross-platform by design: a model can be
reached at its own vendor instead — useful when you already pay for a subscription there
and would rather spend the plan than the router's per-token price. Twelve providers are
built in, and each remembers its own model, reasoning budget and host.

```bash
trc auth login                          # connects the provider in use
trc auth login --provider kimi          # asks: subscription or API key
trc auth login --provider claude        # Anthropic console key
trc auth login --provider openrouter    # OpenRouter key (sk-or-…)
trc auth login --provider opencode      # Zen API key; /login zen works too
trc auth login --provider opencode-go   # Go subscription API key; /login go works too
trc auth login --provider openai        # ChatGPT subscription or an API key
trc auth login --provider gemini        # Google AI Studio API key
trc auth login --provider alibabacloud  # QwenCloud key; asks which host it is for
trc auth login --provider xai           # SuperGrok subscription or a console.x.ai key
trc auth login --provider meta          # Meta Model API key (Muse); /login muse works too
trc auth login --provider zai           # Z.AI / bigmodel key; asks which host it is for
trc auth login --provider kimi --oauth  # subscription, via an OAuth device code
trc auth login --provider kimi --key    # Moonshot platform key, pay per token
trc auth status                         # every provider, one line each
trc auth logout --provider kimi
```

Without `--provider`, `login` and `logout` act on the provider in use — the default one
outside a session. Naming `tokenrouter` reaches the router explicitly. `/login` inside a
session follows the same rule, so it asks for a Kimi credential while you are on Kimi
rather than for a router key.

The subscription path is an OAuth 2.0 device flow (RFC 8628): the CLI prints a URL and
a code, you approve them in a browser on any machine, and the access token is renewed
automatically from then on. A host with no device grant (OpenAI's ChatGPT sign-in) uses
authorization code + PKCE instead: the CLI listens on a loopback port, opens the page,
and finishes the login when the browser redirects back — so that browser has to run on
the same machine. If the vendor's own CLI is already logged in on this
machine, supported providers may reuse that session — pass `--fresh` to force a new
authorization. ChatGPT uses its own TRCode registration and never imports Codex tokens.

Meta may reuse the credential left by `muse login`, with a warning about subscription
restrictions. Its supported third-party path is a pay-as-you-go API key.

### OpenAI / ChatGPT

Choose **Continue with ChatGPT** or run `trc auth login --provider openai --oauth`.
Eligible Plus and Pro users can authorize TRCode to use their plan. The browser registers
TRCode under its own name and asks for plan-usage permission. Signing in without that
permission saves the account but does not enable model requests.

On later logins, choose a saved account or add a different account/workspace. Each
registration keeps its own tokens and model catalog. Returning sign-in reuses the issued
client ID and this installation's host ID. The account appears in `/provider` and
`trc auth status`.

Requests use `https://api.openai.com/v1/responses` with streaming and `store: false`.
TRCode verifies the signed ID token, keeps credentials in protected profile files under
`~/.trcode/auth/openai-profiles/`, and serializes token renewal across processes.
The active `auth/openai.json` contains a profile reference. No Codex client ID, identity
headers or private ChatGPT backend endpoints are used.

Use `trc auth logout --provider openai` to revoke the selected renewable session and
clear its local tokens. Its registration and the installation's host ID are retained
for a later sign-in. If remote revocation cannot be confirmed, TRCode says so.
Review plan usage and app limits in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).
An API key remains a separate, usage-billed option: `trc auth login --provider openai --key`.

Existing logins made with the old Codex-compatible flow require a new TRCode sign-in.
See [OpenAI's official integration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

### Google Gemini

Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey), then run:

```sh
trc auth login --provider gemini
trc -m gemini
```

TRCode uses Google's documented [OpenAI-compatible Gemini API](https://ai.google.dev/gemini-api/docs/openai).
It does not import Gemini CLI sessions, register as Gemini CLI, or call Code Assist.
Legacy Google-account logins require reconnection with an API key. Google's
[Gemini CLI terms](https://geminicli.com/docs/resources/tos-privacy/) prohibit direct
third-party use of the services behind Gemini CLI through its OAuth credentials.

Google also documents [Gemini API OAuth](https://ai.google.dev/gemini-api/docs/oauth)
with an application's own Google Cloud project and OAuth registration. That is separate
from Gemini CLI subscription access; TRCode currently supports the API-key path.

Models from a direct provider carry its name as a prefix and group under it in `/model`:

```bash
trc -m kimi:kimi-for-coding
trc -m kimi                 # alias created at login, points at the first model
```

In a session, `/provider` switches between them:

```
/provider                 # list with connection status; Enter switches, and
                          # picking one that is not connected logs in first
/provider kimi            # switch straight to it
/provider default kimi    # pin one as default without switching to it now
/provider logout kimi     # disconnect; the session falls back to the default model
```

For an unconnected TokenRouter account, run `/login tokenrouter` first, then select
it in `/provider`. Other unconnected providers start login when selected in the panel.

Switching makes that provider the default, so the next start opens on it — on the model
and reasoning budget it was left with. Naming a model from another provider (`/model
kimi:k3`) counts as switching and moves the default too.

Each provider remembers its own model and reasoning budget, so switching back returns you
to where you left it rather than to its first model — what a subscription charges for
thinking, and what it is worth there, does not carry over to the next host. Switching to a
provider for the first time picks the alias login created, else the configured default
when it belongs there, else its first model.

`/model` opens the catalog as a panel: type to filter, ←/→ for the output type, and the
buttons along the foot do what the sub-commands used to — refresh the catalog, widen the
list to every provider, pin the default, jump to `/provider`. It shows the current
provider's models only, since the others cannot serve this session and listing them among
the ones that can is a way to pick a 404; `/model all` opens it wide, `/model refresh`
re-reads the catalog past its cache, and `/model <name>` still finds one anywhere and
switches provider along with it. The provider in use is named in the status line under the
input, where the routing prefix is dropped as redundant:

```
   yolo  Kimi  k3  thinking: high                    context: 3% (23k/1M)
```

The header at the top states them too. A header already on screen is output, not a live
region, so it cannot be edited — instead switching the provider, the model or the
reasoning budget **repaints the screen** and prints the header again, which is the only
way for it to stay true. The transcript remains in the terminal's scrollback, and `/clear`
does the same thing on demand.

Kimi's subscription host does not enumerate its models — and answers 402 to the attempt
once a plan lapses — so the published set is carried in the client:

| Model ID | Version | Context |
|---|---|---|
| `kimi:k3` | Kimi K3 | up to 1M |
| `kimi:k3-256k` | Kimi K3 | 256k, cheaper on quota |
| `kimi:kimi-for-coding` | Kimi K2.7 Code | 256k |
| `kimi:kimi-for-coding-highspeed` | K2.7 Code HighSpeed | 256k, ~5–6× faster output |

Which of them you may actually call depends on your plan. If Kimi adds one before this
client does, `config.json` → `providers.kimi.models` pins your own list.

Credentials for direct providers live in `~/.trcode/auth/<provider>.json`.
The TokenRouter key is stored separately in `~/.trcode/config.json`.

Claude is API key only. A Pro/Max subscription could be reached with the OAuth client
Claude Code carries, but Anthropic's terms scope those plans to their own applications —
so that path is deliberately absent rather than merely undocumented. The key goes in
`x-api-key`, which is what Anthropic reads for its own keys.

OpenRouter is a second router: one key, every vendor, all through
`/chat/completions` — including the models whose vendor has a native dialect of its own.
It is also the only catalog here that publishes real context windows and prices, so
nothing about its models is guessed. Requests carry `HTTP-Referer` and `X-Title` so they
show up under this client on openrouter.ai rather than as an anonymous key.

OpenCode Zen is the gateway behind the `opencode` agent, and a third router: one key over
a curated list — the Claude, GPT, Gemini, Grok, Kimi, GLM, MiniMax, DeepSeek and Qwen
lines, plus a handful of free ones. It answers to `zen` as well, so `/login zen` and
`-m zen:kimi-k3` reach the same key and the same list.

Zen and Go connect through API keys only. TRCode identifies itself with its own
`trcode/<version>` User-Agent and sends `x-opencode-session` for conversation routing.
If you previously signed in through the website, reconnect with
`trc auth login --provider opencode --key` or `trc auth login --provider opencode-go --key`.

Unlike the other routers it does **not** flatten everything into `/chat/completions`.
Each model is served on the dialect its own vendor speaks, under one base URL: GPT, Grok
and Muse Spark on `/responses`, Claude and the hosted Qwen on `/messages`, the rest on
`/chat/completions` — and the catalog says which for none of them, listing bare ids and
nothing else. So the split is carried in the client and applied per model, which is also
what puts reasoning effort and prompt caching in the right shape for each.

Gemini is the exception it cannot cover: Zen serves it on Google's own
`/models/<id>:generateContent`, a dialect this client does not speak. Those six models are
marked in the catalog rather than hidden silently, so `/model` says *native Gemini
endpoint* next to them instead of accepting the choice and failing on the first request.

Windows and prices are not published by that listing either, so they come from the family
rules — the same ones the router's own catalog leans on — and `/context` says when a
number is an estimate.

Two smaller things follow from one host wearing three faces. The key travels as both
`Authorization: Bearer` and `x-api-key`, because `/messages` reads only the second and the
other two only the first, and each answers *Missing API key* to the header it does not
look at. And the catalog is public — it lists for anyone, key or not — so a login cannot
be verified by fetching it: a mistyped key would be told it has sixty-odd models. So the
key is put to the request endpoint instead, as a call the host refuses either way (an
empty message list never reaches a model, and nothing is billed), and only *401* counts:
a plan that will not pay says something about the plan, not about the key.

**OpenCode Go** is the other half of the same console — a $10/month subscription over
~27 open models (Kimi, GLM, Qwen, MiniMax, DeepSeek, MiMo, Hy3, plus Grok 4.5, GPT 5.6
Luna and Muse Spark), on `https://opencode.ai/zen/go/v1`. It is a separate subscription
with a key of its own, so it is a separate provider rather than a second mode: both can be
connected at once, and `kimi-k3` served by each is two ids — `opencode:kimi-k3` and
`opencode-go:kimi-k3` — which is exactly what the failover offer needs to move a session
from one to the other. `/login go` and `-m go:kimi-k3` are the short way in.

Its dialect split is *not* Zen's — no Claude, no Gemini, and MiniMax on `/messages` where
Zen serves it on `/chat/completions` — which is why each host carries its own table rather
than sharing one.

Go's limits are counted in dollars rather than requests: **$12 per 5 hours, $30 a week,
$60 a month**. So the published per-token prices are what `/cost` meters the plan against,
and they are carried in the client, cached-input rate included — on an agent turn the
cached half is most of the bill. Two models are sold in tiers and are priced at their base
one (DeepSeek off-peak, Qwen's `-plus` short-context tier), and the six ids the listing has
but the vendor's table does not price are left unpriced rather than guessed. Anything here
is overridable per model in `config.json` → `pricing`.

**Meta** is the Muse line straight from the vendor: `https://api.meta.ai/v1`, one key from
dev.meta.ai, and `muse-spark-1.2` — a 1M-token agentic model — at **$1.25 / $4.25** per 1M
tokens with cached input at $0.15 and no long-context premium. The host serves all three
dialects under one base URL; requests go on `/responses`, which is what Meta documents for
agent work and where reasoning carries across turns — the same place Zen and Go already
route these models. It answers to `muse` as well, so `/login muse` and
`-m muse:muse-spark-1.2` reach the same key and the same list.

Its listing is key-gated and real, so it is both the catalog and the proof that a key
works; the published set — `muse-spark-1.2`, `muse-spark-1.2-contributor`,
`muse-spark-1.1` — is what the client falls back to when the listing fails. `muse-image` is
served on Meta's own image endpoint, which this client does not speak, so it is marked in
the catalog rather than offered and failed on.

`muse-spark-1.2-contributor` is the same model at a tenth of the price — **$0.10 / $0.20**
— because prompts and completions sent to it may be used to improve Meta products. Both
prices are carried in the client, so `/cost` states the difference rather than leaving it
to be discovered on the bill.

There is no subscription path here, and that is a decision rather than a gap. Meta sells
plans — Everyday, High and Power Usage, counted in requests per rolling five hours — but
scopes them to its own client: *"Your subscription only works through the Muse Code CLI
while signed in with your Meta Model API account"*, and any key issued on the same account
is billed pay-as-you-go regardless. That is the Claude Pro/Max case again: a plan its
vendor does not sell to third-party clients is not one this client reaches for. If Meta
publishes a grant third parties may use, the mode is a dozen lines away.

Alibaba Cloud is Model Studio (DashScope), reached through its OpenAI-compatible endpoint
— Qwen straight from the vendor, at the vendor's prices. The same platform is documented
as **QwenCloud** and as **Model Studio**, and the CLI answers to all of those names:
`/login qwencloud`, `/provider dashscope` and `-m qwencloud:qwen3.8-max` all reach the
`alibabacloud` provider, share its key and list its models once rather than three times.

Alibaba sells those models as several products, each on its own host, and **a key issued
for one is refused by the others** — with a plain `401 Incorrect API key provided`, which
says nothing about the host being the problem. So the login asks which one you have:

| Host | Key | What it is |
|---|---|---|
| `dashscope-intl.aliyuncs.com/compatible-mode/v1` | `sk-…` | Model Studio, pay-as-you-go |
| `dashscope.aliyuncs.com/compatible-mode/v1` | `sk-…` | the same, for accounts registered in China |
| `token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | `sk-sp-…` | the prepaid Token Plan |
| `<workspace-id>.<region>.maas.aliyuncs.com/compatible-mode/v1` | `sk-…` | a workspace deployment |

The Token Plan serves a short list — around a dozen models rather than Model Studio's
hundred and fifty — so the catalogue looks different depending on which host the key
belongs to. Changing hosts later costs no logout, because the key is still good:

```
/provider host                  # pick from the list
/provider host alibabacloud <url>   # or name it outright
``` Model Studio has no single host,
so the login asks for one: Enter takes the shared international host, and a workspace
account pastes its own. It can also be given straight away, or changed later in the
config:

```bash
trc auth login --provider alibabacloud https://<workspace-id>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
/login alibabacloud https://dashscope.aliyuncs.com/compatible-mode/v1   # China host
```

```json
{ "providers": { "alibabacloud": {
    "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" } } }
```

Its listing is scoped to the workspace, so when it comes back empty the client falls back
to the published set — `qwen3.8-max`, `qwen3.7-max`, `qwen3-max`, `qwen-plus`,
`qwen-flash`, `qwen-turbo`, `qwen3-coder-plus`, `qwen3-coder-flash` — with their real
windows. The listing states no types either, so speech, image and embedding models are
recognised by name and land in their own sections rather than among the chat models.

Model Studio also runs every request through a content filter, which reads ordinary
source code as inappropriate content often enough to matter. The refusal is a verdict on
the conversation, not a hiccup — the same history is refused every time — so the client
says so and names the same model at the other hosts you are connected to, which is the
only thing that actually continues the session:

```
⚠ Alibaba Cloud refused this conversation — its content filter, not the request.
  ❯ Continue on openrouter:qwen/qwen3.8-max
    Stop here
```

The offer appears when another connected host serves the same model. A refusal never
reaches the model, so the history is untouched and the turn simply runs again on the other
host; the switch then sticks for the session, because a host that refused this conversation
will refuse every later step of it too. It is asked rather than done — the conversation
moves to a different vendor, and that is not a detail of error handling. Declining, or
having no terminal to ask at, leaves the failure standing with the host's own words and a
list of the same model elsewhere. That list also follows a 402 and a rate limit that
outlived its retries.

Nothing is sent to disable it. The `X-DashScope-DataInspection` header that does is
entitlement-gated — an account without the entitlement gets `403 Header.AccessDenied` on
every request, which is worse than the filter. An account that has it adds the header
itself:

```json
{ "providers": { "alibabacloud": { "headers": {
    "X-DashScope-DataInspection": "{\"input\":\"disable\",\"output\":\"disable\"}" } } } }
```

A subscription host is reached through endpoints its vendor does not document, and it
checks that the client identifies itself the way their own CLI does. If either changes,
`config.json` → `providers` repoints the host and replaces the headers without waiting
for a release:

```json
{ "providers": { "kimi": { "baseUrl": "https://api.kimi.com/coding/v1",
                           "headers": { "User-Agent": "kimi-code/0.27.0" },
                           "models": ["k3", "kimi-for-coding"] } } }
```

Key and settings live in `~/.trcode/config.json` (mode 600). A save only rewrites the
keys it is changing: a running session holds its copy of the file for hours, and writing
that copy back would revert anything edited meanwhile — by hand, or by a second session. Environment variables
override them:

| Variable | Purpose |
|---|---|
| `TOKENROUTER_API_KEY` | the `sk-…` key |
| `TOKENROUTER_BASE_URL` | defaults to `https://api.tokenrouter.com/v1` |
| `TRCODE_MODEL` | default model |
| `TRCODE_HOME` | config directory (handy for isolation) |
