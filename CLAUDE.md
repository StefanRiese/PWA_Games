# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A PWA (Progressive Web App) launcher for small browser-based games, for iPhone and Android —
client-side only, no backend, no build step. `index.html` is the home screen: a list of games,
each of which is its own self-contained, single-file app living in its own subfolder. See
README.md for the user-facing feature list and deployment instructions (GitHub Pages).

## Repository layout

- `index.html` — the launcher shell (HTML + CSS + JS in one file): games list, theme toggle,
  offline support. This is the only file at the repo root you will normally need to edit.
- `manifest.json` — Web App Manifest for Android/Chrome install prompts.
- `games_icon.png` — home-screen / manifest icon (512×512, matching `manifest.json`): a flat white
  toilet glyph (line art) on a solid black background (opaque RGB, no alpha channel — a
  transparent icon background renders inconsistently across home-screen launchers) — the app is
  branded "Klo-App".
- `README.md` — user-facing feature docs (German).
- `shared/common.css` / `shared/common.js` — the design tokens, component CSS, and JS helpers
  (`loadShellPrefs()`, `applyTheme()`, pinch-zoom prevention, `SHARED_I18N`/`sharedT()` for
  translation strings that must match across every game) that used to be copy-pasted byte-for-byte
  into every game file *and* the shell itself; see "Adding a new game" below for how a game wires
  these in. The shell (`index.html`) wires them in the same way, just with paths relative to the
  repo root (`shared/common.css`, not `../shared/common.css`) since it lives one level up from
  every game — and it never calls `loadShellPrefs()` itself, since it's the source of those prefs,
  not a consumer of them.
- Each game lives in its own subfolder (e.g. `some-game/index.html`), following the same
  "one file, no build tools" premise as the shell itself, and is linked from the shell's `GAMES`
  array.

There is intentionally no `src/`, no framework, and no bundler, for the shell or for any game
added under it. `shared/common.css`/`shared/common.js` are plain static files referenced by
`<link>`/`<script src>` — not a build step, not a package — so this constraint still holds.

## Commands

There is no build, lint, or test tooling in this repo (no `package.json`). To develop:

- **Preview locally**: serve the directory over HTTP (not `file://`, since the Service Worker
  requires a proper origin) — e.g. `python3 -m http.server 8000` — then open
  `http://localhost:8000/index.html`.
- **Sanity-check JS syntax** (no linter configured): extract and parse the inline `<script>`
  block, e.g. `node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"`.
  For a game, this only checks the game's own inline block in isolation — it won't catch a
  reference to something `shared/common.js` provides (e.g. `loadShellPrefs`) being missing or
  misspelled, since that function isn't in scope for a standalone parse. Concatenate
  `shared/common.js` in front of the inline block before parsing to catch that class of mistake.
- **Deploy**: push the repo root (plus any game subfolders) to `main`; GitHub Pages serves it
  directly (Settings → Pages → Deploy from branch → `main` / root).

## Architecture (shell)

State (currently just the theme) is a plain `state` object persisted to `localStorage` under
`STORAGE_KEY = 'pwa_games_v1'` via `load()`/`save()`. There is no framework — `applyTheme()`
toggles the `.light` class on `<body>`, and `renderGames()` renders the `GAMES` array (or an
empty-state message when it's empty) into `#games-grid`. When you add a new piece of shell state,
follow the existing pattern: mutate `state`, call the relevant `render*()`, then `save()`.

**Games list**: `GAMES` is a plain array of `{ id, emoji, name, descKey, url }` — `descKey` looks
up the one-line description in the shell's own `I18N` blocks (add the key to both `de` and `en`),
and `url` is a repo-relative path to that game's own `index.html`. Adding a game means adding its
subfolder plus one entry (plus the two `descKey` translations) here; the shell itself doesn't need
any other change. `emoji` is injected via `innerHTML` in `renderGames()` (`` `<div class="emoji">${g.emoji}</div>` ``), so it isn't limited to an actual emoji character — when no single emoji
reads as the game (e.g. a chessboard, a tetromino, paddles-and-ball), a small inline SVG string
works just as well and is what most current entries use; keep it tiny (a handful of `rect`/
`circle`/`line` elements, no `<defs>`/gradients) and prefer `var(--accent)`/`var(--text)`/etc. over
hard-coded hex so it reads correctly in both themes. The game's own topbar `<h1>` should use the
same SVG (scaled down, `vertical-align` tuned to sit on the text baseline) so the icon matches
between the games list and the game itself.

**Design tokens**: the shell reuses the same CSS custom-property scheme as other single-file PWAs
in this style — `--radius-sm/md/lg`, `--space-1..6`, `--font-md` (14px, the harmonized size for
general UI text) — and the same `--bg`/`--card`/`--btn` light-ramp / `--accent`/`--success`/
`--danger` semantic color tokens, dark-first with a `.light` override block. New games are not
required to match this scheme, but reusing it keeps the launcher and its games visually
consistent.

**Offline/installability**: a Service Worker is registered from an inline `Blob` URL (no separate
`sw.js` file), with an explicit `scope` and a static cache name (`pwa-games-shell`) — a
version-derived cache name would make the SW script byte-differ on every content-only version
bump, triggering an unwanted silent auto-update on the next open regardless of the update flow
below; don't reintroduce that. Each shell URL (`index.html`, `manifest.json`, the icon) is fetched
and cached independently (`Promise.allSettled`, not `cache.addAll`) so one flaky fetch can't wipe
out the others, with an `r.ok` check so a transient HTTP error isn't cached as if it were the real
file, and the install throws only if *both* HTML shell URL variants fail (so the browser retries
the whole install on the next online open) — a manifest/icon-only failure is left non-fatal.
Registration happens while `navigator.onLine`, OR while offline if there's no Service Worker
already controlling the page (`navigator.serviceWorker.controller` is null) — not a blanket
`navigator.onLine` gate, which an earlier version of this used. The SW script comes from a local
`Blob`, so registering it needs no network by itself; only an actual `install` (a genuinely
new/changed worker — i.e. after this install/activate/fetch logic itself changes) fetches the
shell over the network. A blanket online-only gate avoids retrying that failed install on every
offline open after such a change (each attempt can trigger the OS's own "no internet, switch to
Wi-Fi?" prompt — confirmed on-device in the sibling scoreboard app), but a genuine deploy like that
always still has an *old* SW installed and controlling, so gating on "no controller" gives the same
protection there. What a blanket online gate gets wrong: iOS evicts an installed PWA's SW
*registration* entirely after a full force-quit, and if the next relaunch happens to be offline,
`navigator.serviceWorker.controller` is null (no worker at all) — skipping registration in that
state means it never attempts to recover, so *every* subsequent offline reopen keeps hitting the
network directly and surfacing the browser's own connection-error page instead of the cached shell,
a self-perpetuating failure that only clears once the device comes back online.

The SW registers with `scope: swScope`, which is the *site root*, not just the shell — so it also
intercepts navigations to every per-game page (`sudoku/index.html`, `tetris/index.html`, ...),
none of which are ever written into Cache Storage (only SHELL is). Its `fetch` handler's fallback
for anything not found in Cache Storage must use `fetch(event.request, { cache: 'no-store' })`,
not a plain `fetch(event.request)` — a plain call still honors the *browser's* own HTTP cache
regardless of any SW-level caching, which let a revisited game page silently keep serving bytes
from before the latest deploy even though the launcher's own version check correctly updated
itself (symptom: "only new games appear and the version number increases, existing games don't
update"). Offline access to a non-shell page was never supported, so a rejection from the
no-store fetch is left to surface as the browser's own offline error rather than a fallback
`fetch()` — a bare fallback would fail for the exact same reason (no network) and just mask that.
For navigation requests specifically, the fetch handler also stamps `Cache-Control: no-store`
onto the *response* it hands back (not just the outgoing request) — a no-store request alone
still let iOS Safari's back-forward cache (bfcache) restore a fully-rendered snapshot of a
previously-visited game page on the next visit without ever reaching this fetch handler again,
which is what caused "the launcher updates itself but game pages never do" even though the fetch
logic above was otherwise correct. A no-store response header opts the page out of bfcache
eligibility, forcing every re-visit through this handler.

**Update flow**: `checkForUpdates()` runs unconditionally on every online `init()` — no button, no
confirmation step, mirroring the same reasoning as other apps in this style: a manual-only gate is
silently bypassed on iOS anyway (iOS evicts an installed PWA's Service Worker registration on a
full force-quit, so the next relaunch's first navigation goes uncontrolled straight to the network
regardless of any in-app button). It fetches the live `index.html` with both a cache-busting query
string and `{cache: 'no-store'}` — both are required: `no-store` bypasses the browser's own HTTP
cache, while the query string is what makes the request miss the Service Worker's own
cache-first `fetch` handler so it actually reaches the network instead of re-serving the already-
cached (i.e. current) version. It regex-extracts the response's embedded `APP_VERSION` and only
proceeds if it differs from the running version, then writes the fetched HTML into the existing
cache and reloads. Any failure (offline, bad response) is swallowed silently — the app just keeps
running the current cached version and retries on the next online open. Bump `APP_VERSION`
(semver) on every deploy you want this to detect.

**Touch-only target**: like the games it hosts, this launcher is meant to be used one-handed on a
phone touchscreen — optimize for tap targets and portrait/landscape layout, not keyboard or mouse
interaction. Pinch-zoom is blocked the same way as other apps in this style:
`gesturestart`/`gesturechange` `preventDefault()` (Safari-specific) plus a document-level
multi-touch `touchmove` fallback, with `body`'s own `touchmove` listener handling the multi-touch
case *before* calling `stopPropagation()` (not after) — otherwise `stopPropagation()` on a
single-touch move would swallow the document-level listener's multi-touch check on any platform
without gesture events (e.g. Android Chrome), leaving pinch-zoom unblocked there.

**Settings subpage**: the theme toggle, language toggle, version number, developer name, and an
install QR code live on a dedicated settings screen, opened via a `game-card`-styled entry at the
bottom of the games list (`#settings-grid`, rendered like any other game so it reads as "one more
row to tap", not a small icon tucked in a corner) — same content pattern as the scoreboard app's
Settings tab (`settings-section`/`settings-row`/`toggle-btn` styling), but as a full-screen
back/forward subpage swap (`showSettings()`/`showGames()`) rather than a tab bar, since the
launcher only ever has these two screens. The QR code is a precomputed bitmap (`QR_MATRIX_BITS`,
one bit per module) pointing at the GitHub Pages URL, generated offline with the Python `qrcode`
library — not fetched from a third-party API at runtime — mirroring the scoreboard app's own QR
code so the shell stays a dependency-free, no-network-calls-beyond-its-own-content single file.
Regenerate it if the deployed URL ever changes. Theme and language are configured **only** here,
in the shell — see the note under "Adding a new game" below for why individual games don't carry
their own toggle UI for either.

## Adding a new game

Each game is a sibling of the shell files, in its own subfolder, and should itself follow the
"one HTML file, no build step" premise — a game may have its own `manifest.json`/icon if you want
it independently installable, or rely on being launched from within the shell. Keep each game
self-contained in its *state* (its own state/localStorage key, its own render logic) rather than
sharing runtime state with the shell or with other games — this is about game state, not static
assets; see immediately below for what a game *does* share.

**Wire up `shared/common.css`/`shared/common.js`** — every game does, and a new one should too,
rather than re-copying the design tokens/component CSS or the `loadShellPrefs()`/`applyTheme()`/
pinch-zoom-prevention JS into its own file (that's exactly the duplication these two files exist
to end — see `shared/common.css`'s and `shared/common.js`'s own header comments for what's in
each and why). Concretely, in a new game's `index.html`:
- `<link rel="stylesheet" href="../shared/common.css"/>` in `<head>`, right after `<title>`.
- `<script src="../shared/common.js"></script>` in `<body>`, immediately before the game's own
  `<script>` block — it must load first so `loadShellPrefs()`/`applyTheme()` are already defined
  by the time the game's own `init()` calls them.
- Don't redefine `loadShellPrefs()`, `applyTheme()`, or the pinch-zoom `addEventListener` block
  locally — they're already global once `common.js` has loaded. Do still keep the game's own
  `load()`/`save()`/`state`/`STORAGE_KEY` local (only the shell-prefs read and the theme/pinch-zoom
  behavior are shared, since those are genuinely identical everywhere; a game's own persisted
  state shape isn't).
- `shared/common.css` already covers `:root`/`.light` tokens, base reset, `topbar`/`icon-btn`,
  `difficulty-row`/`diff-btn`, `panel-box`, `confirm-row`/`btn-secondary`/`btn-danger`/`link-btn`,
  `action-btn`, `result-banner`/`result-text` (win/lose/draw), and `overlay`/`.box`/`.title`/
  `.stat` — don't redeclare these in a game's own `<style>` unless you deliberately need to
  override a specific rule for that one game (later same-specificity rules in the game's own
  `<style>`, which loads after the shared `<link>`, win the cascade, so an override is safe and
  stays local to that game). Only genuinely game-specific CSS (board layout, piece rendering,
  animations) belongs in a game's own `<style>` block.
- This is still plain static files referenced by `<link>`/`<script src>`, not a build step or a
  package — the "no build tools" rule above still holds. The trade-off worth knowing: a game
  folder is no longer 100% copy-paste-portable on its own (it needs `shared/` alongside it), and a
  change to `shared/common.css`/`shared/common.js` now affects every game *and the shell itself*
  at once — so changes to either need the same "syntax-check + smoke-test every game (and the
  shell)" discipline as any other shared-code change, not just the one game you're actively
  working on.

**Board/canvas sizing**: every game caps its own board/canvas width with
`width: min(100%, calc(100dvh - Npx))` (scaled by an aspect-ratio factor for a non-square board,
e.g. Connect Four's `* 7 / 6` or Pong's `/ 1.5`) — `100%` lets it fill the available width on a
narrow phone, and the `100dvh - Npx` term caps it so the board, at its own aspect ratio, never
makes the page taller than the viewport (no scrolling). `N` is the combined height of everything
else on that specific game's page (topbar + difficulty/status/action rows + gaps + safe-area
padding), so it has to be tuned per game, not copied verbatim from another one. Don't add a third,
fixed-pixel term back into that `min()` (the old pattern was
`min(100%, 380px, calc(100dvh - Npx))`) — a hard pixel cap prevents the board from ever reaching
full width even when the height budget would allow it, which is the opposite of what "use the full
width" means here. A tall/portrait-court game (Pong, Breakout, Tetris) will still often fall short
of 100% on an ordinary phone purely because of its own aspect ratio's height cost (a wider board
needs a taller one too) — that's an expected consequence of the height constraint, not a bug to
paper over by reintroducing a pixel cap.

The `Npx` guess in that formula is fragile in a way that's bitten this repo twice on real
iPhones (confirmed via user-supplied screenshots for Snake, Pac-Man, and Sokoban all at once): it
has to account for the combined height of every row above and below the board, but that set of
rows often isn't fixed — a game with a difficulty row, a reset link, or a result-banner that
*replaces* the action-row (rather than sitting alongside it) has a different actual chrome height
depending on game state, and a single guessed constant can only be right for one of those states.
When it's wrong, the board ends up too big and pushes whatever's below it (usually the end-of-game
banner, sometimes the d-pad) off the bottom of the screen, with no scrolling to reveal it since
`overflow-y: auto` on `body` makes it *technically* reachable by scrolling but defeats the
no-scroll design goal. **For a new game, prefer measuring the actual available space in JS instead
of guessing a pixel constant** — see Sokoban's/Snake's/Pac-Man's `sizeBoard()` for the pattern:
give the board's wrapping element `flex: 1; min-height: 0; overflow: hidden;` so it fills exactly
whatever space the flex layout actually leaves after every other row has taken what it needs, then
in JS read that element's real `clientWidth`/`clientHeight` and fit the board (canvas size, or a
`.board-frame`'s explicit `width`/`height`) into it directly, preserving aspect ratio by hand
(`let w = availW, h = w * rows / cols; if (h > availH) { h = availH; w = h * cols / rows; }`).
Call this sizing function on init, on `window.resize` (for orientation changes — call it alone,
not a full re-render, so rotating mid-game doesn't disturb game state), and after anything that
toggles which row is visible (a game starting/ending, a confirm prompt appearing) — but *not* from
a per-frame render loop if the game has one (Pac-Man's `animationLoop` calls `renderAll()` at
60fps; `sizeBoard()` forces a layout reflow via `clientWidth`/`clientHeight`, so it's called only
from the specific state-changing functions, not `renderAll()` itself). This approach is correct by
construction regardless of device chrome, notch, or future changes to the rows around the board —
the old `calc(100dvh - Npx)` convention remains acceptable for a simple game whose chrome truly is
a fixed, unconditional set of rows, but verify that assumption before reusing it.

Each game still keeps its own `I18N`/`t()`/`applyLang()` pattern and its own `state.darkMode`/
`state.lang` fields — with one exception: strings that must read identically in *every* game (so
far just the difficulty-tier labels: "Leicht/Mittel/Schwer", "Easy/Medium/Hard") live once in
`shared/common.js`'s `SHARED_I18N`/`sharedT(key)` instead of being copy-pasted into each game's own
`I18N` block. This repo's games are never extracted and run standalone (see the top of this file),
so duplicating a translation that has to always match everywhere has no portability upside, only
drift risk — which is exactly what happened before this existed (Snake used its own
"Slow/Normal/Fast" wording instead of "Easy/Medium/Hard" until it was caught and harmonized). A
game's own `t(key)` falls back to `sharedT(key)` after its own local `I18N` lookups miss — copy the
exact pattern from any game with a difficulty row (e.g. `function t(key) { return
(I18N[state.lang] && I18N[state.lang][key]) || I18N.de[key] || sharedT(key) || key; }`). Add a new
key to `SHARED_I18N` only when it's a string that must be identical across every game that uses
it, not for a string that merely happens to be the same today — a game-specific string belongs in
that game's own `I18N` block even if it currently duplicates another game's wording. Games
deliberately do **not** render a theme or language toggle button
themselves — those controls live only in the shell's settings subpage (see above). Since a game's
own `localStorage` key has no code path that ever writes a chosen theme/language into it anymore
(no in-game toggle to do the writing), a game can't just read its own key for these two fields —
that would leave it permanently stuck on the hardcoded default the first time it ever ran, deaf to
whatever the player later picks in the shell. Instead, every game's `init()` calls `load()` *then*
`loadShellPrefs()`, which reads the shell's own storage key (`pwa_games_v1`) directly — same
origin, so its `localStorage` is directly readable from any game page — and overwrites
`state.darkMode`/`state.lang` with whatever's there, every time the game opens. `loadShellPrefs()`
must run after `load()`, not before, so it wins. Don't reintroduce a `theme-toggle`/`lang-toggle`
button or `icon-group` in a game's topbar (that pattern was deliberately removed from every game),
and don't remove `loadShellPrefs()` or read only the game's own key for these two fields — that
regresses to a game being frozen on its default language forever, invisible to the shell setting.

**Long-press pattern (applies to any game, not just Minesweeper)**: a long-press-triggered action
must not be allowed to also fire that same gesture's normal tap action afterward — this is a
general rule, and Minesweeper's flag-toggle (`wireCellPress()`, the only current implementation)
is the reference to copy, not a one-off special case. The concrete failure mode, found there and
worth re-checking for any future long-press feature: a long-press action that calls a full
re-render (`renderAll()` rebuilding the pressed element's own `<div>` from scratch, e.g. via
`innerHTML = ''`) can let the still-in-flight `touchend`/`mouseup` for that same gesture land on
the *freshly-created replacement* element instead of the original one — and that replacement's
own event-wiring closure never recorded the long-press (its `longPressFired`-equivalent starts
`false`), so the gesture falls through to a normal tap on top of the long-press action that
already fired. In Minesweeper this meant a long-press-removed flag was immediately re-revealed.
Fixed there with a module-level `suppressTapIndex`, set only by the long-press timer callback (not
by the tap handler itself, so rapid legitimate re-taps of the same element are unaffected) and
consumed by the very next tap-handler call for that same index, regardless of which element's
closure ends up invoking it — copy this same module-level "consume once" guard for any new
long-press gesture that can trigger a re-render of the pressed element, rather than trusting the
per-element closure's own `longPressFired`-style flag alone.

## Sokoban level storage format (undocumented in-game, by request)

`sokoban/index.html`'s `LEVEL_SETS` stores each level as `{ w, h, p, d }` — deliberately *not* the
standard Sokoban ASCII notation (`# . $ @ * +`), and with no comment in the shipped file
explaining the scheme (the user asked for this to be kept out of the game's own source and
documented here instead). `w`/`h` are the grid's column/row count, `p` is the player's flat cell
index (`r*w+c`), and `d` is a base64 string packing three things, in this order, into a single bit
stream before base64-encoding:
1. A 1-bit-per-cell wall bitmap, `w*h` bits, row-major (bit set = wall or void — there's no
   separate "void vs. wall" distinction to resolve at decode time the way raw ASCII Sokoban text
   needs, since both are equally unwalkable and were already folded into this one bit when the
   data was generated).
2. Byte-aligned padding, then one byte holding the box count (== target count, always equal).
3. That many target cell indices, then that many box cell indices, each packed into the minimum
   bit width for the level's cell count (`ceil(log2(w*h))`) — using an explicit index list here
   instead of spending 2 more bits on every cell is what makes this tighter than a naive "3 bits
   for every cell" scheme, since boxes/targets are a small fraction of a level's cells.
Both the bit-stream's own bit order (first bit written = MSB of a multi-bit value) and its
byte-packing order (stream bit `i` -> bit `i & 7` of byte `i >> 3`, i.e. LSB-first within a byte)
matter and must match between encoder and decoder — a mismatch here silently produces garbage
that still "parses" without throwing, which is why this needs round-trip verification, not just a
syntax check. Decoding happens in `decodeLevel()` in that file. If you regenerate or add levels in
this format, round-trip-verify against the original source (parse → encode → decode → compare
wall/target/box/player sets across every level) before trusting the result, the way this was
verified both when the format was introduced and when it was later tightened further.
