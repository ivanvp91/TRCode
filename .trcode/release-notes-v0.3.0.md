# TRCode v0.3.0 — named credentials, hooks, custom commands, plan mode

## Accounts and sign-in

- A provider now keeps a book of named credentials: several API keys and subscription
  logins side by side, one of them active. `/accounts` lists them, Enter makes the row
  active, the buttons add, rename and delete; `/login` on a connected provider opens the
  same list, while an unconnected one asks for a key in a modal-style form with "API key"
  and "Name" fields (the key is masked). Switching is always manual — there is no automatic
  rotation. New flag: `trc auth login --name work`.

## Hooks and notifications

- An external command on the events `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop` and `PreCompact`: JSON on stdin, exit code `2` blocks the event with
  the reason taken from stderr. `PostToolUse` may append `[hook feedback]` to the tool
  result; `UserPromptSubmit` may add its stdout to the prompt.
- `notify` is a command that receives the turn's JSON as its last argument once the turn
  ends.
- Hooks are read from `~/.trcode/config.json` and from the project's
  `.trcode/settings.json`; a project file may only add `hooks` and override `notify` —
  never permissions or a model. Hooks from a repository do not run until `/hooks trust`
  (a fingerprint of the contents, and editing the file asks again).

## Your own commands

- A markdown file in `.trcode/commands/` (or `~/.trcode/commands/`) becomes a command:
  `deploy.md` is `/deploy`, `db/migrate.md` is `/db:migrate`. Frontmatter `description` and
  `argument-hint`, `$ARGUMENTS` is substituted into the body, and `` !`cmd` `` or a
  ```` ```! ```` block is replaced by that command's output before the model sees anything.
  Commands show up in the composer's suggestions, the `/` index, `/help` and `/commands`.

## Permission rules and plan mode

- `/permissions` accepts patterns: `shell(git status:*)`, `shell(rm -rf *)`,
  `edit(src/**)`, `read(./.env)`, `fetch(domain:github.com)`, `*` for every tool. Rules are
  checked in deny → ask → allow passes, and the first match in a pass wins: a specific
  refusal is not overruled by a broad permission and holds even under `/yolo`.
- `/plan` (or `trc --plan`) makes the session read-only: tools that change anything are
  not offered at all, a `<plan-mode>` section is added to the prompt, and after the answer
  the bar asks whether to execute the plan, keep planning or leave the mode.

## Subagents and skills

- Subagents cross providers: the helper model list is one list for the whole client, and a
  marked model of another host is paid for by that host's key. `/subagents` has a tab per
  connected provider.
- The helper step ceiling is now the `subagentSteps` setting; by default there is none,
  like the main loop. A helper that stops says it can be continued with a follow-up.
- A tie between skills no longer drops both: the history receives a short list of names
  (`<skill-choice>`) and the model decides. The skill catalogue in the prompt is cut to
  the first sentence of each description — 6.8k characters instead of 16.5k across 57
  skills.
- New skill `.trcode/skills/desktop-control`: Windows GUI (UIA patterns, clicks, typing,
  window captures through `PrintWindow`) and a real browser over the DevTools Protocol with
  no dependencies. Foreground actions require `-AllowForeground`, irreversible clicks
  require `-Confirm`, and every action is written to an audit log.

## Fixed

- A limit that resets in days is no longer waited out: a `429` with a two-day `Retry-After`
  ends the turn at once with the reset time and a `/model` hint.
- The "keep waiting?" question no longer breaks the bottom of the screen: it is part of the
  turn bar's frame and disappears by itself as soon as data arrives again.
- The subagent model list is checked against the catalogue: a vanished model is removed
  from the label and from what is saved, while an empty catalogue clears nothing.
- "Always allow shell this session" now really allows it — including commands that reach
  another machine (a separate `sessionAllowRemote` set).
- The agent no longer goes to remote machines on its own: `ssh`/`scp`/`rsync` and database
  clients with a non-local host always ask for confirmation, and the prompt has a
  "Servers" section saying the same.
- Orca no longer restarts the pane as opencode: reports carry no `sessionID`.
- A truncated JSON fragment in tool-call arguments no longer poisons the turn: `{}` goes on
  the wire while the history keeps what actually arrived.
- Switching panes, or changing the pane's width, no longer leaves a second copy of the
  bottom block: the screen area is cleared and repainted (`reanchorSeq`), the terminal's
  focus report (DECSET 1004) no longer reaches the input as text, and an implausible pane
  size is ignored.
- A pane narrower than 48 columns no longer duplicates the reasoning row: the terminal
  width is taken as it is and the frame is clipped to the screen.
- Seconds are gone from the live tail of long commands — the progress block shows the
  command's own words; the counter survives in the heartbeat of a silent command.
- `TRCODE_FRAME_TRACE` turns on a frame journal for diagnosing rendering complaints.

## Verification

Full suite: 93 test sets (all green; `rate-test` failed two rendering checks twice under
the load of the full run and passes on its own — 18/18). New suites: `accounts-test`,
`login-form-test`, `hooks-test`, `hooks-live-test`, `custom-commands-test`,
`permission-rules-test`, `plan-mode-test`, `remote-gate-test`, `subagent-stale-test`,
`stall-prompt-test`, `activity-test`.

## Install and update

In an existing install: `trc update` or `/update`, then restart the CLI.

To install from the release archive:

```sh
npm install -g https://github.com/ivanvp91/TRCode/releases/download/v0.3.0/trcode-0.3.0.tgz
```
