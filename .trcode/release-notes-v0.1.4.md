# TRCode v0.1.4

A tenth provider (Meta's Muse line), favorites across every model chooser, a `/swarm`
roster you pick by hand, `/subagents` as two modes instead of a list that could be wiped,
and a loop guard that stops a model re-running the same call forever.

## Highlights

- **Meta Model API** (`meta`, also `muse`) — the Muse line straight from the vendor:
  `https://api.meta.ai/v1`, a key from dev.meta.ai, requests on `/responses` (the dialect
  Meta documents for agent work), and the key-gated listing as both catalog and login
  check. `muse-spark-1.2` is a 1M-token agentic model at **$1.25 / $4.25** per 1M with
  cached input at $0.15; `muse-spark-1.2-contributor` is the same model at a tenth of the
  price because its prompts may be used to improve Meta products — both prices are in the
  client, so `/cost` states the difference before the model is chosen. No subscription
  mode: Meta scopes its plans to its own CLI, and any key on the account is billed
  pay-as-you-go.
- **Favorites** — a star on any model (`/fav`, or the button in every chooser). The
  Favorites tab comes first in each panel and spans every connected host, so picking a
  starred model switches provider along with it; `favoritesAllProviders: false` narrows it
  to the provider in use. `/fav` edits the whole set at once, with Clear all as its own
  button rather than an accidental Enter.
- **The model chooser is organised by provider**, not by modality: one tab per connected
  host with the session's first, lab sections inside, and the provider column shown only
  where a list actually spans several hosts.
- **A `/swarm` roster you choose** — bare `/swarm` opens the panel, `/swarm models` picks
  who runs, and ★ pins the member that merges the answers. Nothing chosen keeps the old
  automatic pick: the session's model plus one model per other vendor.
- **`/subagents` is two modes** — the session's own model, or the list you chose. The list
  survives the switch, so coming back to a shortlist of five costs one keystroke;
  `/orchestrate` shows that same shortlist to its planner, size and price included, and
  the plan on screen names the model each step will run on.
- **A loop guard** — the same tool call repeated verbatim is answered in the tool's own
  voice instead of being run a fourth time, and the turn is given up at the sixth. A model
  whose host refuses image input is now told so in the tool result: one real session had
  spent 158 consecutive steps re-reading the same PNG into a history that never showed it.

## Fixes

- The image fallback works on every protocol now. After a host refuses image content the
  pixels come off before the dialect is chosen, so Anthropic Messages and Responses
  degrade to text like OpenAI chat did instead of resending the same images.
- Self-update unpacks with the Windows system `tar` (System32 bsdtar) rather than whatever
  `PATH` offers first — a Git-for-Windows install puts GNU tar ahead of it, and that one
  reads a `C:\...` archive path as `host:path` and fails on the user's own disk.
- The favorites editor no longer drops stars it cannot currently see: a provider that is
  logged out or still loading keeps its favorites when the set is written back.
- Modality tags are split on whitespace rather than on the letter `s`.
- A failed orchestration step is named in the prompt of the steps that depend on it,
  instead of arriving as an empty context they build on regardless.
- The tool-result size cap no longer re-cuts a stub it already wrote, and the model count
  in the `/model` subtitle is read when the panel draws rather than before it opens.

## Install

```bash
# from the release tarball
npm install -g trcode-0.1.4.tgz

# or from a checkout
npm install
npm run package && npm install -g ./trcode-0.1.4.tgz
```

Then connect a provider:

```bash
trc auth login
trc
```

Or update an existing install in place: `trc update`.
