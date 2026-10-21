---
name: webapp-testing
description: Test a running web app in a real browser — end-to-end flows, form submission, navigation, screenshots, console errors — using Playwright from the shell. Use for "протестируй сайт/приложение", "check the page works", e2e scenarios, reproducing a UI bug, verifying a deployed build, taking screenshots of pages.
description_ru: Протестировать работающее веб-приложение в реальном браузере — end-to-end сценарии, формы, навигация, скриншоты, ошибки консоли — через Playwright из шелла. Для «протестируй сайт/приложение», e2e-сценариев, воспроизведения UI-бага, проверки собранного билда, скриншотов страниц.
triggers: playwright, e2e, е2е, протестируй сайт, протестируй приложение, test the website, проверь страницу, браузерный тест, browser test, скриншот страницы, screenshot of the page, открой страницу и проверь, click through, прогони сценарий, ui test, консольные ошибки, console errors, не открывается страница
---

# Testing a web app with Playwright

## 1. Decide what "works" means for this ask
Name the flows to verify before writing anything ("login → create item → see it in the list", "the page renders without console errors"). A test without an assertion of the expected outcome just exercises the network. If the app is not running, start it first (its dev command, in the background) and use the URL it prints; if only a static file, open the file directly.

## 2. Prefer the runner the project already has
- Existing Playwright config (`playwright.config.*`, a `test:e2e` script) → write specs into that suite and run it; do not invent a parallel setup.
- No suite → drive the browser from a one-off script with `playwright` (installed, or `npx playwright`): `chromium.launch()`, a page, the steps, assertions, screenshots. `npx playwright install chromium` when the browser is missing.
- Pure "look at it" ask → `npx playwright screenshot <url> out.png` and read the image.

## 3. Write steps the way a user would, assert what the user would see
- Locate by role/label/text (`getByRole`, `getByLabel`, `getByText`), not CSS selectors — they survive refactors and double as an accessibility check.
- Assert against visible user-visible state: the text shown, the URL, the element that appeared. Not internal state, not `waitForTimeout` — use `expect(locator).toBeVisible()` and auto-waiting.
- Capture the console (`page.on('console')`, `page.on('pageerror')`) — a silent red console is a failing page even when pixels look right.

## 4. Screenshot what matters
On any failure, screenshot the page at that moment (`fullPage` for layout) — the image is the bug report. For visual verification of a fix, take before/after and compare. Never claim "looks right" without having looked.

## 5. Report in user terms
What was tested (the flows), what passed, what failed with the evidence (screenshot path, console excerpt, the assertion that broke), and — if a bug was found — the smallest repro steps for it.

## What not to do
- No sleeps as synchronization; no flaky selectors (`div:nth-child(3) > span`) when a role/label exists.
- Do not mock the backend into meaninglessness in an e2e — mock only external services and flaky third parties; if the ask is unit-level, that is `writing-tests`, not this.
- Do not leave the started dev server running without saying so.
- Do not assert pixel-perfection from code — open the screenshot.

## Answer format
Flows tested → per flow: pass/fail with the evidence (screenshot path, console errors, failing assertion) → smallest repro for any bug found → what was not covered.
