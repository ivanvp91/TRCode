---
name: design-critique
description: Review an existing interface, screenshot, mockup or page and say what to change — when asked "how does this look", "improve this design", "what's wrong with this screen". For evaluating, not for building from scratch.
description_ru: Разобрать существующий интерфейс, скриншот, макет или страницу и сказать, что менять — когда спрашивают «как это выглядит», «улучши дизайн», «что не так с этим экраном». Для оценки, а не для создания с нуля.
triggers: критика, оцени дизайн, посмотри дизайн, design review, ревью дизайна, что не так с интерфейсом, улучшить дизайн, improve the design, мокап, mockup, юзабилити, usability
---

# Design critique

## 1. Establish the intent first
Ask, or infer and state: what is this screen for, and what should the user do here? Critique without intent is just preference. If the goal is unclear, that is itself the first finding.

## 2. Look in this order
1. **Squint test** — blur the details mentally: does one element dominate? If everything has equal weight, the hierarchy is broken and nothing else matters yet.
2. **Reading path** — where does the eye go first, second, third? Does that match the intended action?
3. **Grouping and spacing** — is related content closer to each other than to unrelated content? Inconsistent gaps are the most common defect.
4. **Alignment** — pick a vertical line and check what breaks it.
5. **Type** — how many sizes/weights are in play? Is body text ≥ 14–16px with a comfortable line-height and measure?
6. **Colour** — how many accents compete? Does the primary action own the strongest colour?
7. **States and edges** — empty, loading, error, long strings, tiny screens, dark mode.
8. **Accessibility** — contrast, focus rings, target size, colour-only meaning.
9. **Copy** — labels that say what happens (`Create project`, not `Submit`), no jargon, no truncation mid-word.

## 3. Rank by impact
Sort findings into: **blocks the task** → **costs comprehension** → **polish**. Three real problems fixed beat twenty listed. Nits go in one collapsed line at the end.

## 4. Every finding gets a fix
"Feels cluttered" is not actionable. "Gap between the header and the table is 8px, same as inside the table — raise to 24px so the header reads as separate" is. Give the concrete value: the size, the token, the reorder.

## What not to do
- Do not restyle to your own taste when the product already has a design system — inconsistency with it is the finding.
- Do not invent problems to fill the list.
- Do not comment on things the user cannot change (brand colour, platform chrome) unless asked.
- Do not confuse "different from what I would do" with "wrong".

## Answer format
- **Verdict** — one or two sentences: does the screen do its job?
- **Fix first** — up to 3 items, each with the concrete change.
- **Then** — the rest, ranked, one line each.
- **Nits** — a single line.
Reference elements by their visible label or position so the reader knows what you mean.
