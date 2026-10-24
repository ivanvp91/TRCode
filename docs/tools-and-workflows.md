# Tools and workflows

[Back to README](../README.md)

- [Tools](#tools)
- [Confirmations](#confirmations)
- [Skills](#skills)
- [Project instructions](#project-instructions)
- [Project memory](#project-memory)
- [A panel of models](#a-panel-of-models)
- [Subagents](#subagents)
- [Writing the prompt](#writing-the-prompt)
- [Working toward a goal](#working-toward-a-goal)
- [Images, video and audio](#images-video-and-audio)

## Tools

`read`, `edit`, `write`, `ls`, `glob`, `grep`, `shell`, `read_image`, `web_search`, `fetch`,
`run_code` (opt-in), `skill`, `todo`, `memory`, `task`, `ask_user_question`, plus anything the connected MCP
servers provide. `generate_image`, `generate_video` and `generate_audio` join them once a
model is chosen — see [Images, video and audio](#images-video-and-audio).

`web_search` queries DuckDuckGo's keyless HTML endpoint — no API key, no account;
`fetch` downloads a URL and strips the HTML to readable text. Both sit in the
`network` permission class, so by default every call asks first.

`read_image` puts a picture in front of a vision model: PNG/JPEG/GIF/WebP with automatic
downscaling to a preview of at most 1.6 MB; `crop` inspects a region. Originals are
preserved. `describe=false` reads metadata only, also for large files and BMP.
A host that refuses images is
remembered, and later reads arrive as text only.

Independent calls in one turn run in parallel (up to 4 at a time).

`ask_user_question` lets the model collect 1–4 related decisions in the same bordered
modal used by the model and provider pickers. The dialog opens directly above the input
line — the conversation stays where it is and the input, spinner and status keep their
place under it. Walk the options with ↑↓ and Enter;
multi-select questions use Space to mark options. Every question also accepts your own
answer — choose **Your answer** or start typing. **Back** keeps earlier answers editable.
The last screen reviews the whole batch; only **Submit** sends it to the model and saves
it in the conversation. **Esc / Ctrl+C** cancels the turn without submitting partial
answers. Parallel agents' questions and permission prompts are queued. In headless runs
the tool reports that interaction is unavailable, leaving the model to ask in its reply.

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
through the ordinary write permission, read-before-overwrite guard, conflict check and
snapshot store so `/rewind` still reaches them. Native imports, `process`, `require`
and global `fetch` are unavailable. No environment secrets are inherited. These
restrictions and Node permissions provide defense in depth, not an OS sandbox for
hostile code. The program runs under a
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

Any MCP server — the same ones Claude Code runs — plugs in through the config, in
the same shape. Stdio is the default; `url` selects Streamable HTTP:

```json
// ~/.trcode/config.json, or .trcode/mcp.json in a project (project wins on a shared id)
"mcpServers": {
  "tradingview": {
    "command": "npx",
    "args": ["-y", "some-tradingview-mcp"],
    "env": { "API_KEY": "…" },
    "tools": ["get_quote", "search_symbols"],
    "approval": "ask"
  },
  "docs": {
    "url": "https://mcp.example.com/mcp",
    "headers": { "X-Client": "trcode" },
    "bearerTokenEnvVar": "DOCS_TOKEN",
    "toolInputSchemaMaxBytes": 3000
  }
}
```

A server in a project's `.trcode/mcp.json` is a command that repository wants run on your
machine, so it does not start until you allow it: `trc` names the waiting servers at
startup, `/mcp` shows exactly what each would run, and `/mcp trust` starts them. The
approval covers this folder and this exact config — any edit to the command, its
arguments or environment has to be approved again. Servers in your own
`~/.trcode/config.json` start without asking.

Servers start in the background at session start; their tools appear in the registry as
`mcp__<id>__<tool>` when each one is ready. Names that require sanitizing or truncating
receive a hash suffix to avoid collisions. Tools explicitly marked read-only use
`network` permission (`read` when the server's `approval` is `auto`); other tools use
`write`. Both ask by default.

What a server can say and what this client does with it:

- **`tools/list`** is paginated (`nextCursor`) and re-read when the server sends
  `notifications/tools/list_changed` — a tool added mid-session becomes callable
  without `/mcp reload`. A failed re-list keeps the previous catalog.
- **Schemas are compacted.** One tool schema may cost more than the tool's answer;
  `toolInputSchemaMaxBytes` (default 5000) is the budget. Over it, descriptions are
  dropped first, then `$defs`, then objects deeper than three levels collapse. This
  also caps what a third-party server can inject into every request.
- **Filters.** `tools` is an allowlist; `enabledTools` / `disabledTools` refine it.
- **Resources** become three tools — `list_mcp_resources`, `read_mcp_resource`,
  `list_mcp_resource_templates` — that appear once a connected server advertises them.
- **Results** keep text, attach `image` blocks to the model (vision hosts), fold
  `structuredContent` into a JSON block (unless a text block already carries the same
  JSON), and cut at `outputLimit` characters.
- **Server requests**: `ping` is answered, `roots/list` returns the project folder;
  sampling and elicitation are refused.
- **Progress** (`notifications/progress`) is printed in the transcript; **images** and
  **resource links** are no longer replaced by `[content omitted]`.
- **Transport failures** are retried three times (250 ms, 1 s) for the handshake and
  the catalog; a Streamable HTTP session the server forgot (404) is re-established and
  the call replayed once. A crashed server is restarted with backoff (1 s → 30 s).
- **Protocol revisions**: `"protocol": "legacy"` (default) speaks `initialize`;
  `"auto"` probes `server/discover` and falls back; `"2026-07-28"` insists on the
  stateless revision and carries version and client identity in `_meta` on every
  request. A server older than the revision is the expected case, not an error.

`/mcp` shows status, protocol, tools, resources and templates; `/mcp restart <id>`,
`/mcp stop`, `/mcp logs <id>` and `/mcp reload` cover the rest.

`"tools"` is optional but worth setting on fat servers, and `mcpToolSearch: true` goes
further: instead of sending every server's schemas, the registry exposes one
`find_mcp_tools` search, and the schemas of the matches join the request as soon as the
model asks for them.


### Multi-agent work

Three ways to distribute agent work, using the same worker execution policy, plus a panel without tools:

- **`task`** — the model spawns subagents for subtasks itself. Several `task` calls in one
  turn run at once; each has its own context and model, and the lead agent sees only their
  final text. A request with several independent parts is fanned out this way without being
  asked, and the running helpers are listed in the turn bar with their model, step budget
  used and tokens spent. `read_only: true` gives a scout with no write access. By default a
  subagent runs on **the session's own model** — `/subagents` names other models it may be
  launched on (a session left open once sent its reconnaissance to the cheapest id in an
  OpenRouter catalog: 130 requests, 2.8M input tokens on a model nobody chose for this).
- **`/orchestrate`** (`/orch`) — the task is split into 2-6 subtasks with dependencies.
  Independent steps run in parallel, dependent ones receive their predecessors' results,
  investigation steps are read-only, and writing steps run one at a time and last. The
  current model then merges everything into one answer. The plan and step statuses are
  visible as it goes. With a `/subagents` list switched on, the planner is shown it — size
  and price included — and picks a model per step: the big one where there is a judgement
  call, a cheap one for mechanical reconnaissance. A step naming anything else runs on the
  session's model, and the plan on screen names the model each step will actually use.
  The planner receives recent conversation context and read tools to inspect the project.
  The task, plan, step results and each worker's own history are saved as work proceeds.
  `/orchestrate status` shows saved progress without making requests; `/orchestrate resume`
  continues interrupted or failed work, skipping completed steps. It also works after
  reopening the session with `/resume`. `/orchestrate replan <instructions>` revises the
  unfinished part while preserving completed steps and their results. Replanning is explicit;
  the scheduler does not silently replace a plan after a failure. Starting a new task replaces
  the session's saved orchestration. Stopping a task preserves file changes already made.
- **`/swarm`** — one task goes to several models from different vendors at once, they work
  read-only, and one model then merges the answers and names the disagreements explicitly.
  The roster is picked by hand on `/swarm models` — or, with nothing chosen, automatically:
  the session's model plus one model per other vendor. Bare `/swarm` opens the panel, where
  ★ marks the model that writes the synthesis (unpinned, the session's model writes it).
  Workers receive recent conversation context. A worker that reaches its step limit or is
  interrupted is reported as incomplete and does not enter synthesis as a completed answer.
  Interrupted runs retain available worker text in the conversation, marked as unsynthesized.
- **`/brain <question>`** — not agents but models talking: several answer the same
  question alone, read each other's answers, revise, and one writes the final text. They
  have the session's tools under its approval rules, so a current fact can be looked up —
  see [A panel of models](#a-panel-of-models).

Chat, `/orchestrate`, `/swarm` and `/brain` keep the input frame and status line visible
while running. Esc or a single Ctrl+C stops the active task. In chat, Enter steers the
running turn — the message joins it at the next step, after the tool results and before
the next request — and Tab queues it for a turn of its own. Commands and panels have no
step boundary to steer, so Enter there always queues. After an interrupt, queued messages
and the draft return to the editor and are not automatically sent.
The `toolConcurrency` setting bounds worker fan-out in chat, orchestration and swarm;
orchestration steps that change files still run one at a time.

## Confirmations

| Class | Default |
|---|---|
| `read` (read, ls, glob, grep, skill, todo) | `allow` |
| `write` (write, edit) | `ask` — with a diff |
| `shell` | `ask` — with the command |
| `network` (web_search, fetch, explicitly read-only MCP tools) | `ask` |
| `paidMedia` (generate_image, generate_audio, generate_video) | `ask`, independently of `network` |
| `agent` (task) | `allow` |

A `run_code` program asks under its own name for everything risky it does: shell commands
confirm as `run_code>shell`, web calls as `web_search`/`fetch`. File writes inside the
program use `write` permission and the same file guards and snapshots as the file tools.
An unclassified MCP tool uses `write` permission too.

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

A skill may carry a description per language: `description_ru` (or `description_de`, …) is
used while that language is set, and the plain `description` is the fallback. Every bundled
skill has a Russian one; other languages fall back to English until someone writes them.

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

Bare `/brain` opens the same panel as **checkboxes**: every row is a member, Space marks
or unmarks it on any tab (`Active models`, `Favorites`, `All models`), and Enter saves the
whole set at once — newly checked rows join the panel, unchecked rows leave it. A panel of
ten is assembled in one visit, not ten. The question itself is the `Ask…` button, or
`/brain <question>` on the command line.

The panel has **the session's tools** — web search and fetch, reads, shell — under the same
approval rules as an ordinary turn, and no session of its own. A question about a library's
current behaviour is checked against the web instead of being guessed at, and a question
about this project is answered from the files themselves. Three rounds of three models
multiply every tool step by nine, so the budget is short: eight tool rounds for the
answering round, four for revision and synthesis, and the panel is told to use them to
find facts rather than to make changes — it is a discussion, not the agent's turn.

**When the budget runs out, the model is asked for its answer anyway** — the same history,
the tools taken away, one request. Without that a model that researches well stops on the
sentence it was about to act on ("let me check a few more facts") and the panel carries
that sentence into the final answer as if it were one: a four-minute run whose result was
a promise to look something up.

What it does **not** have is history. A question put mid-session still needs the recent
conversation to resolve a pronoun — see below — and the files the question names travel
with it.

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

The lead reaches for this on its own. A request that splits into independent parts — a
translation into ten languages, a review per module, the same edit in many files — is a
fan-out, not a queue: one `task` call per part in the same turn, without the user having
to ask for subagents. Independent tool calls in general go out together.

While helpers work, the turn bar lists them:

```
1. deepseek-v4.1-flash 70% · 25k tok · read src/agent/loop.ts
2. glm-5.3-flash 12% · 3.2k tok · grep(task)
```

A row carries the model, the share of the helper's step budget it has used, the tokens it
has spent so far, and its latest action. The percentage is measured against the same step
ceiling the helper runs under — 100% is where it is stopped — so it caps at 99% while the
helper is alive. A row leaves the list the moment its helper returns: the header and the
result are already in the transcript, and the turn bar gives those rows back to the answer
that follows. The row uses the stats line's palette: the model in orange, the numbers,
the percentage and the action in gray.

A subagent is paid for by the key this session is using, and it runs on **the session's own
model by default**. `/subagents` is where that is decided — two modes, and the panel says
which one is in force:

- **the session's model** — every subagent runs on whatever the session runs on;
- **a list you chose** — subagents may be launched on any model marked in it.

The list is kept either way. Switching to the session's model does not throw it away, so
coming back to a shortlist of five costs one keystroke instead of five choices; `Forget the
list` is the separate, deliberate button.

```
/subagents              # the panel: Space marks, Enter saves and switches to the list
/subagents model qwen3.8-max   # add one by name — alias or prefix resolve, as in /model
/subagents session      # run on the session's model; the list stays, unused
/subagents list         # use the list again
/subagents auto on      # let the lead launch helpers without asking, for this provider
/subagents auto off     # ask before autonomous delegation (the default)
```

The panel includes an Auto on/off button, independent of the model choice. With auto off,
an autonomous `task` launch asks **Yes / No / Enable auto mode**. Yes approves helper
launches for the current turn; No makes the lead continue on its own. Parallel launches
share one decision. Enable auto mode saves the setting for the current provider, so later
turns do not ask. An explicit request such as "launch subagents" or "запусти субагентов"
authorizes that turn without changing the saved setting; an explicit prohibition still
blocks delegation with auto on. YOLO does not override this preference.

If helper models have never been chosen, an approved launch opens the provider's model
picker before starting helpers. Mark models to use that list, or save an empty selection
to explicitly use the session's model. Cancelling the picker stops the turn. A helper
with no explicit model uses the first available configured model in list mode.
`/orchestrate` is an explicit delegation request and also checks model setup. In a
noninteractive session, configure models in advance; with auto off, autonomous launches
are declined unless the user's request explicitly asks for helpers.

The same shortlist is what `/orchestrate` offers its planner, so one choice governs every
agent this session may launch.

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

How many workers run at once is `toolConcurrency` (default 4), including orchestration
and swarm workers. On a host that meters requests this bounds how many workers race for
the same slot. Each worker may make up to three concurrent tool calls of its own.

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

## Working toward a goal

A task you have to keep prodding — "get the tests green", "finish the migration", "audit
every route and fix what is broken" — is exactly what `/goal` is for. It sets a persistent
objective, and after every turn of yours the agent takes another one on its own, keeping
at it until the work is done, the budget runs out, or you stop it.

```
/goal make npm test green          # set it; the agent continues after each of your turns
/goal rewrite docs --turns 10      # with an explicit budget
/goal                              # status: the mark, the objective, turns spent
/goal pause                        # stop the automatic continuation (Esc does the same)
/goal resume                       # continue; a spent budget is granted anew
/goal clear                        # remove it
```

The goal lives on the session, so it survives restart and `-c`/`--resume`: coming back to
the session comes back to the goal, and the status line under the input carries its mark —
◉ active, ◎ paused, ✓ complete.

How it works, in brief:

- Every goal turn sends the objective again as its prompt — *assess the state, do the next
  concrete step, verify the result* — so the model always knows what it is chasing, not
  just what the last tool call left behind.
- Only the model's own word ends it: a reply that ends with the `<goal-complete>` tag
  marks the goal done. Prose like "done" in a status note does not fire.
- Anything you type between goal turns goes first — a question, a correction, `/goal
  pause` mid-run lands instead of waiting out the round.
- **Esc pauses the goal** rather than skipping one round: an interrupt must mean stop, not
  "try again on your own". `/goal resume` continues it.
- A turn that fails on the network pauses the goal too — an unattended loop must not
  retry into a dead host forever.

Without `--turns` a built-in limit of **25 turns** pauses the goal on its own — an agent
running unattended must not be able to burn tokens forever. The pause is announced once;
`/goal resume` grants a fresh budget of the same size. An explicit `--turns <n>` replaces
that limit.

## Images, video and audio

Image, video and audio models do not answer `/chat/completions`, so they are not chat
models here — they are tools. You pick one, and the model you are talking to writes the
prompt and calls it when you ask for a picture, a clip or a voice-over. The result lands
in the directory trcode was started from (`image-<timestamp>.png`, `video-….mp4`,
`audio-….wav`); scratch files live in `.tmp/` and are deleted once they are not needed.

```
/image                 # the model panel: provider tabs, search, what each model can do
/image seedream        # or name it — any unique part of the id
/audio                 # the same for speech and music
/video model           # the same for video
/image off             # take the tool away again
```

The panels are the `/model` panel with media pools in it. Where `/model` shows context and
price, these show capabilities: aspect ratios, resolutions, durations, how many variants,
price per second.

| Provider | Images | Video | Audio |
|---|---|---|---|
| OpenRouter | `POST /images`, every model in its image catalogue; parameters are checked against it | `/videos` — Seedance, Veo, Kling, Sora, Wan, Hailuo… | gpt-audio (speech), Lyria (music) |
| TokenRouter | `image-generation` models | `video-generation` models (new-api tasks) | `audio-chat` models |
| xAI (API key) | grok-imagine, including edits of a source image | grok-imagine-video | — |
| Z.AI | glm-image, cogview | cogvideox-3 | — |

The chosen model is stored with its provider — `openrouter:bytedance/seedance-2.5`,
`tokenrouter:kling-v3` — because the provider decides which API is called. A Grok
subscription (OAuth) reaches only the chat proxy, so xAI media needs the API key.

Every generation is paid, so each one asks first, like a shell command, and shows the
model and parameters. Esc stops waiting for a video; the job may still finish on the
provider's side. Allowing ordinary network access does not authorize paid generation:
`permissions.paidMedia` controls it separately; `--yolo` explicitly allows it too.

Each generation works in its own folder, `.tmp/<kind>-<timestamp>-<id>/`, holding a
`manifest.json` (prompt, parameters, reference hashes, status, cost, job id), references
and the retained paid response. Once the result is saved, the folder is removed.

For planning and assembly, the agent first calls `prepare_media_workspace`, which creates a
`.tmp/` folder for scripts, downloads and scenes; passing it as `workspace` keeps scene
generations (each with its own record and `result.*`) inside it. Only the finished
deliverable goes to the current directory. Project workspaces are removed when trcode exits.
A folder that still holds paid but unsaved output, or a video job in flight, is kept until
`resume_media` finishes it. An explicit `out` can export elsewhere; existing files are
refused before payment and are never silently replaced.
`resume_media` recovers retained image/audio or resumes polling/downloading the existing
video job, without a new generation POST. A failed submission with no job id remains
`submission_unknown`; it must not be automatically repeated.

- **Images** — `generate_image`: prompt, aspect ratio, resolution or size, quality,
  format, background, variants, and reference images (local paths or URLs) for models that
  take them. Unsupported options and values are rejected before payment. Returned
  images must actually decode; filenames follow the real format. Size, aspect ratio,
  requested format and transparency are checked and mismatches are reported.
- **Audio** — `generate_audio`: a speech model reads the text word for word in the chosen
  voice and delivery ("cheerful", "whispered"); a music model takes a brief. The format is
  checked from the protocol: requested speech PCM16 is wrapped as 24 kHz mono WAV.
  Truncated/malformed streams fail rather than publish partial speech. Available
  transcripts, silence and clipping are checked and discrepancies are reported.
- **Video** — `generate_video`: duration, resolution, aspect ratio, sound, first and last
  frame, plus reference images on supported hosts. Invalid parameters are refused before
  submission; temporary polling failures are retried. MP4 downloads are streamed,
  bounded and checked for a valid container signature; this is not full codec or visual QA.

### Video mode

`/video` turns the session into a studio. Questions, planning and settings do not trigger
paid generation. For a generation request, a text
model — any one, chosen with `/video prompt_model`, or the session's own — looks at
attached images, writes the shot description with timed beats, and calls the video
model. The durations, resolutions and aspect ratios the video model accepts go into its
system prompt, so it does not guess. The first `/video on` asks for both models;
`/video off` goes back to the model the session had before. The mode lasts until the
program exits — after a restart it is off, so nothing is generated by accident.

Reference and editing capabilities depend on the selected model. External links need
appropriate reading tools; local editing and assembly can use shell tools. A failed
paid job is not automatically resubmitted. xAI Imagine 1.5 supports a pinned last frame
and respects an explicit request for silent video.
