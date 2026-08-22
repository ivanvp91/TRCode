# Brief: Editorial Bold — display type, real motion, a page with a point of view

**Fill first:** brand · audience · one-sentence promise · primary action · accent colour ·
motion level (default: high).

**Use for:** an agency site, a portfolio, a brand or product launch, a manifesto page, a
conference. **Not for** anything a user has to work in every day, and not for a product
whose buyer is risk-averse — this style trades trust signals for personality.

## Mood

A magazine spread that moves. Type is the interface: one enormous display face carrying
the whole hierarchy, a warm paper ground instead of clinical white, an accent used like
ink, and photography or type-as-image doing the rest. Asymmetry on purpose. Space used as
a statement, not as filler.

## Tokens

```css
:root {
  --paper:    #F3F0EA;      /* warm, never #FFF */
  --paper-2:  #E9E5DC;
  --ink:      #121212;
  --ink-soft: #4A4842;
  --hairline: #D6D1C6;
  --accent:   #FF4A1C;      /* vermillion; or #1B4DFF, #0F5132 — one only */
  --invert-bg:#121212;
  --invert-ink:#F3F0EA;

  --r: 0px;                 /* square by default; radius is a different genre */
}
```

**Type.** This is the whole design, so pick deliberately: display — Instrument Serif,
Fraunces, Bricolage Grotesque, PP Editorial-style serif, or a grotesque at weight 800
(Archivo, Anton); text — Inter, Söhne, or a serif at 18px for real reading. Display sizes
`clamp(48px, 11vw, 190px)`, line-height 0.92, tracking `-0.04em`, optical alignment at the
edges (hang the punctuation). Body 18–20px, line-height 1.6, measure 60ch. Never more than
two families.

**Grid.** 12 columns, wide gutters, and content deliberately breaking out of them: a
headline spanning 1–11, an image spanning 7–13 into the bleed, a caption in column 2.
Baseline rhythm of 8px. Full-bleed sections alternating with narrow ones.

**Colour discipline.** Paper, ink, one accent, one inverted section. Photography is
allowed to be the only other colour, and it should be duotone or grain-treated so it
belongs to the palette.

## Layout

1. **Nav** — wordmark and 3 links, or a menu button opening a full-screen overlay with
   huge links. No sticky bar competing with the type.
2. **Hero** — a statement, not a value proposition: 4–8 words at the largest size on the
   page, one line of context, one link with an underline that draws itself. Set the whole
   viewport; do not fear leaving 60% of it empty.
3. **Marquee** — a single line of services, clients or claims, moving slowly, in the
   accent or inverted.
4. **Work / proof** — a list, not a grid: each row a name, a year, a discipline, revealing
   a cropped image on hover next to the cursor.
5. **Manifesto** — one wide paragraph at 24–28px, ragged right, with two words in the
   accent. This is where a reader decides whether they like you.
6. **Detail sections** — alternating full-bleed image and narrow text, captions in
   monospace or small caps.
7. **Numbers** — three facts set in the display face, huge, tabular.
8. **Inverted CTA** — a dark section, one enormous line, one link.
9. **Footer** — contact as a headline, not a form. Email at 48px+. Time zone, availability,
   socials as plain links.

## Motion — high, but choreographed

Follow `motion.md`; this brief spends its budget on entrances rather than on ambience.

- **Hero**: mask reveal — words rise from behind a clip, stagger 60ms, `--t-slow` on
  `--ease-out`. Once. It should feel like a curtain, not a bounce.
- **Section headings**: the same reveal, cheaper (30ms stagger, 420ms).
- **Images**: `clip-path: inset(0 0 100% 0 → 0 0 0 0)` over 700ms with a simultaneous
  `scale(1.06 → 1)` inside the frame. The image never fades in — a clipped reveal reads as
  intent, a fade reads as a slow connection.
- **Marquee**: `linear`, 30–45s per cycle, duplicated content for a seamless loop, pauses
  on hover, direction flips on scroll direction if you want one flourish.
- **Work list**: on hover the row's ink goes to the accent in 120ms and a cropped thumbnail
  follows the pointer with a 0.12 lerp. Touch devices get a static thumbnail instead.
- **Links**: an underline drawing from the left in 200ms; buttons magnetic within 40px,
  displacement capped at 6px, snapping back with a spring.
- **Page transitions**: a paper-coloured panel wipes across in 320ms, content swaps behind
  it, wipes out in 260ms. Anything slower and navigation feels blocked.
- **Scroll**: at most one pinned sequence on the page, ≤ 200vh long, with a visible progress
  indicator. Optional smooth-scroll (Lenis) with `lerp: 0.09` — never in an app, only here.
- **Cursor**: a custom cursor is allowed exactly once, as a small dot that scales over
  interactive elements. It must never replace the system cursor over text or inputs.

## Signature detail

The one thing repeated: hanging punctuation and optically aligned headline edges; or every
section numbered in the accent (`↳ 03`); or a hand-set kerning pass on the wordmark echoed
in every h2. Editorial design is judged on details of exactly this size.

## Anti-patterns

- Display type at 48px calling itself editorial. If the h1 is not uncomfortably large, this
  is the wrong brief.
- Centring everything. Asymmetry is the genre; a centred column is the SaaS brief.
- Motion on every element — when everything animates, the eye stops reading the order.
- A pinned scroll sequence longer than 200vh, or two of them.
- Smooth scroll plus parallax plus a custom cursor plus a page-transition curtain, all at
  once: pick two.
- Pure white background, 12px radii, card shadows — three different genre leaking in.
- Lorem-ipsum-shaped copy. This layout exposes empty writing instantly.

## Paste this

> Design and build an editorial, type-led site for **[brand]**, aimed at **[audience]**.
> Statement: **[one sentence]**. Primary action: **[action]**.
>
> System: warm paper #F3F0EA, ink #121212, hairline #D6D1C6, one accent **[hex]** used like
> ink, one inverted (#121212) section. Two families only: a display face
> (Instrument Serif / Fraunces / Bricolage / Anton) at clamp(48px, 11vw, 190px),
> line-height 0.92, tracking -0.04em, hanging punctuation; and a text face at 18–20px/1.6,
> measure 60ch. Square corners, no card shadows. 12-column grid with deliberate breakouts
> and full-bleed sections alternating with narrow ones; 8px baseline rhythm.
>
> Sections: minimal nav (wordmark, 3 links or a full-screen overlay menu) → full-viewport
> hero of 4–8 enormous words plus one context line and one drawing-underline link, ≥50% of
> the viewport left empty → slow marquee of services or clients → work as a hover-revealing
> list, not a grid → a manifesto paragraph at 24–28px, ragged right, two words in the
> accent → alternating full-bleed image and narrow text with monospace captions → three
> huge tabular numbers → an inverted CTA section with one line and one link → a footer
> where the email is a 48px headline.
>
> Motion, choreographed and once each: hero words rise from behind a clip-path mask,
> stagger 60ms, 560ms on cubic-bezier(.16,1,.3,1); section headings the same at 30ms/420ms;
> images reveal by clip-path inset from the bottom over 700ms with a simultaneous 1.06→1
> scale inside the frame, never a plain fade; marquee runs linear over 30–45s, seamless,
> pausing on hover; work rows shift to the accent in 120ms and a cropped thumbnail trails
> the pointer with a 0.12 lerp (static on touch); links draw an underline from the left in
> 200ms; buttons are magnetic within 40px with displacement capped at 6px; route changes
> wipe a paper panel across in 320ms and out in 260ms; at most one pinned scroll sequence,
> ≤200vh, with a progress indicator. transform, opacity and clip-path only; 60fps;
> prefers-reduced-motion keeps every reveal as a ≤150ms opacity change and removes all
> parallax, magnetism, pinning and the custom cursor.
>
> Ban: centred layouts, pure white backgrounds, rounded cards with shadows, animation on
> every element, more than two of {smooth scroll, parallax, custom cursor, page-transition
> curtain}, and placeholder-shaped copy — write real words.
