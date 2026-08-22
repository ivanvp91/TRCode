# Motion system

Shared by every brief. A brief overrides a number here only when it says so.

## 1. What earns an animation

Motion explains a change of state. Four legitimate jobs:

- **Arrival** — something entered the viewport or the DOM.
- **Response** — the interface acknowledged a pointer, a key, a submit.
- **Continuity** — the same object moved, resized or changed place; the eye follows it
  instead of re-finding it.
- **Waiting** — work is in progress and the wait has a shape.

Anything else is decoration and gets cut. "It looks more alive" is not a job.

## 2. Timing scale

One scale, used everywhere. Slower is not more premium; slow is what a page feels like
when it is fighting you.

| Token | ms | Used for |
|---|---|---|
| `--t-micro` | 120 | hover, press, focus ring, colour change |
| `--t-fast` | 200 | tooltip, dropdown, small fade/slide, toggle |
| `--t-base` | 320 | modal, drawer, tab panel, accordion, layout shift |
| `--t-slow` | 560 | scroll reveal of a section, image reveal |
| `--t-hero` | 900 | the opening sequence of the hero, once per session |

Exit is always faster than entrance — roughly 0.7× — because leaving needs no explanation.

## 3. Easing

```css
--ease-out:   cubic-bezier(.16, 1, .3, 1);    /* entrances, reveals — decisive, no bounce */
--ease-in-out:cubic-bezier(.4, 0, .2, 1);     /* movement between two known places */
--ease-in:    cubic-bezier(.7, 0, .84, 0);    /* exits, dismissals */
```

Never `linear` except for continuous loops (marquee, shimmer, orbit). Never `ease` — the
CSS default is the shape of a 2010 page. Springs only where the user drags: Motion
`{ type: "spring", stiffness: 260, damping: 30, mass: 0.9 }`.

## 4. What may be animated

`transform` and `opacity`. Also `filter` and `clip-path` sparingly, and colour on small
areas. Never `width`, `height`, `top/left`, `margin` — they relayout every frame; use
`transform: scale()` / `translate()`, or FLIP (`layout` in Motion, `view-transition-name`
in CSS). Never animate `box-shadow` directly: put the shadow on a pseudo-element and
animate its opacity.

Budget: ≤ 10 simultaneously animating elements, ≤ 3 distinct entrance patterns per page,
each element animates once. Hold 60fps on a mid-range laptop — if a scroll effect drops
frames, it is deleted, not optimised twice.

## 5. Patterns

**Scroll reveal.** `opacity: 0 → 1`, `translateY: 16px → 0`, `--t-slow`, `--ease-out`,
fired at 20% visibility, **once**. Repeating on every scroll-back reads as a demo reel.
Children stagger 60–80ms, capped at 6 items — a 20-item stagger is a loading bar.

**Hero.** One sequence, ≤ 900ms total: headline in (word stagger 30ms), sub 80ms later,
CTA 120ms after that, visual last. The hero must be legible in the HTML before JS runs —
animation enhances a painted page, it never gates it. No entrance animation on anything
above the fold that the user could already be reading.

**Hover / press.** Card lift `translateY(-2px)` + shadow step, `--t-micro`. Scale ≤ 1.02
for cards, ≤ 1.05 for icons. Press: `scale(.98)`, 80ms. Touch devices get the pressed
state, not the hover one (`@media (hover: hover)`).

**Focus.** A visible ring, 2px, offset 2px, in the accent — instant, never faded in, never
`outline: none` without a replacement.

**Page / route transition.** 200–260ms crossfade plus 8px rise. Use the View Transitions
API where available, `AnimatePresence` in React. Anything longer makes navigation feel
broken.

**Layout change.** When an item is added, removed or reordered, animate the neighbours
with FLIP at `--t-base`. A list that jumps loses the user's place.

**Numbers.** Count up over 800ms `--ease-out` with `font-variant-numeric: tabular-nums`,
once, only for headline stats. Live values flash their background for 220ms instead.

**Waiting.** No spinner for waits under 300ms — show nothing. Beyond that, a skeleton in
the shape of the content, shimmer 1.2s `linear` infinite. Beyond 3s, say what is happening
in words. Optimistic UI beats every loading animation.

**Text.** Word-level stagger, never letter-level for anything longer than 4 words, and
only on the one hero line. Never animate body copy — it is there to be read.

**Ambient.** Slow, non-repeating-looking, ≤ 20s cycles, low contrast: a drifting gradient
glow, a grid parallax at ≤ 12% displacement, a noise overlay. If it draws the eye during
reading, it is too strong. Pause when `document.hidden`.

## 6. Scroll

Prefer native: `animation-timeline: view()` / `scroll()` for reveals and progress bars,
`position: sticky` for pinning, IntersectionObserver as the fallback. Reach for
GSAP + ScrollTrigger only for genuine choreography (pinned sequences, horizontal
sections). Smooth-scroll libraries (Lenis) are a taste, not a default — they break
find-in-page and native anchors; use one only on a marketing page, never in an app.

Parallax: ≤ 12% displacement, never on text, never on anything clickable.

## 7. Reduced motion, always

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Then restore the *information*: elements still appear (opacity ≤ 150ms), state still
changes, loading is still visible. Reduced motion means no vestibular triggers — parallax,
large translations, scale, spin — not a dead interface. Autoplaying video and ambient
loops stop entirely.

## 8. The check before shipping

- Every animation names its job (arrival / response / continuity / waiting).
- Nothing above the fold waits on JS to become readable.
- Scroll reveals fire once, and the page is complete with JS disabled.
- Reduced motion tested by actually turning it on.
- 60fps while scrolling the whole page, on a laptop, with the profiler open.
- Keyboard: every hover affordance has a focus equivalent.
- Nothing bounces. Overshoot on a marketing hero is a choice; overshoot on a button is a toy.
