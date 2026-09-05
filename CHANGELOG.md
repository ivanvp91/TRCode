# Changelog

All notable changes to TRCode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versioning is
[SemVer](https://semver.org/) while the client stays pre-1.0.

## [0.1.5] — 2026-09-05

### Added

- **`/goal` — a persistent objective the agent keeps working toward** (по образцу Qoder
  CLI). `/goal <objective> [--turns <n>]` задаёт цель, и после каждого хода пользователя
  агент сам берёт следующий: цель повторяется вербатимом в промпте каждого goal-хода,
  модель объявляет завершение тегом `<goal-complete>`. Цель хранится в session-файле и
  переживает resume; встроенный лимит 25 ходов ставит её на паузу автоматически (`--turns`
  заменяет лимит, `/goal resume` выдаёт новый бюджет). Esc на goal-ходе — пауза, а не
  пропуск раунда; упавший ход тоже ставит паузу вместо вечного ретрая. Модуль
  `src/session/goal.ts`, команды `status | pause | resume | clear`.
- `src/session/goal.ts` — состояние цели (`Goal`, turnGate/spendTurn/completeGoal,
  goalPrompt/goalLine) и тесты `test/goal-test.mjs` (24 проверки) и
  `test/goal-live-test.mjs` (17 проверок, живой REPL на сценарном SSE-сервере).

### Fixed

- Модель сессии больше не подменяется при старте/фоновом обновлении каталога: если
  каталог пришёл без листинга нужного провайдера (фетч упал/таймаут), `reconcileModel()`
  теперь не трогает модель, а фолбэк предпочитает модель того же хоста — раньше сессия
  уходила на чужой хост и каждый ход умирал с 503 «No available channel».
  Тест `test/model-switch-test.mjs` (9 проверок).


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
