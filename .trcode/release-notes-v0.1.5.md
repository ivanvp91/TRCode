# TRCode v0.1.5

## Added

- **`/goal` — a persistent objective the agent keeps working toward** (after Qoder CLI).
  `/goal <objective> [--turns <n>]` sets a goal, and after each of your turns the agent
  takes the next one on its own:

  ```
  /goal make npm test green          # set it; the agent continues after each of your turns
  /goal rewrite docs --turns 10      # with an explicit budget
  /goal                              # status: the mark, the objective, turns spent
  /goal pause                        # stop the automatic continuation (Esc does the same)
  /goal resume                       # continue; a spent budget is granted anew
  /goal clear                        # remove it
  ```

  The goal is repeated verbatim in the prompt of every goal turn (*assess the state, do
  the next concrete step, verify the result*), and only the model declares completion —
  with a `<goal-complete>` tag at the end of its answer. The goal lives in the session file
  and survives a restart and `-c`/`--resume`; the goal mark (◉ active, ◎ paused,
  ✓ complete) sits in the status line. Anything you type between goal turns goes through
  first — a question, an edit, `/goal pause` during a turn take effect instead of waiting
  for a round. **Esc pauses the goal** rather than skipping the round; a turn that failed
  on the network also pauses it — an unattended loop must not retry forever into a dead
  host. Without `--turns` a built-in limit of **25 turns** applies — the pause is announced
  once, and `/goal resume` grants a fresh budget. New module `src/session/goal.ts`; tests
  `test/goal-test.mjs` (24) and `test/goal-live-test.mjs` (17, a live REPL on a scripted
  SSE server).

## Fixed

- The session model is no longer substituted at startup or on a background catalog
  refresh: if the catalog came back without a listing from the needed provider (the fetch
  failed or timed out), the model is left alone, and the fallback prefers a model on the
  same host. Previously the session moved to a foreign host and every turn died with
  503 "No available channel". Test `test/model-switch-test.mjs` (9 checks).

## Numbers

- 59 test suites, all green (was 56 in v0.1.4).
- Full changelog: [CHANGELOG.md](CHANGELOG.md).
