---
name: web-artifacts-builder
description: Build a complex, multi-component single-file HTML artifact or standalone web page — React or vanilla JS with Tailwind utility classes, multiple components, state, charts, and interactions, all in one self-contained .html file that opens in a browser with no build step. Use for "собери страницу/прототип/дашборд одним файлом", "make me an HTML artifact", interactive mockups, demos, calculators, visualizations.
description_ru: Собрать сложный много-компонентный HTML-артефакт или автономную страницу — React или ванильный JS с Tailwind-классами, несколько компонентов, состояние, графики и интерактив, всё в одном самодостаточном .html файле, который открывается в браузере без сборки. Для «собери страницу/прототип/дашборд одним файлом», интерактивных мокапов, демо, калькуляторов, визуализаций.
triggers: html артефакт, artifact, одним файлом, single file, самодостаточная страница, standalone html, прототип страницы, interactive prototype, react страница, tailwind страница, одностраничник, html page, собери html, сделай страницу, интерактивный мокап, no build step, без сборки
---

# Building single-file web artifacts

## 1. Confirm the shape before writing
A single-file artifact means: one `.html` file, everything inline — markup, styles (Tailwind via CDN or a `<style>` block), scripts, data. No imports from local files, no build step, no server; double-clicking the file must work. If the user asked for a real project (components in files, a repo), that is `ui-design` + normal development, not an artifact — say so.

## 2. Structure the file
```
<!DOCTYPE html>
<html>
<head>
  meta viewport, title
  Tailwind CDN (or <style> with hand-written tokens)
  fonts via Google Fonts link (max 2 families)
</head>
<body>
  <div id="root"></div>
  <script type="module">
    // React via esm.sh CDN, or plain vanilla JS
  </script>
</body>
```
- **React when there is real state** (forms, filters, multi-step flows): `react` + `react-dom` from `esm.sh`, `h` via `React.createElement` or inline `htm` — no JSX compiler in the browser.
- **Vanilla JS when it is mostly static with light interactivity** — less weight, no framework needed.
- Charts: inline SVG hand-built for simple ones; a CDN (Chart.js, D3) only when the user asked for that kind of chart.

## 3. Design like it is a designed page
An artifact is judged as a product, not a demo: apply the ui-design system (spacing scale, type hierarchy, one accent, states) and the frontend-design taste (no default-template look). Dark mode if the genre calls for it, defined as CSS variables up front. Every interactive element gets hover/focus/disabled even in a prototype — dead-looking controls read as broken.

## 4. Data and state
- Seed with realistic sample data inline (a `const DATA = [...]` block) — never `lorem ipsum`, never empty shells. The data should tell the story the artifact is about.
- All client-side: no API keys, no calls to authenticated services. If live data is needed, say so — an artifact can mock it and mark where the real call plugs in.
- Keep state minimal and local; `useState` per concern, not one global object.

## 5. Make it runnable, then verify
- Write the file, then actually open it (or `npx playwright screenshot file.html out.png` and view the screenshot) — a broken CDN link or a JS error leaves a blank page, and the user will find it before you do if you don't.
- Check the console path: no external resource may 404. Prefer pinned CDN versions over `@latest`.

## What not to do
- No build-step constructs: JSX without a transpiler, TS, npm imports, local module files, tailwind.config.
- No placeholder sections ("Chart goes here") — ship the chart or cut the section.
- No 3000-line monolith of dead code: cut what the ask didn't require; an artifact is a focused deliverable.
- Do not fetch remote data at render time silently — offline opening must still render with the seed data.

## Answer format
The file path, then one line per major component ("what it does, what state it holds"), then how it was verified (opened/screenshot), then what to swap for real data in production.
