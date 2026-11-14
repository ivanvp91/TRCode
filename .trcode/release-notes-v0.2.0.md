# TRCode v0.2.0 — terminal interface and reliable updates

## Interface

- Fixed the accumulation of blank lines during multi-line input and history
  scrolling, the spacing around the input field, list flicker and panel
  repainting.
- A "Response" divider appeared between the reasoning and the answer ("Response"
  in the English interface) with one blank line beneath it.
- The command list works during a turn; Enter steers the current turn at the
  nearest step boundary, Tab queues the message.
- `!command` runs in the shell, and its output is available to the model in the
  history.
- Added the TRCode splash screen, the session name in the status bar, and tips
  about client features that can be turned off: `/tips on|off|reset`.

## Updates

- `/update --check` only checks whether a release exists.
- Dependency version ranges are checked, including already installed packages.
- Dependencies are installed in a separate directory; an npm error always stops
  the update before the working build is replaced.
- The build and dependencies are replaced by renames on a single disk. On error a
  rollback runs; if files are locked and recovery is impossible, the backups are
  kept and the message points at their path.
- `sharp` is loaded when image tools are used, so its absence does not prevent
  starting the CLI and repairing the installation.

## MCP and sessions

- MCP servers from the project's `.trcode/mcp.json` wait for `/mcp trust`;
  changing the configuration requires a new approval.
- Fixed HTTP session recovery, UTF-8 decoding, Windows argument escaping, `ping`
  and `roots/list` responses, and duplicated JSON results.
- Improved the session picker windows and OAuth token recovery with several
  clients running at once.

## Verification

Full suite: 77 test suites. Additionally checked: the spacing under the divider,
the build version, and installation from the published archive.

## Install and update

In an existing installation: `trc update` or `/update`, then restart the CLI.

To install from the release archive:

```sh
npm install -g https://github.com/ivanvp91/TRCode/releases/download/v0.2.0/trcode-0.2.0.tgz
```
