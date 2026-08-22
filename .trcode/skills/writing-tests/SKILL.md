---
name: writing-tests
description: Add or extend automated tests — when asked to cover a function, write a test for a fix, raise coverage, or "check that this works". Also when a change lands with no test at all.
description_ru: Добавить или расширить автотесты — когда просят покрыть функцию, написать тест к исправлению, поднять покрытие, «проверь, что это работает». А также когда изменение приходит вообще без теста.
triggers: тест, тесты, тестов, тестирование, unit test, юнит, test coverage, покрытие, напиши тесты, write tests, vitest, jest, pytest, мок, mock, фикстура, fixture
---

# Writing tests

## 1. Copy the local convention
Before writing a line: find an existing test for something similar. Use the same runner, the same file location and naming, the same assertion style, the same fixture helpers. Check `package.json` scripts / Makefile for how tests are actually run — then run them once to confirm the suite is green to start with.

## 2. Decide what is worth testing
Test the contract, not the implementation:
- The happy path, once.
- The boundaries: empty, one, many, zero, negative, maximum length.
- The error paths: bad input, missing file, rejected promise, timeout.
- The bug you just fixed — a test that fails on the old code.

Skip tests that only restate the code (`expect(add(1,1)).toBe(2)` next to `a+b`) and tests that assert on private internals.

## 3. Shape of a good test
- One behaviour per test; the name says the behaviour: `returns null when the config file is missing`.
- Arrange / act / assert, visibly separated.
- No shared mutable state between tests, no dependence on execution order.
- Deterministic: pin time, seed randomness, never hit the real network.
- Assert on the specific value, not merely that something is truthy.

## 4. Mock as little as possible
Prefer real objects and temp directories over mocks. Mock only what is slow, external, or non-deterministic. A test that mocks the thing under test proves nothing.

## 5. Verify the test is real
Break the production code on purpose (or check out the pre-fix state) and confirm the new test fails. A test that passes against broken code is worse than no test. Then restore and run the full suite.

## What not to do
- Do not change production code to make it easier to test without saying so.
- Do not chase a coverage number by testing getters.
- Do not leave `.only`, `.skip`, stray console output or committed fixtures nobody reads.

## Answer format
- Which files were added/changed and what each test asserts, in one line each.
- The command to run them, with its actual output.
- Gaps you left uncovered and why.
