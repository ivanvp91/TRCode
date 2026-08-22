# TRCode v0.1.1

Patch release: two new providers, a usage report, and the input frame staying on screen while a model thinks or the history is compacted.

## Highlights

- **xAI (Grok) and Z.AI** — SuperGrok / console.x.ai and Z.AI / bigmodel sit next to the existing providers; `/login xai` and `/login zai` (or `trc auth login --provider …`).
- **`/stat`** — usage by provider and model, with today / week / month / all-time filters.
- **The input frame stays put** while a model reasons and while auto-compaction runs. A growing reasoning preview no longer scrolls the box off the bottom of the terminal; compaction uses the turn bar instead of a lone spinner.
- **Live tok/s** on the spinner and the per-turn status line.
- **Shift+Tab in the turn bar** — the confirmation mode flips mid-turn the same way it does in the idle editor, including when the key arrives glued to other input.

## Install

```bash
# from the release tarball
npm install -g trcode-0.1.1.tgz

# or from source
git clone https://github.com/ivanvp91/TRCode.git
cd TRCode
npm install
npm run package && npm install -g ./trcode-0.1.1.tgz
```

Then connect a provider:

```bash
trc auth login
trc
```
