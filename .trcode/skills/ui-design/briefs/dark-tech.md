# Brief: Dark Tech — luminous, engineered, for developer and AI products

**Fill first:** product · audience · one-sentence promise · primary action · accent colour
· motion level (default: moderate).

**Use for:** a developer tool, an AI product, infrastructure, an API, a CLI — anything
whose buyer reads code. **Not for** consumer retail or anything that must feel warm and
human.

## Mood

A dark room with instruments in it. Near-black surfaces, one luminous accent that behaves
like light rather than paint, hairlines that read as engineering, monospace used as a
material. Terminal blocks, code samples and real numbers instead of adjectives. The page
should look like the product's own UI, not like an ad for it.

## Tokens

```css
:root {
  --canvas:   #08090B;
  --surface:  #0E1013;
  --raised:   #14171C;
  --hairline: #1F242B;
  --hairline-hi: #2C333C;

  --ink:       #E7EAEE;
  --ink-muted: #9AA4B2;
  --ink-faint: #6B7480;

  --accent:    #5B8CFF;          /* or #34D399, #A78BFA — one, and only one */
  --accent-dim:#2B3D6B;
  --glow:      radial-gradient(60% 60% at 50% 0%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 70%);

  --ok: #34D399; --warn: #FBBF24; --danger: #F87171;

  --r-md: 12px; --r-lg: 18px;
  --shadow-lift: 0 20px 60px -20px rgba(0,0,0,.8);
}
```

Light theme is optional here, but if the product has one, define it now: canvas `#FFFFFF`,
surface `#F7F8FA`, hairline `#E4E7EC`, ink `#0B0D10`, same accent.

**Type.** UI: Inter or Geist. Code and labels: JetBrains Mono, Geist Mono or IBM Plex
Mono — used for eyebrows, badges, table headers, version tags, keyboard hints. h1
`clamp(40px, 6.5vw, 76px)`, weight 600, tracking `-0.03em`. Body 16px/1.6 in `--ink-muted`,
never in full `--ink` — reserve maximum contrast for headings and numbers.

**Texture.** Two allowed, both nearly invisible: a 32px grid,
`linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px)` both axes, masked to fade
out; and a 3–5% noise overlay. Never both at full strength, never a third.

**Depth.** Elevation comes from a lighter surface plus a hairline, not from a shadow.
Shadows appear only under things that genuinely float.

## Layout

Container 1200px. Nav sticky with blur. Hero centred; everything below on a left-aligned
grid.

1. **Nav** — logo, docs, pricing, changelog, GitHub star count (real), one solid CTA.
2. **Hero** — a monospace status chip (`v2.4 — SOC 2`), h1 of ≤ 8 words, one lead line, a
   primary CTA and a copyable install command (`npm i …` with a copy button that actually
   copies), and a glow behind it all. Under it: a terminal or an app screenshot with a
   hairline frame and a real caret.
3. **Proof strip** — three numbers with monospace units, hairline-separated.
4. **How it works** — three or four steps, each with a real code snippet, syntax
   highlighted, tabs if there is more than one language.
5. **Feature grid** — 2×3 bento of unequal cells; each cell one idea plus one small live
   thing (a chart, a diff, a log line). Cells get a gradient border on hover.
6. **Comparison or benchmark** — a real table with tabular numbers, the honest row
   included.
7. **Docs / quickstart** — a dark code block that is copy-pasteable, ≤ 12 lines.
8. **Pricing** — usage-based tiers with a slider or calculator if that is the model.
9. **Closing CTA** — the install command again, larger.
10. **Footer** — dense, four columns, status badge, tiny version and commit link.

## Motion — moderate

Follow `motion.md`; specifics here:

- **Glow**: the hero radial drifts 3–4% of viewport width over 24s, ease-in-out, infinite,
  paused when the tab is hidden. It never pulses in brightness — that reads as a heartbeat
  and cheapens it.
- **Grid**: parallax at ≤ 10% of scroll distance, transform only.
- **Hero sequence**: chip → h1 (word stagger 30ms) → lead → CTA row → screenshot, total
  ≤ 900ms; the terminal then types one line at 22ms per character, once, and stops with a
  blinking caret at 1.06s. No looping typewriter — it is a page, not a screensaver.
- **Bento cells**: on hover a 1px conic gradient border rotates once over 1.4s and the cell
  lifts 2px. Only the hovered cell reacts.
- **Code blocks**: tab switch crossfades 200ms with the height animated by FLIP; the copy
  button swaps to a check for 1.2s.
- **Numbers**: count up once, tabular, 800ms.
- **Scroll reveals**: 16px rise, 560ms, once, stagger 60ms inside a group.
- **Charts / logs**: data draws left-to-right over 600ms on first view; live rows slide in
  160ms and flash their background 220ms.

## Signature detail

One, repeated: the monospace eyebrow with a leading slash (`/ how it works`); or a hairline
that becomes an accent gradient exactly where the pointer is; or every section numbered
`§01`. Repetition is what turns a trick into an identity.

## Anti-patterns

- Purple→pink gradient text on the h1. The most-generated look on the internet.
- Glowing borders on everything at once, so nothing is emphasised.
- A looping typewriter effect, a fake terminal running invented commands, or code samples
  that would not compile.
- Neon on a pure black `#000` — use `#08090B` and a real ramp, or the page vibrates.
- Cards with 24px blur shadows on a dark background: shadows are invisible in the dark and
  only muddy the edges.
- Star counts, benchmarks or logos that are not real.

## Paste this

> Design and build a dark, engineered marketing site for **[product]**, aimed at
> developers building **[audience use case]**. Promise: **[one sentence]**. Primary action:
> **[action]**.
>
> System: canvas #08090B, surface #0E1013, raised #14171C, hairline #1F242B, ink #E7EAEE,
> muted #9AA4B2, one accent **[hex]** treated as light — used for the hero glow, focus
> rings, links and one CTA, never as gradient text. Inter for UI, JetBrains Mono for
> eyebrows, badges, table headers and all code. h1 clamp(40px, 6.5vw, 76px), weight 600,
> tracking -0.03em; body 16px/1.6 in the muted ink. Elevation from surface + hairline, not
> shadows. Two textures only: a 32px grid at 3.5% white, mask-faded, and 4% noise.
>
> Sections: sticky blurred nav with a real GitHub star count → hero (monospace version
> chip, ≤8-word h1, one lead line, CTA plus a working copy-to-clipboard install command,
> radial accent glow behind) → terminal/app screenshot in a hairline frame → three
> monospace metrics → three steps each with a real syntax-highlighted snippet and language
> tabs → 2×3 bento grid of unequal cells, each with one small live element → an honest
> benchmark table with tabular numbers → a ≤12-line copyable quickstart → usage-based
> pricing → closing CTA repeating the install command → dense footer with a status badge.
>
> Motion, moderate and mechanical rather than playful: hero sequence under 900ms (chip →
> word-staggered h1 → lead → CTAs → screenshot); the terminal types one line once at 22ms
> per character and stops with a blinking caret, no loop; the hero glow drifts 3–4% over
> 24s and pauses when the tab is hidden, never pulsing in brightness; the grid parallaxes
> ≤10%; bento cells rotate a 1px conic gradient border over 1.4s on hover and lift 2px, one
> at a time; code tabs crossfade 200ms with FLIP height; metrics count up once; charts draw
> over 600ms on first view; scroll reveals rise 16px in 560ms on cubic-bezier(.16,1,.3,1),
> once. transform and opacity only, 60fps, prefers-reduced-motion keeps every state change
> and drops the movement.
>
> Ban: gradient text on headings, glowing borders everywhere, looping typewriters, fake
> terminals or invented benchmarks, pure #000 backgrounds, blurred drop shadows on dark
> surfaces, more than one accent hue.
