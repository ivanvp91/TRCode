---
name: game-designer
description: Design and build a game as a full product, step by step — concept and core loop, a one-page design doc, mechanics and balancing, levels, art direction with actual graphics drawn in code (SVG / canvas sprites / pixel art), juice, sound, and a playable build. Use for "придумай игру", "сделай игру", game concepts, prototypes.
description_ru: Спроектировать и собрать игру как полный продукт, пошагово — концепция и core loop, одностраничный дизайн-док, механики и баланс, уровни, арт-направление с отрисовкой графики кодом (SVG / canvas-спрайты / пиксель-арт), сочность, звук и играбельный билд. Для «придумай игру», «сделай игру», концептов и прототипов.
triggers: игра, игру, игры, game, гейм-дизайн, гейм дизайн, game design, геймплей, gameplay, геймдев, gamedev, дизайн игры, концепция игры, прототип игры, game loop, core loop, платформер, platformer, аркада, arcade, головоломка, puzzle game, спрайт, sprite, пиксель-арт, pixel art, левел-дизайн, level design, unity, godot, phaser, unreal, gdd
---

# Game designer: from concept to playable product

## 0. Scope before dreaming
Pin down in one exchange: platform and tech (default when unstated: a **single-file HTML5/canvas game** — it runs anywhere and needs no install), scale (jam-size prototype vs. finished product), and who plays it (kids / casual / core — this drives difficulty, theme, and reading speed). Everything below scales to that answer.

## 1. Concept: the loop is the game
Before any art or code, write and confirm:
- **Pitch** in one sentence: the player fantasy plus the core verb ("you are a lightning bolt dodging clouds to charge a city").
- **Core loop** (the 30-second cycle): act → risk/obstacle → reward → stronger/deeper → act again. If the loop isn't fun in words, it won't be fun in code.
- **2–3 design pillars** — adjectives every later decision is tested against ("fast, readable, one-more-try"). A feature that serves no pillar is cut.
- **First 60 seconds**: what the player sees, presses, and feels before any menu matters.

## 2. GDD-lite: one page, not forty
A short design doc the user confirms before the build: mechanics list with the core verb first; controls (keys/touch); win/lose conditions; progression (what changes run to run); enemies/obstacles with one-line behaviours; scope split — **MVP list vs. "later" list**. Cutting to MVP here is the step that makes the project finish.

## 3. Mechanics and balance
- One deep core verb beats five shallow ones; depth comes from combining the verb with situations, not adding buttons.
- Every tunable (speeds, spawn rates, HP, timers, scores) lives in **one config block/table at the top of the code**, never scattered as magic numbers — balancing is editing that table.
- Difficulty is a curve, not a constant: state how it ramps (time, waves, levels) and what relieves it (pickups, checkpoints).
- Risk/reward in every choice: the safe path scores less; the greedy path threatens the run.

## 4. Levels and progression
Design each level (or wave band) as **teach → test → twist**: introduce the element safely, test it under pressure, then combine it with a known one. The first level is a tutorial without words — geometry teaches. Pace intensity like a wave: spike, breathe, bigger spike; end sessions on a near-miss or a new unlock so "one more try" is automatic.

## 5. Art direction and drawing the graphics
The graphics are produced, not described — drawn in code as inline SVG, canvas-drawn sprites, or generated pixel art:
- Pick **one named style** the chosen tech can execute crisply: flat geometric vector, chunky pixel art (fixed grid, e.g. 16×16, drawn via canvas `fillRect` runs), neon glow on dark, or paper/flat-shadow. Commit fully; mixed styles read as broken.
- **Fixed palette of 4–8 colours** declared as constants; background lowest contrast, player highest, hazards one reserved colour never used for anything else.
- **Readability beats richness**: player, enemy, pickup, and hazard must be distinct by silhouette alone at gameplay speed. Squint test: shapes still identifiable.
- One light direction if shading exists; consistent outline rule (all sprites outlined or none).
- Animation is cheap and mandatory: 2–6 frames or transform-based squash-and-stretch on jump/land/hit; idle bobbing on anything alive. A static screen reads as a mockup, not a game.

## 6. Juice: the difference between demo and game
Every player action gets an immediate reaction: hit-stop (30–80 ms freeze) on impact, screen shake scaled to force, particles on destroy/collect, easing on all movement (never linear UI), score numbers that fly, a death that is loud and a restart that is instant (&lt; 1 s, one key). Sound via WebAudio-generated bleeps is enough — silence is the only wrong choice.

## 7. Build order: playable at every step
Ship the build in increments, each one runnable:
1. Scene + player moving with final-feel controls (tune acceleration/friction *now*).
2. Core verb + one obstacle/enemy → the loop exists.
3. Lose and win states + restart.
4. Juice pass (hit-stop, shake, particles, sound).
5. Score/UI/menu + pause.
6. Content: levels/waves/enemy variety from the GDD list.
7. Polish: difficulty tuning from the config table, edge cases (pause during death, resize, refocus).
Never advance a step while the previous one feels bad — feel bugs compound.

## 8. Playtest honestly
State how to test each build: what to try, what should feel good, known rough edges. Watch for the classic lies: too hard for anyone but its author (halve difficulty for the first minute), unclear goal (a stranger must know what to do in 10 seconds), unfair deaths (hitboxes smaller than sprites, never bigger).

## What not to do
- No scope creep into the prototype: multiplayer, open worlds, save systems and meta-progression live on the "later" list until the core loop is proven fun.
- No walls of settings/menus before the game is fun.
- Do not describe graphics that aren't drawn, or leave placeholder rectangles in a "finished" step — every increment looks like its art direction.
- Do not bury tuning constants in logic code.
- Do not call it done untested: play the failure paths, not just the happy run.

## Answer format
1. Pitch, core loop, and pillars (confirm before building).
2. The one-page GDD-lite with the MVP/later split.
3. Then per build step: what was added, the full runnable code, controls, and what to feel-test.
4. The config table location and the 3 values most worth tuning first.
