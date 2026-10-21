---
name: frontend-design
description: Give a web UI a distinctive, opinionated visual identity instead of the generic AI look — bold typography choices, unusual palettes with real contrast, characterful details, motion with intent. Use when a page or component risks looking like every generated template: default Inter on white, three equal cards, purple gradient. Complements the process of ui-design; this one is about taste and identity.
description_ru: Придать веб-интерфейсу характерный, авторский визуальный облик вместо генерического AI-вида — смелая типографика, необычная палитра с настоящим контрастом, характерные детали, анимация с умыслом. Когда страница или компонент рискует выглядеть как шаблон: дефолтный Inter на белом, три равные карточки, фиолетовый градиент. Дополняет процесс ui-design; этот — про вкус и идентичность.
triggers: не шаблонно, авторский дизайн, характерный дизайн, distinctive design, avoid generic, не выглядит как AI, стильно, выразительный дизайн, make it stand out, не дефолтный, не сгенерированный, identity, фирменный стиль, смелый дизайн, bold design, уникальный вид
---

# Frontend design: escape the generic look

## 1. Name the identity before the CSS
Answer in one line: what should this interface feel like and what single design idea carries it ("an instrument panel made of paper", "a print magazine that learned to animate", "terminal luxury"). A concrete idea produces a coherent page; "clean and modern" produces the template.

## 2. The tells of the generic look — banned by default
- Default stack untouched: Inter/Roboto/system-ui, white or `#0f172a` background, one purple or blue accent.
- The purple-to-pink gradient headline, glassmorphism cards, blurred gradient blobs behind the hero.
- Everything as equal-width cards with equal shadows in a 3-column grid.
- Emoji as feature icons; icons at odds with the type's weight and era.
- Rounded-8px-everything; `ease` at 300ms on every transition.
- Centered hero, centered paragraph, centered nothing else.

Each of these may be the *right* choice once — but they arrive in a bundle by default, and the bundle is the tell.

## 3. Typography is the cheapest identity
- Pick a pairing with a reason: a characterful display face (serif, condensed, mono, grotesque) against a quiet body face. One distinctive family used sparingly beats five loaded and ignored.
- Scale with contrast: a display size at 3–4× body reads as authored; 1.3× reads as a document.
- Tune the details: tight tracking on large display sizes, generous line-height in body, tabular figures where numbers align, real small caps or none.
- Measure 60–75 characters; headings tighter (45–60).

## 4. Colour with a point of view
- Build from a real palette decision — near-black warm ink, deep green paper, duotone, an off-white cream — not from the Tailwind ramp defaults. A slightly unusual neutral background (`#faf7f2`, `#101014`) does more than another accent.
- One dominant + one accent used decisively beats five used timidly. Semantic colours stay semantic (dataviz, errors) — identity lives in the surfaces and the accent.
- Contrast is not negotiable: ≥ 4.5:1 body text regardless of how fashion-forward the palette is.

## 5. Composition: asymmetry and hierarchy
- One dominant element per view, sized so hierarchy is obvious from across the room. Equal cards mean nothing was prioritized.
- Vary the grid: a 12-column grid where content breaks it deliberately (a wide image, a pull quote, a sidebar that isn't 1/3).
- Whitespace at the group level carries structure — larger gaps between unlike things than between like ones.
- Deliberate asymmetry (a headline that overlaps an image, an offset list) reads as designed; centred symmetry reads as default.

## 6. Details and motion with intent
- A signature detail: a distinctive border treatment, a custom focus ring, an underline style, a noise texture, a marquee, numbered sections. One idea, applied consistently, is an identity.
- Motion from the ui-design system: entrance, response, continuity, waiting — each animation has a job, transforms/opacity only, `cubic-bezier(.16,1,.3,1)` for entrances. Motion repeats *nothing* on scroll-back and respects `prefers-reduced-motion`.
- States designed, not defaulted: hover that does something meaningful (reveal, shift, invert), focus-visible as part of the identity, empty states written in the product's voice.

## What not to do
- Do not apply "distinctive" to expert tools where density and neutrality are the identity — a trading console wants tabular figures and restraint, not a display serif.
- Do not stack five ideas: one design idea executed fully beats three blended halfway.
- Do not sacrifice readability for style — contrast, measure and hit targets are constraints, not suggestions.
- Do not fight an existing product's established direction; continuity wins over novelty (see ui-design §2).

## Answer format
First the identity line (§1) and the named design idea; then the implementation with tokens/variables for the palette, type scale and timing; then a short note: which default tells were rejected and what replaced each, which family/face carries the identity, what the signature detail is.
