# Brief: Minimal SaaS — light, precise, quietly modern

**Fill first:** product · audience · one-sentence promise · primary action · accent colour
· motion level (default: subtle).

**Use for:** a product or SaaS marketing site, a pricing page, a docs landing, a B2B tool
whose buyer needs to trust it in four seconds. **Not for** an agency portfolio (too quiet)
or a data console (too airy).

## Mood

Swiss discipline with 2026 manners: a lot of white, one accent used sparingly, type doing
the hierarchy instead of colour, hairlines instead of shadows. Nothing shouts; the
confidence comes from alignment and restraint. The page should look like it was drawn on a
grid by someone who deleted things.

## Tokens

```css
:root {
  /* surfaces */
  --canvas:    #FAFAFB;
  --surface:   #FFFFFF;
  --raised:    #F4F5F7;
  --hairline:  #E6E8EC;
  /* ink */
  --ink:       #0B0D10;
  --ink-muted: #5A6270;
  --ink-faint: #8B93A1;
  /* accent — replace, keep it single and non-gradient */
  --accent:    #1E5AF5;
  --accent-ink:#FFFFFF;
  --accent-wash:#EEF3FF;
  /* semantic */
  --ok: #0E9F6E;  --warn: #C67C00;  --danger: #D93636;

  --r-sm: 8px; --r-md: 12px; --r-lg: 20px;
  --shadow-1: 0 1px 2px rgba(11,13,16,.06);
  --shadow-2: 0 16px 40px -12px rgba(11,13,16,.14);   /* overlays only */
}
```

**Dark mode** (define now, not later): canvas `#0C0D0F`, surface `#131518`, hairline
`#22262C`, ink `#ECEEF1`, muted `#9AA3B0`, accent stays, accent-wash `#141C33`.

**Type.** UI/body: Inter or Geist. Display: the same family at weight 600 with tracking
`-0.02em` — a second family only if it is a real serif used only for h1/h2 (Instrument
Serif, Fraunces). Scale, fluid: `clamp()` between 14/16 body, 18/20 lead, 28/40 h2,
40/68 h1. Body line-height 1.55, headings 1.08–1.15. Measure 62–70ch.

**Spacing** 4/8/12/16/24/32/48/64/96/128. Section rhythm: 96px mobile, 128px desktop.
**Borders** 1px `--hairline` everywhere; shadows only for things that float above the
page. **Radius** `--r-md` for cards and inputs, `--r-sm` for chips, full for pills.

## Layout

Container 1180px, content column 640–720px for prose. 12-column grid, 24px gutters,
everything snapping to a shared left edge.

1. **Nav** — logo, 4 links, one ghost + one solid CTA. Sticky, transparent over the hero,
   gaining `backdrop-filter: blur(12px)` and a hairline after 40px of scroll.
2. **Hero** — eyebrow chip, h1 of ≤ 9 words, one lead sentence, two CTAs, and a real
   product visual (screenshot in a bezel-less frame with a hairline and `--shadow-2`).
   Never a stock illustration.
3. **Logo row** — grayscale, 40% opacity, one line, no carousel.
4. **How it works** — three steps, numbered, hairline-separated, no cards. Cards for
   everything is what makes a page look generated.
5. **Feature blocks** — two or three alternating text/visual rows, each with one verb-led
   headline and ≤ 25 words.
6. **Proof** — one quote at 24px with a real name and role; metrics as three tabular
   numbers.
7. **Pricing** — 2–3 plans, the recommended one raised by a 1px accent border, not by
   scale; a feature list of ≤ 7 rows.
8. **FAQ** — accordion, 6 questions, first one open.
9. **Closing CTA** — one line, one button, generous space.
10. **Footer** — four columns, hairline top, small print in `--ink-faint`.

## Motion — subtle

Follow `motion.md`; specifics here:

- **Hero**: h1 words stagger 30ms, sub +80ms, CTAs +120ms, visual last with
  `translateY(12px)` and `scale(.985)` over `--t-hero`. Total under 900ms.
- **Sections**: reveal at 20% visibility, `translateY(16px)`, `--t-slow`, once.
- **Nav**: blur + hairline fade in at 40px, `--t-fast`.
- **Cards / rows**: hover lift 2px + hairline turns `--accent` at 30% opacity, `--t-micro`.
- **Buttons**: press `scale(.98)`; solid CTA gets a 1px accent glow ring on hover, no
  gradient sweep.
- **Numbers**: metrics count up once, 800ms, tabular.
- **Accordion**: height via `grid-template-rows: 0fr → 1fr`, `--t-base` — not `max-height`
  with a guessed pixel value.
- Nothing floats, pulses or bobs when idle. The only ambient movement allowed is a very
  slow accent-wash gradient behind the hero, ≥ 20s, ≤ 6% opacity.

## Signature detail

Pick exactly one and repeat it everywhere so the page has a fingerprint: a 1px accent
underline that draws on hover; a small monospace label above every section
(`01 — HOW IT WORKS`); or numerals in a contrasting serif. One detail, used five times,
reads as a system; five details used once read as indecision.

## Anti-patterns

- Purple-to-blue gradient hero, glassmorphism everywhere, floating blurred blobs — the
  three tells of a generated page.
- Everything in cards with equal shadows and equal weight.
- Emoji as feature icons. Stock illustrations of people at desks.
- Centred paragraphs longer than one line.
- Five font sizes, two accents, three radii.
- A "trusted by" row of invented logos.

## Paste this

> Design and build a light, minimal, precisely gridded marketing site for **[product]**,
> aimed at **[audience]**. Promise: **[one sentence]**. Primary action: **[action]**.
>
> System: canvas #FAFAFB, surface #FFFFFF, hairline #E6E8EC, ink #0B0D10, muted #5A6270,
> single accent **[hex]** used only for actions and never as a gradient; semantic
> #0E9F6E / #C67C00 / #D93636. Inter (or Geist), fluid type — body 16px/1.55, h1
> clamp(40px, 6vw, 68px) at tracking -0.02em, measure ≤ 70ch. Spacing scale
> 4/8/12/16/24/32/48/64/96/128, sections 128px apart. 1px hairline borders, no shadows
> except overlays, radius 12px. Define light and dark as CSS custom properties up front.
>
> Sections in order: sticky nav (4 links + 2 CTAs) → hero (eyebrow, ≤9-word h1, one lead
> line, two CTAs, product screenshot in a hairline frame) → grayscale logo row → three
> numbered steps separated by hairlines, not cards → two alternating feature rows → one
> quote plus three tabular metrics → pricing (2–3 plans, recommended marked by a 1px accent
> border only) → 6-question accordion → closing CTA → four-column footer.
>
> Motion, subtle and purposeful: hero words stagger 30ms and finish under 900ms; sections
> reveal once at 20% visibility with opacity + 16px rise over 560ms on
> cubic-bezier(.16,1,.3,1); nav gains blur and a hairline after 40px; cards lift 2px on
> hover in 120ms; buttons press to scale(.98); metrics count up once; accordion animates
> grid-template-rows 0fr→1fr. Animate transform and opacity only, 60fps, nothing idles or
> bounces, and honour prefers-reduced-motion by keeping the state changes and dropping the
> movement. The hero must be readable before any JS runs.
>
> Ban: gradient hero backgrounds, glassmorphism, blurred floating blobs, emoji icons,
> stock illustrations, everything-in-a-card layouts, more than one accent colour.
