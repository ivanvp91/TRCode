# Changelog

All notable changes to TRCode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versioning is
[SemVer](https://semver.org/) while the client stays pre-1.0.

## [Unreleased]

## [0.3.0] — 2026-11-14

### Added

- **Several keys and accounts per provider.** A provider used to have one
  credential, and changing the key meant typing it again through `/login`.
  Now every provider keeps a ledger of named credentials
  (`src/provider/accounts.ts`, `~/.trcode/auth/<id>.accounts.json` with 0600
  permissions): API keys and subscription logins sit side by side, one of them
  is active, and its data is still written to `<id>.json` — the old readers
  (`resolveAuth`, `verifyProvider`, `trc auth status`) are unchanged. `/login`
  at a connected provider opens the list: Enter makes the row under the cursor
  active, buttons add (`Add account`), rename and delete; deleting the last
  credential disconnects the provider. At a provider that is not connected,
  `/login` asks for the key: a modal-framed window with `API key` and `Name`
  fields (after a browser login — the account name, email by default), and the
  new key becomes active. New records from the CLI — `trc auth login --name work`.
  A key the host rejected during the check is removed from the ledger together
  with the file, and the provider goes back to the previously active account.
  Switching is always manual: there is no automatic rotation, and the choice of
  who pays stays with the user.
  Checks — `test/accounts-test.mjs` (26) and `test/login-form-test.mjs` (24).
- **The key input window is no longer a raw prompt.** `src/ui/form.ts` — a form in
  the modal frame (`╭─ Title ─╮`, subtitle, fields with a cursor, a row of buttons,
  a key legend): the key is drawn as asterisks, Tab/↑↓ move between fields, Tab from
  the last field moves to the buttons (`←/→` select, Enter executes), Enter confirms
  the form, Esc cancels, and pasting a key with a newline submits it. For non-TTY
  the line-by-line `askSecret` remains, so `echo key | trc auth login` works.
- **Permission rules by pattern.** Besides the classes (`permissions.shell`) there is
  now a list of `permissionRules` (`src/permissionRules.ts`): `shell(git status:*)` —
  a command prefix, `shell(rm -rf *)` — a glob, `edit(src/**)`/`read(./.env)` — paths
  relative to the project root (`*` within a segment, `**` across segments, a leading
  `/` — an absolute path), `fetch(domain:github.com)` — a host and its subdomains,
  `*` instead of the tool name — everything. The check runs in three passes deny → ask
  → allow, and in each the first match wins: a narrow denial is not overridden by a
  broad allowance. `deny` applies even under `/yolo` and to commands that go to
  another machine; `allow` — only to ordinary calls. `/permissions` without arguments
  shows the classes and a numbered list of rules, `allow|ask|deny <rule>` adds one,
  `remove <rule|#>` and `clear` remove them. Check — `test/permission-rules-test.mjs` (41).
- **Plan mode.** `/plan [on|off]` and the `trc --plan` flag: the session becomes
  read-only — `buildTools({planMode})` leaves only reading, search, web, `todo`,
  `memory`, skills and asking the user, while writing/edit/shell/run_code/subagents/paid
  generation and MCP tools are not offered at all (the list is by name: a new tool
  does not end up there by itself). A short `<plan-mode>` section is added to the
  system prompt in this mode — the regular prompt did not grow. After a successful
  turn the bar asks: execute the plan, keep planning or leave the mode; "execute"
  turns the mode off and queues the task. The status line shows the mode as "plan".
  Check — `test/plan-mode-test.mjs` (15).
- **Lifecycle hooks.** An external command for the events `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and `PreCompact`
  (`src/hooks.ts`): a JSON payload on stdin, `event`/`cwd`/`tool`/`args`/`output`
  in it and in the `TRCODE_*` variables, exit code `2` — blocking the event with
  stderr as the reason. `UserPromptSubmit` with code 0 adds its stdout to the
  prompt (`<hook-context>`), `PostToolUse` — a `[hook feedback]` line to the
  tool result, `PreToolUse` does not let the tool start at all.
  The matcher is a regex over the tool name. Hooks are read from `~/.trcode/config.json`
  and from the project's `.trcode/settings.json` (the project file may add only
  `hooks` and replace `notify` — not permissions and not the model); `/hooks` shows
  what is in force and where from, `/hooks reload` re-reads the files, `TRCODE_NO_HOOKS`
  turns everything off. On PowerShell the exit code is also passed through explicitly
  (`exit $LASTEXITCODE`) — otherwise any refusal would read as "1". Hooks from the
  repository do not run by themselves: `/hooks` shows them, `/hooks trust`
  approves the file as a whole (a fingerprint of its contents in `hooksTrusted`), and
  editing the file asks again — just like with project MCP servers.
- **Notification about the end of a turn.** `notify` in the same files: the command
  receives JSON as its last argument (`type`, `ok`, `stoppedBecause`,
  `lastAssistantMessage`). It runs once from `finishTurn`, does not hold the
  composer and does not bring the turn down on error.
- **Your own slash commands from files.** `.trcode/commands/*.md` (in the repository)
  and `~/.trcode/commands/*.md` (at the user's) become `/name` commands; a
  subdirectory is a namespace (`db/migrate.md` → `/db:migrate`), and the project
  wins on a name clash. Frontmatter `description` and `argument-hint`,
  `$ARGUMENTS` is substituted (or appended at the end), `` !`cmd` `` and a
  ```` ```! ```` block are replaced by the command's output before the request goes
  to the model, `${TRCODE_CWD}`/`${TRCODE_SESSION_ID}` — by paths and the session id
  (`src/ui/commands/custom.ts`). The commands reach the composer's suggestions, the
  index on `/`, `/help` and the "did you mean" hint; `/commands` lists them.
  Checks — `test/hooks-test.mjs`, `test/hooks-live-test.mjs` (a hook inside a real
  turn), `test/custom-commands-test.mjs`.
- **The subagent step ceiling is now a setting and is off by default.** The `task`
  helper hit a hard 40 steps regardless of `maxSteps` (which only limits the main
  loop, and for many is 0): a fix ordered after a review was cut off mid-sentence,
  and the result carried a preamble like "Now the agent operates on …".
  The ceiling is now set by `subagentSteps` in the config (0 — no ceiling, like the
  main loop; a role with `maxSteps` still narrows the helper), and a helper that
  stopped says in its result that it can be continued with a follow-up
  carrying its `agent_id`. In the bar of an uncapped helper the spent rounds are
  shown instead of "0%". Checks — `test/harness-features-test.mjs`.
- **Subagents move between providers.** The helper model list was tied to the
  session's provider: `subagentModels` and `subagentMode` were maps by `providerId`,
  and `workerModels` selected only models of the same host, so a cheap host on another
  plan could not become a helper. Now there is one list for the whole client
  (`subagentModels: string[]`), the mode too (`subagentMode: "session" | "list"`), and
  the pool is every connected provider: a marked model of a foreign host gets into the
  `enum` of the `task` tool, `/orchestrate` offers it to a step, and that host's key
  pays for it. An old config with per-provider maps is read as is — lists are merged
  on load, the mode is derived from the records (`list` wins), and the `/subagents`
  panel is no longer limited to the current provider: a tab per connected provider,
  "Favorites" and the caption "N marked below, at any provider". `/subagents auto on|off`
  still applies per session provider — that is a permission to run on its own, not a
  model choice.
  Checks — `test/subagent-test.mjs` (35), `test/subagent-stale-test.mjs` (13),
  `test/orchestrate-test.mjs` (13).
- **A tie between skills no longer silences the skill.** If two skills scored close,
  the auto-selection silently dropped both (`MARGIN`), and a request like "fix the
  flaky test" was left without a procedure. Now, instead of an empty pick, a
  `<skill-choice>` with a short list of two or three names goes into the history
  (`chooseSkills`, `src/skills/match.ts`), and the model that reads the whole request
  decides; something already offered is not offered again (`offeredSkills`). Phrase
  triggers are also compared by words rather than by substring (Russian inflections:
  a declined form versus the dictionary form of the same phrase), a word claimed by four or more skills only
  ranks, and a short request with a verb ("fix ci", 8 characters) already counts as a
  task. The skill catalogue in the prompt is squeezed to the first sentence of the
  description and moved right after `<environment>`: at 57 skills that is 6.8k characters,
  about 1.9k tokens instead of
 4.6k. Checks — `test/skill-test.mjs`.
- **A skill for driving the desktop and the browser.** `.trcode/skills/desktop-control`:
  Windows actions (windows, the UIA tree, clicks on controls, input, window captures via
  `PrintWindow`) and a browser through DevTools Protocol with not a single dependency
  (`scripts/browser.mjs`, including the batch mode `batch scenario.json`).
  Both executors leave the user's desktop alone by default: foreground
  actions require an explicit `-AllowForeground`, irreversible clicks — `-Confirm`,
  every action is written to `~/.trcode/desktop-actions.jsonl`, and forbidden
  applications are set in `apps.json`. Regressions — `tests/smoke.ps1`,
  `tests/foreground-policy.ps1`, `tests/browser-batch-smoke.mjs`.

### Fixed

- **Seconds are gone from the live tail of commands.** Every output line of a long command
  went into the progress block with a prefix like "125s · ", and the list read like a
  timer rather than like work: five identical "125s · PASS …" hung in it. Now
  the tail carries only the command's own words (`src/tools/shell.ts`); the count
  remains in the heartbeat "Running… (2m 30s · quiet … of 10m 0s)", which appears when
  the command is silent. Checks — `test/activity-test.mjs`, `test/shell-output-test.mjs`.

- **A limit that clears in days is no longer sat out.** A plan's weekly limit answers
  `429` with a `Retry-After` of two days and more (and the words
  "resets in 2d 6h"), and the client honestly slept for all of it: the transcript
  carried "Waiting ~54h 55m before retrying" and a countdown in the status, the terminal stood
  without an answer, and only after four minutes of silence did the "Keep
  waiting" question appear. Such a turn cannot be waited out, so a wait that does not fit
  into the overall patience budget (`RATE_LIMIT_PATIENCE_MS`, five minutes) is no longer
  taken at all: `postWithRetry` in `src/provider/client.ts` ends the turn right away with
  the message "the usage limit is spent; the host asks to wait 2d 6h …
  Switch models with /model, or send again after the limit resets" and the host's words
  about the reset time. The "The same model elsewhere" hint on a 429
  still suggests a neighbouring host. Check — the block in
  `test/provider-test.mjs`.
- **The "keep waiting?" question no longer breaks the bottom of the screen.** When the host
  went silent, the turn paused the bottom bar and drew the `Keep waiting` buttons as an
  ordinary line in the transcript: the bar disappeared, the answer that arrived while the
  question hung was printed right over those buttons, and the next repaint of the question
  (`←/→`, Enter) erased the answer already printed and left a second copy of the buttons
  below — in a long turn with many tool calls the bottom panel was not
  restored afterwards. Now the question is part of the bar's frame (`src/ui/stall.ts`,
  `setFooterAbove`), the bar keeps working and stays on the last line of the
  screen, the model's output goes above the question the usual way, and `onStall` receives
  a second argument — an `AbortSignal` that fires as soon as data
  arrives in the stream again (`withIdleWatchdog` in `src/provider/client.ts`): the question
  is dismissed by itself, without a keypress. Check — `test/stall-prompt-test.mjs` (32).
- **The subagent model list is checked against the catalog.** A saved id
  outlived its model: `opencode-go:minimax-m3.1-flash-free` stayed marked
  when the host no longer served it — in the `/subagents` panel it counted in the
  "N marked below" caption and in the "Subagents at …" line, although there was no row
  for it on screen, and saving the panel meant writing it again. Now the list is read
  through the catalog (`liveSubagentModels` in `src/ui/commands/agents.ts`): the panel
  opens without the vanished models, saving writes only what is visible on
  screen, and a line "removed from the list (N) — no longer
  offered: …" is printed once. A list that emptied out stops meaning "work by list"
  (the mode falls back to the session model), and an empty catalog prunes nothing —
  until the provider has loaded there is nothing to judge by. Check —
  `test/subagent-stale-test.mjs`.
- **"Always allow shell in this session" now really allows — on another machine too.**
  The button added `shell` to the set allowed for the session, but a command that goes
  to another machine is confirmed forcibly (`force`), and force
  deliberately ignores that set — so for `ssh`/`scp` the button did
  nothing, and the next command asked again. Now forced calls have their own permission
  (`sessionAllowRemote` in `src/ui/permissions.ts`): the set granted for ordinary
  work still does not let them through, while the button in such a request is called
  "Always allow remote commands this session" and is remembered separately; the request
  itself prints a line about why it asks even with YOLO on. `/new` resets both
  sets. Check — `test/remote-gate-test.mjs`.
- **Orca no longer starts the panel as opencode.** trcode's reports carry only the panel
  coordinates, the state and the text. They used to carry `sessionID` too —
  trcode's session id — and the `opencode` route, through which the reports go, Orca
  reads as "this is an opencode session" and remembers it as resumable
  (`sleepingAgentSessionsByPaneKey`). After a restart Orca raised the panel with the
  command `opencode --session <id>`, opencode checks the prefix of its own id and
  failed with `Error: Expected a string starting with "ses" at ["sessionID"]`.
  Now `busy`/`idle`/`userPrompt`/`assistantText` in `src/ui/orca.ts` do not
  name the session: the panel is restored by an ordinary shell rather than by a foreign
  agent. The old record about the panel is cleared by itself as soon as trcode starts a
  turn in it (a status without a session removes it — `canReuseStatusProviderSession`).
- **A JSON fragment in call arguments no longer poisons the turn.** A strict host
  answers 400 "`arguments` must be valid JSON" to a `function_call` whose
  arguments do not parse, and repeats it on every following step — and the
  fragment lives in the history because the provider itself put it there (Muse
  cuts a call off in the middle of an object, a step that hit the output limit leaves
  half). The history still keeps what arrived (the model sees that text
  in the tool result), while `{}` goes onto the wire — in both dialects:
  `wireToolArgs()` in `src/provider/schema.ts`, called from `wireMessages`
  (`src/provider/client.ts`) and `toResponsesInput` (`src/provider/responses.ts`).
  Arguments that arrived already parsed as an object also stopped turning into
  `"[object Object]"` — they become a JSON string again
  (`ResponsesStreamParser`, `parseResponsesResult`).
- **The agent no longer goes to servers on its own initiative.** A "Servers" section
  has been added to the base prompt — a remote machine is in play only when the
  user named it in the current request, and only for that host and action
  they named; the subagent prompt and the minimal preset get a line about the same.
  The prompt is half the job; the other half is that `shell` now recognises commands that
  go to another machine (`ssh`, `scp`, `sftp`, `mosh`, `sshpass`,
  `telnet`, `rsync` with a remote address, and the `mysql`/`mysqldump`/
  `mariadb`/`psql` clients with a non-local host), and asks for confirmation always:
  neither `permissions.shell = "allow"`, nor `--yolo`, nor "allow for the session"
  granted for ordinary work lets it through, and without an interactive terminal the
  command is declined. Local `-h 127.0.0.1` and `--host=localhost` remain ordinary
  commands. Check — `test/remote-gate-test.mjs`.
- **Switching panes no longer leaves a copy of the block.** Coming back to the pane you
  switched away from re-lays the screen without any resize at all: the terminal stays
  silent, while the frame drawn before the departure is no longer the one on screen — the
  cursor path upwards is counted by lines, and erasing starts inside the frame: the
  "⠋ thinking" line with the old time remains above the live one. Now trcode asks the
  terminal for focus reports (DECSET 1004) and on focus return repaints the area
  of the screen (see below), and the report itself does not reach the input as text
  (`onTerminalFocus` in `src/ui/stdin.ts`, handlers in `src/ui/render.ts` and
  `src/ui/editor.ts`). Width and height from an implausible report (0, or
  the size of a hidden pane) are no longer used for layout: the last real
  one is kept (`termWidth`, `screenRows`). Check — the block "a pane that
  comes back to the front" in `test/pin-test.mjs`.
- **Changing the pane width no longer leaves a copy of the block.** Switching screens
  changes the terminal width, and what it does with what is already drawn is its business:
  xterm.js cuts a line it did not wrap itself, other terminals wrap
  it into two. The offset to the top of the frame was counted by one of the models, and after a width
  change it lied one way or the other: too large erased the transcript above the
  block, too small left the upper part of the previous frame — the
  "⠋ thinking" line with the old time hung above the live one. Now the offset is not counted
  at all: the screen area is cleared from the first line and written again — the tail of
  the transcript from the line log (`tailRows`), then the block, exactly down to the last line.
  Lines are cleared and filled in place, the scrollback does not grow and not a single line
  is printed twice (`reanchorSeq` in `src/ui/render.ts`). The idle
  composer goes the same way (`src/ui/editor.ts`). Check — the blocks about a width
  change in `test/pin-test.mjs`, including on a terminal that cuts lines:
  without this fix the last lines of the transcript are lost.
- **A frame trace for diagnosing complaints like these.** `TRCODE_FRAME_TRACE=<path>` or
  a `~/.trcode/frame-trace` file turns on the `~/.trcode/frame-trace.log` journal:
  resize/focus events, the terminal's size report, where and how much is erased,
  where the frame is drawn, how many lines are occupied. It is written in the background, does not affect drawing
  (`src/ui/trace.ts`).
- **A pane narrower than 48 columns no longer leaves a copy of the reasoning line.**
  The layout kept floors — 48 terminal columns, 30 columns of content — and
  observed them even inside a pane already below the floor: every band came out several
  cells wider than the screen, the terminal wrapped it into two lines, and the frame became taller than
  the number of lines it was drawn from. The line-based count did not find its top —
  the previous lines stayed on screen while the live bar was drawn lower: the
  "⠋ thinking" line hung twice. Now the terminal width is taken as it is, the content
  floors are trimmed to it (`termWidth` in `src/ui/ansi.ts`, `contentWidth`
  and its neighbours in `src/ui/layout.ts`), and the footer frame is clipped to the
  screen width before drawing (`frameLines` in `src/ui/render.ts`) — a frame line is always exactly
  one physical line. The bar's status line shares the width between the model and the
  hint instead of squeezing the hint past the edge. Check — the block about a narrow
  pane in `test/pin-test.mjs` and the line-width checks in
  `test/turnbar-test.mjs`.

## [0.2.2] — 2026-10-25

### Fixed

- **The answer no longer disappears together with the screen.** At the end of a turn the composer takes the
  freed lines from the departing turn row and shifts the transcript down — the shift was counted
  by the printed-lines counter, and it is reset by the cursor position probe at the start of input.
  If the terminal does not answer the cursor query (`ESC[6n`) — and that happens in a terminal
  pane inside an orchestrator — what was printed during the turn counted with a minus sign, and
  instead of a couple of lines the composer asked to move the screen by the whole length of the turn: 600-plus lines.
  The terminal threw the transcript into the scrollback, and an empty screen remained without the answer and without
  the input line. Now the probe also recalculates the counter's reference point, "printed since"
  is never negative, and the shift itself cannot exceed the screen height. Check —
  the block "a failed probe does not scroll the screen away" in `test/pin-test.mjs`.

## [0.2.1] — 2026-10-24

### Added

- **Eleven new UI languages: Chinese, Japanese, German, French,
  Spanish, Italian, Portuguese, Ukrainian, Polish, Malay and Indonesian.**
  `/lang` now accepts a code, an English or a native name (thirteen languages in all), and
  without an argument opens a picker. English and Russian still live right in the output
  sites (`t("Model", "<native>")`), the rest — in `src/i18n/<code>.ts` catalogs, whose key is
  that same English text: a new line needs no changes at the call sites, and an
  untranslated one reads in English rather than disappearing. So that a catalog could
  match a line at all, substitutions became named — `t("Deleted {id}", "<native>",
  { id })`: every template string was converted (a script walked through 819 calls of `t()` and its
  aliases, none were left). Plurals go through `Intl.PluralRules`, and the forms (one
  for Chinese and Japanese, four for Polish and Ukrainian) live in the catalog next to the
  strings: `count(2, ["model","models"], …)` picks the right one itself. Catalogs: 710 strings and
  7 inflected nouns per language, coverage 710/710 — subagents translated them from a common
  list of keys collected from the sources. The language directive in the system prompt got a
  line per language, and the `prompt-test` ceiling did not grow. The `test/i18n-test.mjs` suite is
  extended to 45 checks (catalog, substitution, plural, fallback, header and help in
  de/zh/pl) and did not get any lighter.

- **Subagents start by themselves when a task splits into parts.** A request like "translate into
  10 languages", "check every module", "make one edit in all these files" no longer
  goes into the queue: the system prompt gained the rule "a request with several
  independent parts is a fan-out, not a queue", and the same is said in the description of the
  `task` tool — one call per part in one turn, without the user asking,
  with the results merged on the lead agent. The room in the prompt was freed by shortening
  three formulations nearby, and the ceiling of `test/prompt-test.mjs` (980 tokens) was not raised:
  it is 972 now. `/subagents auto on|off` remains the permission switch: with `off`
  the first self-started run asks once "Yes / No / Enable auto".
  The hint about the command now names `auto on`, not just the model choice.

- **A status bar for subagent work in the turn row.** While the helpers work, a list runs above
  the spinner — one line per helper:

  ```
  1. deepseek-v4.1-flash 70% · 25k tok · read src/agent/loop.ts
  2. glm-5.3-flash 12% · 3.2k tok · grep(task)
  ```

  The line carries the model (without the provider prefix), the share of the step budget spent
  (counted against the same ceiling the helper runs under, so 100% means it
  stopped, and no more than 99% is shown while it runs), the tokens spent (this helper's input + output)
  and the last action. The palette is the one of the turn statistics line:
  the model name in orange, the number, percentages, tokens and action — in gray. A helper that has
  finished disappears from the list at once:
  its header and result are in the transcript by then. The list lives in a separate
  block of the bar (`TurnBar.setActivity`), so the start of the lead's answer (`endReasoning`)
  does not erase it, and the lines it occupied are returned to the transcript.
  `SubagentActivity` gets `begin/update/end` instead of `begin/push/end`, with
  `SubagentProgress` (id, label, model, steps, budget, tokens, last action);
  in non-TTY, as before, steps are printed as `├ [n] …` lines.

- **Backups of edited files in `.tmp/agent-backups/`.** Every file that
  `edit` or `write` is about to overwrite leaves a plain copy of its
  previous bytes in the project: `.tmp/agent-backups/<session-id>/<path>.<YYYYMMDD-HHMMSS>`, keeping the
  directory structure. This is not the `/rewind` store — that still lives in `~/.trcode`
  addressable by hash and can roll a turn back; the copies are for a human who wants to bring
  a file back by hand, so they are ordinary files inside the project, not blobs. They live exactly
  as long as the session lives: deleting a session through `/sessions` deletes them too, and copies of
  sessions whose files are gone are cleaned out on start. A created file gets no copy,
  an empty or too large one (> 4 MB) — neither, identical bytes are not duplicated a second time,
  and a copy failure never cancels the edit itself. The `.tmp/` directory is already in `.gitignore`.
  The system prompt now says where the copies live and how long they live, — the rule
  fitted into the previous `test/prompt-test.mjs` ceiling (980 tokens) by shortening
  three formulations nearby. The `test/backup-test.mjs` suite (23 checks) is in `run-all.mjs`.

- **A model's question is drawn above the input line, not below it.** The `ask_user_question`
  dialog no longer replaces the bottom panel: its lines go into the same frame as the bar, only
  on top — the question floats above the transcript, while the input line and the status stay in their places
  under it. The answer comes into the bar the usual way; background transcript printing moves
  neither the dialog nor the input. For the duration of the question the bar does not stop (`exclusiveInput` with
  `keepBar`), so the spinner and the turn status keep living. Test —
  `test/questions-overlay-test.mjs` (13 checks, a virtual screen).

- **Tools for the `/brain` panel.** A panel model no longer answers blind: each one
  gets the same set of tools as the session agent (`web_search`, `web_fetch`,
  reading files, the shell) and works by the same confirmation rules. A question about
  the current state of the library is checked on the web, a question about the project — against the files themselves.
  The budget is 8 tool steps per model per round (three rounds for nine models
  multiply every step), the system prompt asks to look facts up rather than change the project, and
  tool calls are visible in the status line. Without context passed in (headless
  `runBrain`) the panel, as before, works with a single `complete()` without tools.
  Files named in the question are still attached in advance: that is cheaper than
  a tool step in every round for every model.

### Fixed

- **The tok/s rate is counted by generation, not by the turn's clock.** The `tok/s` line
  in the status bar divided the produced tokens by the whole turn time, and most of it
  is taken by tool calls, waiting for a limit and resends: an honest 40 tok/s after ninety
  seconds of building showed as 3. On top of that, every new usage message
  replaced the `↓` counter with the number of the last step, and the rate dropped again together with it.
  Now `src/ui/rate.ts` measures only the time during which the model actually streamed
  (the stream opens with the first delta, closes with the usage line and goes out by itself after a pause
  within a step), `↓` in the bar became cumulative for the turn, and the final `tok/s avg` line takes
  the same generation time. Test — `test/rate-test.mjs`.

- **The empty "Answer"/"Response" block is no longer printed.** A round in which the model
  first emits a newline or spaces and then only calls a tool used to
  draw the `Response` divider with emptiness under it — that read like an empty answer
  from the model (and in a long agent task a dozen such blocks pile up). Now the divider
  waits for the first visible character: leading spaces accumulate in a buffer and enter the block already
  trimmed on the left, and a round without words prints only the tool call line.
  Test — the block about a "wordless tool round" in `test/firstturn-test.mjs`.

- **A turn in which the model only reasoned no longer ends in silence.** The model
  spends the whole output budget on reasoning: the host returns `finish_reason: "length"` without
  text, or the router cuts the stream without `finish_reason`. `runAgent` used to consider such a
  step a completed turn and return an empty answer — a statistics line above emptiness was left on
  screen. Now the step is sent again (up to five times) with a warning
  in the transcript, an empty assistant turn is not written to the history, and if the budget is already burned by
  reasoning — the retry carries a short extra "answer right now" (only in the request,
  not in the history). After two retries the turn ends with an explicit error.
- **The `/brain` panel no longer ends with a promise to answer.** If a model spent
  the whole budget of tool steps on research, `max_steps` cut it off exactly
  between "let me check a couple more facts" and the answer itself — and that phrase went into the panel's
  result (a live case: 4m35s, 41 requests, 529k input, and in the session history there is
  "Before bringing the final answer together, let me check a few disputed facts with tools").
  Now, on budget exhaustion (or looping), the model gets one more request on
  the same history and without tools: "the budget is spent, answer with what you have already gathered".
  The budget became more sensible: 8 steps per round of answers, 4 for analysing other models' answers and synthesis.
- **Emptiness above panels and output after sending a line.** At the start of a
  session the composer "falls" to the last screen line, leaving empty lines above itself. After
  sending, the cursor stayed at the bottom, so the message echo, the answer, the command output and
  panels (`/brain`, `/model`, `/fav`) began under that emptiness — a spacious empty
  screen with the text at the very bottom. Now, on send, the composer gives those lines back to the
  transcript: the next printed line sits right under the last message,
  and on the next input the composer goes down to the last line again (the remainder is
  counted by the actual cursor row through DSR, with a fallback to the line counter).
- **The `/brain` question and the `/swarm` task are typed in the ordinary composer.** This used to be a
  bare `❯ Question:` line — without the band, the status and editing keys — and it was printed where
  the cursor stood.

### Changed

- **A silvery gradient on the logo.** The dotted monogram is no longer flooded with a single gray
  tone: it is coloured like brushed metal — a neutral ramp from steel in the lower left
  corner to polished silver in the upper right, and over it, once every ten seconds, a narrow
  mirror band sweeps there and back, bleaching the dots in its path, so
  that the surface reads like metal under light. The colour stayed the same gray (the channels
  are equal), only its lightness changes. The shades slide rather than jump: a channel changes
  by no more than one step (4 out of 255) per frame, so the ramp step, the
  band width and the period were all chosen together. Frames went to 30 per second instead of 60, and the colour steps glue
  smoothed cells into one run — a patch is about a kilobyte on average, and all the
  same only the changed cells are redrawn. The geometry, the cursor position and the terminal
  background did not change (the dots are still transparent), `TRCODE_NO_SPLASH=1` gives a
  static logo. The `test/logo-test.mjs` suite checks the neutrality of the palette, the span
  of the ramp, the presence of the highlight, the smoothness of the slide and the seamless cycle.

- **The `/brain` panel is checkboxes.** Every row is now a mark: Space sets and clears
  it on any tab ("Active models", "Favorites", "All models"), and Enter applies
  the whole set at once — marked rows join the council, unmarked ones leave it (the main
  model that fell out of the list is reset). Enter on a row used to add or remove
  one model and reopen the panel, so a council of ten was assembled in ten
  visits. The question, as before, is asked with the "Ask…" button or `/brain <question>`.

## [0.2.0] — 2026-10-22

### Added

- **Hints about untried features.** After an ordinary completed turn a single
  `tip — …` line sometimes appears under the answer: `/brain`, `/uilib add`, `/swarm`,
  `/goal`, `/rewind`, `/fork`, `/trace`, `/preset minimal`, `/stat`, `/subagents`,
  `/compact` or `!` for shell commands. Never more than once per turn, never on
  the first two turns and never during a goal, none repeats between runs
  (`config.tipsSeen`), and a hint about something already used in the session is skipped.
  Which one — is picked at random from those not yet shown and applicable (they used to go
  in list order, and `!`, `/stat` and `/subagents` were almost never reached). The rhythm
  "every third turn" is counted by completed turns (`App.turnsDone`), not by
  user messages: auto-skills, `/uilib` designs, steer lines and `/brain` threw the
  count off, and `/compact` zeroed it. "Subagents were already used" means a call of the
  `task` tool, not the word `subagent` in the output of any tool.
  The switch — `/tips off`, bring it back — `/tips on`, forget what was shown — `/tips reset`.
- **`!command` runs a shell command without sending it to the model.** The line goes
  through the same `shell` tool as the agent's: confirmations, timeouts, the live
  tail and Esc work as in a turn, the output is printed as the usual `Ran <cmd>` block.
  The command and its output are added to the history as a hidden user message, so
  the next turn already knows what you found out, and replaying the session does not duplicate them.
  The hint in the status line names `!`, and while typing a line with `!` it changes to
  "will run in the shell · the model will not see it". The former meaning of `!` ("send my
  words without rewriting the prompt") is gone — `/prompt off` is there for that.
- **The command list works during a turn too.** In the bar under the spinner `/` opens the same
  list as when idle: filtering by input, `↑↓` over the rows, Enter inserts
  the command into the line; the list keeps its height while narrowing (`suggestionLines` is shared by
  the composer and the bar). A line starting with `/` is therefore **not** sent into the current turn
  but queued — otherwise the model would read `/model k3` as text. The spinner's hint
  at that moment says `enter to pick`, and on a command — `enter to queue the
  command`.

### Security

- **MCP servers from the project's `.trcode/mcp.json` no longer start unasked.**
  Any cloned repository with this file used to execute the command listed there at the
  moment `trc` was launched in the folder (and its tools could even declare themselves
  `approval: "auto"`). Now such servers wait for `/mcp trust`. An approval applies to
  this folder and to exactly this configuration: any change of the command, arguments or
  environment requires approving again (`config.mcpTrusted`, fingerprint `id + config`).
  On start a warning with the list is printed, and `/mcp` shows what exactly
  will be started. Servers from the user's global config start as before.

### Fixed

- **Self-update: `/update --check` only checks the release.** The argument is no longer
  lost in the command handler and does not start an installation.
- **Self-update verifies dependency version ranges.** Missing or
  incompatible dependencies are prepared in a separate copy of `node_modules`; any
  npm error stops the installation, even if npm left `package.json` in place.
  The new build and the dependencies are swapped by renames on one disk.
  On error both directories are restored; if a lock prevents the rollback too,
  the backups are kept, and the error points at their location.
- **Multiline input and history no longer accumulate empty lines.** When
  the input field shrinks, the freed lines are returned at once, and the status
  stays at the bottom of the screen.
- **Reasoning closes before the answer.** Leading empty lines of the answer
  are skipped; before the text a divider `Answer` (`Response` in
  the English UI) is printed with one empty line under it.
- **MCP: a Streamable HTTP session the server forgot is now really restored.** On a 404 the client
  re-initialised but sent `initialize` with
  the old `Mcp-Session-Id`, and servers on the official SDK answered with a refusal. Now the
  identifier is reset, as the spec requires.
- **MCP stdio: Cyrillic and emoji on a chunk boundary no longer turn into `�`.**
  The server's stdout was decoded in pieces; now as a stream (`setEncoding`). stderr
  lines are collected whole too.
- **MCP on Windows: arguments with `&`, `|`, `<`, `>`, `^`, `()` are quoted.**
  `npx mcp-remote https://host/sse?a=1&b=2` was executing `b=2` as a second cmd command.
- **MCP: a server `ping` gets an empty result, and `roots/list` — the project
  folder.** Both used to be answered "method not found", although the client declares
  `roots`.
- **MCP: `structuredContent` is no longer duplicated** if the server already put the same
  JSON into a text block (as the spec advises).
- **MCP HTTP: a response over 8 MiB gives a clear error at once**, instead of hanging until
  the timeout.
- **`/sessions` and other chooser windows no longer flicker when the arrows move.** The window
  was erased and printed line by line; now the frame is repainted in one
  synchronised write over the old one. Window repaints also no longer
  get into the transcript's line journal and into the scroll counter.
- **A browser OAuth login is not broken by a stray request** to the callback address
  without a code (a repeat, a prefetch).
- **OAuth token refresh when several `trc` sessions run.** If another process
  refreshed the token first and the host rejected our refresh token as used,
  fresh data is taken from disk instead of demanding a login again (with ChatGPT its profile lock
  already did this).
- **The command list: cursor, width, Esc.** (1) After drawing the panel above the composer
  the cursor stayed in column 1, to the left of `›`: every overlay line ends with a newline,
  and nobody returned the caret column. Now `paintOverlay` puts it back.
  (2) The panel width was computed from the longest line, so while filtering
  the panel jumped. Now it occupies exactly the columns of the input band: from the left edge
  (without the field's indent) to the right one. During a turn there was its own empty line under the panel
  plus an empty line above the band — now one, as when idle.
  (3) During a turn, Esc with the list open interrupted the whole turn while the panel stayed
  where the bar was. Now Esc closes only the list, as when idle; the next Esc and
  Ctrl+C interrupt the turn, as before. The bar's hint with the list open:
  "esc to close the list".
- **The command list during a turn no longer leaves a hole.** The bar grew by the height of the
  list (the transcript moved up), and after closing it shrank, leaving ~10 empty
  lines above itself: reasoning and the spinner fell down, the bar looked like an empty
  composer, and the turn seemed to have been interrupted. Now the list's lines are "borrowed"
  (`setFooter(..., cover)` in `render.ts`): the list is drawn over the transcript above the
  bar and, on closing, returns the covered lines from the line journal, including
  what was printed in the meantime.
- **The session's first answer is no longer separated from the input field by three empty lines.**
  After the first message the splash is dismissed (`dismissWelcome`) and the input field
  unpins. When the turn ended, `readInput()` re-measured the screen as at start and
  forgot the lines the bar had held, so the composer went down by the difference in
  height between the bar and the composer (usually 2 lines). Now the bar's debt is kept, and the
  composer takes its lines, as after any following turn. Test:
  `firstturn-test.mjs` (a real `App` against a mock server).
- **The line journal no longer keeps the composer's gap in its tail.** The empty lines
  the composer went down onto (`noteBlankRows`) stayed "at the end" of the journal
  forever, and all subsequent text was written before them, although on screen it
  lies under them. Everything restored from the journal (the command list when idle and
  during a turn) drew emptiness over the last lines of the answer. Now the gap
  is "sealed" when the composer erases its frame (`sealBlankRows`).
- **The spinner label (`thinking`, `continuing`, …) is highlighted in the model's colour** from the status
  line (`brightCyan`) rather than in gray.
- **The passive update check runs exactly once and honours the
  switches.** `TRCODE_NO_UPDATE_CHECK` and `TRCODE_UPDATE_API` were checked only by the CLI,
  while session start (App.init) kept its own copy of the condition — with the check off the
  request still went out, and on a clean install the same GET went twice
  (CLI + init). Now `src/update.ts` has a single `passiveCheckEnabled(cfg)`, and only
  `App.init()` calls it.
- **Self-update can no longer install a build that lacks a dependency.**
  A release archive carries `dist` and `package.json`, but not `node_modules` —
  the package manager installs those. A release that added a dependency (that is how `sharp` appeared)
  used to replace `dist` and leave `trc` failing on an import at start. Now
  `applyUpdate` compares the archive's `dependencies` with the installed versions
  (walking the parents, as Node does), and prepares the missing or incompatible ones itself —
  `npm install --no-save <dep>@<range>` in a separate directory, through `npm-cli.js`
  next to node, without a shell; `trc update` and `/update` show this step. If npm could not do it,
  the swap is not made, and the error names the reason and the exact command
  (`npm install "sharp@^0.35.5"` in the install folder). Verified on a live release:
  0.1.7 → 0.1.9 used to give `ERR_MODULE_NOT_FOUND: sharp` on every start,
  now `sharp` is delivered in ~8 s and `trc` starts.
- **`sharp` is loaded on first use, not at start** (`src/tools/sharp.ts`).
  Clients before 0.1.9 update with the old code without the check above; the next release
  installed by them will start anyway, and without `sharp` only the image tools will refuse —
  with a hint to run `/update`. `update-test.mjs` checks that no
  module in `dist` imports `sharp` statically.

### Changed

- **Line wrapping in the input field goes by words, not by cells.** A long message
  used to be cut exactly at the band width, and a word went to the next line
  in half ("in comp" / "letion"). Now the break is placed after the last space
  that fits; only what has no space at all is cut forcibly —
  a path, base64, minified JSON. The input band during a turn wraps the same way.
- **The status lines under the input field go to the edge of the band.** They used to be laid out
  in the width of the chat text, and the bar's right edge hung eight cells from the terminal edge;
  now the hint and `context:` are flush to the same edge as the typed text, and the bar
  reads as part of the band rather than as a separate paragraph.
- **Enter during a turn steers the current turn instead of waiting for its end.** A message
  typed in the bottom line while the model works gets into the history at the nearest
  step boundary — after the tool results and before the next request — so the
  model reads it and changes course without losing what it has already done. Until the turn takes it,
  the line is visible in the bar as `⎿ steering:`. **Tab** sends the message as a separate turn
  after the current one, as before; in panels (`/brain`, `/orchestrate`, `/swarm`) and long
  commands there is no step boundary, so there Enter still queues.
  An interrupted turn (Esc) returns both steered and queued lines to the editor.

## [0.1.9] — 2026-10-21

### Added

- **MCP: the client is now complete.** Next to stdio there is Streamable HTTP
  (`url`, `headers`, `bearerToken`/`bearerTokenEnvVar`; legacy SSE is deliberately
  not supported). The server's resources are visible to the model through three tools —
  `list_mcp_resources`, `read_mcp_resource`, `list_mcp_resource_templates`. The
  2026-07-28 protocol is added: the modes `legacy` (default), `auto` (tries
  `server/discover` and falls back to `initialize`) and `2026-07-28` (every request
  carries the version and the client capabilities in `_meta`). For fat servers —
  `mcpToolSearch: true`: a single `find_mcp_tools` lives in the request, and the schemas of the tools it finds
  are attached on the next step of the same turn. `/mcp` learned
  `restart <id>`, `stop` and `logs <id>`.
- **MCP: resources and attachments instead of placeholders.** `image` blocks from results now
  go to the model as attachments, `structuredContent` — as a JSON block, `resource_link` and
  embedded resources — as text.
- **Google Gemini: a key and (with a warning) an account login.** `/login gemini`
  (or `/login google`) offers two paths. A key from AI Studio goes through the official
  OpenAI-compatible shim `generativelanguage.googleapis.com/v1beta/openai`, the catalog
  comes from the host. An account is the OAuth client of Gemini CLI against Code Assist
  (`cloudcode-pa.googleapis.com/v1internal`, the `{model, project, request}` format),
  the project is discovered by itself through `loadCodeAssist`/`onboardUser`; the
  `~/.gemini/oauth_creds.json` session is reused. Before the browser a
  warning is printed: Google considers such a login a ToS violation and has been banning accounts since February
  2026 — the key remains the supported path.
- **Muse Wonder and Muse Spark 1.3 in Meta.** `muse-wonder-1.0`, `muse-spark-1.3` and
  `muse-spark-1.3-contributor` (1M windows, Responses) are added to the published roster.
  `muse login` leaves the session in `~/.config/muse/auth.json` — `/login meta`
  reuses it (or the key lying there) with a warning: the Muse Code subscription
  is intended for the Meta CLI only, and such use may cost you it.
- **OpenAI: a platform key and a ChatGPT subscription** — `/login openai`
  offers "Subscription / API key". The subscription is a browser OAuth (PKCE) under
  the official ChatGPT client; requests go to the ChatGPT backend with its service
  headers (`originator`, `OpenAI-Beta`, `ChatGPT-Account-Id`), the account is read from
  `id_token`. The key is the ordinary `api.openai.com/v1`. The session of a third-party CLI is deliberately
  not reused: that server rotates the refresh token, and a refresh from here would log
  its owner out. Responses only and streaming only — that is what
  the backend requires; non-streaming calls (compaction, titles) are assembled from the stream.
- **Logging into OpenCode Zen and OpenCode Go through an account** — `/login opencode-go` and
  `/login opencode` offer "Subscription / API key"; the subscription is the OpenCode
  Console device flow (the same one opencode itself uses), without copying a key. The token refreshes
  by itself; `trc auth login --provider opencode-go --oauth` skips the choice.

### Changed

- **Auto-compaction became a ladder.** Compaction used to kick in only at 90% of the window and immediately
  lose everything except the summary and the user's words. Now, as the window fills, three
  steps turn on: at 25% (`autoCompactLightAt`) — a light cleanup without a model call (old
  tool results are squeezed to their header, old reasoning is stripped, the last
  turns are not touched); at 50% (`autoCompactMediumAt`) — a condensed outline of the old history keeping the working
  tail (~12 messages) verbatim; at 90% (`autoCompactAt`) — the full
  summary as before. The steps are quota'd per cycle: **3 light and 2 medium**, after which
  the ladder waits for the next threshold instead of repeating a step, otherwise a history stuck slightly
  above 25% would be cleaned every turn and never reach 50%. The three comes from `1/(1−φ)`, where φ is the share of
  growth that falls on tool output: for code turns φ ≈ 2/3. The counters survive a
  restart (they live in the session file), a full summary opens a new cycle. Everything can be
  turned off through `/compact auto off`, the **Context** line in `/settings` or `autoCompact: false`
  in config.json; a manual `/compact` works in any case.
- **MCP: schemas travel by budget, the catalog stays live.** `toolInputSchemaMaxBytes`
  (5000 by default) squeezes a schema in three passes: descriptions → `$defs` → deep
  objects. `tools/list` is read by `nextCursor`, `notifications/tools/list_changed`
  re-reads the catalog (on error the previous one stays). `enabledTools` /
  `disabledTools`, `approval` / `toolApprovals` (a read-only tool with `auto` goes as
  `read`), `outputLimit`, `startupTimeoutSec` / `toolTimeoutSec`, `enabled` /
  `required` appeared.
- **Compaction reworked: a handoff summary instead of a digest.** Instead of a digest of the whole
  history, the new history is a handoff summary plus the last **user** messages
  verbatim (up to 20k tokens; a too large one is trimmed with a note), while assistant turns and
  tool traffic drop out. The prompt is "CONTEXT CHECKPOINT COMPACTION", without
  tools, and the transcript fits into the summarizer's window. Compaction is also checked
  **between tool rounds** inside a turn (no more than twice per turn); the history is
  changed in place so that the agent loop keeps sending the live one. `/compact`
  uses the same rules.
- **A transient 503 no longer gives up after three quick attempts.** The host's transient
  answers (503 "Endpoint is unavailable", 502/504/500) are retried up to
  `upstreamRetries` times (10 by default) with a `upstreamRetryDelayMs` pause (10 s), and
  every pause is written into the transcript with the attempt number — the terminal resends the same
  request itself instead of handing the error to the human. Esc interrupts the wait.

### Fixed

- **MCP: zombie processes, lost images, a dead catalog.** `stop()` killed
  only the launcher (`npx.cmd` left node alive), now the tree is taken down through
  `killTree`, and stderr is drained after exit. `image` blocks are no longer replaced
  with "[image content omitted]". A 404 on an established HTTP session re-initialises
  it and repeats the call, Esc sends `notifications/cancelled`, the handshake and the
  catalog are retried three times (250 ms, 1 s), and a crashed server is restarted with
  a backoff of 1 s → 30 s.
- **Tool pixels are no longer lost on the gRPC gateway.** The refusal "tool message
  content part 1 is not text; only text parts are supported on the gRPC path"
  applies only to tool messages, while a screenshot pasted by the user is accepted by such a host.
  The first fallback used to throw the pixels out of the tool results — the turn
  survived, but the model did not see the screenshot it had called `read_image` for
  ("does not recognise the screen"). Now the tool's images move into a user message
  right after the result, with the caption "Output of read_image"; stripping pixels from the whole
  history remains the second line of defence — for a host that takes no images at all.
- **Esc interrupts where there is no turn too.** The spinner printed "esc to interrupt" everywhere in a row,
  but only TurnBar read the keyboard: a browser login (`/login openai`,
  `/login gemini`) hung for minutes while Esc did nothing. `escWatch()` appeared —
  a subscription to Esc/Ctrl+C for waits outside a turn; both OAuth flows are wired to it (cancellation
  through an `AbortSignal` reaches `pollForToken`/`webLogin`), as are the Code Assist project lookup
  and the model catalog refresh. The Spinner itself shows the hint only where someone
  serves it.
- **400 "The `reasoning_content` in the thinking mode must be passed back" on a
  saved history.** If an assistant turn with tool_calls arrived without thinking (a session
  from a version before this field, a model switch in the middle of a turn, a synthesised pair after
  a history repair), the client gets a 400 once, remembers the model and resends
  `reasoning_content: ""`, which the host accepts — instead of handing the error to
  the human. Verified live on `opencode-go:deepseek-v4.1-flash`: 400 → automatic
  resend → 200.

## [0.1.8] — 2026-10-16

### Added

- **`ask_user_question`** — the model collects 1–4 related decisions in one modal: ↑↓ and
  Enter, Space for multiple choice, a custom answer, "Back", a review screen and
  "Submit". Esc cancels the turn without partial answers; questions from parallel agents and
  permission requests are queued. In headless the tool reports that it cannot
  ask.
- **`/orchestrate resume | status | replan`** — the task, the plan, the step results and the history
  of every executor are saved as the work goes. An interrupted or failed job can be
  continued, including after `/resume`; `replan` reconsiders only unfinished
  steps.
- **`/subagents auto on|off`** — with auto off, starting helpers asks
  "Yes / No / Enable auto". An explicit "start subagents" allows one turn,
  an explicit refusal blocks even with auto. If helper models are not chosen, the model
  chooser opens after the approval.
- **`resume_media`** — continues waiting for and downloading an existing video, restores
  held images and audio without paying again. Paid generations are counted in the
  session cost.
- `read_image` decodes the picture through Sharp: a preview reduced to 1.6 MB, `crop`,
  metadata without pixels; the generation result is checked against the requested size,
  aspect ratio, format and transparency.

### Changed

- **Media no longer litters.** The result is saved to the launch directory
  (`image-<time>.png`, `video-….mp4`, `audio-….wav`), temporary files — to `.tmp/`.
  The one-off generation folder is deleted right after saving, the `prepare_media_workspace`
  workspace — on exit. Only a folder with a paid but unsaved result or an unfinished
  video remains — until `resume_media`.
- Paid generations are permitted separately (`permissions.paidMedia`); a network permission does
  not cover them. MCP tools without a read-only mark require the `write` permission.
- `src/ui/commands.ts` (4600 lines) is split across `src/ui/commands/*`.

### Fixed

- All 25 reproduced audit problems are fixed (`docs/audit/`): a file lost by
  `/rewind` after a backup error, the tool queue after Esc, permission bypass and
  hangs in `run_code`, overwriting a file changed during confirmation, escaping
  cwd through a junction, CRLF, an SSE break in audio, PCM instead of MP3, HTML instead of MP4,
  polling repeats, xAI video parameters, GIF sizes, `~/` in paths and others.
- Sessions are saved atomically with a backup; orchestration does not count a step that
  hit a limit or was interrupted as a success.
- The section strip in panels (`/fav`, `/brain`, `/model`) wraps onto the following lines,
  like the button row: with a dozen connected providers the tail of the tabs was cut off by the frame and
  a section could not be selected. Test — `test/picker-test.mjs`.
- **Resume is no longer read in pieces.** A restored session is scrolled through in full:
  prompts, answers (without a 24-line cap) and every tool call with the name of the
  target and the first lines of output (`ctrl+o` — the rest). Only the last
  four turns used to be printed, calls went as `tool({"json"…})` lines without output, and everything older was collapsed
  into a table of contents. The compaction digest is shown with its first 20 lines and can be expanded. Test —
  `test/resume-test.mjs`.

## [0.1.7] — 2026-10-01

### Added

- **Images, video and audio straight from the chat.** Media models do not answer
  `/chat/completions`, so they are connected as tools: the chat model writes the
  prompt itself and calls `generate_image`, `generate_video` or `generate_audio`, and the file
  is saved in the project folder. Every generation is paid and asks for confirmation, like
  a shell command; Esc interrupts the wait.
- **`/image`, `/audio`, `/video model` — model choice in the same panel as `/model`**:
  provider tabs, search, "Refresh", and "Turn off" for images and audio. Where
  `/model` shows the context and the price, here there is a capabilities line — aspect ratios, resolutions,
  durations, n, price per second. A model can also be named right away: `/image seedream`,
  `/audio off`, `/image status`. Until an image or audio model is chosen, there is no tool
  in the chat and requests do not pay for its description.
- **Providers**: OpenRouter — images (`POST /images`, 55 models, parameters checked
  against its catalog), video (`/videos`, 30 models) and audio (gpt-audio, Lyria);
  TokenRouter — images, video (new-api `/video/generations` jobs) and audio by endpoint
  types from the catalog; xAI by API key — grok-imagine for images (with an edit based on
  the source) and video; Z.AI — glm-image, cogview and cogvideox-3. The chosen model is stored
  together with the provider (`tokenrouter:kling-v3`): which API is called depends on it.
- **`/video` — video mode.** Every message becomes a video order: the prompt
  model (any text model, `/video prompt_model`) looks at attached images, writes
  a frame description with a shot list by seconds and calls the video model; the allowed
  durations, resolutions and aspect ratios of the chosen model go into its system prompt.
  `/video off` returns the previous session model. The mode lives until the program exits —
  after a restart it is off, so that generations do not start by themselves.
- **Audio**: a speech model reads the text verbatim in the chosen voice and with a given delivery,
  a music model gets a brief. The stream is assembled from base64 pieces, the format is determined by
  signature, bare PCM is wrapped in WAV.
- A provider error is unwrapped down to its own words: OpenRouter embeds the
  upstream answer as a string in its JSON, and instead of "HTTP 400: {"error":{"message":"HTTP 400:
  {\"error…" you now see `InvalidParameter: The parameter resolution is invalid`.
- Tests: `test/video-test.mjs` (26 checks) and `test/media-test.mjs` (37 checks —
  all four providers on one mock server).

## [0.1.6] — 2026-09-23

### Fixed

- **OpenCode Zen and Go no longer answer 400 "Request is missing x-opencode-session".**
  The gateway asks the client to send a stable conversation id in `x-opencode-session` — by it
  it keeps one conversation on one backend and hits the prefix cache warmed there — and
  without the header it refuses to route the request. The header is declared in the registry
  (`ProviderMode.sessionHeader`) and travels on every request to both modes, including
  the key probe at login. The value is a hash, not a local session id: it carries the
  local date, and the vendor has no need to know it. Requests without an explicit id (a subagent, compaction,
  the title generator) differ by their own prompt prefix — exactly the thing
  the gateway caches. Tests in `test/provider-test.mjs` (8 checks).
- `User-Agent` became `trcode/<version>` instead of a version-less `trcode-cli`: Go asks a
  client to call itself by its own name, and the version in it is the only way for a host
  to tell the traffic of one release from another.

## [0.1.5] — 2026-09-05

### Added

- **`/goal` — a persistent objective the agent keeps working toward** (following Qoder
  CLI). `/goal <objective> [--turns <n>]` sets a goal, and after every user turn the
  agent takes the next one itself: the goal is repeated verbatim in the prompt of every goal turn,
  the model declares completion with the `<goal-complete>` tag. The goal is stored in the session file and
  survives a resume; the built-in limit of 25 turns pauses it automatically (`--turns`
  replaces the limit, `/goal resume` grants a new budget). Esc on a goal turn is a pause, not a
  skipped round; a failed turn also pauses instead of retrying forever. The module is
  `src/session/goal.ts`, the commands `status | pause | resume | clear`.
- `src/session/goal.ts` — the goal state (`Goal`, turnGate/spendTurn/completeGoal,
  goalPrompt/goalLine) and the tests `test/goal-test.mjs` (24 checks) and
  `test/goal-live-test.mjs` (17 checks, a live REPL against a scenario SSE server).

### Fixed

- The session model is no longer substituted at start or on a background catalog refresh: if
  the catalog arrived without a listing of the needed provider (the fetch failed/timed out), `reconcileModel()`
  now leaves the model alone, and the fallback prefers a model of the same host — previously the session
  went to a foreign host and every turn died with 503 "No available channel".
  The `test/model-switch-test.mjs` suite (9 checks).


### Added

- **Meta Model API** (`meta`, also `muse`) — the Muse line straight from the vendor:
  `https://api.meta.ai/v1` with a key from dev.meta.ai, requests on `/responses` (the
  dialect Meta documents for agent work, and the one Zen and Go already route these models
  to), the key-gated `GET /v1/models` as both catalog and login check, and
  `muse-spark-1.2` / `-contributor` / `1.1` as the published fallback at their real 1M
  windows. Prices are carried in the client — $1.25/$4.25 per 1M with $0.15 cached input,
  and a tenth of that for the contributor SKU, whose prompts may be used to improve Meta
  products — so `/cost` states the difference before the model is chosen. `muse-image` is
  marked as an endpoint this client does not speak rather than offered and failed on.
  There is no subscription mode: Meta's plans (Everyday / High / Power Usage) are scoped
  to the Muse Code CLI by its own documentation, and any key on the same account is billed
  pay-as-you-go — the same reason Claude Pro/Max is absent.
- `muse-*` now reads as a Meta model everywhere it is served (Meta, Zen, Go, OpenRouter),
  with the 1M window known without a catalog.

- **Favorites** — a star on any model (`/fav`, or the button in every chooser), kept in
  `favoriteModels`. The Favorites tab comes first in each panel and spans every connected
  host, so picking a starred model switches provider along with it; `favoritesAllProviders:
  false` narrows the tab to what the provider in use serves, and `/settings` carries the
  switch. `/fav` edits the whole set at once — Space marks, Enter saves, Clear all is its
  own button rather than an accidental Enter.
- **The model chooser is organised by provider**, not by modality: one tab per connected
  host with the session's first, lab sections inside each, and the provider column shown
  only where a list actually spans several hosts.
- **A `/swarm` roster you choose** — bare `/swarm` opens the panel, `/swarm models` picks
  who runs (`swarmModels`), and ★ pins the member that merges the answers
  (`swarmMainModel`). Nothing chosen keeps the old automatic pick: the session's model
  plus one model per other vendor.
- **`/subagents` is two modes rather than a list that can be wiped** (`subagentMode`):
  the session's own model, or the list you chose. Switching to the session's model keeps
  the list, so coming back costs one keystroke; `/subagents session` and `/subagents list`
  say it from the command line. `/orchestrate` shows that same shortlist to its planner —
  size and price included — and the plan on screen names the model each step will run on.
- **A loop guard in the agent loop**: the same tool call repeated verbatim is answered in
  the tool's own voice instead of being run a fourth time, and the turn is given up at the
  sixth. A model whose host refuses image input is now told so in the tool result — one
  real session had spent 158 consecutive steps re-reading the same PNG into a history that
  never showed it.

### Fixed

- The image fallback now works on every protocol. After a host refuses image content the
  pixels are stripped in `buildBodyFor`, before the dialect is chosen, so Anthropic
  Messages and Responses degrade to text like OpenAI chat did instead of resending the
  same images and earning the same 400 again.
- Self-update unpacks with the Windows system `tar` (`System32\tar.exe`, bsdtar) rather
  than whatever `PATH` offers first: a Git-for-Windows install puts GNU tar ahead of it,
  and GNU tar reads a `C:\...` archive path as `host:path` and fails on the user's own disk.
- The favorites editor no longer drops stars it cannot currently see. It preselects the
  saved set rather than the catalog-filtered one, so a provider that is logged out or
  still loading does not lose its favorites when Enter writes the set back.
- Modality tags are split on whitespace, not on the letter `s` — `/[,s]+/` turned "Speech"
  into "peech" and lost the modality.
- A failed orchestration step is named in the prompt of the steps that depend on it,
  instead of silently arriving as an empty context they build on regardless.
- The tool-result size cap no longer re-cuts a stub it already wrote, which fired the trim
  notice every turn on a history that never changed.
- The model count in the `/model` subtitle is read when the panel draws, so a catalog that
  lands behind the panel no longer leaves a stale number on screen.

## [0.1.3] — 2026-08-26

### Added

- **Self-update from GitHub Releases** (`src/update.ts`): `trc update [--check]` and
  `/update` download the newest release tarball, unpack it with the system `tar` and swap
  `dist` in place, keeping the old build until the new one lands. A passive startup check
  (`updateCheck: true`, at most one GET every six hours, off with
  `TRCODE_NO_UPDATE_CHECK`) only prints a note under the version in the header — nothing
  is ever applied by itself.
- **`/settings`** — a sectioned picker for the toggleable preferences: what the status
  line shows (`statusFields`: model, tokens, steps, time, speed), whether UI mockups
  match themselves automatically (`uilibAuto`, gates the auto-injection in
  `App.autoLoadDesign`), whether release checks run at all (`updateCheck`).
- **The main model of `/brain`** — "Make main" in the panel picker pins which panel member
  writes the final answer (`brainMainModel`, empty = the session's model).
- **Picker options** — `onOpen` lets the caller repaint an open panel (the model catalog
  re-fetches itself past the cache), `groupGap` puts a blank line before every section
  heading.
- New suites: `stat-test.mjs` (17 checks) and `update-test.mjs` (23 checks against a mock
  of the GitHub API and a fake tgz).

### Fixed

- The auto-retry after a connection drop no longer requires an empty buffer: a step that
  died mid-answer is resent too (up to three attempts). The partial text stays on the
  screen as a cut-off block; the resent step answers in a fresh one, and only that
  complete answer reaches the history — nothing half-said is ever sent back.
- `/stat` periods: the first usage row was cloned into the accumulator before being added,
  doubling the whole spend on every tab, and old sessions were filtered by their aggregate
  `lastUsed`, pulling everything into "Today". Daily buckets now carry each model's real
  per-day share, and the period filter slices them before the fold.
- A killed process tree could hang the shell tool forever: `taskkill` is fire-and-forget,
  and a surviving grandchild — a gradle daemon's java.exe — kept the stdout pipe open.
  After a kill the tool settles with what it captured after ten seconds instead of waiting
  for a `close` that never comes.
- Header repaints mid-session (model switch, an update notice) printed the startup logo
  again; they now reprint the fields alone in a compact box.

### Changed

- Provider lists read alphabetically: the registry, the hosts in `trc models`, the model
  catalog and the pickers. Pinned vendors lead where order carries meaning.
- `test/run-all.mjs` picks a free port per run and SIGKILLs a timed-out suite's whole
  tree, so two checkouts can test at once and an orphaned mock server no longer holds the
  port.

## [0.1.2] — 2026-08-25

### Added

- **`/trace [n]`** — the request projection log. What actually goes out differs from the
  stored history: trim shortens old results, skills splice in mid-turn. Every request
  appends one line to `<session-id>.proj.jsonl` — system prompt, tool schemas, history
  after trim, injections, what trim saved, the provider's cached-token count.
- **Tool presets** — `/preset minimal` (and `trc --preset minimal`) shrinks the session to
  `shell` + `edit` with a matching short prompt; `/preset standard` restores everything.
- **`run_code`** (opt-in: `"codeMode": true`) — the model writes one JavaScript program
  whose SDK calls (`sdk.fs.*`, `sdk.shell`, `sdk.web.*`) run in a child process; only the
  return value enters the conversation. Paths stay inside the project, shell and web
  confirm through the broker, writes are snapshotted for `/rewind`.
- **`/fork [turn]`** — branch the session at a past turn without undoing anything; also
  offered as "Fork here instead" in the `/rewind` menu.
- **`read_image`** — put a picture (PNG/JPEG/GIF/WebP/BMP, ≤1.6 MB) in front of a vision
  model as real image content; hosts that refuse images are remembered and get text.

## [0.1.1] — 2026-08-25

### Added

- xAI and Z.AI providers, `/stat` — a spend table with period tabs.
- The turn bar keeps its frame while the model thinks.

## [0.1.0] — 2026-08-23

First tagged release: multi-provider routing (TokenRouter, Kimi, Anthropic, OpenRouter,
OpenCode Zen, OpenCode Go, Alibaba Cloud), OAuth device flow, sessions with compaction
and checkpoints, skills, subagents, `/brain`, `/orchestrate`, `/swarm`, Orca support.

