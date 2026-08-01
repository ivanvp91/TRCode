---
name: code-review
description: Review uncommitted changes or a specific diff — when asked to "check my code", "review this", "what is wrong with these changes". Not for writing new code.
---

# Reviewing changes

## 1. Collect the diff
- `git status --porcelain` — what is touched at all.
- `git diff` for unstaged, `git diff --staged` for staged.
- If this is not a git repository, ask which files to look at. Do not guess.

## 2. Read more than the diff
A diff lies about context. For every changed file, read the whole function rather than the changed lines only: half of the real bugs live in how a new line interacts with an old one.

## 3. What to look for, most important first
1. **Correctness** — broken logic, inverted conditions, off-by-one, unhandled branches.
2. **Edge cases** — empty input, null/undefined, zero length, negative numbers, concurrent calls.
3. **Errors and resources** — swallowed exceptions, unclosed handles, missing timeouts.
4. **Security** — SQL built by concatenation, unescaped input, secrets in code, path traversal.
5. **Consistency** — anything that breaks the conventions this repository already follows.

Style and taste come last, and only when they genuinely hurt readability.

## 4. Verify a finding before reporting it
For each finding, answer yourself: on exactly what input does this break? If you cannot state the scenario, there is no finding — drop it. A false alarm costs more than a missed nit.

## 5. Answer format
For each finding:
- `path:line` — one sentence on what the defect is.
- The concrete failure scenario: what input leads to what outcome.
- The suggested fix, if it is short.

Sort by severity. If you found nothing, say so in one line — do not invent remarks to fill space.
