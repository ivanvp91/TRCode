# TRCode v0.1.9 — twelve providers, smart auto-compaction, solid MCP

A large release: three new providers (OpenAI, Google Gemini, Meta Muse), a full
MCP client, three-step compaction, automatic 503 retries, and a batch of fixes
that made the terminal hang or miss a screenshot.

## Added

- **OpenAI, two ways** — `/login openai` offers "Subscription / API key".
  Subscription is browser OAuth (PKCE) under the official ChatGPT client: the
  backend's service headers (`originator`, `OpenAI-Beta`, `ChatGPT-Account-Id`,
  three session headers), the account is read from `id_token`. The backend accepts
  only `/responses` and only streaming, does not take `max_output_tokens`
  and requires `store: false` — this is expressed by mode flags, so non-streaming
  calls (compaction, titles) are assembled from the stream. The key is plain
  `api.openai.com/v1`. We deliberately do not reuse another CLI's session: that
  server rotates the refresh token.
- **Google Gemini** — `/login gemini` (or `/login google`). An AI Studio key goes
  through the official OpenAI-compatible shim. Account login is the Gemini CLI
  OAuth client against Code Assist (`{model, project, request}`, the project
  discovered via `loadCodeAssist`/`onboardUser`, resumable session
  `~/.gemini/oauth_creds.json`) with a warning: Google treats such use as a ToS
  violation. The key remains the supported path.
- **Meta Muse** — `muse-wonder-1.0`, `muse-spark-1.3`, `muse-spark-1.3-contributor`
  (1M windows, Responses); `/login meta` reuses the `~/.config/muse/auth.json`
  session.
- **OpenCode Zen and OpenCode Go through an account** — OpenCode Console device
  flow, no key copying; `trc auth login --provider opencode-go --oauth` skips the
  choice.
- **MCP is now complete**: Streamable HTTP alongside stdio, protocol 2026-07-28
  (`legacy` / `auto` / `2026-07-28`), resources through three tools
  (`list_mcp_resources`, `read_mcp_resource`, `list_mcp_resource_templates`),
  `mcpToolSearch` with `find_mcp_tools` for fat servers, `/mcp restart|stop|logs`.

## Changed

- **Compaction is a handoff summary plus the last user messages** verbatim,
  between tool rounds inside one turn, the history is changed in place.
- **Auto-compaction became a ladder.** 25% of the window is light cleanup without
  a model call (old tool results and reasoning), 50% is a digest that keeps the
  working tail, 90% is a full summary. The steps are quota'd per cycle: **3 light
  and 2 medium**, so a history stuck just above the threshold is not cleaned on
  every turn and still reaches the next step; a full summary opens a new cycle,
  and the counters live in the session. Switches: `/compact auto off`, the
  **Context** row in `/settings`, or `autoCompact: false` in config.json.
- **A transient 503 no longer gives up** — up to 10 retries with a 10 s pause
  (`upstreamRetries`, `upstreamRetryDelayMs`), each pause with its attempt number
  in the transcript; Esc interrupts the wait.
- **MCP: schemas travel by budget** (`toolInputSchemaMaxBytes`), the catalog
  refreshes on `list_changed`, `enabledTools` / `disabledTools`, `approval`,
  `outputLimit`, `startupTimeoutSec` / `toolTimeoutSec` appeared.

## Fixed

- **Tool pixels on the gRPC gateway.** The "only text parts are supported on the
  gRPC path" rejection applies only to tool messages: tool images now move into a
  user message with a caption, and the model sees the screenshot it called
  `read_image` for.
- **Esc interrupts outside a turn too** — `escWatch()` for OAuth login, Code Assist
  project discovery and catalog refresh; the Spinner promises the key only where
  someone listens for it.
- **400 "The `reasoning_content` … must be passed back"** — the client catches it
  once per model and sends the empty field instead of failing the turn.
- **MCP: zombie processes, lost images, dead catalog** — the process tree via
  `killTree`, image blocks reach the model, a session 404 is reinitialized and the
  call retried, a crashed server restarts with backoff.

## Install

```sh
npm install -g trcode-0.1.9.tgz
```
