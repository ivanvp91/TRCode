---
name: debugging
description: Track down a bug, crash, failing test or "it works locally but not here" — when given an error message, a stack trace, or a report that something behaves wrong. Not for writing new features.
description_ru: Найти причину бага, падения, упавшего теста или «локально работает, а здесь нет» — когда дают сообщение об ошибке, стектрейс или жалобу, что что-то ведёт себя не так. Не для новых возможностей.
triggers: баг, багу, багов, дебаг, debug, debugging, ошибка, ошибку, падает, крашится, crash, traceback, stack trace, стектрейс, не работает, exception, исключение, воспроизвести, repro, почини, fix the bug, failing test, тест падает
---

# Debugging

## 1. Pin down the symptom
Before touching code, state in one line: what was expected, what happened instead, on what input. If the report is vague ("it's broken"), get the exact command, the exact output, and whether it ever worked.

## 2. Reproduce
- Run the failing command or test yourself. A bug you cannot reproduce is a bug you cannot verify fixed.
- Narrow it: smallest input, single test case, one file. `git stash` / `git log -S<symbol>` to find when it appeared.
- If it reproduces only sometimes, suspect ordering, caching, timezones, network, or leftover state — not randomness.

## 3. Read the trace properly
The first frame in your own code matters more than the top frame in a library. Read the whole function around it, plus the caller. Check what the values actually are, not what they should be — add a temporary print/log rather than reasoning from memory.

## 4. Form one hypothesis at a time
Write it down: "X is null because Y never runs when Z". Then test that specific claim. Do not change three things at once — you will not know which one mattered, and two of them will be new bugs.

## 5. Fix the cause, not the symptom
A `try/catch` around a crash, a `?? 0`, an `if (!x) return` — these hide the defect unless the missing value is genuinely legal. Ask: why did this value get here? Fix that. Only guard when the invariant truly allows the empty case.

## 6. Prove it
- Run the original repro — it must now pass.
- Run the surrounding tests — the fix must not break neighbours.
- Remove every temporary print you added.
- If there was no test covering this, add one that fails before the fix.

## What not to do
- Do not rewrite unrelated code while you are in there.
- Do not declare it fixed because "it should work now" — run it.
- Do not silence a linter or a type error to make the symptom disappear.

## Answer format
1. Root cause — one or two sentences, with `path:line`.
2. The fix, and why it is at that level rather than a guard higher up.
3. How it was verified (command run, test added).
4. Anything still uncertain or worth watching.
