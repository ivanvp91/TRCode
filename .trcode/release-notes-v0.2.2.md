# TRCode v0.2.2 — the screen no longer goes blank at the end of a turn

## Fixed

- When the terminal does not answer the cursor position query (`ESC[6n`), at the end of a
  turn the composer asked to scroll the screen by the whole length of the turn — 610 lines
  in the live case. The terminal threw the transcript into the scrollback, and an empty
  screen was left: neither the answer nor the input line. Now the position probe also
  recomputes the row counter's reference point, "printed since" is never negative, and the
  shift itself cannot exceed the screen height.
- The cursor query is silent, in particular, in a terminal pane inside the orchestrator
  (Orca): before, the void appeared in exactly such panes, and rarely in a normal terminal.

## Verification

Full set: 82 test suites. New block in `test/pin-test.mjs` — "a failed probe
does not scroll the screen away" (103 checks in the suite).

## Installation and update

In an existing installation: `trc update` or `/update`, then restart the CLI.

To install from the release archive:

```sh
npm install -g https://github.com/ivanvp91/TRCode/releases/download/v0.2.2/trcode-0.2.2.tgz
```
