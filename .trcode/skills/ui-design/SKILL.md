---
name: ui-design
description: Design or build a user interface — a whole app, website, or client portal, or a single screen, landing page, component, dashboard, form, or a visual refresh of an existing one. Carries ready design briefs (tokens, layout, motion) in briefs/. Use before writing markup or CSS, whenever how it looks, reads and animates matters.
description_ru: Спроектировать или собрать интерфейс — целое приложение, сайт или клиентский портал, либо отдельный экран, лендинг, компонент, дашборд, форму или обновление вида существующего. Содержит готовые дизайн-брифы (токены, композиция, анимация) в briefs/. До написания разметки и CSS, всегда когда важно, как это выглядит, читается и движется.
triggers: дизайн, design, интерфейс, вёрстка, верстка, layout, макет, лендинг, landing, экран, screen, компонент, component, стили, styling, палитра, palette, типографика, typography, дашборд, dashboard, сайт, website, портал, portal, личный кабинет, клиентский портал, client portal, веб-приложение, web app, user interface, анимация, анимации, анимированный, анимировать, motion, микроанимации, микровзаимодействия, transitions, переходы, hover, scroll reveal, параллакс, parallax, дизайн-бриф, бриф, design brief, дизайн-система, design system, токены дизайна, design tokens
---

# UI design

## 1. Before any markup
Answer three things:
- **Who** uses this screen and what single action must they be able to take?
- **What is the primary element?** Exactly one thing per screen wins the eye. Everything else is support.
- **Where does it live** — an existing product (then match its system) or standalone (then define the system below).

## 2. Genre and style direction before system
A product has a genre, and the genre is chosen before any palette. Name the genre, the audience, and the chosen style direction in the first line of the answer — then every visual decision serves it. What reads as "well designed" is genre-relative:
- **Marketing landing / startup site**: expressive is allowed — bold display type, one strong accent, confident hero, generous rhythm. Blandness is the failure mode here.
- **Corporate / SaaS product**: calm, structured, trust-first — restrained palette, familiar patterns, nothing that needs explaining. Playfulness reads as unreliable.
- **Content / editorial / docs**: typography carries everything — reading comfort, measure, hierarchy; chrome recedes.
- **E-commerce / showcase**: the product imagery is the hero; the UI is a quiet frame around it.
- **Expert data-dense tools** (trading, monitoring, admin, analytics): dark or strictly neutral theme, high density, tabular figures, monospace numbers. Density and precision read as professional; airy editorial styling here reads as a cheap template.
- **Creative / games / kids**: personality is the point — vivid color, motion, character; corporate restraint would kill it.

Commit to one named direction (minimal, editorial, brutalist, glassmorphism, neon, corporate…) and push it consistently — one direction done fully beats three blended halfway. The virtues of one genre are defects in another: terminal density on a landing is hostile, landing showmanship in an admin is noise.

**Take the brief that fits the genre and follow it.** `briefs/` next to this file holds ready systems — real hex values, type and spacing scales, section order, a motion spec and a ban list, plus a paste-ready prompt block at the end of each:

| Brief | Genre |
| --- | --- |
| `briefs/minimal-saas.md` | product / SaaS marketing site, light, precise |
| `briefs/dark-tech.md` | AI, developer, infra product — dark and luminous |
| `briefs/editorial-bold.md` | agency, portfolio, brand launch — display type, high motion |
| `briefs/dense-console.md` | dashboard, trading, admin, monitoring |
| `briefs/motion.md` | the shared motion system every brief refers to |
| `briefs/stack.md` | the free toolchain and the prompting order |

A brief replaces improvisation, not judgement: keep its ramps, scales and timings, swap the accent and the fonts for the product's own. If the project already has a visual direction, that direction wins and the brief is only consulted for its motion spec and its ban list.

**Continuity beats novelty**: if the project has earlier mockups or a live product, name their visual direction first and stay inside it. A "fresh concept" means a new composition and new ideas *within* the established genre; switching genre or style direction happens only when the user explicitly asks for it.

## 3. A whole product: structure before pixels
When the ask is an app, a website, or a client portal — not one screen — design top-down. First write a one-line map: every screen and its single job. Ten screens sharing one system beat ten screens designed one by one.
- **Marketing site**: the hero states what the product does in one sentence plus one call to action; sections below answer objections in order — what it is → how it works → proof → price → the CTA again. Navigation is 4–6 items; everything else lives in the footer.
- **Application**: choose the shell once — sidebar for many sections, topbar for few — and never mix. Find the product's core object (order, project, patient, trade) and design its list → detail → edit triad first; every other screen inherits those patterns.
- **Client portal**: the first screen after login answers "what is the state of my stuff" — balance, orders, open tickets — a status view, not a welcome banner. Every frequent task reachable in ≤ 2 clicks from it. Design the unglamorous screens early, portals live or die on them: login/reset/invite, account and settings, notifications, and every empty state ("no invoices yet" with the action to create one). If there are roles, state per screen what a viewer sees versus an admin.

## 4. Set the system, then obey it
Define once, reuse everywhere:
- **Spacing**: one scale, e.g. 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. No arbitrary values in between. Space *between* groups must exceed space *inside* a group — that gap is what creates structure.
- **Type**: 2–3 sizes for body/heading, one family (system stack is fine), line-height ~1.5 for body and ~1.2 for headings, measure 60–75 characters. Weight and size carry hierarchy — not colour.
- **Colour**: one neutral ramp for surfaces and text, one accent for interface actions (buttons, links, selection) and nothing else *decorative*, plus semantic red/amber/green. This disciplines chrome, not data: a dashboard legitimately carries semantic series — P&L green/red, long/short, event categories, chart series — each colour with a fixed meaning, documented once. Reach for the neutral first; six *decorative* hues look accidental, six *semantic* ones look like an instrument.
- **Radius, border, shadow**: one radius, one hairline border colour, at most two elevation levels. Prefer a border over a shadow for separation.

## 5. Layout
Vertical rhythm on one grid. Align to a common left edge; ragged left edges read as broken. Constrain content width (~640px for prose, ~1200px for app shells) instead of letting it span the viewport. Group related controls; separate groups with space before you reach for a divider.

## 6. States are not optional
Every interactive element needs: default, hover, focus-visible (a real visible ring — never `outline: none` alone), active, disabled. Every data view needs: loading, empty, error, and the "one item" and "too many items" cases. The empty state is a design surface: say what goes here and offer the action.

## 7. Accessibility as a constraint, not a pass at the end
- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI borders.
- Never encode meaning in colour alone — pair it with a label or icon.
- Real semantics: `button` for actions, `a` for navigation, labels tied to inputs, headings in order.
- Keyboard-reachable in a sensible order; hit targets ≥ 44px on touch.
- Respect `prefers-reduced-motion` — it removes movement, never the state change itself (section 8).

## 8. Motion is part of the design, not a pass at the end
A static page reads as unfinished. Motion is designed with the layout, in the same tokens, and every animation has one of four jobs: **arrival** (something entered), **response** (the interface acknowledged you), **continuity** (the same thing moved — the eye follows instead of re-finding), **waiting** (work is in progress). If a transition explains none of them, cut it.

The whole system — timing scale, easings, scroll reveals, hero sequences, hover and press, page transitions, loading, ambient movement, reduced motion, the performance budget — is in `briefs/motion.md`; read it before animating anything. The short version:

- One timing scale: 120ms micro · 200ms fast · 320ms base · 560ms reveal · 900ms hero once. Exits ~0.7× their entrance.
- `cubic-bezier(.16,1,.3,1)` for entrances, `cubic-bezier(.4,0,.2,1)` for movement. Never the CSS default `ease`, never `linear` outside a loop.
- `transform` and `opacity` only (plus `clip-path` and `filter` sparingly). Never width/height/top/left; use FLIP or view transitions for layout changes.
- Scroll reveals fire **once**, at ~20% visibility, 16px rise; stagger 60–80ms capped at six items.
- The page must be readable before JS runs, and complete with JS disabled. Motion enhances a painted page.
- ≤ 3 entrance patterns per page, nothing animates twice, 60fps or it gets deleted.
- `prefers-reduced-motion` removes movement and keeps every state change.

Genre sets the budget: a landing may spend it on a hero sequence and image reveals, a console spends it only on value flashes, row inserts and skeletons.

## 9. Responsive and theme
Design the narrow layout first, then let it grow. Use fluid widths and `max-width`, not fixed pixel columns. If the product has dark mode, define both palettes as tokens up front — never a colour that exists only in one theme.

## What not to do
- Do not switch the product's genre for the sake of freshness — an unrequested pivot from dark terminal to light editorial (or corporate to playful) is a miss, not a concept.
- Do not pass off sparseness as elegance in expert tools — for a professional audience, missing data density is a defect.
- Decoration that carries no information: gradient headers, drop shadows on everything, icons for their own sake.
- Placeholder text used as a label.
- Centred long paragraphs; text over busy images.
- Five font sizes and three accents on one screen.
- The generated-page tells: purple→pink gradient headline, glassmorphism, blurred floating blobs, everything in equal cards with equal shadows, emoji as feature icons, `ease` at 300ms on everything, elements re-fading in every time they scroll back into view.
- Motion with no job — idle bobbing, looping typewriters, ambient pulsing that competes with reading, a pinned scroll sequence because it was possible.

## Answer format
For a whole product: the screen map first (one line per screen), then the implementation screen by screen. The implementation (HTML/CSS/component code) uses tokens/variables for the system above — including the timing and easing tokens — plus a short note listing: the brief used (or why none fits), the primary action, the spacing/type/colour scale chosen, what animates and which job each animation does, and which states are covered.
