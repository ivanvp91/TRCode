# TRCode v0.2.1 — thirteen languages, subagent fan-out, cleaner terminal

## Interface languages

- Eleven new languages: Chinese, Japanese, German, French, Spanish, Italian, Portuguese,
  Ukrainian, Polish, Malay and Indonesian (thirteen in total). `/lang` accepts a code, the
  English or the native name, and with no argument opens the picker; placeholders became
  named, plurals go through `Intl.PluralRules`, and an untranslated string reads in English
  instead of disappearing.

## Agent work

- A request with several independent parts no longer runs as a queue: the agent fans out
  subagents itself — one `task` call per part in the same turn.
- Above the spinner runs a list of the working helpers: model, spent step budget, tokens
  and the last action.
- The `/brain` panel models get the agent's tools, and the panel itself became checkboxes:
  space marks a row on any tab, Enter applies the whole set.
- A question from the model is drawn above the input line without shifting either the
  dialog or the composer.
- `/brain` and `/swarm` ask in the normal composer — with the band, the status and the
  editing keys.
- Every file that `edit`/`write` overwrites leaves its previous bytes in
  `.tmp/agent-backups/<session-id>/` until the session ends.

## Fixed

- `tok/s` in the status bar is computed from generation time, not from the turn clock; `↓`
  became cumulative per turn.
- A turn in which the model only thought no longer ends silently: the step is sent again,
  and an empty answer is not written to history.
- The `/brain` panel no longer ends with "let me check a couple more facts": when the step
  budget is spent, the model answers from what it has gathered.
- The empty "Response" block is no longer printed.
- The void above panels and output after a submitted line is gone.

## Terminal

- The splash logo is coloured like brushed metal: a silver ramp and a specular highlight
  every ten seconds, with a channel changing by no more than one step per frame.

## Verification

Full set: 82 test suites.

## Installation and update

In an existing installation: `trc update` or `/update`, then restart the CLI.

To install from the release archive:

```sh
npm install -g https://github.com/ivanvp91/TRCode/releases/download/v0.2.1/trcode-0.2.1.tgz
```
