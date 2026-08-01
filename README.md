# trcode

An agentic coding CLI for [TokenRouter](https://api.tokenrouter.com) models — a terminal
agent in the spirit of Claude Code, with live model switching, subagents, skills and
token accounting.

Node 20+, zero runtime dependencies (native `fetch`, raw-mode TTY, ANSI).

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

Key and settings live in `~/.trcode/config.json` (mode 600). Environment variables
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

Flags: `-m/--model`, `-e/--effort`, `-C/--cwd`, `-c/--continue`, `-r/--resume <id>`,
`-p/--print`, `--json`, `--base-url <url>`, `--yolo` (no confirmations).

## Commands

Type `/` and a filtered command list opens under the input: ↑↓ to move, Enter to
insert, Esc to dismiss. `/help` prints the full reference.

**Main**

| Command | What it does |
|---|---|
| `/model [name]` | switch model; with no argument, a vendor-grouped list with type tabs |
| `/effort [level] [save]` | reasoning budget: `off`, `minimal`, `low`, `medium`, `high` |
| `/orchestrate <task>` | split a task into subtasks and run them on subagents |
| `/swarm <task>` | several models solve it in parallel, then a synthesis pass |
| `/compact [focus]` | compact the history into a structured digest |
| `/yolo [on\|off]` | skip confirmations — tools run immediately |
| `/new` | start a new session |

**Session** — `/sessions`, `/resume [id]`, `/rename [title]`, `/context`, `/cost`

**Settings** — `/default [name]`, `/models [all]`, `/aliases`, `/permissions`, `/login`, `/config`, `/cwd`

**Other** — `/tools`, `/skills`, `/todo`, `/keys`, `/init`, `/clear`, `/version`, `/help`, `/exit`

### Keys

**Ctrl+Enter** inserts a newline inside a message. Enter with *any* modifier is accepted,
in both reporting schemes (kitty `ESC[13;Nu`, xterm `ESC[27;N;13~`), as is Alt+Enter and
a trailing backslash.

If your terminal sends something else, `/keys` shows the exact bytes of every keystroke
and offers to pin the combination; it is stored in the config under `newlineKeys`. If a
key press produces no output at all, the terminal is swallowing the combination as its
own shortcut and the CLI cannot see it.

**↑ / ↓** walk the prompt history, which persists across restarts, separately per project.
**Esc** interrupts the current turn, **Ctrl+C** exits, **Ctrl+L** repaints the frame.

## The interface

Below the input sits a status line: mode, model, reasoning budget, directory and how
full the context window is.

```
   ╭────────────────────────────────────────────────────────────────╮
   │ ❯                                                              │
   ╰────────────────────────────────────────────────────────────────╯
   yolo  moonshotai/kimi-k3  thinking: high  ~/proj      context: 3% (23k/1M)
```

The `yolo` marker appears when confirmations are off (`--yolo` at launch, or `/yolo`).

Typing `/` opens the command list right under the frame:

```
   ╭──────────────────────────────────────────────────────────────╮
   │ ❯ /                                                          │
   ╰──────────────────────────────────────────────────────────────╯
     → /model     [name|alias]  —  switch model
       /effort    [off|minimal|low|medium|high] [save]
       /yolo      skip confirmations
       (1/25)  ↑↓ · Enter to pick · Esc to dismiss
```

While the model works, the input frame stays where it is: the spinner sits above it and
the transcript scrolls above that. A ten-minute run never leaves you looking at a bare
spinner wondering whether the prompt is coming back.

```
   ⏺ read(src/index.ts)
     └ 45 of 45 lines
   ⠹ reasoning (6m 33s · ↑18k ↓11.4k)  esc to interrupt · type to queue a message
     ⎿ queued: and check the tests too
   ╭────────────────────────────────────────────────────────────────╮
   │ ❯                                                              │
   ╰────────────────────────────────────────────────────────────────╯
   moonshotai/kimi-k3  thinking: high  ~/proj      context: 3% (23k/1M)
```

You can type while the model is busy. **Enter** queues the message and it is sent as soon
as the current turn finishes; anything left unsent stays in the box for editing. **Esc**
interrupts the turn and does not clear what you typed.

After a turn, only that turn — nothing already shown under the input is repeated:

```
   moonshotai/kimi-k3:high · ↑1.5k ↓40 · 2 steps · 12s
```

The chat area has margins (narrow on the left, wider on the right); on a narrow terminal
the right margin collapses rather than squeezing the text.

## Resuming a session

Sessions are stored per project. `/resume` opens the picker, and every row says how much
context that session carries — the number that decides what the next turn will cost. It
turns yellow past half the window and red past 80%.

```
   Pick a session
   ↑↓ move · Enter select · Esc cancel · type to filter
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

## Token spend

An agent loop resends the whole history on every step, so a long session costs
quadratically in input tokens — that is where bills like "2.2M in, 44k out" come from.
Most of that bulk is tool output (file dumps, greps) the model has already read and acted
on.

So before each request **old tool results are shortened** to their first lines with a note
that the rest was omitted. Nothing is dropped, `tool_call` ↔ `tool` pairing stays intact,
and the last few turns are left untouched. Measured on a 12-round tool-heavy session
(bytes of real requests):

| Threshold | Sent | Saved |
|---|---|---|
| no limit | 2001 KB | — |
| 120k | 2001 KB | 0% — never reached |
| 60k | 1771 KB | 11% |
| **40k (default)** | **1356 KB** | **32%** |
| 25k | 1173 KB | 41% |

The threshold is `maxRequestTokens` (default 40 000; `0` disables it):

```json
{ "maxRequestTokens": 40000 }
```

The second safeguard is auto-compaction. A fraction of the window (`autoCompactAt`) is
useless on a 1M-token model — 82% of 1M never arrives, and the history grows all session.
So compaction also triggers on an absolute threshold: twice `maxRequestTokens`.

`/compact` compacts on demand; `/cost` shows where the tokens went.

Reasoning tokens are counted separately, because they bill as **output**: a three-line
answer can carry 25k tokens of thinking at `high`. If more than half the output is
reasoning, `/cost` says so and suggests lowering `/effort`.

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

Native Gemini, image and video generation and audio chat are not supported — those models
are hidden by default, and `/models all` lists them with the reason.

```
/models          # only the ones that actually work, by vendor
/models all      # the whole catalog, annotated with why the rest do not
```

`/model` with no argument opens a list with type tabs — **[Text] [Images] [Video] [Audio]**
(←/→ or Tab) — grouped by vendor, newest first inside a group (by the API's `created`
field). MoonShot, Anthropic, OpenAI, Qwen and xAI are pinned to the top:

```
    Models
   [ Text 75 ] [Images] [Video] [Audio]     ←/→ or Tab to switch type
    ── MoonShot ───────────────
   ❯ moonshotai/kimi-k3          ★● ctx 1M
     moonshotai/kimi-k3-free        ctx 1M
     moonshotai/kimi-k2.7-code
    ── Anthropic ──────────────
     anthropic/claude-opus-5
```

★ is the default model, ● the current one. Typing filters the list.

Turn the filter off with `"hideIncompatibleModels": false`. Picking an incompatible model
warns you outright instead of failing on the first request.

Names can be abbreviated: `/model k3`, `/model grok-4.5`, `/model deepseek-v4-pro` —
aliases, the tail after `/`, prefixes and substrings all resolve; ambiguity prints the
candidates.

`/model <name>` changes the model for this session only; `/default` writes it to the config
(and applies it immediately). If a saved model disappears from the catalog, the CLI falls
back to the default and says so.

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

`read`, `edit`, `write`, `ls`, `glob`, `grep`, `shell`, `skill`, `todo`, `task`.

Independent calls in one turn run in parallel (up to 4 at a time).

### Multi-agent work

Three mechanisms, deliberately distinct:

- **`task`** — the model spawns subagents for subtasks itself. Several `task` calls in one
  turn run at once; each has its own context and model, and the lead agent sees only their
  final text. `read_only: true` gives a scout with no write access.
- **`/orchestrate`** (`/orch`) — the task is split into 2-6 subtasks with dependencies.
  Independent steps run in parallel, dependent ones receive their predecessors' results,
  investigation steps are read-only, and writing steps run one at a time and last. The
  current model then merges everything into one answer. The plan and step statuses are
  visible as it goes.
- **`/swarm`** — one task goes to several models from different vendors at once (the roster
  is picked automatically), they work read-only, and the current model then merges the
  answers and names the disagreements explicitly.

## Confirmations

| Class | Default |
|---|---|
| `read` (read, ls, glob, grep, skill, todo) | `allow` |
| `write` (write, edit) | `ask` — with a diff |
| `shell` | `ask` — with the command |
| `agent` (task) | `allow` |

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
actually needed. See `.trcode/skills/code-review/` for an example.

## Project instructions

`AGENTS.md`, `TRCODE.md`, `CLAUDE.md` or `.trcode/instructions.md` are picked up walking
up from the current directory, plus `~/.trcode/instructions.md` as global instructions.

## Context window

The API does not report window sizes. `kimi-k3` and `kimi-k3-free` are pinned at 1M; the
rest fall back to an estimate of 128k, marked `?` in the status line. Pin real values in
`config.json`:

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
  "maxRequestTokens": 40000,
  "requestTimeoutMs": 300000,
  "maxSteps": 60,
  "autoCompactAt": 0.82,
  "temperature": 0.2
}
```

## Tests

Everything runs against a local mock of the API — no key and no network required:

```bash
npm test
```

```
PASS  protocol-test.mjs      36/36     PASS  repaint-test.mjs    5/5
PASS  editor-harness.mjs     11/11     PASS  menu-test.mjs
PASS  paste-test.mjs         9/9       PASS  resume-test.mjs     39/39
PASS  newline-test.mjs       13/13     PASS  turnbar-test.mjs    21/21
PASS  history-test.mjs       9/9       PASS  keyscan-test.mjs    6/6
PASS  focus-test.mjs         8/8       PASS  shutdown-test.mjs   8/8
```

The suites cover the wire protocols and history trimming, plus the terminal behaviour that
is otherwise painful to verify: paste in four delivery shapes, split escape sequences,
focus events, frame repainting, multi-line input, prompt history, the resume flow and the
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

## Layout

```
src/
  index.ts             entry point, arguments, headless mode
  config.ts            config, key, project instructions
  provider/
    client.ts          request dispatch, SSE, retries, effort probing
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
    session.ts         history, persistence
    compact.ts         context compaction
    trim.ts            per-request history trimming
    history.ts         prompt history across restarts
  tools/               read, edit, write, ls, glob, grep, shell, skill, todo
  skills/loader.ts     skill discovery
  ui/
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
    keyscan.ts         /keys inspector
```

## License

MIT
