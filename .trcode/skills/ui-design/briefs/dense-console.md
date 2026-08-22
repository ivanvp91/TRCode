# Brief: Dense Console — dashboards, trading, admin, monitoring

**Fill first:** product · operator · the one question the first screen answers · primary
action · semantic colour set · motion level (functional only).

**Use for:** a trading terminal, an analytics dashboard, an admin panel, a monitoring or
ops tool, a client portal's data screens. **Not for** marketing pages — the density that
reads as professional here reads as hostile there.

## Mood

An instrument. The operator looks at this for six hours and knows where everything is
without reading labels. Information per screen is a feature; whitespace is a cost. Chrome
recedes to hairlines, the data carries all the colour, numbers are monospaced and aligned
on the decimal point. Nothing decorative survives.

## Tokens

```css
:root {
  --bg:        #0B0E12;
  --panel:     #111519;
  --panel-2:   #161B21;
  --line:      #1C2229;
  --line-hi:   #2A323B;

  --text:      #D7DEE7;
  --muted:     #8C97A5;
  --faint:     #616C7A;

  --accent:    #4C8DFF;        /* selection, focus, active nav — never data */
  /* data semantics — fixed meanings, documented once, never reused decoratively */
  --up:   #12B981;  --down: #F0533D;  --warn: #E3A008;  --info: #4C8DFF;
  --series-1:#4C8DFF; --series-2:#12B981; --series-3:#C084FC; --series-4:#E3A008; --series-5:#38BDF8;

  --row: 30px;                  /* comfortable 34px, compact 26px — one choice, everywhere */
  --r: 6px;
}
```

Light theme only if operators asked for it: bg `#FFFFFF`, panel `#F7F8FA`, line `#E3E7EC`,
text `#0D1117`, same semantics.

**Type.** UI: Inter at 13px (12px compact, 14px comfortable), line-height 1.35. **All
numbers** in a mono with tabular figures — JetBrains Mono, Geist Mono — or Inter with
`font-variant-numeric: tabular-nums`, right-aligned, decimals aligned. Column headers 11px,
uppercase, tracking `0.06em`, `--faint`. Never a display face anywhere.

**Density rules.** Table row height `--row`, cell padding 8px horizontal / 0 vertical,
1px `--line` between rows only where scanning needs it (or zebra at 2% white, not both).
Panels separated by 1px lines, not by gaps and shadows. Section gap 12px, panel padding
12–16px. A dashboard that needs scrolling to answer its main question is mis-designed.

## Layout

- **Shell**: 48px icon rail or 220px sidebar (one choice), a 44px top bar with the global
  context (account, environment, connection state, clock in the operator's timezone), and
  the workspace filling the rest. Panels resizable where it is genuinely useful, otherwise
  a fixed grid.
- **First screen answers one question** — "what is the state of my stuff" — above the fold:
  status, exposure, alerts, what needs action. Not a welcome banner, not a chart nobody
  reads.
- **The core object triad** (order / position / patient / ticket): list → detail → edit,
  designed first; every other screen inherits those patterns.
- **Tables** are the primary surface: sticky header, sticky first column, keyboard
  navigation (arrows, `j/k`, `enter` to open, `/` to filter), column sort and visibility,
  a persistent filter bar with the active filters shown as removable chips, and the row
  count always visible.
- **Charts**: no gridline is worth more than the data; axes in `--faint`, one series
  colour per meaning, tooltips that follow the cursor with the exact value in mono, and a
  crosshair shared across stacked charts.
- **Every state** designed: loading (skeleton in the shape of the table), empty ("no open
  positions" + the action), error (what failed, what to do, retry), stale (last update
  time + a dimmed panel), disconnected (a persistent bar, not a toast).
- **Destructive actions**: confirm with the object named and typed where irreversible; show
  what will happen, not "are you sure".

## Motion — functional only

Every animation here has to earn its 200ms against an operator who has seen it 400 times
today. `motion.md` applies, with a tighter budget:

- **Value change**: background tint flash in the semantic colour, 220ms, then fade. No
  movement, no scale — the number must stay readable while it changes.
- **New row**: 160ms opacity + 4px slide; the rows below it move by FLIP so the eye keeps
  its place. Ten rows arriving at once animate as one group, not ten staggers.
- **Panel / drawer**: 200ms slide, `--ease-in-out`. Modals fade 160ms with a 4px rise, no
  scale.
- **Tab and route change**: 120ms crossfade at most. An operator switching tabs 200 times
  a day must not wait for choreography.
- **Charts**: initial draw 400ms on first mount only; updates interpolate over 250ms;
  live-appended points do not re-animate the whole series.
- **Skeletons**: shimmer 1.2s linear while loading; nothing pulses after data arrives.
- **Sort / reorder**: FLIP over 240ms so the row you were watching is followable.
- **Alerts**: a toast enters in 180ms, sits, and stays until dismissed if it is severe.
  Critical alerts never auto-dismiss and never animate repeatedly.
- **Forbidden**: scroll reveals, hero sequences, parallax, ambient glow, hover lifts on
  rows, anything that moves while the operator reads.

## Signature detail

One, and it should be functional: a 2px semantic left border on rows that need attention;
or sparklines in the last column of every table; or a connection heartbeat in the top bar
that is genuinely tied to the socket. In this genre the personality comes from precision,
not from ornament.

## Anti-patterns

- Marketing chrome leaking in: gradients, rounded 16px cards, drop shadows, big headings,
  generous padding. Every one of them costs rows.
- Proportional figures in a numeric column, or numbers left-aligned.
- Colour as the only carrier of meaning — pair with a sign, an arrow or a label.
- A rainbow of decorative hues; more than five series colours in one chart.
- Hiding the primary action in a kebab menu.
- Auto-refresh that reshuffles rows under the pointer, or a table that scrolls itself.
- Toasts for anything the operator must act on.

## Paste this

> Design and build a dense, dark operator console for **[product]**, used by **[operator]**
> for hours at a time. The first screen must answer: **[the one question]**. Primary
> action: **[action]**.
>
> System: bg #0B0E12, panel #111519, line #1C2229, text #D7DEE7, muted #8C97A5, accent
> #4C8DFF for selection/focus/active nav only. Fixed data semantics: up #12B981, down
> #F0533D, warn #E3A008, info #4C8DFF, and at most five series colours with documented
> meanings. Inter at 13px/1.35; every number in a tabular mono, right-aligned, decimals
> aligned; column headers 11px uppercase tracking 0.06em. Row height 30px, cell padding 8px
> horizontal, 1px hairlines instead of gaps and shadows, radius 6px, panel padding 12–16px.
>
> Shell: 48px icon rail, 44px top bar carrying account, environment, connection state and
> the operator's clock, workspace filling the rest. Above the fold: status, exposure,
> alerts, what needs action — no welcome banner. Build the list → detail → edit triad for
> the core object first and inherit it everywhere. Tables get a sticky header and first
> column, keyboard navigation (arrows, j/k, enter, / to filter), sortable and hideable
> columns, a filter bar with removable chips, and a visible row count. Charts: faint axes,
> one colour per meaning, mono tooltips, a crosshair shared across stacked charts. Design
> loading (table-shaped skeleton), empty (with the action), error (what failed and how to
> retry), stale (last-update time, dimmed) and disconnected (persistent bar) states.
>
> Motion, functional only: value changes flash a 220ms semantic background tint without
> moving; new rows enter in 160ms with a 4px slide and neighbours reflow by FLIP, batched
> arrivals animating as one group; drawers slide 200ms, modals fade 160ms with a 4px rise;
> tab and route changes crossfade in ≤120ms; charts draw once over 400ms on mount and
> interpolate updates over 250ms; sorting reorders by FLIP over 240ms; skeletons shimmer
> 1.2s while loading and stop when data lands; severe alerts never auto-dismiss. transform
> and opacity only; prefers-reduced-motion removes movement while keeping every state
> change visible.
>
> Ban: scroll reveals, hero sequences, parallax, ambient glow, hover lifts on rows,
> gradients, 16px radii, drop shadows, proportional figures in numeric columns, colour as
> the only carrier of meaning, primary actions hidden in kebab menus, and auto-refresh that
> reorders rows under the pointer.
