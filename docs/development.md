# Development and integrations

[Back to README](../README.md)

- [Tests](#tests)
- [Running inside Orca](#running-inside-orca)
- [Layout](#layout)

## Tests

Everything runs against a local mock of the API — no key and no network required:

```bash
npm test
```

The suites cover the wire protocols, provider routing and the OAuth device flow (against a
throwaway server on localhost), history trimming, the request projection log, the code-mode
sandbox (path guard, snapshots, timeout, abort), session forking, the tool presets and the
self-update path against a mock of the GitHub API,
plus the terminal behaviour that is otherwise painful to verify: paste in four delivery
shapes, split escape sequences,
Shift+Tab in its three encodings, focus events, frame repainting, multi-line input,
prompt history, the resume flow and the
during-turn bar on a virtual screen, and the process actually exiting instead of lingering.

`test/measure-tokens.mjs` measures request sizes at several `maxRequestTokens` thresholds
and prints the table from [Token spend](models-and-costs.md#token-spend).

To drive the CLI against the mock by hand (Bash):

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
TRCode is not on its list — the routes are `claude`, `cursor`, `gemini`, `grok`,
`kimi`, `opencode` and a dozen more. So the reports go out as `opencode`, whose contract is
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

`scripts/orca-agent-patch.mjs` takes `cursor`, whose binary name (`cursor-agent`), label
(`Cursor`) and icon slot are exactly where ours fit:

```bash
npm link                                   # provides the trcode-agent command
node scripts/orca-agent-patch.mjs --check   # what it would do, changes nothing
node scripts/orca-agent-patch.mjs           # apply, then restart Orca
node scripts/orca-agent-patch.mjs --revert  # back to the backup it made
```

Three things change. In `out/preload/index.js` the agent table's `detectCmd` becomes
`trcode-agent` — `launchCmd` and `expectedProcess` default to it, so one string moves the
whole slot. In `out/renderer/assets/agent-catalog-*.js` the label `Cursor` becomes
`Trcode`, and the 64×64 PNG that Orca inlines as a base64 data URI for that agent is
replaced by `assets/branding/trcode-app-icon-64-indexed.png`, padded back to the very
same byte count with an ancillary `tEXt` chunk so the base64 keeps its length.

The internal id stays `cursor`, so the hook route and the pane icon slot still belong to
it. The archive's own per-file SHA-256 (the header stores it twice per file) is rewritten
to match, which the script only does when the old hash occurs exactly twice. Orca stops
offering Cursor, and every Orca update replaces `app.asar` and undoes this, so run it
again after one. The script refuses to write if Electron's ASAR integrity fuse is on (a
patched file would stop the app from starting), asserts every file keeps its size before
writing, and refreshes its backup from whatever the current build is. Orca's web and
mobile-web bundles are built differently (icons there are separate PNG files), so only
the desktop renderer is patched.

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
    videomode.ts       /video mode and its system-prompt section
  session/
    session.ts         history, persistence, fork
    compact.ts         context compaction
    trim.ts            per-request history trimming
    projection.ts      per-request token projection log (/trace)
    checkpoint.ts      file snapshots for /rewind
    goal.ts            persistent goal (/goal)
    history.ts         prompt history across restarts
  tools/               read, edit, write, ls, glob, grep, shell, read_image,
                       run_code (opt-in), skill, todo, memory, task,
                       generate_image / _video / _audio (imagegen.ts,
                       video.ts, audiogen.ts; media.ts and mediamodels.ts
                       hold the hosts, model pools and shared plumbing)
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
