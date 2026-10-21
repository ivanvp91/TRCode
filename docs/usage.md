# Usage and sessions

[Back to README](../README.md)

- [Usage](#usage)
- [Commands](#commands)
- [The interface](#the-interface)
- [Resuming a session](#resuming-a-session)

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

Flags: `-m/--model`, `-e/--effort`, `-C/--cwd`, `-c/--continue`,
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
| `/brain <question>` | a panel of models answers together — see [A panel of models](tools-and-workflows.md#a-panel-of-models) |
| `/orchestrate <task>` | split a task into subtasks with dependencies and run them on subagents |
| `/orchestrate resume \| status \| replan <instructions>` | continue saved work, inspect its plan, or revise unfinished steps |
| `/swarm <task>` | several models solve it in parallel, then a synthesis pass |
| `/swarm` | the roster panel: who runs, who merges the answers; `/swarm models` picks them |
| `/compact [focus]` | compact into a handoff summary, keeping recent user messages |
| `/compact auto [on\|off]` | switch auto-compaction off or on, or report the thresholds |
| `/rewind [last]` | put files back to how they were before a turn |
| `/yolo [on\|off]` | skip confirmations — tools run immediately (also Shift+Tab) |
| `/goal <objective> [--turns <n>]` | set a persistent goal the agent keeps working toward — see [Working toward a goal](tools-and-workflows.md#working-toward-a-goal) |
| `/image [model\|off]` | choose the model that draws; the chat then calls it on request — see [Images, video and audio](tools-and-workflows.md#images-video-and-audio) |
| `/video [on\|off\|model\|prompt_model]` | video mode: a text model prepares generation requests; questions and planning do not generate clips |
| `/audio [model\|off]` | choose the model that speaks or makes music |
| `/new` | start a new session |

**Session** — `/sessions`, `/resume [id]`, `/fork [turn]`, `/rename [title]`, `/context [<tokens>|auto]`, `/cost`, `/trace [n]`
(`/fork` branches the session at a past turn — the original stays intact, details in
[Forking a session](#forking-a-session); `/trace` shows what every request actually carried:
system prompt, tool schemas, history after trim, injections — the projection behind
[Token spend](models-and-costs.md#token-spend))

**Settings** — `/lang [en\|ru]`, `/default [name]`, `/aliases`, `/permissions`, `/login [provider] [url]`, `/settings`, `/update [--check]`, `/config`, `/cwd`
(the catalog lives in `/model` — the panel lists the current provider by type and vendor,
`/model all` every provider, and its Refresh button re-reads it past the cache; `/login`
connects the one in use unless another is named, and takes a host for the providers whose
endpoint is per-account; `/settings` groups the toggleable preferences — what the status
line shows, whether skills and UI mockups match themselves automatically, whether updates
are looked for; `/update` installs the newest GitHub release — details below)

**Agents** — `/subagents [model [id]\|session\|list\|auto on\|auto off]`, `/prompt <task> \| model [id] \| off\|command\|auto`,
`/prompt_model [id]`, `/mcp [reload]`
(`/subagents` picks between the two ways an agent gets a model — the session's own, or a
list you chose — with `model <id>` to add one by name; the list survives the switch, so
`session` is a mode rather than a wipe — details in
[Subagents](tools-and-workflows.md#subagents); `/prompt` routes a short ask through a cheap model first —
details in [Writing the prompt](tools-and-workflows.md#writing-the-prompt))

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
[Presets](tools-and-workflows.md#presets))

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

Then the whole session is replayed, each message through the renderer the live transcript
used: prompts as you sent them, answers as real markdown — tables aligned into columns, code
fences kept as blocks — and every tool call under the name and target it ran with, followed
by the first lines of its output. Nothing is folded into a "last four turns" list, because a
resumed session that starts mid-conversation is a session you have to read twice. A compacted
session shows its digest as a labelled block instead of raw XML:

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

   ● Read(pricing.php)
       └ 1  <?php
         2  $plans = [
         … +118 lines (ctrl+o to expand)
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
