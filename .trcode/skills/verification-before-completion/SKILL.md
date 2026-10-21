---
name: verification-before-completion
description: Prove the work is done before declaring it done — run the checks, the tests, the build, the actual command, and show the evidence. Use before telling the user "готово", "fixed", "done", "works", or when closing a task; also after edits to config, dependencies, or anything that can break a run.
description_ru: Доказать, что работа сделана, прежде чем объявлять её сделанной — прогнать проверки, тесты, сборку, реальную команду и показать доказательство. Перед тем как сказать «готово», «исправлено», «работает» или закрыть задачу; а также после правок конфигов, зависимостей и всего, что может сломать запуск.
triggers: проверь, verify, готово?, done check, всё работает?, убедись, sanity check, финальная проверка, final check, не забудь проверить, before committing, перед коммитом, закрываем, does it work, так точно работает?, double check
---

# Verification before completion

## 1. "Done" means proven, not plausible
A task is finished when the claim has been executed, not when the code looks right. Before any "ready" message, run the weakest spot: the test suite this change touches, the build, the exact command that failed before. If nothing was run, the honest status is "written, not verified".

## 2. Match the check to the change
- Code change → the tests covering it, plus the suite's neighbours (an export change breaks importers, not just its own file).
- Type-sensitive repo → the typecheck (`tsc --noEmit` or the repo's equivalent), not just the tests.
- Config, dependency, or build-file change → the thing that consumes it actually runs (start the app, run the build).
- Claimed behavior ("now it handles empty input") → the exact input tried, not a related one.
- UI change → looked at, via screenshot or opening the page, not inferred from the code.

## 3. Read the failures you asked for
When a check fails: report it plainly with the output, say what it means, and either fix it or state that it is not fixed. Never present a failing run as green, and never let a pre-existing failure silently become "the test was already red" without confirming it is the same red (run the suite on the untouched tree if unsure).

## 4. Partial runs are not green runs
- Skipped, filtered, or "ran only the suite I touched" is a valid scope — when stated as such. It is not valid as a basis for "all tests pass".
- A suite that hung or got killed is not a pass; rerun it or say it did not finish.
- Timing-flaky suites: one standalone rerun before blaming code — but say the word "flaky" with evidence, not as a reflex.

## 5. Close the loop on side effects
- Temporary files, debug prints, added console.logs — removed (they will be found by a grep before claiming cleanliness).
- New dependencies actually install (`npm install` ran), scripts referenced in docs actually exist.
- If a fix needs a restart or a rebuild to take effect (compiled `dist/`, a running server), say which and whether it was done.

## What not to do
- Do not say "should work now" — say what was run and what it printed.
- Do not run a check and ignore its output because the diff looked small.
- Do not claim the whole suite passed from a partial run.
- Do not fix a failing check by deleting or skipping it without flagging that loudly.

## Answer format
The closing status line carries the evidence: what command ran, the exit code / pass count, and anything left unverified with the reason. "Done — `node test/x-test.mjs` 12/12 green; typecheck clean; `dist/` rebuilt." If not verified: "Written but not verified — <why>, here is the command that would verify it."
