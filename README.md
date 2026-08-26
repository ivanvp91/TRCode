# TRCode

```
 ████████╗██████╗
 ╚══██╔══╝██╔══██╗
    ██║   ██████╔╝
    ██║   ██╔══██╗
    ██║   ██║  ██║
    ╚═╝   ╚═╝  ╚═╝
```

**TRCode** — a cross-platform agentic coding CLI: a terminal
agent in the spirit of Claude Code, with live model switching, subagents, skills and
token accounting.

One client, nine providers: the TokenRouter catalog, Kimi, Anthropic, OpenRouter,
OpenCode Zen, OpenCode Go, Alibaba Cloud (Qwen), xAI (Grok) and Z.AI — subscriptions and
API keys side by side, each model served on the wire protocol its vendor speaks (OpenAI
chat, Responses and Anthropic Messages), with reasoning effort and prompt caching shaped
per host.

Node 20+ on Windows, macOS and Linux; zero runtime dependencies (native `fetch`,
raw-mode TTY, ANSI).

## Install

```bash
npm install
npm run build
npm link          # provides the trc and trcode commands globally
```

## The key

```bash
trc auth login            # asks for the key and verifies it against /v1/models
trc auth status
```

If you get **401 "Invalid API key"**:

```bash
trc auth status                                  # shows the host and a masked key
trc auth login --base-url https://your-host/v1   # a key for a different endpoint
trc auth login --force                           # save without verifying
trc auth login sk-your-key                       # pass the key as an argument
```

The key is saved only after it verifies — if verification never succeeded, `config.json`
is not created at all. A pasted key is stripped of bracketed-paste markers, whitespace
and quotes, so invisible terminal noise never ends up inside it.

## Other providers

TokenRouter is the default, but the platform is cross-platform by design: a model can be
reached at its own vendor instead — useful when you already pay for a subscription there
and would rather spend the plan than the router's per-token price. Seven providers are
built in, and each remembers its own model, reasoning budget and host.

```bash
trc auth login                          # connects the provider in use
trc auth login --provider kimi          # asks: subscription or API key
trc auth login --provider claude        # Anthropic console key
trc auth login --provider openrouter    # OpenRouter key (sk-or-…)
trc auth login --provider opencode      # OpenCode Zen key; /login zen works too
trc auth login --provider opencode-go   # the Go subscription; /login go works too
trc auth login --provider alibabacloud  # QwenCloud key; asks which host it is for
trc auth login --provider xai           # SuperGrok subscription or a console.x.ai key
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
automatically from then on. If the vendor's own CLI is already logged in on this
machine, that session is picked up instead of asking you to authorize twice — pass
`--fresh` to force a new authorization.

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

The header box at the top states them too. A box already on screen is output, not a live
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

Tokens for these providers live in `~/.trcode/auth/<provider>.json` (mode 600), never in
`config.json` — that file is printed whole by `trc config` and `/config`.

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

## Usage

```bash
trc                                  # interactive
trc "fix the build"                  # one task, then interactive
trc -p "what does src/index.ts do"   # headless: answer to stdout, then exit
trc -p "..." --json                  # headless, machine-readable
trc -m k3 "walk me through the architecture"   # a specific model for this session
trc -e high "a tricky refactor"      # with the maximum reasoning budget
trc -c                               # continue this project's last session
```

Flags: `-m/--model`, `-e/--effort`, `--preset standard|minimal`, `-C/--cwd`, `-c/--continue`,
`-r/--resume <id>`, `-p/--print`, `--json`, `--base-url <url>`, `--yolo` (no confirmations).

## Commands

Type `/` and a filtered command list opens under the input: ↑↓ to move, Enter to
insert, Esc to dismiss. `/help` prints the full reference.

**Main**

| Command | What it does |
|---|---|
| `/model [name\|all]` | switch model — the current provider's, `all` for every provider |
| `/provider [name]` | switch provider; `default [name]` pins it, `host [name] [url]` changes its endpoint, `logout <name>` disconnects |
| `/effort [level] [save]` | reasoning budget: `off`, `minimal`, `low`, `medium`, `high` |
| `/brain <question>` | a panel of models answers together — see [A panel of models](#a-panel-of-models) |
| `/orchestrate <task>` | split a task into subtasks with dependencies and run them on subagents |
| `/swarm <task>` | several models solve it in parallel, then a synthesis pass |
| `/compact [focus]` | compact the history into a structured digest |
| `/rewind [last]` | put files back to how they were before a turn |
| `/yolo [on\|off]` | skip confirmations — tools run immediately (also Shift+Tab) |
| `/new` | start a new session |

**Session** — `/sessions`, `/resume [id]`, `/fork [turn]`, `/rename [title]`, `/context [<tokens>|auto]`, `/cost`, `/trace [n]`
(`/fork` branches the session at a past turn — the original stays intact, details in
[Forking a session](#forking-a-session); `/trace` shows what every request actually carried:
system prompt, tool schemas, history after trim, injections — the projection behind
[Token spend](#token-spend))

**Settings** — `/lang [en\|ru]`, `/default [name]`, `/aliases`, `/permissions`, `/login [provider] [url]`, `/settings`, `/update [--check]`, `/config`, `/cwd`
(the catalog lives in `/model` — the panel lists the current provider by type and vendor,
`/model all` every provider, and its Refresh button re-reads it past the cache; `/login`
connects the one in use unless another is named, and takes a host for the providers whose
endpoint is per-account; `/settings` groups the toggleable preferences — what the status
line shows, whether skills and UI mockups match themselves automatically, whether updates
are looked for; `/update` installs the newest GitHub release — details below)

**Agents** — `/subagents [model [id]\|auto]`, `/prompt <task> \| model [id] \| off\|command\|auto`,
`/prompt_model [id]`, `/mcp [reload]`
(`/subagents` names the models subagents may run on: the interactive list, `model <id>`
to add one by name, `auto` to reset to the session's model only — details in
[Subagents](#subagents); `/prompt` routes a short ask through a cheap model first —
details in [Writing the prompt](#writing-the-prompt))

### Language

```
/lang            # pick from a list
/lang ru         # Русский
/lang en         # English (the default)
```

`/lang` sets three things at once and saves the choice as the default: the language the
agent answers in, the one skills describe themselves in, and the interface itself — the
header box, the status line, the command list and its help, the pickers, the permission
prompts and the messages commands print. Switching repaints the header, so the screen is
in the new language immediately.

Code, identifiers, paths, commands and log output are never translated in any language —
translating them would make the answer wrong rather than localised. Model ids, provider
names and anything an API returns stay as they are too.

Still English: the non-interactive CLI (`trc --help`, `trc auth …`), the progress output of
`/orchestrate` and `/swarm`, and a handful of rarely-seen messages.

Strings are written in both languages where they are used — `t("Model", "Модель")` —
rather than kept in a key catalogue, so the English text stays visible in the code that
prints it. Command labels are lazy (`help: () => t(…)`) because the command table is built
once at import, long before `/lang` runs.

The setting is stated in the system prompt rather than inferred. "Answer in the user's
language" sounds reasonable and behaves badly: a pasted stack trace or an English error
message is enough to flip the model mid-session.

Skills carry one description per language in their frontmatter:

```yaml
description: Track down a bug, crash or failing test — when given an error message…
description_ru: Найти причину бага, падения или упавшего теста — когда дают ошибку…
```

`description_<code>` is optional. A skill without one still works; it simply describes
itself in English whichever language is selected. All 13 bundled skills carry a Russian
description.

**Other** — `/tools`, `/skills`, `/preset [standard\|minimal]`, `/todo`, `/keys`, `/init`, `/clear`, `/version`, `/help`, `/exit`
(`/preset minimal` keeps only `shell` and `edit` with a short prompt — see
[Presets](#presets))

### Updating

The client checks GitHub Releases at startup — at most once every six hours, never
applying anything — and the header says when a newer version exists. Installing is
explicit:

```bash
trc update           # download, unpack, swap — the new build runs on restart
trc update --check   # only report what is out there
```

Same inside a session: `/update`. The tarball comes from
`github.com/ivanvp91/TRCode/releases`, is unpacked with the system `tar`, and the swap
keeps the old `dist` around until the new one is in place. `"updateCheck": false` (or
`TRCODE_NO_UPDATE_CHECK`) turns the passive startup check off; `/update` keeps working.

### Keys

**Ctrl+Enter** inserts a newline inside a message. Enter with *any* modifier is accepted,
in both reporting schemes (kitty `ESC[13;Nu`, xterm `ESC[27;N;13~`), as is Alt+Enter and
a trailing backslash.

If your terminal sends something else, `/keys` shows the exact bytes of every keystroke
and offers to pin the combination; it is stored in the config under `newlineKeys`. If a
key press produces no output at all, the terminal is swallowing the combination as its
own shortcut and the CLI cannot see it.

**Shift+Tab** turns confirmations off and on again without typing a command — the same
thing `/yolo` does, one keystroke away. The status line shows `yolo` while they are off.
Three terminal encodings are accepted (`ESC[Z`, `ESC[27;2;9~`, `ESC[9;2u`), so it works
under xterm's modifyOtherKeys and the kitty keyboard protocol as well as plain backtab.

**↑ / ↓** move between the lines of a multi-line draft, and walk the prompt history from
its first (or last) line — the history persists across restarts, separately per project.
**Esc** interrupts the current turn, **Ctrl+C** exits, **Ctrl+L** repaints the frame.

## The interface

Below the input sits a status line: mode, provider, model, reasoning budget, directory and
how full the context window is. The directory is the elastic part — it shrinks from the
left and is dropped first when the row runs out of room.

```
   ╭────────────────────────────────────────────────────────────────╮
   │ ❯                                                              │
   ╰────────────────────────────────────────────────────────────────╯
   yolo  TokenRouter  moonshotai/kimi-k3  thinking: high  ~/proj   context: 3% (23k/1M)
```

The `yolo` marker appears when confirmations are off (`--yolo` at launch, or `/yolo`).

A tool call is named by what it did, and an edit shows as a numbered diff — changed lines
on a coloured band that runs to the edge, the code syntax-highlighted, unchanged context
dimmed, and long untouched runs collapsed to `⋮`:

```
   ● Update(src/provider/registry.ts)
       └ Added 3 lines, removed 2 lines
         1   import fs from "node:fs";
         3 - const MAX = 10;
         3 + const MAX = 20;
         5   export function seed(): SeedModel[] {
         6 +   // the published list is carried here
```

Removed lines keep their old number — that is the line you still have in front of you —
and added lines carry the new one. A line wider than the terminal is cut with `…` rather
than left to the terminal, which would wrap it into column 1 outside the margins. A new
file previews the same way: a diff against nothing.

When a model reports its reasoning — Anthropic `thinking`, OpenAI `reasoning_content`,
the Responses summary — it is streamed as a muted block above the answer:

```
   ● thinking
       Надо посмотреть, как считается Base. Похоже, шринкидж тянет к медиане
       каталога, и это стоит проверить на холодных счетах.

   ● moonshotai/kimi-k3
   Готово.
```

The block is line-buffered, so a delta that ends mid-word does not wrap the same line
twice, and it closes before the answer or a tool call is printed under it.

Messages are separated by a blank line, and whatever belongs to one — the grey
explanation, a tool's activity, its output — is indented a step under it, so a block
reads as one thing:

```
   ✔ Kimi is connected — 4 models available
       Models: kimi:k3, kimi:k3-256k, kimi:kimi-for-coding
       Use it with: /model kimi   (alias for kimi:k3)
```

Typing `/` opens the command list right under the frame:

```
   ╭──────────────────────────────────────────────────────────────╮
   │ ❯ /                                                          │
   ╰──────────────────────────────────────────────────────────────╯
     → /model     [name|alias]  —  switch model
       /provider  [name] | default [name] | logout <name>
       /effort    [off|minimal|low|medium|high] [save]
       /yolo      skip confirmations
       (1/34)  ↑↓ · Enter to pick · Esc to dismiss
```

The caret is hidden for as long as the bar is up. Every write erases and redraws the bar,
which walks the cursor between the transcript and the bar — visible, that reads as the
caret flying around the screen. It is restored when the bar comes down, and on process
exit, so a crash cannot leave the shell without one.

While the model works, the input frame stays where it is: the spinner sits above it and
the transcript scrolls above that. A ten-minute run never leaves you looking at a bare
spinner wondering whether the prompt is coming back.

```
   ⏺ read(src/index.ts)
     └ 45 of 45 lines
   ⠹ reasoning (6m 33s · ↑ 18k ↓ 11.4k)  esc to interrupt · type to queue a message
     ⎿ queued: and check the tests too
   ╭────────────────────────────────────────────────────────────────╮
   │ ❯                                                              │
   ╰────────────────────────────────────────────────────────────────╯
   moonshotai/kimi-k3  thinking: high  ~/proj      context: 3% (23k/1M)
```

You can type while the model is busy. **Enter** queues the message and it is sent as soon
as the current turn finishes; anything left unsent stays in the box for editing.

**Esc** interrupts the turn — the streaming answer, the thinking, a tool that is running,
a send being held back after a 429, and a permission prompt waiting on you — and hands
back everything you typed, queued messages included. A tool that ignores its own signal
cannot hold the turn open either: the results of an interrupted round are discarded, so
there is nothing to wait for. Nothing is sent on your behalf after an interrupt: sending the queue
would start a new turn in the same breath, which is indistinguishable from Esc having done
nothing.

A terminal delivers whatever accumulated since its last read, so the Esc that matters —
pressed mid-stream, hit twice out of impatience, or landing right after a typed word —
often arrives glued to other bytes. It counts as Esc all the same. An Esc that opens a
recognised sequence (`Esc [`, `Esc O`) is still a cursor key, not an interrupt.

Tool activity is indented one step past the answer that triggered it, with a blank line
opening the group, so calls never read as another paragraph of the message:

```
   ● moonshotai/kimi-k3
   Логика tap-tap работает через pointerdown, переписываю тест.

     ⏺ edit({"new_string":"// подсветка после tap"})
       └ 3 lines changed
     ⏺ shell({"command":"node tests/ui.test.js"})
       └ ok
```

After a turn, only that turn — nothing already shown under the input is repeated. The
input figure covers every request the turn made, not just the last one:

```
   moonshotai/kimi-k3:high · ↑ 48k in 4 requests · 31k cached ↓ 1.2k · 4 steps · 1m 12s
```

The chat area has margins (narrow on the left, wider on the right); on a narrow terminal
the right margin collapses rather than squeezing the text.

## Resuming a session

Sessions are stored per project. `/resume` opens the picker, and every row says how much
context that session carries — the number that decides what the next turn will cost. It
turns yellow past half the window and red past 80%.

```
   Pick a session
   ⌕ search — just type                                              12
   ↑↓ move · Enter select · Esc cancel · ^U clear
   ❯ pricing analysis                        ~184k/1M  18%   64 msgs  2h ago
     editor rewrite                           ~11k/1M   1%    5 msgs  3d ago
```

A session with no messages is never written and never listed; files left by earlier
builds are cleaned up at startup.

Choosing one does not commit you to it. A card shows the size, then three buttons:

```
   pricing analysis
   202608011349-e115a0 · moonshotai/kimi-k3 · 64 messages
   ██████░░░░░░░░░░░░░░░░░░░░░░░░░░  ~184k of 1M tokens (18%)

    Continue as is   [Compact and continue]  [Back to the list]   ←/→ · Enter to confirm
```

**Compact and continue** runs the same digest as `/compact` before the session opens, so a
bloated history does not cost full price on the very first turn. **Back to the list**
returns to the picker rather than dropping you back at the prompt.

Then the last few turns are replayed as real markdown — tables aligned into columns, code
fences kept as blocks, long turns cut off with a line count. A compacted session shows its
digest as a labelled block instead of raw XML:

```
   ───────────────  resumed · 202608011349-e115a0  ───────────────
   12 messages · ~44k of 1M tokens (4%) · moonshotai/kimi-k3 · compacted 1×

   ▍ compacted context
   ▍ Task
   ▍ Ship the pricing page.

   ✦ analyse the fx monitor pricing

   ● moonshotai/kimi-k3
   Plan    │ $/mo  │ Accounts │ Sync
   ────────┼───────┼──────────┼───────
   Free    │ 0     │ 3        │ 5 min
   Starter │ 9.99  │ 10       │ 30 sec
```

`/sessions` is the same list with four actions instead of two — **Continue · Rename ·
Delete · Compact**, Esc to go back:

```
   quick question
   202608011429-557db8 · moonshotai/kimi-k3 · 12 messages
   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ~2.1k of 1M tokens (0%)

    Continue   [Rename]  [Delete]  [Compact]   ←/→ · Enter to confirm · Esc back to the list
```

Deleting asks for confirmation and refuses to remove the session you are currently in.
`/rename [title]` renames the open session — without an argument it prompts, prefilled
with the current title.

`-c/--continue` reopens the most recent session directly, `-r/--resume <id>` a specific
one.

### Undoing a turn

Every write the agent makes through `write` or `edit` is snapshotted first: the previous
bytes go into a content-addressed store beside the session file, and the log records which
turn touched what. There is no staging area between the agent and your work, and without
this a turn that misread the task rewrites half a dozen files with nothing to go back to.

`/rewind` lists the turns that changed files — newest first, with the prompt that started
each one and how many files it would put back. `/rewind last` skips the list. Picking a
turn undoes it **and everything after it**, then asks what to restore:

```
   Rewinding to before: add pagination to the users list
   • src/users/list.ts
   • src/users/page.tsx

    Files only  [Files and conversation]  [Conversation only]  [Cancel]
```

*Files only* is the usual answer: the model still remembers what it tried and can be told
to try it differently, and a note in the history tells it to re-read what moved. *Files and
conversation* drops the turn as well, as if it never happened.

Files the turn created are deleted; files it changed go back to what they held before. A
file edited outside the session since is still restored, and the newer content it had is
called out by name — that is the one case where the rewind itself loses something.

`shell` is covered too, but only as far as it can be: a command cannot be asked what it
will touch, so what gets snapshotted is what the command *names* — `sed -i … src/app.ts`,
`> config.json`, `mv a b`, `rm old.txt`. Those files are read before it runs and compared
after; the ones that changed go into the same log, and a file the command created is
deleted on rewind like any other. A path built by a glob or inside a script is outside
this, and the system prompt tells the model as much: change files with `edit`/`write`, and
if a shell command really is the only way, say which files it will change.

Snapshots are deleted with their session, and stores whose session is already gone are
cleaned up at startup.

### Forking a session

`/rewind` undoes; `/fork` branches. Picking **Fork here instead** in the rewind menu — or
running `/fork` directly — creates a new session carrying the history up to the chosen
point, while the original stays exactly as it is on disk and in the list:

```
   Branch from where?
   ❯ analyse the fx monitor pricing                        #0
     add pagination to the users list                      #12
     fix the timezone drift in reports                     #28

    Switch to the fork now  [Stay here]   ←/→ · Enter to confirm
```

The cut never splits a tool pair — it moves back to before the assistant message that made
the calls, so a host never sees a history ending in an unanswered `tool_calls`. The fork's
title carries a `· fork` mark, and `/fork <n>` jumps straight to a position without the
picker. Typical use: "what if I had asked differently there" without losing the road
already taken.

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

The second safeguard is auto-compaction: past `autoCompactAt` of the context window (0.9 by
default) the history is digested. It used to also fire at twice `maxRequestTokens`, which
sounded like a safety net and behaved like a trap — that budget is the on-the-wire trim, not
the window, so on a 1M-token model it compacted at 80k, throwing away a history the model
could still hold whole. Compaction loses detail, so it waits for the window to fill.

`/compact` compacts on demand; `/cost` shows where the tokens went.

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
(`kimi:kimi-for-coding`) and are listed under that provider — see [Other providers](#other-providers).

Native Gemini, image and video generation, audio chat and embeddings are not supported —
those models are hidden from the picker by default, and listed with the reason wherever
they do appear.

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

`/model <name>` changes the model for this session only; `/default` writes it to the config
(and applies it immediately). If a saved model disappears from the catalog, the CLI falls
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

## Tools

`read`, `edit`, `write`, `ls`, `glob`, `grep`, `shell`, `read_image`, `web_search`, `fetch`,
`run_code` (opt-in), `skill`, `todo`, `memory`, `task`, plus anything the connected MCP
servers provide.

`web_search` queries DuckDuckGo's keyless HTML endpoint — no API key, no account;
`fetch` downloads a URL and strips the HTML to readable text. Both sit in the
`network` permission class, so by default every call asks first.

`read_image` puts a picture in front of a vision model: PNG/JPEG/GIF/WebP/BMP up to
1.6 MB, sent as real image content rather than a path. A host that refuses images is
remembered, and later reads arrive as text only.

Independent calls in one turn run in parallel (up to 4 at a time).

### run_code: many calls, one step

`run_code` (off by default — `"codeMode": true` in `config.json`) hands the model a
different shape of work: instead of five rounds of read → result → read, it writes **one
JavaScript program** whose SDK calls run in a child process, and only the program's
return value enters the conversation:

```js
const files = await sdk.glob('src/**/*.ts');
const out = {};
for (const f of files) {
  const t = await sdk.fs.read(f);
  out[f] = (t.match(/TODO/g) || []).length;
}
return out;
```

The SDK mirrors the dedicated tools — `sdk.fs.read/write/list/glob`, `sdk.shell`,
`sdk.web.fetch/search` — with the same guardrails: paths cannot leave the working
directory, shell and web calls ask for permission like their tools do, and writes go
through the snapshot store so `/rewind` still reaches them. The program runs under a
timeout (`codeModeTimeoutMs`, 60s) and Esc kills the whole process tree.

The point is the input bill: intermediate outputs never ride along on later steps. A task
that gathers data across twenty files costs one round trip instead of twenty-plus, and
what lands in the history is the summary, not the dumps.

### Presets

`/preset minimal` (or `trc --preset minimal`) shrinks the session to two tools — `shell`
and `edit` — and a short prompt to match: no workspace listing, git state, skills, memory
or model notes. The full set comes back with `/preset standard`.

Two uses. Quick fixes on a cheap model, where half the tool catalog is noise. And a
baseline: the first request drops to roughly a third of the usual size, which makes the
cost of everything else measurable. Switching presets mid-session warns that the next
request rebuilds the prompt cache from scratch — both halves of the request changed.

### MCP servers

Any stdio MCP server — the same ones Claude Code runs — plugs in through the config,
in the same shape:

```json
// ~/.trcode/config.json, or .trcode/mcp.json in a project (project wins on a shared id)
"mcpServers": {
  "tradingview": {
    "command": "npx",
    "args": ["-y", "some-tradingview-mcp"],
    "env": { "API_KEY": "…" },
    "tools": ["get_quote", "search_symbols"]
  }
}
```

Servers start in the background at session start; their tools appear in the registry as
`mcp__<id>__<tool>` when each one is ready, and fall under the `network` permission class
(`ask` by default — answer "always" once to stop the prompts for a session). `/mcp` shows
status and tool lists, `/mcp reload` restarts the servers after a config change.

`"tools"` is optional but worth setting on fat servers: every exposed schema travels in
every request. Remote SSE/HTTP servers are not supported yet — stdio only.

### Multi-agent work

Four mechanisms, deliberately distinct:

- **`task`** — the model spawns subagents for subtasks itself. Several `task` calls in one
  turn run at once; each has its own context and model, and the lead agent sees only their
  final text. `read_only: true` gives a scout with no write access. By default a subagent
  runs on **the session's own model** — `/subagents` names other models it may be launched
  on (a session left open once sent its reconnaissance to the cheapest id in an OpenRouter
  catalog: 130 requests, 2.8M input tokens on a model nobody chose for this).
- **`/orchestrate`** (`/orch`) — the task is split into 2-6 subtasks with dependencies.
  Independent steps run in parallel, dependent ones receive their predecessors' results,
  investigation steps are read-only, and writing steps run one at a time and last. The
  current model then merges everything into one answer. The plan and step statuses are
  visible as it goes.
- **`/swarm`** — one task goes to several models from different vendors at once (the roster
  is picked automatically), they work read-only, and the current model then merges the
  answers and names the disagreements explicitly.
- **`/brain <question>`** — not agents but models talking: several answer the same
  question alone, read each other's answers, revise, and one writes the final text. No
  tools, no file changes — see [A panel of models](#a-panel-of-models).

## Confirmations

| Class | Default |
|---|---|
| `read` (read, ls, glob, grep, skill, todo) | `allow` |
| `write` (write, edit) | `ask` — with a diff |
| `shell` | `ask` — with the command |
| `network` (web_search, fetch, MCP tools) | `ask` |
| `agent` (task) | `allow` |

A `run_code` program asks under its own name for everything risky it does: shell commands
confirm as `run_code>shell`, web calls as `web_search`/`fetch`. File writes inside the
program go through the same snapshot store as `write` and `edit`, so `/rewind` covers them.

The confirmation is a row of buttons: **←/→** to move, **Enter** to confirm. The keys
`y` / `a` / `n` work as shortcuts, Esc rejects. In headless mode without `--yolo`,
anything requiring confirmation is rejected automatically. Plainly destructive commands
(`rm -rf /`, `mkfs`, a fork bomb) are blocked outright.

## Skills

A skill is a folder with a `SKILL.md` that carries frontmatter:

```markdown
---
name: code-review
description: When to apply it — the model decides from this line whether to load the skill.
triggers: ревью, review, посмотри код, что не так с кодом
---

The body: a proven procedure.
```

Create one with `/skills new <name> [description]` — it scaffolds the frontmatter and
prompts. `/skills new <name> global` makes it global rather than project-local.
`/skills edit <name>` opens the file in `$EDITOR`. `/skills gen <task>` has the agent study
the repository and write the skill itself.

Skills are looked up in `~/.trcode/skills/<name>/` (global) and
`<project>/.trcode/skills/<name>/` (project, overriding global). Only the name and
description reach the system prompt — the body is loaded by the `skill` tool when it is
actually needed.

A skill may carry a description per language: `description_ru` is used while `/lang ru` is
set, and the plain `description` is the fallback. Every bundled skill has one.

### Auto-selection

The catalogue in the prompt only invites the model to load a skill, and the request where
the procedure would have mattered is exactly the one a hurried model answers straight
away. `triggers` closes that gap: a comma-separated list of words a person actually types,
in every language you work in. When a request hits one, the body is put into the history
before the model answers — no tool call, no round trip:

```
> почини баг: падает с TypeError на пустом конфиге
  ⚡ skill debugging — баг, падает, почини
```

The rules are deliberately dull, because a wrong procedure costs more than a missing one:

- A trigger is required. Matching the name or the description only ranks candidates — it
  never fires by itself, so "run npm test" does not pull in the skill about writing them.
- **Talking about a subject is not asking for work on it.** "давай обсудим продвижение
  продукта", "как думаешь, стоит ли нам вкладываться в seo" — a conversation opener stops
  the matcher outright. A procedure is a few thousand tokens of instructions; a discussion
  is the wrong moment for it, and the model can still pull one in with the `skill` tool
  once the talk turns into a task.
- **Code is not prose.** Paths, file names, identifiers and backticked spans are removed
  before anything is read: `переименуй foo в bar в src/index.ts` was matching the database
  skill on the word `index` — which came from a filename, not from the person typing.
- **A word is counted once**, however many spellings of a trigger it resembles: "серверов"
  matching `сервер`, `серверы` and `серверов` is one fact, and scoring it three times made
  a passing mention look like a case.
- **A word half the catalogue claims decides nothing.** A trigger listed by three or more
  skills is worth half — it still ranks, but on its own it no longer reaches the bar.
- A two-word phrase outweighs a word, and a word already covered by another skill's
  matched phrase does not count twice: `ревью дизайна` goes to `design-critique`, not to
  `ui-design`.
- Endings are ignored, stems are not: `дублирования` matches `дублирование`, `почини`
  does not match `почисти`.
- Two close candidates mean no pick at all — the model still has the catalogue.
- Each skill lands once per session: it stays in the history afterwards, and re-sending it
  would be billed on every step from there on. `/resume` shows it folded to one line.

`auto: off` in the frontmatter keeps a skill out of this entirely; `/skills auto off`
(config: `skillAuto`) switches it off for everything. `/skills` marks with ⚡ the skills
that can fire on their own.

### The same match, mid-turn

A request announces maybe half of what a task will need. "Почини баг" becomes a test for
the fix, then a refactor of what the fix touched, then a line in the README — and none of
that was in the first sentence, so a matcher that runs once has already missed it. The
model's own plan is where that intent shows up, so the match runs again at every step
boundary of the turn, reading what the model just said and the arguments of the calls that
state a plan (`todo`, `task`):

```
  ⏺ edit src/skills/match.ts
  ⚡ skill writing-tests — тесты, юнит
  ⏺ write test/skill-test.mjs
```

The bar is higher there than for a request: narration is long, it restates the task in its
own words and names in passing everything it considered and dropped, so one stray trigger
word proves nothing — it takes a trigger phrase or two separate trigger words. At most two
procedures load per turn (each is paid for again on every remaining step), each still lands
once per session, and a file's contents are never read as intent — a file that says "тест"
a hundred times is not a request to write tests.

Subagents get this too, and it is the only way a procedure reaches them: they are given no
catalogue at all, so the `skill` tool is invisible to them. Their brief is matched the way
a request is, and one more load is allowed mid-run.

This repository carries a starter library in `.trcode/skills/`, usable as it is and as an
example of the format:

| Area | Skills |
| --- | --- |
| Code | `code-review`, `debugging`, `refactoring`, `writing-tests` |
| Product | `product-spec`, `technical-writing` |
| Design | `ui-design`, `design-critique` |
| Marketing | `positioning`, `marketing-copy`, `launch-plan` |
| Presentations | `presentation`, `pitch-deck` |

All of them carry triggers in English and Russian, so they fire on their own. Copy the
folders to `~/.trcode/skills/` to get them in every project. The whole catalogue costs
~800 tokens of system prompt; delete the folders you do not want.

`ui-design` ships with design briefs in `.trcode/skills/ui-design/briefs/` — four ready
systems (minimal SaaS, dark tech, editorial, dense console) with real tokens, section
order, a motion spec and a ban list, plus a shared motion system and a paste-ready prompt
block per brief. Modern and animated is the default there: every animation has to explain
a state change, and the timing scale, easings and reduced-motion rules are fixed once for
all of them.

One of them is about this repository rather than portable: `models-providers` documents
every provider trcode speaks to, the three wire dialects, how reasoning effort, prompt
caching, context windows and prices are decided, and the checklists for adding a provider
or a model family. It ships with reference files next to `SKILL.md`, read on demand.

## Project instructions

`AGENTS.md`, `TRCODE.md`, `CLAUDE.md` or `.trcode/instructions.md` are picked up walking
up from the current directory, plus `~/.trcode/instructions.md` as global instructions.

## Project memory

The agent remembers what is worth carrying across sessions: a decision taken, a convention
agreed on, a gotcha that cost an hour once and must not cost it again. Facts land in
`.trcode/memory.md` — plain markdown, one line per fact, safe to read and edit by hand.

Memory is **on by default**; `/memory` opens the settings screen with buttons to turn it
off and on (or `/memory off` / `/memory on` straight away), and `/memory show` prints what
is remembered.

```markdown
Builds with npm run build; tests need no network
The mock server owns port 8877 — do not hardcode another one
```

While on, everything in the file rides along in the system prompt as `<project-memory>`
(capped at 200 lines) and the `memory` tool is in the registry, so the next session opens
already knowing it. Turning it off takes both out of the session. The section is
snapshotted at session start like the rest of the prompt, which keeps the provider cache
intact while the tool writes the file.

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

## A panel of models

One model answering is one model's blind spots. `/brain` puts several on the same
question: each answers alone, then reads the others and revises, then one writes the
result. Where `task`, `/orchestrate` and `/swarm` split *work*, `/brain` splits *opinion*
— it is the mode for design questions, architecture reviews and "проверьте мою идею",
answered over one project by models that see it from different vendors.

```
/brain стоит ли выносить кеш в отдельный процесс
/brain models        # who is on the panel — ←/→ switches provider, Space marks, Enter confirms
```

The panel is chosen **across providers on purpose**: two models from one vendor share that
vendor's habits, and the disagreement between a Qwen and a Claude is worth more than
between two Qwens. That is why the picker's tabs are the providers rather than the output
types — the models you can reach are spread over several keys.

The panel has no tools and no session of its own — it is models talking, not agents
working — so what it needs to answer travels with the question.

**The conversation goes with it.** A question asked mid-session is usually about the
session: "обсудите идею" is three words and a pronoun, and what the pronoun points at is
on the screen, not in the question. So the recent part of the history goes along — what
was said, and, cut short, what the session read along the way. Newest first when the 24k
budget runs out, because the question was asked about the end of the conversation.

**A file the question names goes with it too**: `/brain обсудите ideas/001-router.md` reads
that file from the working directory and hands it to everyone. Up to three files and 40k
characters; a path that does not exist here is just a word in a sentence.

When there is neither — an empty session and no file named — the panel is told so before
it runs, not after three models have each spent a minute answering that they were given
nothing.

What the user sees is the discussion as it happens — each model's first answer and its
revision — and then one answer at the end, written by the session's own model, or by the
panel member marked as the main one (`/brain models`, "Make main"; kept in the config as
`brainMainModel`). The final
answer says where the panel genuinely disagreed and what the split depends on; it does not
manufacture a consensus, and it does not report on the process. The question and that
answer join the session as an ordinary exchange, so the next turn continues from it.

The arithmetic is worth knowing before you type it: a panel of three costs seven requests
(three answers, three critiques, one synthesis), and every one of them is billed to the
session. Two or three models is a panel; beyond four it is mostly models agreeing with
each other at your expense. A model that fails drops out and the rest carry on; if only
one survives, its answer is the answer — a lone model is not asked to critique itself.

## Subagents

The `task` tool runs a subtask in its own context and returns only its final text, so the
lead agent's history stays free of the intermediate steps. Several `task` calls in one
turn run in parallel.

A subagent is paid for by the key this session is using, and it runs on **the session's own
model by default**. `/subagents` names the other models it may be launched on — a shortlist
you choose:

```
/subagents              # the list, with checkboxes: Space marks, Enter confirms
/subagents model qwen3.8-max   # add one by name — alias or prefix resolve, as in /model
/subagents auto         # back to "the session's model only"
```

`/subagents model <id>` resolves the name the same way `/model` does and checks it against
the current provider's catalog before adding; a model another provider owns is refused with
that said, rather than added to a list it can never run from.

Left open, the offer's "use a cheap one for mechanical work" sent real work to the cheapest
id in the provider's catalog — one session racked up 130 requests and 2.8M input tokens on
`gemini-3.7-flash` nobody had chosen. A shortlist is still worth setting on a metered
account: four subagents on a host that allows one request a minute is four minutes of
queueing, and picking the models on purpose is how a fan-out stays predictable. Names that
the provider no longer serves are dropped from the list rather than offered; if that empties
it, the session's model comes back rather than an empty menu, which a model reads as "any
string will do".

Asking for a model outside the allowlist — or one from another provider — runs the subagent
on the session's model instead, with a line saying so; an `enum` is a suggestion to a model,
not a constraint on it.

How many run at once is `toolConcurrency` (default 4) — subagents are tool calls, so on a
host that meters requests this is also how many of them race for the same slot.

## Writing the prompt

A one-line ask costs the big model a step of guessing, another of asking, and often a
wrong first attempt — all at its price. `/prompt` spends a cheap model instead: it knows
the working directory and which skills exist, and turns the ask into a brief.

```
/prompt нарисуй интерфейс     # writes the brief, then: Send · Edit first · Discard
/prompt                       # asks what you want done, then the same
/prompt models                # reopens the list — the model picker, minus what this
                              # provider cannot serve
/prompt models qwen3.6-flash  # or name it outright; /prompt models auto goes back to
                              # the default one, still without asking again
/prompt_model …               # the same, as a command of its own
/prompt off | command | auto  # when it happens at all
/promt, /promt_model          # the spelling half of us type first
```

The first `/prompt` on a provider asks who should write — choose from the list, or keep
the model it would have used. Either answer is remembered, including "keep", so the
question is asked once and never again; `/prompt models` reopens the list later.

The writer is chosen **per provider**, because a key buys models at one host only: the
pinned one if it is there, else `smallModel` when it belongs to this provider, else the
session model. A pin at a model the catalogue no longer has — or one that cannot hold a
chat turn — is ignored rather than obeyed into a 404.

`auto` rewrites without being asked, but only what is worth rewriting: a message of at
least 40 characters that is not "продолжи", "да", "stop" or another continuation word.
Prefixing a message with `!` sends your own words untouched. What you typed stays on
screen either way — the brief is printed under it, dimmed, not instead of it. The call is
billed to the session like any other, and Esc cancels it; a writer that fails or returns
nothing leaves your original message to be sent as it is.

### Steps per turn

A turn runs until the model stops calling tools. There is **no step ceiling by default** —
`"maxSteps": 0`. The old default of forty was meant to catch runaway loops, but on real
work it fired far more often than on runaways: an audit of a repository is a hundred
reads, and being stopped two thirds of the way through to be told to say "continue" costs
more than the loop it was guarding against. What actually guards a turn is already there:
Esc ends it at any moment, the bar counts steps and tokens live, and auto-compaction keeps
the history inside the window.

Set a number to put a ceiling back — `"maxSteps": 40` — and the turn stops there with a
line saying so. Delegated runs keep their own bounds regardless (a subagent 40 steps, a
plan step 30, a swarm step 25): nobody is watching those, they cannot be told to continue,
and the agent that launched one can always launch another.

## Tests

Everything runs against a local mock of the API — no key and no network required:

```bash
npm test
```

```
PASS  protocol-test.mjs      60/60     PASS  history-test.mjs    13/13
PASS  provider-test.mjs     152/152    PASS  focus-test.mjs      8/8
PASS  mode-test.mjs          13/13     PASS  repaint-test.mjs    15/15
PASS  lang-test.mjs          13/13     PASS  menu-test.mjs
PASS  i18n-test.mjs          22/22     PASS  skill-test.mjs      67/67
PASS  diff-test.mjs          41/41     PASS  uilib-test.mjs      47/47
PASS  thinking-test.mjs      15/15     PASS  checkpoint-test.mjs 26/26
PASS  trim-test.mjs          12/12     PASS  resume-test.mjs     44/44
PASS  cache-test.mjs         25/25     PASS  turnbar-test.mjs    45/45
PASS  prompt-test.mjs        35/35     PASS  transcript-test.mjs 14/14
PASS  projection-test.mjs    11/11     PASS  preset-test.mjs     9/9
PASS  codemode-test.mjs      9/9       PASS  fork-test.mjs       10/10
PASS  stat-test.mjs          17/17     PASS  update-test.mjs     23/23
```

51 suites in all. The suites cover the wire protocols, provider routing and the OAuth device flow (against a
throwaway server on localhost), history trimming, the request projection log, the code-mode
sandbox (path guard, snapshots, timeout, abort), session forking, the tool presets and the
self-update path against a mock of the GitHub API,
plus the terminal behaviour that is otherwise painful to verify: paste in four delivery
shapes, split escape sequences,
Shift+Tab in its three encodings, focus events, frame repainting, multi-line input,
prompt history, the resume flow and the
during-turn bar on a virtual screen, and the process actually exiting instead of lingering.

`test/measure-tokens.mjs` measures request sizes at several `maxRequestTokens` thresholds
and prints the table from the "Token spend" section.

To drive the CLI against the mock by hand:

```bash
MOCK_PORT=8799 node test/mock-server.mjs &
TRCODE_HOME=./.tmp-home \
TOKENROUTER_BASE_URL=http://127.0.0.1:8799/v1 \
TOKENROUTER_API_KEY=sk-test TRCODE_MODEL=mock-smart \
  node dist/index.js -p "read package.json" --json
```

## Running inside Orca

[Orca](https://orcaterm.com) runs several agents in split panes and colours each one by
what it is doing. It learns that over a loopback HTTP server: an agent POSTs its state to
`http://127.0.0.1:<port>/hook/<agent>`, and the pane turns **working**, **needs attention**
or **done** — the last one is what raises the notification when a long turn finishes.

TRCode speaks that protocol when it finds itself in an Orca pane. Nothing to configure:
`ORCA_PANE_KEY` in the environment is the switch. It reports the prompt, a throttled
preview of the answer, permission requests (the pane goes red until you answer) and the
end of the turn.

One wrinkle worth knowing: Orca answers **404** to an agent id it does not know, and
TRCode is not on its list — the routes are `claude`, `codex`, `cursor`, `gemini`, `grok`,
`kimi`, `opencode` and ten more. So the reports go out as `opencode`, whose contract is
public (Orca ships the plugin that speaks it). The pane will show an opencode icon; the
status, the preview and the notifications are the real ones.

```json
{ "orca": true, "orcaAgent": "opencode" }
```

`"orca": false` stays silent; `orcaAgent` switches the route (`"claude"` also works). If
Orca is closed, slow or missing, the reports fail open — a post has a 1.5 s timeout and its
failure never reaches the turn.

### Making Orca call it trcode

The status works as described above, but the pane is labelled after whichever agent's
route is used. Orca's agent list lives inside `resources/app.asar`, and adding an entry
means repacking the archive — asar is a header of offsets followed by concatenated files,
so inserting one byte shifts everything after it. Replacing bytes with the *same number*
of bytes is safe, which leaves one move: take over the slot of an agent you do not use.

`scripts/orca-agent-patch.mjs` takes `cursor`, whose binary name (`cursor-agent`) and
label (`Cursor`) are exactly as long as ours:

```bash
npm link                                   # provides the trcode-agent command
node scripts/orca-agent-patch.mjs --check   # what it would do, changes nothing
node scripts/orca-agent-patch.mjs           # apply, then restart Orca
node scripts/orca-agent-patch.mjs --revert  # back to the backup it made
```

Four strings change: the three that name the binary Orca looks for and launches, and the
display name. The internal id stays `cursor`, so the hook route and the pane icon still
belong to it — the icon will be Cursor's, the label will read Trcode. Orca stops offering
Cursor, and every Orca update replaces `app.asar` and undoes this, so run it again after
one. The script refuses to write if Electron's ASAR integrity fuse is on (a patched file
would stop the app from starting), asserts the file size is unchanged before writing, and
refreshes its backup from whatever the current build is.

## Layout

```
src/
  index.ts             entry point, arguments, headless mode
  config.ts            config, key, project instructions
  provider/
    client.ts          request dispatch, SSE, retries, effort probing
    registry.ts        providers: routing by model id, base URL, headers
    credentials.ts     per-provider tokens, kept out of config.json
    oauth.ts           OAuth 2.0 device flow (RFC 8628)
    protocol.ts        which wire protocol a model speaks
    responses.ts       OpenAI Responses adapter
    anthropic.ts       Anthropic Messages adapter
    models.ts          catalog, cache, aliases, vendor grouping
  agent/
    loop.ts            the answer → tools → answer cycle
    prompt.ts          system prompt
    subagent.ts        the task tool
    swarm.ts           /swarm
    orchestrator.ts    /orchestrate
  session/
    session.ts         history, persistence, fork
    compact.ts         context compaction
    trim.ts            per-request history trimming
    projection.ts      per-request token projection log (/trace)
    checkpoint.ts      file snapshots for /rewind
    history.ts         prompt history across restarts
  tools/               read, edit, write, ls, glob, grep, shell, read_image,
                       run_code (opt-in), skill, todo, memory, task
  skills/loader.ts     skill discovery
  ui/
    highlight.ts       syntax colour for diffs
    editor.ts          raw-mode line editor
    stdin.ts           single owner of the input stream
    repl.ts            the loop, turns, transcript
    commands.ts        slash commands
    render.ts          banner, markdown, tables, spinner, diffs
    layout.ts          chat geometry and time formatting
    picker.ts          list picker with tabs and sections
    choice.ts          button row for confirmations
    prompt.ts          one-line text prompt (rename)
    turnbar.ts         the bottom bar shown while a turn runs
    orca.ts            pane status reporting for the Orca terminal
    keyscan.ts         /keys inspector
```

## License

MIT
yscan.ts         /keys inspector
```

## License

MIT
r
```

## License

MIT
