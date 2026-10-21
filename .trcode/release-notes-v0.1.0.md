# TRCode v0.1.0

First release of TRCode — a cross-platform agentic coding CLI for the terminal: one client over the TokenRouter catalog, Kimi, Anthropic, OpenRouter, OpenCode Zen, OpenCode Go and Alibaba Cloud (Qwen). Zero runtime dependencies; Node 20+ on Windows, macOS and Linux.

## Highlights

- **Agentic loop** — tool use (shell, read/edit/write, glob/grep/ls, web search and fetch), subagents, skills with auto-loading, todo tracking.
- **Seven providers, one keyring** — per-provider model, reasoning effort and host; live switching mid-session (`/model`), failover to the same model at another host on refusals.
- **Token accounting** — live counters in the turn bar, per-turn and per-session totals, context pressure with automatic compaction, prompt caching where the host supports it.
- **Sessions** — resume, `/sessions`, replay rendered as markdown, checkpointed file edits (`/rewind`).
- **Project memory** — durable facts in `.trcode/memory.md` that ride in the system prompt across sessions; `/memory` to manage.
- **Terminal UI** — a persistent input frame while the model works (type ahead, queue messages), ctrl+o to expand anything the screen shortened, arrow-key history, syntax-coloured diffs.

## Install

```bash
# from the release tarball
npm install -g trcode-0.1.0.tgz

# or from source
git clone https://github.com/ivanvp91/TRCode.git
cd TRCode
npm install
npm run package && npm install -g ./trcode-0.1.0.tgz
```

Then connect a provider:

```bash
trc auth login
trc
```

## Changes since the initial commit

- Project memory: a `memory` tool, `/memory` command and a `<project-memory>` prompt section (snapshotted like the rest of the prompt to keep the cache intact).
- Ctrl+O and the arrow keys now work in the turn bar while a turn runs, not only in the idle editor: expand a shortened block mid-turn, steer the caret inside a multi-line draft, walk submitted history with ↑/↓.
- The installable npm package: `prepack` builds, `npm run package` produces the tarball.
