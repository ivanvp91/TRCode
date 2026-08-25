# TRCode v0.1.2

Feature release: a request projection log (`/trace`), tool presets, an opt-in
code-execution mode (`run_code`), session forking (`/fork`), and the `read_image`
tool for vision models.

## Highlights

- **`/trace [n]` — the request projection log.** The stored history is not what goes out:
  trim shortens old results and skills are spliced in mid-turn. Every request now appends
  one line to `<session-id>.proj.jsonl`: system prompt, tool schemas, history after trim,
  injections, what trim saved, and the provider's cached-token count. `/trace` shows the
  last n as a table; the log survives a resume, so "what did the model see at step 3"
  finally has an answer.
- **`/preset minimal`** (also `trc --preset minimal`) shrinks the session to two tools —
  `shell` and `edit` — with a matching short prompt: no workspace listing, git state,
  skills or memory. The first request drops to roughly a third of its usual size;
  `/preset standard` brings everything back.
- **`run_code` (opt-in: `"codeMode": true`)** — instead of five rounds of read → result →
  read, the model writes one JavaScript program whose SDK calls (`sdk.fs.*`, `sdk.shell`,
  `sdk.web.*`) run in a child process; only the return value enters the conversation.
  Same guardrails as the dedicated tools: paths stay inside the project, shell and web
  confirm through the broker, writes are snapshotted for `/rewind`, timeout and Esc kill
  the whole tree. Intermediate outputs never ride along on later steps — this is the
  direct answer to the quadratic input bill.
- **`/fork [turn]`** branches the session at a past turn without undoing anything: a new
  session carries the history up to that point, the original stays intact on disk and in
  the list. The cut never splits a tool pair. Also offered as "Fork here instead" in the
  `/rewind` menu.
- **`read_image`** puts a picture in front of a vision model (PNG/JPEG/GIF/WebP/BMP,
  ≤1.6 MB) as real image content; hosts that refuse images are remembered and get text
  afterwards.

## Install

```bash
# from the release tarball
npm install -g trcode-0.1.2.tgz

# or from source
git clone https://github.com/ivanvp91/TRCode.git
cd TRCode
npm install
npm run package && npm install -g ./trcode-0.1.2.tgz
```

Then connect a provider:

```bash
trc auth login
trc
```
