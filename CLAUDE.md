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
- `games_icon.png` — home-screen / manifest icon (512×512, matching `manifest.json`): a flat
  game-controller glyph on a dark gradient, matching the launcher's `--accent` blue/`theme_color`.
- `README.md` — user-facing feature docs (German).
- Each game lives in its own subfolder (e.g. `some-game/index.html`), following the same
  "one file, no build tools" premise as the shell itself, and is linked from the shell's `GAMES`
  array.

There is intentionally no `src/`, no framework, and no bundler, for the shell or for any game
added under it.

## Commands

There is no build, lint, or test tooling in this repo (no `package.json`). To develop:

- **Preview locally**: serve the directory over HTTP (not `file://`, since the Service Worker
  requires a proper origin) — e.g. `python3 -m http.server 8000` — then open
  `http://localhost:8000/index.html`.
- **Sanity-check JS syntax** (no linter configured): extract and parse the inline `<script>`
  block, e.g. `node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"`.
- **Deploy**: push the repo root (plus any game subfolders) to `main`; GitHub Pages serves it
  directly (Settings → Pages → Deploy from branch → `main` / root).

## Architecture (shell)

State (currently just the theme) is a plain `state` object persisted to `localStorage` under
`STORAGE_KEY = 'pwa_games_v1'` via `load()`/`save()`. There is no framework — `applyTheme()`
toggles the `.light` class on `<body>`, and `renderGames()` renders the `GAMES` array (or an
empty-state message when it's empty) into `#games-grid`. When you add a new piece of shell state,
follow the existing pattern: mutate `state`, call the relevant `render*()`, then `save()`.

**Games list**: `GAMES` is a plain array of `{ id, emoji, name, desc, url }` — `url` is a
repo-relative path to that game's own `index.html`. Adding a game means adding its subfolder plus
one entry here; the shell itself doesn't need any other change.

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
Registration only happens while `navigator.onLine`.

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
self-contained (its own state/localStorage key, its own render logic) rather than sharing runtime
state with the shell or with other games.

Each game still keeps its own `I18N`/`t()`/`applyLang()` pattern and its own `state.darkMode`/
`state.lang` (loaded from/saved to its own `localStorage` key, same as any other piece of that
game's state) — but games deliberately do **not** render a theme or language toggle button
themselves. Those controls live only in the shell's settings subpage (see above); a game simply
reads whatever `darkMode`/`lang` it last had saved (defaulting dark/German like the others) with
no in-game way to change either. Don't reintroduce a `theme-toggle`/`lang-toggle` button or
`icon-group` in a game's topbar — that pattern was deliberately removed from every game.

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
