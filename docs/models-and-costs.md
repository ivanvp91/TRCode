# Models, context and costs

[Back to README](../README.md)

- [Token spend](#token-spend)
- [Models](#models)
- [Reasoning budget (effort)](#reasoning-budget-effort)
- [What a turn costs](#what-a-turn-costs)
- [Rate limits](#rate-limits)
- [Context window](#context-window)
- [Configuration](#configuration)

## Token spend

An agent loop resends the whole history on every step, so a long session costs
quadratically in input tokens — that is where bills like "2.2M in, 44k out" come from.
Most of that bulk is tool output (file dumps, greps) the model has already read and acted
on.

So before each request **old tool results are shortened** to their first lines with a note
that the rest was omitted. Nothing is dropped, `tool_call` ↔ `tool` pairing stays intact,
the last few messages are left untouched, and the session keeps the full text — only the
outgoing copy is cut. Two limits do the cutting, and they answer different problems.

`maxRequestTokens` is the budget for the whole request. `maxToolResultBytes` is a ceiling
on **one** old result, applied even when the request is inside the budget — otherwise a
single 400KB file read rides along on every step until the entire history finally crosses
the threshold. Measured on a 12-round session that reads a 24KB file each round (bytes of
real requests, `test/measure-tokens.mjs`):

| Setting | Sent | Saved |
|---|---|---|
| no limits | 1950 KB | — |
| budget 60k | 1719 KB | 12% |
| budget 40k | 1303 KB | 33% |
| budget 25k | 1118 KB | 43% |
| **budget 40k + cap 12k (default)** | **1182 KB** | **39%** |
| budget 25k + cap 12k | 1182 KB | 39% |
| cap 12k, no budget | 1182 KB | 39% |
| budget 40k + cap 12k, `trimKeepRecent: 4` | 777 KB | 60% |

Two things worth reading off that table. Once the per-result cap is on, **lowering the
budget buys nothing** — the cap has already shortened everything the budget would have
reached, so 40k and 25k send the same bytes. And the biggest remaining lever is
`trimKeepRecent`: protecting 4 recent messages instead of 8 saves another 20 points —
which is why 4 is the default. The regression to watch for is the model re-reading a file
it was working from; raise it back to 8 in `config.json` if a session starts doing that.

When results are smaller than the cap it does nothing at all — the same session with 6KB
reads sends 581 KB with the cap on or off.

```json
{ "maxRequestTokens": 40000, "maxToolResultBytes": 12000, "trimKeepRecent": 8, "trimMinBytes": 400 }
```

Set either limit to `0` to disable it.

Tool output is also bounded at the source: `shell` keeps the first 20k characters and the
**last** 20k, marking what it dropped in between. Cutting only at the head loses the
summary line a test run exists for, and the model then reruns the command to see it.

The second safeguard is auto-compaction, and it runs as a ladder — the cheap losses
first, the lossy one only when the window is nearly gone. It is checked twice, before a
turn and again between tool rounds, because a turn that reads a hundred files overflows
inside itself, not between prompts:

| Share of the window | What happens | What it costs |
| --- | --- | --- |
| `autoCompactLightAt` (0.25) | old tool output shrinks to a stub, old thinking is dropped; the last few turns are untouched | no model call, nothing thrown away that cannot be re-read |
| `autoCompactMediumAt` (0.5) | older history becomes a handoff summary; the working tail (last ~12 messages) stays verbatim | one summariser call, the tail survives |
| `autoCompactAt` (0.9) | full compaction: a handoff summary plus the recent **user** messages verbatim (up to 20k tokens) | one summariser call, assistant turns and tool traffic are gone |

Each rung is rationed per cycle — **3 light passes and 2 medium ones**, then the ladder
waits for the next threshold instead of repeating a rung that has had its chances. Without
that, a history hovering just above 25% would be trimmed on every turn and never reach 50%.
Three is where the maths lands: a light pass can only reclaim tool output that has aged out
of the kept tail, so the number of passes needed to climb from 25% to 50% is `1/(1−φ)` for a
tool share φ — with coding turns at roughly φ ≈ 2/3 that is 3. Two mediums is one effective
pass plus a retry; a medium pass at the 50% mark frees about a third of the window, so a
third one would need that much fresh growth again. A full pass rewrites the history and
starts a new cycle; the counters are saved with the session.

The full pass keeps the user's own words because the task and its corrections are the one
thing a model cannot rediscover by reading the workspace, while assistant turns and tool
traffic are exactly what grows without bound.
It used to also fire at twice `maxRequestTokens`, which
sounded like a safety net and behaved like a trap — that budget is the on-the-wire trim, not
the window, so on a 1M-token model it compacted at 80k, throwing away a history the model
could still hold whole. Compaction loses detail, so the lossy rungs wait for the window to fill.

`/compact [focus]` compacts on demand with the full rules; `/compact auto on|off` (or the
**Context** row in `/settings`) turns the ladder off entirely, leaving `/compact` manual.
`/cost` shows where the tokens went.

A host that answers a transient upstream failure — a 503 “Endpoint is unavailable” from a
proxy that is restarting, a 502/504 — is not taken for a verdict: the same request is resent
up to `upstreamRetries` times (10 by default) `upstreamRetryDelayMs` apart (10 s), and each
pause is announced in the transcript with its attempt number. Esc cancels the wait. Retries
live in the provider client, so they cover a turn's own requests, titles and compactions
alike.

The third safeguard is the provider's prompt cache. On the OpenAI path it applies by
itself; on the **Anthropic** path nothing is cached unless the request says where, so
TRCode marks the system prompt, the tool schemas and the end of the history as cache
breakpoints. Measured against the live API with a 4.8k-token prompt:

| Request | Input | Of it cached |
|---|---|---|
| first | 4834 | 0 |
| identical repeat, `promptCache: false` | 4834 | 0 |
| identical repeat, default | 4834 | **4832** |

Two things follow from that, and both are implemented: the workspace listing in the
system prompt is snapshotted per directory (creating one file used to rewrite the prefix
and miss the cache for the rest of the session), and trimming shortens only the copy that
goes on the wire, byte-for-byte the same on every step. If a host rejects `cache_control`,
the first 400 is caught, the field is dropped and the request is retried once — set
`"promptCache": false` to skip even that probe.

The cheapest tokens are the ones never fetched, so the system prompt spends ~150 of its
own on saying how: delegate anything needing more than three files to a read-only subagent
(its reading stays in *its* context), grep for the line before reading around it with
offset/limit, never `cat` a file through the shell, never re-read a file already in the
transcript, prefer `edit` over rewriting. The prompt is 757 tokens and `test/prompt-test.mjs`
holds it under 900 — it rides along on every request, so it is measured, not just written.

Past half the window, the turn footer says so once per threshold:

```
   History is ~62k tokens (62% of the window) and every step re-sends it.
   /compact digests it, /new starts clean.
```

Reasoning tokens are counted separately, because they bill as **output**: a three-line
answer can carry 25k tokens of thinking at `high`. If more than half the output is
reasoning, `/cost` says so and suggests lowering `/effort`.

The per-turn line reports what the **whole turn** sent, not the last request — with ten
tool rounds the last request is a fraction of the bill:

```
   moonshotai/kimi-k3:high · ↑ 61k in 4 requests · 48k cached ↓ 3.8k · 1.4k of it reasoning · 4 steps · 18m 42s
```

`/cost` breaks the same numbers down per model, with an average per request and a cached
column — a flat zero there on an Anthropic model means the prefix keeps moving or the
host is dropping the field.

### What a request is made of

The stored history is not what goes out: trim shortens old results, skills and design
references are spliced in mid-turn, and the system prompt and tool schemas ride on top of
every request. `/trace [n]` shows the projection — what each of the last *n* requests
actually carried:

```
   step    time   system  schemas  history  injected   trim→  cached  model
      0   14:03     1.2k     2.8k      1.1k     2.4k        —       —  moonshotai/kimi-k3
      1   14:03     1.2k     2.8k      4.6k     2.4k  -9.1k    7.2k  moonshotai/kimi-k3
      2   14:04     1.2k     2.8k      5.0k     2.4k  -12k     9.8k  moonshotai/kimi-k3

   Injected: skill:debugging.
```

One line per request, appended as the turn runs to `<session-id>.proj.jsonl` beside the
session file — so it survives a resume and answers "what did the model see at step 3"
after the fact. The `injected` column names what was spliced in (a skill auto-loaded
mid-turn, for instance), `trim→` is what trimming saved against sending the history as-is,
and `cached` is the provider's own number once the response reports it.

## Models

The TokenRouter catalog holds ~118 namespaced models: `moonshotai/kimi-k3`,
`deepseek/deepseek-v4-pro`, `x-ai/grok-4.5`, `z-ai/glm-5.2` and so on.

Three wire protocols are supported at once:

| Protocol | Endpoint | Models |
|---|---|---|
| OpenAI chat | `/v1/chat/completions` | Kimi, DeepSeek, Qwen, GLM, Grok, MiniMax… |
| OpenAI Responses | `/v1/responses` | `openai/gpt-5.6-sol`, `-terra`, `-luna`, `gpt-5.5-pro` |
| Anthropic | `/v1/messages` | `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5` |

Aliases: `sol`, `terra`, `luna`, `opus`, `fable`, `sonnet`, `k3`, `free`, `grok`, `glm`…

Models reached at their own vendor rather than through the router carry a provider prefix
(`kimi:kimi-for-coding`) and are listed under that provider — see [Other providers](providers.md#other-providers).

The chat picker hides models whose endpoints the client cannot use for conversation.
Image, video and audio generation use separate tools and model pickers — see
[Images, video and audio](tools-and-workflows.md#images-video-and-audio).

`/model` and `trc models` group the catalog the way it is tagged — **[Text] [Images]
[Video] [Audio]** — and by vendor inside each type, so what a model is comes before whose
it is. The vendor comes from the model id, not from the host it was reached at: a router
resells a hundred labs' models, and filing all of OpenRouter under "OpenRouter" is a list
nobody can navigate.

Names are shown without their routing prefix — a column of repeated `alibabacloud:` is
width spent on nothing — and the host gets a column of its own, only when the list spans
more than one. The full id remains what a row selects, so `/model alibabacloud:qwen3.8-max`
and typing either spelling into the filter both still work. A provider that publishes
neither types nor vendors (Model Studio) gets both read off the names, and dated snapshots
(`qwen3.7-max-2026-05-17`) sink below the id they are a snapshot of:

```
/model           # this provider's catalog, by type then vendor
/model all       # every provider's
/model refresh   # re-read it, past the cache
```

`/model` with no argument opens the panel: type tabs — **[Text] [Images] [Video] [Audio]**
(←/→) — grouped by vendor, newest first inside a group (by the API's `created` field), with
MoonShot, Anthropic, OpenAI, Qwen and xAI pinned to the top. Typing filters; every word has
to match somewhere in the row, in any order. Tab moves to the buttons, and `alt+`the number
on a button runs it from anywhere:

```
   ╭─ Model ──────────────────────────────────────────────────────────╮
   │                                                                  │
   │  Alibaba Cloud · 116 models · ★ default · ● in use               │
   │                                                                  │
   │   Text 116  [ Images 21 ]  [ Audio 3 ]                           │
   │                                                                  │
   │   ╭──────────────────────────────────────────────────────────╮   │
   │   │ ⌕ qwen max                                          2/116 │   │
   │   ╰──────────────────────────────────────────────────────────╯   │
   │                                                                  │
   │  ── Qwen ────────────────────────────                            │
   │  ❯ qwen3.8-max          ● ctx 1M              $0.8/$3.2          │
   │    qwen3.7-max            ctx 1M              $0.6/$2.4          │
   │                                                                  │
   ├──────────────────────────────────────────────────────────────────┤
   │  [ 1 Refresh ]  [ 2 All providers ]  [ 3 Make default ]          │
   │  ↑↓ move · Enter select · ←→ section · Tab buttons · Esc close   │
   ╰──────────────────────────────────────────────────────────────────╯
```

The same panel is what `/provider`, `/brain`, `/subagents`, `/skills`, `/uilib` and `/stat`
open — one frame, one set of keys, and the sub-commands each of them used to take as typed
words (`add`, `auto`, `refresh`, `on`/`off`) sitting on the buttons. They remain commands
on the command line; the panel is for the times you do not remember which word it was.

★ is the default model, ● the current one.

The **search field sits above the list**, not in a footer hint: with hundreds of models a
list whose search is invisible is a list nobody searches. Every word has to match
somewhere in the row, in any order — `qwen max` finds `qwen3.8-max`, which a plain
substring search never would — and the counter says how much of the catalogue survived the
query. A pasted name works as well as a typed one, `^U` clears, and switching type tabs
starts a fresh query.

Turn the filter off with `"hideIncompatibleModels": false`. Picking an incompatible model
warns you outright instead of failing on the first request.

Names can be abbreviated: `/model k3`, `/model grok-4.5`, `/model deepseek-v4-pro` —
aliases, the tail after `/`, prefixes and substrings all resolve; ambiguity prints the
candidates.

`/model <name>` switches the session model and remembers the choice for the project;
`/default` also sets the configured default. If a saved model disappears from the catalog, the CLI falls
back to the default and says so.

### Per project

The model and the reasoning budget are remembered **per project** — keyed by the worktree
root (the nearest `.git` above the working directory), so two worktrees of one repository
are two projects and a subdirectory is the same one. Start `trc` in a checkout you left on
`x-ai/grok-4.6` and it opens there, with no `/model` to repeat; another checkout keeps its
own. The last 40 projects are kept, in `config.json` → `projectState`.

The order a new session resolves: this project → where the default provider was left →
`"model"` in the config. `trc -m <model>` overrides all three for that run without
overwriting anything.

## Reasoning budget (effort)

```
/effort              # pick a level with the arrows
/effort high         # for this session
/effort high save    # make it the default
trc -e low ...       # one-off from the command line
```

Levels: `off` (the parameter is not sent), `minimal`, `low`, `medium`, `high`.
**The default is `high`.**

The wire shape depends on the protocol and is discovered automatically:
`reasoning_effort` → `reasoning` for chat models, `reasoning` for Responses,
`thinking: {type:"adaptive"}` + `output_config.effort` for Claude 5
(Claude 4.x uses `thinking: {type:"enabled", budget_tokens}`).
The working shape is remembered in `effortForm` so probes are not paid for twice.
`/effort reset` forgets what was learned and probes again.

**If a model answers 400 to the parameter, it is dropped, the request is retried, and the
model is recorded** — it is never sent again, even after a restart, and the status line
marks it `high (unsupported)`.

Per-model budgets live in the config:

```json
{ "effort": "high", "effortByModel": { "moonshotai/kimi-k3-free": "low" } }
```

Precedence: `/effort` in the session → `effortByModel[model]` → `effort` → `high`.

## What a turn costs

An agent loop re-sends the whole history on every step, so a session costs O(steps²) in
input tokens — that is where a multi-million-token bill on a handful of prompts comes
from. Three things keep it down, and they apply to every model and every host:

**Repeats are collapsed.** Agents re-read the same file and re-run the same grep
constantly. The first copy of a result is sent verbatim; a later one that is byte-for-byte
the same becomes `[identical to the earlier read result above — unchanged]`. Nothing is
lost — the content is still in the context above — and "unchanged" is usually the answer
the re-read was after. In one real session that was 46 results worth 67k tokens, in a
history of 305k: re-sent on each of 96 later steps, those repeats alone would have cost
about 6M input tokens.

**Old output is shortened, and one result is capped hard.** A single tool result is cut to
4k bytes one step after it arrives, and the rest of the history is trimmed only when a
request would exceed **half the model's window** — not a fixed 40k, which treated a 1M
model like a 128k one and rewrote history that had room to spare. Both numbers are
measured rather than guessed: replaying 35 real sessions — 1348 requests — a 4k cap beat
the old 12k one under every assumption about what a cached token costs, and a
window-derived budget cut cache breaks from 356 to 244.

| policy | biggest request | cache breaks | cost at ×1 · ×0.5 · ×0.25 · ×0.1 |
|---|---|---|---|
| old: 40k budget, 12k cap | 71k | 356/1185 | 35.8M · 21.7M · 14.6M · 10.4M |
| 40k budget, 4k cap | 71k | 369/1185 | 31.6M · 18.1M · 11.4M · 7.3M |
| half the window, 4k cap | 90k | 244/1185 | 36.3M · 19.5M · **11.1M** · **6.1M** |
| no trimming at all | 302k | 0/1185 | 74.4M · 37.9M · 19.7M · 8.7M |

Cost here is fresh tokens plus cached ones at that fraction of the price. The discount
differs per host, so the honest answer is a table and not a number — but every column
agrees that capping a single result early is worth more than trimming the history late.

**The prefix stays byte-identical between steps**, because every stub is a pure function
of the history before it. That is what a provider-side prompt cache matches on — and the
cache is where the real saving is: those sessions ran at 71–76% cached input.

Only the wire copy is shortened. The stored session keeps every byte, so `/resume`,
`/compact` and the replayed transcript still show what actually happened.

## Rate limits

Requests go out when they are ready. **Only a 429 that actually came back buys a wait** —
nothing is ever held back in advance.

When one does come back, the host's own idea of when to come back wins: `Retry-After`
first, then the window spelled out in the message ("Maximum 1 requests within 1 minutes"),
then 20 seconds. Most hosts count every attempt against the window, refused ones included,
so the retry waits the whole thing out rather than probing sooner.

How many times it retries is bounded by **time, not by a count** — up to five minutes of
waiting, at most eight attempts. A count alone was wrong in both directions: three tries
is plenty against a per-second limit and hopeless against one request per minute, where
four subagents queue behind each other and the last one needs four windows just to reach
the front. That is what used to kill a fan-out: the parent launched four subagents, three
were refused on arrival, and they gave up before their turn came round. The wait is
named in the spinner, along with the model it belongs to: a limit hit by a subagent or by
the small model must not read as the one on screen being metered.

The client used to also keep the window a host named and pace later sends by it. That is
the textbook answer and it was wrong here — a limit belongs to an account at a moment, the
client cannot see when it lifts, and guessing wrong costs a minute of dead time before
every later step, on models that were never metered. Guessing wrong the other way costs
one refused request. Over a turn of dozens of steps the asymmetry is not close.

## Context window

The TokenRouter catalog reports no window size for any model, so the client carries the
numbers the vendors publish — by family rather than by id, because the catalog renames
models faster than a table can follow (`qwen3.7-max` became `qwen3.8-max`) and a family
that shipped 256k does not drop to 128k in the next point release:

| Family | Window |
|---|---|
| Qwen `-max` from 3.7 · `-plus` / `-flash` / `-turbo` · Coder | 1M |
| Qwen `-max` up to 3.6 · open weights | 256k |
| Kimi K3 · DeepSeek V4 · GLM‑5.2 · MiniMax M3 · Claude 5 · Gemini 2.5+ | 1M |
| GPT‑5.4 and newer | 1.05M |
| Kimi K2 | 256k |
| Claude 4.x | 200k |
| GPT‑5 up to 5.2 | 400k |
| GLM 4.6 – 5.1 | 200k |
| MiniMax M2 | 200k |
| Grok | 256k, 4.5/4.6 500k, `-fast` 2M |
| DeepSeek V3 · Mistral · GPT‑OSS · Gemma | 128k |

A family that grew its window is keyed by version, not by id: Qwen's `-max` line held
256k through 3.6 and moved to 1M with 3.7, so `qwen3.8-max` gets 1M and `qwen3.6-max`
still gets 256k. OpenRouter reports real windows and prices in its own catalog, so its
models use those instead of the table. Anything matching nothing above falls back to an
estimate of 128k, marked `?` in the status line. That estimate also decides when a session
auto-compacts, so a model with a much larger window is worth correcting:

```
/context           # how full the window is
/context 500k      # pin the real size for the current model
/context auto      # drop the pin
```

The pin lands in `config.json`, where it can also be written by hand:

```json
{ "contextWindows": { "z-ai/glm-5.2": 200000 } }
```

Prices are not published either, so no money is shown anywhere — only tokens.

## Configuration

`~/.trcode/config.json`:

```json
{
  "baseUrl": "https://api.tokenrouter.com/v1",
  "model": "moonshotai/kimi-k3",
  "smallModel": "moonshotai/kimi-k3-free",
  "promptModels": { "tokenrouter": "moonshotai/kimi-k3-free" },
  "promptMode": "command",
  "subagentModels": {},
  "subagentAuto": {},
  "brainModels": [],
  "brainMainModel": "",
  "toolConcurrency": 4,
  "modelPrompts": {},
  "hideIncompatibleModels": true,
  "aliases": { "k3": "moonshotai/kimi-k3", "free": "moonshotai/kimi-k3-free" },
  "effort": "high",
  "effortByModel": {},
  "effortParam": "both",
  "effortForm": {},
  "effortUnsupported": [],
  "contextWindows": {},
  "newlineKeys": [],
  "permissions": { "read": "allow", "write": "ask", "shell": "ask", "agent": "allow" },
  "shell": "auto",
  "maxRequestTokens": 0,
  "maxToolResultBytes": 0,
  "trimKeepRecent": 4,
  "trimMinBytes": 400,
  "requestTimeoutMs": 600000,
  "upstreamRetries": 10,
  "upstreamRetryDelayMs": 10000,
  "maxSteps": 0,
  "autoCompactAt": 0.9,
  "promptCache": true,
  "orca": true,
  "orcaAgent": "opencode",
  "providers": {},
  "lang": "en",
  "skillAuto": true,
  "uilibAuto": true,
  "defaultProvider": "tokenrouter",
  "providerState": { "kimi": { "model": "kimi:k3", "effort": "high" } },
  "projectState": { "trcode-cli-9f2c1a4b7e08": { "model": "x-ai/grok-4.6", "effort": "medium" } },
  "statusFields": { "model": true, "tokens": true, "steps": true, "time": true, "speed": true },
  "updateCheck": true,
  "temperature": 0.2
}
```
