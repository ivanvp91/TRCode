# tokenrouter-cli

## Running tests — read before running `npm test`

- `npm test` (= `node test/run-all.mjs`) runs ~53 suites **sequentially** and takes
  **2–5 minutes**. Silence does not mean it hung.
- **Run it in the background** (`run_in_background: true`), then read the output
  file when the completion notification arrives. This avoids minutes of blocking
  "Running…" ticker lines in the transcript.
- **Never pipe it through a tail filter** (`| Select-Object -Last N`, `| Select-String`,
  `| tail`): the pipe buffers all output until the whole run ends, so the run looks
  frozen for minutes. If you must run it in the foreground, run it plain —
  `PASS`/`FAIL` lines stream as each suite finishes.
- A single suite runs directly: `node test/<name>-test.mjs`.
- Each suite is SIGKILLed (tree and all) after 120 s. Mock servers take free ports
  and exit on their own when their parent dies, so interrupted or parallel runs do
  not leak processes or block ports.
- Do not start two `npm test` runs at once in this checkout: suites share
  `.test-home`. Timing-sensitive suites (`ratelimit`, `interrupt`, `shell-output`)
  also flake under heavy CPU load — e.g. while another session runs a Gradle build.
  If one of them fails in a full run but passes standalone, it was load, not code.

## Concurrent sessions

Several Claude sessions often work in this checkout at the same time. Expect files
to change under you; re-read before editing, and never revert changes you did not
make.
