# Stack and how to drive a builder with a brief

Everything here is free. The paid asset libraries are curation on top of exactly this.

## Base

| Layer | Choice | Why this one |
|---|---|---|
| Styling | Tailwind CSS v4 | every model writes it fluently; tokens live in `@theme` |
| Components | shadcn/ui | copied into the repo, not imported — you own and edit the code |
| Motion | `motion` (ex Framer Motion) for React; plain CSS + IntersectionObserver otherwise | declarative, interruptible, respects reduced motion |
| Choreography | GSAP + ScrollTrigger, only for pinned sequences | overkill for a fade; correct for a scene |
| Icons | Lucide | one weight, one grid, no emoji |
| Fonts | Geist / Inter / JetBrains Mono, plus one display face | self-host with `next/font` or `@font-face`, `font-display: swap` |
| Effects | Magic UI, Aceternity UI | free animated blocks; take the code, delete what you do not need |

No-framework version: hand-written CSS with custom properties, `@starting-style` and
`transition-behavior: allow-discrete` for enter/exit, `animation-timeline: view()` for
reveals, View Transitions API for route changes. Zero dependencies, and it is enough for
most marketing pages.

## Tokens first, always

Write the palette, the type scale, the spacing scale and the **timing scale** as custom
properties before any component. A model given tokens produces a coherent page; a model
given adjectives produces the average of its training data.

```css
@theme {
  --color-canvas: #FAFAFB;
  --color-ink:    #0B0D10;
  --color-accent: #1E5AF5;
  --spacing-section: 8rem;
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --t-micro: 120ms; --t-fast: 200ms; --t-base: 320ms; --t-slow: 560ms;
}
```

## Prompting order

The order matters more than the wording — a builder anchors on what it reads first:

1. **Genre and audience** — one line. ("Dark developer tool for backend engineers.")
2. **Tokens** — the actual hex values, families, scales. Paste them.
3. **Structure** — sections in order, one line each, with what each must contain.
4. **Motion** — the specific timings from the brief, not "smooth animations".
5. **Bans** — the anti-patterns list. This does more work than everything above it.
6. **Then** the request itself.

Ask for **one section at a time** on anything real. A whole page in one shot is where
inconsistency comes from: the model runs out of attention around section four and starts
inventing a second design system.

## Reviewing what comes back

Run it against `design-critique` and this list:

- Does it use the tokens, or did it invent hexes? Grep for hex codes not in the brief.
- One accent, or three?
- Is the type scale the one you gave, or five arbitrary sizes?
- Do the animations have jobs (`motion.md` §1), or is everything fading in?
- Does the hero render with JS disabled?
- Reduced motion actually honoured, tested by turning it on?
- Focus rings visible on every interactive element, tab order sane?
- 60fps while scrolling, profiler open?
- Empty, loading and error states present, or only the happy path?

## The tell-tales of a generated page

If you see three or more of these, the brief was not followed:

purple→pink gradient headline · glassmorphism panels · blurred floating blobs · everything
in equal cards with equal shadows · emoji feature icons · centred paragraphs · `ease` and
300ms on everything · stock illustrations of people at desks · "Trusted by" with invented
logos · a looping typewriter · pure `#000` or pure `#FFF` grounds · every element fading in
on scroll, every time it scrolls into view.
