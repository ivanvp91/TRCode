# TRCode v0.1.3

Maintenance release: self-update from GitHub Releases, a `/settings` panel, `/stat`
period accounting fixed via daily buckets, plus reconnect and shell-hang fixes.

## Highlights

- **Self-update** — `trc update [--check]` and `/update` download the newest release
  tarball, unpack it with the system `tar` and swap `dist` in place; the old build stays
  until the new one lands. The passive startup check (at most once every six hours,
  `"updateCheck": false` or `TRCODE_NO_UPDATE_CHECK` to turn off) never applies anything —
  it only puts a note under the version in the header.
- **`/settings`** — a sectioned picker for the preferences that used to live only in
  `config.json`: which fields the status line shows (`statusFields`), whether UI mockups
  match themselves automatically (`uilibAuto`), whether release checks run (`updateCheck`).
- **The main model of `/brain`** — "Make main" in the panel picker pins who writes the
  final answer (`brainMainModel`, empty = the session's model).
- **Reconnect mid-answer** — a step that died after part of the answer streamed is resent
  too (up to three attempts). The partial text stays on screen as a cut-off block; the
  resent step answers in a fresh one and only that complete answer reaches the history.
- **`/stat` periods fixed** — the first usage row was cloned into the accumulator before
  being added (the whole spend doubled on every tab), and old sessions were filtered by
  their aggregate `lastUsed`, pulling everything into "Today". Daily buckets now carry each
  model's real per-day share.
- **No more shell-tool hangs** — after killing a tree, a surviving grandchild (a gradle
  daemon's java.exe) could hold the stdout pipe open forever; the tool now settles with
  what it captured ten seconds after the kill.

Also: compact header repaints (a model switch no longer prints the startup logo again),
provider lists read alphabetically, picker panels can repaint while open (`onOpen`) and
gap their sections (`groupGap`), and `test/run-all.mjs` picks a free port per run so two
checkouts can test at once. New suites: `stat-test.mjs` (17 checks) and `update-test.mjs`
(23 checks against a mock of the GitHub API).

## Install

```bash
# from the release tarball
npm install -g trcode-0.1.3.tgz

# or from source
git clone https://github.com/ivanvp91/TRCode.git
cd TRCode
npm install
npm run package && npm install -g ./trcode-0.1.3.tgz
```

Then connect a provider:

```bash
trc auth login
trc
```

Or update an existing install in place: `trc update`.
