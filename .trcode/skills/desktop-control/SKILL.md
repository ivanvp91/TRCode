---
name: desktop-control
description: Only when the user explicitly asks you to operate their Windows GUI — click, type, move windows, or drive a canvas/Blender viewport. Never for URL analysis, ordinary web research, or any web page (read with fetch/web_search, automate with browser.mjs over CDP). Background first: UIA patterns, settext and window captures need no flag; raw focus/move/key/type/click/drag/scroll refuse without -AllowForeground, and that flag plus consent in the current user request are both required.
description_ru: Только когда пользователь явно просит управлять его Windows GUI — кликать, печатать, двигать окна или работать с канвасом/вьюпортом Blender. Никогда для анализа ссылок, обычного веб-поиска и любых веб-страниц (читать — fetch/web_search, автоматизировать — browser.mjs через CDP). Сначала фон: паттерны UIA, settext и снимки окон флага не требуют; сырые focus/move/key/type/click/drag/scroll без -AllowForeground отказываются выполняться, и нужны одновременно флаг и согласие в текущем запросе пользователя.
triggers: управление компьютером, управляй компьютером, компьютерное управление, управление мышью, управление клавиатурой, desktop control, computer use, кликни, нажми кнопку, нажми на кнопку, напечатай в поле, введи текст в поле, открой окно приложения, закрой окно приложения, переключись в окно, desktop automation, gui automation, автоматизируй интерфейс, протестируй интерфейс приложения
auto: off
---

# Desktop control (Windows, background first)

Two executors, one skill:

- `scripts/desktop.ps1` — native windows: UI Automation first (no flag), raw
  mouse and keyboard only with `-AllowForeground`. Everything below until
  "Web pages" is about it.
- `scripts/browser.mjs` — a real Chrome driven over the DevTools Protocol, for
  anything that renders web content. No npm install, no pixels.

Each action is one process; it prints `ok …`, one line of JSON, or `error …`
with exit code 1.

## Background by default — the first rule

Do the work in the background whenever a background path exists. Foreground
input costs the user their machine; it is a last resort that now takes two
gates, not an implementation detail.

- **A website is never a desktop job.** Reading, searching or answering a
  question about a page is `fetch` / `web_search` — a link in the request is
  still not permission to open anything. Automating a page is `scripts/browser.mjs`
  over CDP (`text`, `click <sel>`, `type <sel> <text>`, `press`, `eval`). Never
  drive Chrome, Edge, Electron or any Chromium window with `desktop.ps1` mouse
  or keyboard actions — no `focus`, `move`, `click`, `drag`, `scroll`, `key`,
  `type`, no address-bar typing, no clicking a page by coordinates. The only
  desktop call allowed near a browser window is `screen -Window -Handle`, and
  only for a canvas page that has no DOM to read.
- **Raw input is behind `-AllowForeground`.** `focus`, `move`, `key`, `type`,
  `click`, `drag` and `scroll` refuse to run without it, and they refuse
  *before any side effect*: no window is raised, no focus is stolen, no pointer
  or key event is sent. The error says so —
  `<action> would move the OS pointer, take the foreground or synthesize input …
  Nothing was moved and no key was sent` — and names the flag. Pass it only when
  both gates described below are in place.
- **Use the accessibility path, which needs no flag.** `ui` reads the tree;
  `clickui` activates a control through its UIA pattern (`Invoke`, `Toggle`,
  `Select`, `Expand`) and only falls back to a synthetic click at the element's
  centre — that fallback is gated exactly like raw input; `settext` writes a
  field through `ValuePattern` with no keystrokes; `gettext` reads a value back.
  `screen -Window -Handle` captures through `PrintWindow`, which neither focuses
  nor clicks the window, so it stays a read and needs no flag. When a control
  exposes a pattern, there is no reason to take the machine.
- **Two keys, and the flag is not consent.** A foreground action needs (a) an
  explicit grant in the *current* user message for *this* app and *these*
  actions, and (b) `-AllowForeground` on the call. Consent from an earlier turn,
  from "continue", from an auto-selected skill, or from a previous identical
  run does **not** carry over; the flag alone never makes an action acceptable.
- **Say honestly what cannot be done in the background.** An arbitrary native
  GUI app cannot be driven in the background unless it exposes an API or an
  accessibility pattern — there is no honest way to press a button in a window
  nobody raised. So reach for the app's own API (Blender `bpy` in
  `--background`, a CLI, a file export), for UIA (`clickui`, `settext`), or for
  an isolated VM/desktop where foreground input harms nobody. If none of these
  exists, say so and ask for foreground permission explicitly instead of
  silently taking the mouse.

## Consent and scope — read before any command

- **Never apply this skill to analyze a URL, read a site, do web research, or
  answer a question about a page.** Use `fetch`/`web_search` first. A link in the
  request is not permission to launch or focus a browser, and `openurl` is not an
  analysis tool.
- **No GUI action without an explicit request in the current user message.**
  "Open Chrome and go to X" authorizes that action. "Analyze X", "continue",
  "test the skill", or a previous authorization does not authorize taking over
  the machine again. If the desired action goes beyond the words of the request,
  ask and wait.
- Consent covers only the named application and actions. Do not start GUI smoke
  tests, open extra tabs/windows, click dialogs, type into fields, read the
  clipboard, or capture the desktop as an unrequested side effect. Do not run
  `tests/smoke.ps1` unless the user explicitly agrees to a foreground test.
- `openurl` and a visible `browser.mjs open --headed` may raise a browser window,
  so they need the grant above; subsequent CDP actions do not move the OS pointer
  or steal focus. Every raw desktop action (`focus`, `move`, `key`, `type`,
  `click`, `drag`, `scroll`, and the mouse fallback inside `clickui`) needs both
  the grant *and* `-AllowForeground`. `ui`, `gettext`, `settext`, pattern-driven
  `clickui` and `screen -Window` change no focus, but they still read private
  window content, so they need the same task-level authorization.

The skill loader injects the absolute directory of this `SKILL.md`; set `$D` from it rather than assuming a user-scope install, because the skill may also live in `<project>/.trcode/skills/desktop-control`.

```powershell
$D = Join-Path '<skill-dir-reported-by-the-loader>' 'scripts/desktop.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $D windows -Filter notepad
```

## The reliable workflow — one enumeration, then handles

1. **Enumerate once**: `windows -Filter <app or title>` prints one JSON array with
   `handle`, `pid`, `process`, `title`, `class`, `x/y/width/height`, `active`,
   `minimized`. Save it and keep the `handle` of your target. `-All` also lists
   hidden and untitled windows, which `windows` skips by default.
2. **Address it by handle from then on**: pass `-Handle <n>` to `focus`, `ui`,
   `screen -Window`, `click`, `clickui`, `drag`, `scroll`, `key`, `type`,
   `gettext`, `settext`. `-Pid n` and `-Match <title or process>` are accepted by
   the same resolver, but they re-pick a window on every call and can land on a
   different one after the app opens a dialog — that is exactly the class of bug
   `-Handle` removes. With `-Handle` you also do not have to call `focus` first:
   the input actions focus the target themselves and abort if that fails.
3. **Read**: `ui -Handle <n> -Depth 4 [-Name <text>]` walks the UI Automation tree
   and prints `type`, `name`, `id` (AutomationId), `cls`, rect, `enabled`,
   `focus`, and available `patterns`. `-Name` filters on name or AutomationId and
   adds a `parents` chain. `-Max` (default 400) caps the dump.
4. **Act**: `clickui -Handle <n> -Name "<label>"` (Invoke/Toggle/Select/Expand
   patterns, else a verified click at the element's centre) and
   `settext -Handle <n> -Name "…" -Value "…"` are the background forms — no
   flag, no pointer. `type -Handle <n> -Text "…"`, `key -Handle <n> -Combo ctrl+s`,
   `click -Handle <n> -X … -Y …`, `drag -Handle <n> -X1 …`, `scroll` and `move`
   send real input and require `-AllowForeground`; without it they refuse before
   touching anything.
   Once allowed, a targeted input still never lands somewhere else by accident:
   `click`/`drag`/`scroll`
   re-check that the point still belongs to the target window's root window before
   the first mouse event (`… point x,y is over other-app: Title, not over the target
   window; input was not sent`), and `type`/`key` re-check foreground ownership
   (`target window is not in the foreground; key was not sent` /
   `target window lost focus after N character(s); typing stopped`). An abort is a
   correct outcome: re-enumerate, do not retry blindly.
5. **Verify**: `screen -Window -Handle <n>` and look at the file, or
   `gettext -Handle <n> -Name …` to read the value back. The window capture is
   taken through `PrintWindow`, so it shows the requested window even while
   another app is in front and does **not** require focusing it. A step counts as
   done when the capture says so, not when the action printed `ok`.

Default target when no `-Handle`/`-Pid`/`-Match` is given: the foreground window
for `focus`/`ui`/`clickui`/`gettext`, the root window under the point for
`click`/`drag`, the window under the pointer for `scroll`. That is the risky path —
it means "whatever happens to be there" — so use it only for a deliberate
whole-desktop action, and remember that every one of these raw forms still needs
`-AllowForeground`.

## Web pages — browser over pixels

If the target renders web content (site, web app, Electron/Chromium window),
drive it through `scripts/browser.mjs` instead of clicking coordinates: selectors
survive layout changes and `text` reads the result exactly. `desktop.ps1` mouse
and keyboard are never the tool for this content — a browser window is off
limits for raw input, and `screen -Window` is only a fallback for a canvas page
with no DOM.

Two ways to get a page open in a browser:

- **The user's own browser, one new tab, only when explicitly requested**:
  `openurl -Url https://… -Match chrome` (or `-Match msedge`, the only two values).
  It locates the running browser's
  executable and hands it `--new-tab <url>`, which the browser routes to its
  existing instance and profile — no synthetic `ctrl+t` and no address-bar typing
  into a contested foreground window, and the user stays signed in. Only absolute
  `http`/`https` URLs are accepted. This is a *request* to the browser: it cannot
  read the page back, so verify DOM state with `browser.mjs` or `screen`.
- **DOM-verifiable, in an owned browser**: `browser.mjs open <url|file> --headed`
  starts its own Chrome and every later `text`/`click`/`type` acts on that page.
  Use it when the result must be checked, or when the flow is scripted end to end.

`browser.mjs` needs Node 22+ (its global `WebSocket` speaks CDP). Use
`scripts/browser.mjs` from the same skill directory as `$D`:

```bash
node "<skill-dir>/scripts/browser.mjs" open .tmp/page.html
node "<skill-dir>/scripts/browser.mjs" text "#total"
```

| Action | What it does |
| --- | --- |
| `open <url\|file> [--headed] [--port 9222]` | new tab in the owned browser, waits for `readyState`, prints the url |
| `batch <scenario.json>` | run a whole scenario in one process and one CDP connection; one final JSON report |
| `nav <url>` / `tabs` / `use <index\|id\|text>` | navigate, list, switch tab |
| `text [sel]` / `html [sel]` | innerText / outerHTML of the first match (default `body`) |
| `click <sel>` | scroll into view, focus, `click()`; prints the element's text |
| `type <sel> <text>` | sets the value natively and fires `input`/`change` (React-safe) |
| `press <enter\|tab\|escape\|arrowdown\|…> [sel]` | real key event through CDP |
| `eval <js>` | evaluate in the page, returns JSON |
| `wait <ms>` / `waitfor <sel> [ms]` | sleep / poll for a selector |
| `shot [path]` | PNG of the viewport |
| `close` / `quit` | close the tab / the browser |

For a multi-step flow such as posting a form, prefer one `batch` over separate
model turns. The scenario is `{"steps":[…]}`; steps are `{open:url}`, `{nav:url}`,
`{wait:ms}`, `{waitfor:{selector,timeoutMs}}`, `{click:selector}`,
`{type:{selector,text}}`, `{press:{key,selector}}`, `{eval:js}`,
`{text:selector}`, `{shot:path}`, `{close:true}` and `{quit:true}`. It stops on
the first failure and reports the failed step instead of guessing or retrying.
Only `open` may launch the owned browser; all other steps work in its existing
page without OS mouse, keyboard or foreground events.

Rules:

- Selectors, not coordinates. If `text` returns `null`, run `html` on the parent
  and look at what is actually there — never guess a coordinate.
- The browser is **headless** with a unique temporary profile. The script only
  drives and closes the browser process it started itself: a foreign CDP on the
  port is refused, never adopted. For an authenticated flow use `--headed`, and
  let the user sign in once in that window; that profile keeps cookies until
  `quit` removes it.
- `quit` when the task is done; it closes the owned browser and deletes the
  profile. Without it the headless browser and its profile stay on the port.
- Unknown `--options` are errors (for `type`/`eval` they are data); use `--` to
  pass a literal value that begins with `--`. `close` never launches a browser,
  and `nav` reports a real navigation/load error instead of printing `ok`.
- A `<canvas>`-only page has no DOM to select: capture the owning window with
  `screen -Window -Handle` and use targeted clicks (see the canvas section).

## Captures

`screen [-Path file] [-Window | -Region x,y,w,h] [-Handle n] [-Confirm]` writes a
PNG (default `%TEMP%\screen-<stamp>.png`) and prints its path and size.

- `-Window -Handle <n>` is the normal capture: `PrintWindow` reads that window's
  own surface, so it works while the window is behind another one, does not
  focus it and sends no input — it needs no `-AllowForeground`, and it is the
  background-safe way to see what a window shows. If Windows cannot render an
  occluded window at all, the action errors and saves nothing (`Windows could
  not capture the occluded target window`) — then narrow with `-Region`, or ask
  for permission to raise the window (`focus -AllowForeground`).
  A minimized window is refused rather than captured as a tiny placeholder.
- No `-Window`/`-Region` means the whole virtual screen, which contains every
  window on the desktop: that needs `-Confirm`. So does a `-Region` that covers
  the whole virtual screen.
- `-Region` is in physical screen pixels (the same space as `windows` rects), not
  window-relative.

## Coordinates and DPI

The script is DPI-aware, so every number — window rects from `windows`, element
rects from `ui`, `click`/`drag` coordinates, capture size — is in **physical
pixels** of the virtual desktop. Derive a point as
`window.x + <offset inside the window>` using a rect from `windows` or `ui`; do
not trust the logical size an app displays. When you have no element to aim at,
read the offset off a fresh `screen -Window -Handle` capture and re-capture
after acting to confirm.

## Canvas apps, viewports and Blender

A 3D viewport, canvas or game area exposes nothing useful to UI Automation: `ui`
returns a shell, and pixels are the only ground truth. This is the one place
where no background path exists, so it is the honest reason to ask for
foreground permission — and every input step needs `-AllowForeground`. The
workable sequence is always the same:

1. capture the exact window — `screen -Window -Handle $w.handle -Path .tmp/before.png`
   (works while it is still behind the terminal, no focus needed);
2. aim with coordinates derived from that window's rect, e.g.
   `-X1 ($w.x + 400) -Y1 ($w.y + 600)` for a `drag`, never a bare screen guess;
3. act with the targeted form — `drag -Handle $w.handle … -AllowForeground`,
   `click -Handle $w.handle … -AllowForeground`,
   `key -Handle $w.handle -Combo … -AllowForeground` — so the point check and the
   focus check run on top of the flag;
4. verify with a **fresh** capture of the same handle and compare.

```powershell
$w = (powershell -NoProfile -ExecutionPolicy Bypass -File $D windows -Filter blender | ConvertFrom-Json)[0]
powershell -NoProfile -ExecutionPolicy Bypass -File $D screen -Window -Handle $w.handle -Path .tmp\before.png
powershell -NoProfile -ExecutionPolicy Bypass -File $D drag -Handle $w.handle -X1 ($w.x+400) -Y1 ($w.y+600) -X2 ($w.x+700) -Y2 ($w.y+600) -AllowForeground
powershell -NoProfile -ExecutionPolicy Bypass -File $D screen -Window -Handle $w.handle -Path .tmp\after.png
```

Before that, check whether the app has an API at all: if it does, the viewport
was never the answer.

For anything that should be repeatable, GUI gestures are the wrong API. Blender
exposes its whole scene graph through Python and can build and save a model
headless:

```powershell
blender --background --python script.py
```

The script imports `bpy`, constructs geometry, materials and modifiers, and saves
with `bpy.ops.wm.save_as_mainfile(filepath=...)`; its stdout is checkable, so run
it through the shell tool, not through this skill. Use the GUI only to inspect a
result or to do something the API does not express (a viewport tweak, a dialog).
Never present a recorded sequence of clicks as "modeling": a click path is bound
to one window size, one camera and one UI language, and it breaks on the next
run. When the user asks for a 3D model, the deliverable is a script plus the file
it produces.

## Applications that expose nothing useful

Legacy WinForms/MSAA apps report every control as `type: "Pane"`, with
`AutomationId` equal to the native window handle: `-ControlType Button` finds
nothing, while `-Name "Spin"` and `-AutomationId 1706232` work. Chromium-based
apps expose a deep tree (4–6 levels to reach a control), so raise `-Depth`
before concluding the control is missing. Both are still background candidates:
`clickui` on a found element and `settext` on its `ValuePattern` change the app
with no flag — only when neither works is raw input the answer.

## Actions

| Action | What it does |
| --- | --- |
| `windows [-Filter text] [-All]` | windows as JSON; save the `handle` |
| `active` | foreground window |
| `focus [-Handle n \| -Match title \| -Pid n]` | restore + bring to front; needs `-AllowForeground`; fails instead of pretending |
| `openurl -Url https://… [-Match chrome\|msedge]` | new tab in the user's running browser (default `chrome`) |
| `ui [-Handle n] [-Depth 4] [-Name text] [-Max 400]` | UI Automation tree as JSON |
| `screen [-Handle n] [-Window] [-Path file] [-Region x,y,w,h] [-Confirm]` | PNG, prints the path; prefers `PrintWindow` for `-Window`; full screen needs `-Confirm` |
| `clickui [-Handle n] -Name x [-AutomationId id] [-ControlType ty] [-Index n]` | UIA patterns first (background, no flag); the mouse fallback at the element's centre is gated like raw input |
| `click [-Handle n] -X n -Y n [-Button left\|right\|middle] [-Double]` | raw click (`-AllowForeground`); aborts if the point or the foreground is not the target |
| `move -X n -Y n` | pointer move only — no target check, no app gate, but it is raw input and needs `-AllowForeground` |
| `drag [-Handle n] -X1 -Y1 -X2 -Y2` | both endpoints verified against the target, 12-step move (`-AllowForeground`) |
| `scroll [-Handle n] -Amount n [-Direction up\|down]` | wheel at the current pointer, after focusing and verifying the target (`-AllowForeground`) |
| `key [-Handle n] -Combo ctrl+shift+s` | chord in one `SendInput` batch; aborts if the target lost foreground (`-AllowForeground`) |
| `type [-Handle n] -Text "..."` | Unicode text; aborts as soon as the target loses focus (`-AllowForeground`) |
| `gettext [-Handle n] -Name x [-AutomationId id]` | read a field (`ValuePattern`, else `Name`); app-gated, no flag |
| `settext [-Handle n] -Name x -Value "..."` | write through `ValuePattern` — background alternative to `type`, no flag |
| `clipboard [-Mode get\|set] [-Text ...]` | last-resort transport; `get` needs `-Confirm` |
| `wait -Ms n` | settle time between steps |
| `-AllowForeground` on `focus`/`move`/`key`/`type`/`click`/`drag`/`scroll` | the foreground key: without it these refuse before any side effect; it grants nothing unless the current request already asked for it |
| `-Force` on any action | bypass the app gate (only after the user agreed) |
| `-Confirm` on any action | allow an action the irreversible guard stopped |

## Allow/deny per app

`apps.json` next to `SKILL.md` decides which applications may be driven:

```json
{ "default": "allow", "allow": [], "deny": ["keepass", "1password", "bitwarden"] }
```

Matching is on the process name, case-insensitive, deny wins. `default: "deny"`
turns it into an allow-list; any other `default` is a configuration error. The
gate covers `focus`, `openurl`, `click`, `clickui`, `type`, `key`, `settext`,
`drag`, `scroll`, `screen -Window` and `gettext`. Raw clicks/drags/scrolls are checked
against the process owning the window **under the coordinates**, not merely the
foreground window. A window whose process cannot be identified is denied
(fail-closed), as is an elevated window this process cannot inspect. A blocked
action prints `error app '<name>' is denied in apps.json` — do not fight it: ask
the user to edit the file, or pass `-Force` once they agreed to that one action.
`-Force` is an audit-visible bypass, not an extra confirmation. Raw input is
also behind `-AllowForeground`, so the app gate is never the only barrier.

Full-screen captures (and regions covering the whole virtual screen) need
`-Confirm`, because they include every window. `clipboard get` also needs
`-Confirm`: the clipboard may hold a password copied somewhere else.

Password managers are denied out of the box and must stay that way: the user
should unlock and read their own secrets.

## Audit log

Every invocation appends exactly one JSON line to
`~/.trcode/desktop-actions.jsonl`: timestamp, action, process, window title,
detail, status (`ok`, `denied by apps.json`, `denied`, `bypassed`, `error`).
Typed text and fields read by `gettext`/`clipboard` are logged as character
counts, never as content. Screenshots log their path, size and scope. Use it to
answer "what did the agent do on my machine".

## Irreversible actions

Labels and key chords that look destructive — delete, remove, erase, wipe,
truncate, format, uninstall, reset, clear, purge, pay, buy, purchase, checkout,
send, submit, publish, deploy, block, deactivate, unsubscribe, overwrite (and
their Russian equivalents) — are refused unless `-Confirm` is passed. So are
`alt+f4`, and `enter`/`delete` while the focused element carries such a label.
`type -Text` containing a line break needs `-Confirm` too, because the newline
presses Enter and can submit a form or confirm a dialog.

When the guard stops you: read the whole dialog first, say what it will do, wait
for an explicit yes, then re-run with `-Confirm`. Never pass `-Confirm`
speculatively "to see what happens".

## Guardrails

- **Background first, foreground by permission.** While foreground steps run
  the user cannot use the machine — say so, and get the grant in the current
  request before the first one. `-AllowForeground` on a raw action is the second
  key, never a substitute for that grant. `ui`, `gettext`, `settext`, UIA
  `clickui` patterns and `screen -Window` need no flag: they take neither the
  pointer nor the keyboard, and `PrintWindow` never focuses the window.
- **Never type secrets**: passwords, card numbers, API keys, 2FA codes — ask the
  user to enter those themselves.
- **Carry the handle.** `-Handle` is what makes `type`/`key`/`click`/`drag` land
  in the window you meant; `-Match` re-picks a window on every call and is only
  acceptable for a one-step action on a single-window app.
- **Treat an abort as information.** `input was not sent`, `lost foreground`,
  `could not focus` mean another window intervened: re-enumerate, re-capture, and
  decide again. Do not loop the same call.
- **Read before clicking.** `ui` first; pixels only where nothing is exposed. A
  blind click in the wrong place is how data gets destroyed.
- **Screenshots are private.** Capture to temp with `screen -Window -Handle`, look
  with `read_image`, and do not copy desktop captures into the repository or into
  anything published. A full-screen capture needs explicit `-Confirm`.
- **Stop on surprise.** If the result is not what was expected, re-read the screen
  and re-plan; never repeat a click that already did something.

## Regression tests — no foreground needed

- `node tests/browser-batch-smoke.mjs` runs a headless owned-browser form flow,
  verifies batch success/failure reports, and cleans up the browser and profile.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tests/foreground-policy.ps1`
  verifies every raw-input/focus action refuses without `-AllowForeground` and is
  audited. It injects no input. Foreground/pointer changes by the person using
  the machine during the probe are reported as notes, not failures.
- `tests/smoke.ps1` is the intentional foreground test and must not be run without
  explicit user permission for that test; its calls carry `-AllowForeground`.

## What not to do

- Do not use this when a CLI, API or file export exists — that is faster and
  reproducible. For 3D work that means Blender's Python API in `--background`
  mode, not a click path over the viewport.
- Do not use `desktop.ps1` mouse or keyboard on Chrome, Edge, Electron or any
  other web content: read pages with `fetch`/`web_search`, automate them with
  `browser.mjs`. Do not drive a web page by coordinates when selectors can
  reach it, and do not synthesise `ctrl+t` plus address-bar typing when
  `openurl` asks the browser itself for the tab.
- Do not pretend a native GUI was handled in the background when it cannot be.
  Without an API or an accessibility pattern, the honest answer is a foreground
  request (or a VM), not a quiet takeover.
- Do not rearrange or close the user's windows, or leave an app on a half-filled
  form: finish the flow or restore the state you found.
- Do not take over an app the user is actively working in without asking.
- Do not load or use this skill for a link-analysis request; use the web tools.
- Do not treat a past request or an auto-selected skill as permission for a new
  foreground action. The current user message must explicitly authorize it, and
  the call must still carry `-AllowForeground`.
