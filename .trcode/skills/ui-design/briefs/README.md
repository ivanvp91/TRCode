# Design briefs

A brief is the part of a design decision that has to be made *before* the first line of
markup and stays fixed afterwards: genre, palette, type, spacing, motion, and the one
detail that keeps the result from looking like every other generated page.

This is what the paid "vibe coding" asset libraries actually sell. It costs nothing to
own: one brief, written once, beats a thousand borrowed prompts, because it is about this
product.

## The rule these briefs exist to enforce

**Modern and animated is the default, not an upgrade.** A static page with no state
transitions reads as unfinished in 2026. But motion is design, not decoration: every
animation has to explain a change — something appeared, something moved, something is
loading, something responded to you. If you cannot say what a transition explains, cut it.

`motion.md` is the shared motion system. Every brief here refers to it and only states
what it does *differently*. `stack.md` is the free toolchain and how to drive an AI
builder with it.

## The briefs

| File | Genre | Motion level |
|---|---|---|
| `minimal-saas.md` | product / SaaS marketing site, light, precise | subtle |
| `dark-tech.md` | AI / developer / infra product, dark, luminous | moderate |
| `editorial-bold.md` | agency, portfolio, brand launch, expressive | high |
| `dense-console.md` | dashboard, trading, admin, monitoring | functional only |

## How to use one

1. **Pick by genre, not by taste.** Section 2 of `SKILL.md` decides the genre; the brief
   only executes it. A console styled as an editorial site is a miss however pretty.
2. **Fill the six blanks** at the top of the brief: product, audience, one-sentence
   promise, primary action, accent colour, motion level.
3. **Keep the tokens.** The hex values and the scales are there so the result is coherent,
   not so they are admired. Change the accent and the fonts; leave the ramps, the spacing
   scale and the timing scale alone until something concrete demands otherwise.
4. **Paste the block at the end of the brief** into the builder (this CLI, Cursor, Claude
   Code, v0, Lovable, Bolt) *above* the actual request. It is written as an instruction to
   a model, not as prose for a human.
5. **Check against `## Anti-patterns` in the brief and section 8 of `motion.md`** before
   calling it done. That checklist is what separates this from a generated template.

## Writing a new brief

Copy the shape of `minimal-saas.md`: mood in one paragraph, then tokens, then layout, then
motion, then the signature detail, then anti-patterns, then the paste block. Concrete
values only — a brief that says "modern colours and smooth animations" has said nothing
and will produce exactly the average of the training data.
