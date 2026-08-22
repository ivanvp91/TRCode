---
name: refactoring
description: Restructure existing code without changing what it does — when asked to clean up, simplify, split a big file or function, remove duplication, or "make this nicer". Not for fixing bugs or adding features.
description_ru: Переустроить существующий код, не меняя поведения — когда просят почистить, упростить, разделить большой файл или функцию, убрать дублирование, «сделать аккуратнее». Не для починки багов и не для новых возможностей.
triggers: рефактор, рефакторинг, refactor, refactoring, почисти, почистить, cleanup, clean up, упрости, упростить, simplify, дублирование, duplication, разбей файл, tech debt, техдолг, отрефактори, зарефактори
---

# Refactoring

## 1. Establish the safety net first
- Find the tests that cover the code. Run them and record that they pass *before* you touch anything.
- No tests? Say so, and either write a characterisation test for the current behaviour first, or keep the change small enough to verify by reading.

## 2. Understand the current shape
Read every caller of what you are about to move (`grep` the symbol). A refactor that looks local is usually not: default arguments, re-exports, dynamic access by string, and tests all reach in.

## 3. Pick the smallest useful move
In order of payoff:
1. **Delete** — dead code, unused parameters, commented-out blocks, redundant branches.
2. **Name** — a magic number, a boolean parameter, a `data2` variable.
3. **Extract** — pull a coherent block into a function with one job; not "the middle 20 lines".
4. **Deduplicate** — but only when the copies really are the same rule, not two rules that coincide today.
5. **Reshape** — flatten nesting, early returns, invert a condition.

## 4. One transformation per step
Make the change, run the tests, move on. A pile of simultaneous edits is not a refactor, it is a rewrite with no way back.

## 5. Match the codebase, not your taste
Follow the naming, file layout, error handling and comment density that already exist here. A refactor that introduces a new style is a net loss even if the style is better in the abstract.

## What not to do
- Do not change behaviour, error messages or public signatures unless explicitly asked. If you find a bug on the way, report it separately — do not fix it silently inside the refactor.
- Do not add abstraction for a second case that does not exist yet.
- Do not reformat whole files; it buries the real change in the diff.
- Do not "improve" comments into noise. Delete comments that lie; keep the ones explaining *why*.

## Answer format
- What changed, grouped by intent (deleted / renamed / extracted / moved).
- Confirmation that behaviour is identical, and how you know (tests run, output compared).
- Anything you deliberately left alone and why.
