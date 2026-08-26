# Changelog

All notable changes to TRCode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versioning is
[SemVer](https://semver.org/) while the client stays pre-1.0.

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
