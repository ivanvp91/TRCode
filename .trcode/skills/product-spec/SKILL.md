---
name: product-spec
description: Turn a vague idea into something buildable — a PRD, feature spec, scoped MVP or ticket breakdown. Use when asked "how should we build X", to write requirements, or when a request is too fuzzy to start coding.
description_ru: Превратить смутную идею в то, что можно построить — PRD, спецификацию фичи, MVP с границами, разбивку на задачи. Когда спрашивают «как нам сделать X», просят написать требования, или запрос слишком расплывчат, чтобы начинать код.
triggers: спека, спецификация, spec, prd, требования, requirements, техзадание, user story, юзер стори, mvp, скоуп, scope, разбей на задачи, break down, тикеты, tickets, бэклог, backlog
---

# Product spec

## 1. Nail the problem before the solution
Write: who has the problem, how often, what they do today, and what it costs them. If you cannot answer these, the spec is premature — ask. A spec that opens with a solution hides the fact that nobody checked the problem exists.

## 2. Define done
- **Goal**: one sentence.
- **Success metric**: the number that moves, and by how much.
- **Non-goals**: what this explicitly does not do. This section prevents more waste than any other.

## 3. Describe behaviour, not implementation
User stories or plain flows: trigger → steps → outcome. Cover the main path first, then:
- empty / first-run state,
- error and failure paths (offline, permission denied, invalid input),
- limits (rate, size, quantity) and what happens at the limit,
- permissions: who can see and do what,
- what happens to existing data and existing users (migration, backwards compatibility).

Leave the *how* to whoever builds it, unless a technical constraint is part of the requirement.

## 4. Scope honestly
Split into **must / should / later**. The "must" set is the smallest thing that delivers the outcome end to end — a thin slice all the way through, not half of every layer. If everything is a must, the scope is wrong.

## 5. Open questions
List every decision you could not make, with who must decide it and by when. An unmarked assumption is what gets rebuilt later.

## 6. Break it into work
Tickets that are independently shippable, each with a title, one-line goal, and acceptance criteria written as checkable statements ("returns 400 with `invalid_range` when `to` < `from`"). Note dependencies and order.

## What not to do
- No requirements phrased as "fast", "intuitive", "robust" — give the number or the check.
- Do not design the UI in the spec beyond what the behaviour requires.
- Do not silently expand scope; propose additions as separate "later" items.
- Do not skip non-goals and open questions to look decisive.

## Answer format
Problem → Goal & metric → Non-goals → Flows (with edge cases) → Scope (must/should/later) → Open questions → Tickets with acceptance criteria. One page for a feature, two for a product.
