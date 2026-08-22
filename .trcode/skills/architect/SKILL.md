---
name: architect
description: Plan an implementation before coding — decompose a feature or system into steps, choose the approach among alternatives, name affected files and risks. Use for "как это реализовать", "спроектируй", non-trivial features, refactors touching many files, or when the user asks for a plan first.
description_ru: Спланировать реализацию до кода — разложить фичу или систему на шаги, выбрать подход из альтернатив, назвать затрагиваемые файлы и риски. Для «как это реализовать», «спроектируй», нетривиальных фич, рефакторингов на много файлов и когда просят сначала план.
triggers: архитектура, architecture, спроектируй, спроектировать, план реализации, implementation plan, как реализовать, как лучше сделать, декомпозиция, продумай, дизайн системы, system design, подход, tradeoff, компромиссы, структура проекта, roadmap реализации
---

# Architect: plan before code

## 1. Read before you plan
A plan written from imagination fails on contact with the repo. Before proposing anything: find how similar things are already done here (the pattern to copy), what utilities exist (the code NOT to write), and where the change must plug in. Name the files you read — the plan's credibility comes from them.

## 2. Restate the problem
One paragraph: what must become possible, for whom, and how we'll know it works. If requirements are ambiguous in a way that changes the design, ask now — one question at plan time saves a rewrite at code time. Distinguish the actual requirement from the user's proposed solution; sometimes a simpler mechanism serves the same need.

## 3. Consider 2–3 approaches, recommend one
For a non-trivial task, sketch the realistic alternatives in 2–4 lines each: what it touches, what it costs, what breaks it. Then commit to one with the reason ("Б проще и повторяет паттерн из X.ts; А быстрее в рантайме, но тянет новую зависимость"). No option surveys without a verdict — the deliverable is a decision, not a menu.

## 4. The plan itself
Steps in build order, each one: what changes, in which files, and how to verify it before moving on. Good plans have:
- **Vertical slices**: something runnable after each step, not "all models, then all logic, then all UI".
- **The risky bit first**: the unproven integration or algorithm goes in step 1–2, while abandoning is cheap.
- **Named reuse**: "use `existing_helper()` from utils" beats "write a helper".
- **Explicit non-goals**: what this change deliberately does not cover, so scope doesn't creep silently.
- **Migration/compat notes** when data formats, APIs, or stored state change: what happens to existing data, is rollback possible.

## 5. Size the plan to the task
A one-file change needs three bullets, not a document. A cross-cutting refactor needs the full treatment plus a "how to land it in reviewable pieces" note. If the plan exceeds ~10 steps, the task wants splitting into independently shippable stages — say where to cut.

## What not to do
- No plans from memory of the codebase — only from files actually read this session.
- No "step 1: create the architecture" vagueness — every step names files and verifiable outcomes.
- No gold-plating: don't design for imagined future requirements the user didn't state.
- Don't start implementing when the user asked for a plan; don't keep planning when the plan is approved.

## Answer format
1. The problem restated (short), and what was read to ground the plan.
2. Approaches considered with the recommendation and reason.
3. Numbered steps: files → change → verification, risky-first, vertically sliced.
4. Non-goals, risks, and open questions (if any genuinely block).
