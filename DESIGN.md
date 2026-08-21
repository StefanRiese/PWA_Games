# Design Guide

This documents the visual and interaction design system shared by the launcher and every game
in this repo, so a new game reads as "one more room in the same house" rather than a bolted-on
one-off. It's a design reference — see `CLAUDE.md` for repo layout, build/deploy commands, and
the reasoning behind specific architectural decisions (Service Worker caching, bfcache, i18n
discipline, etc.). When the two disagree, `CLAUDE.md` wins on *why*; this file wins on *how it
should look*.

## Philosophy

- **One file, no build step.** Every game is a single self-contained `index.html` — inline
  `<style>`, inline `<script>`, no external requests beyond the page itself. Copy an existing
  game as your starting point rather than writing one from scratch; the closest existing game to
  what you're building (grid game, canvas/physics game, puzzle game) is the right template.
- **Touch-first, one-handed, portrait.** Every control is a tap target sized for a thumb, not a
  mouse pointer. Design for a phone in one hand before considering keyboard/mouse as a bonus.
- **Own state, own identity.** Each game has its own `localStorage` key, its own render loop, its
  own copy of shared patterns (i18n, theme). Nothing is imported or shared at runtime between
  games or with the shell — consistency comes from copying the same patterns, not from a shared
  library.

## Design tokens

Every game (and the shell) opens with the identical `:root` token block, dark by default with a
`.light` class override:

```css
:root {
  --bg: #0b0c0f; --card: #17191f; --border: rgba(255,255,255,0.09);
  --text: #eef0f3; --muted: #8d94a1;
  --btn: #20232b; --btn-border: rgba(255,255,255,0.12);
  --accent: #2563eb; --success: #22c55e; --danger: #ef4444;
  --radius-sm: 12px; --radius-md: 16px; --radius-lg: 22px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px;
  --font-md: 14px;
}
.light {
  --bg: #f4f5f9; --card: #ffffff; --border: rgba(15,23,42,0.08);
  --text: #14161b; --muted: #6b7280;
  --btn: #edeff3; --btn-border: rgba(15,23,42,0.10);
}
```

Don't invent new tokens for things these already cover (a new shade of gray, a new spacing
value). `--font-md` (14px) is the one harmonized text size for all UI chrome — labels, buttons,
status text. Game content (board glyphs, scores, big numbers) sets its own size relative to the
board, not from this token.

`--accent`/`--success`/`--danger` are semantic, not decorative: accent = the active/selected
state (a chosen difficulty, a toggle that's on), success = won/positive, danger = lost/negative
or destructive.

## Page shell

```css
html { height: 100%; height: 100dvh; overflow: hidden; position: fixed; width: 100%; }
body {
  height: 100%; height: 100dvh; background: var(--bg);
  font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: var(--text);
  -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: env(safe-area-inset-top, var(--space-4)) var(--space-3) env(safe-area-inset-bottom, var(--space-6));
  display: flex; flex-direction: column; gap: var(--space-3);
  transition: background 0.3s;
}
button { font-family: inherit; cursor: pointer; border: none; background: none; color: inherit;
  transition: transform 0.15s cubic-bezier(0.34,1.56,0.64,1); }
button:active { transform: scale(0.93); }
button:disabled { cursor: not-allowed; transform: none; opacity: 0.4; }
button:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
```

`body` is a top-to-bottom flex column — every major section (topbar, difficulty row, status row,
board, action row) is just a direct child in document order, spaced by the shared `gap`. Don't
reach for absolute positioning to lay out the page; the board's own overlays (pause veil, hint
veil) are the exception, not the rule.

## Topbar

Every game's topbar is identical in structure: back button, title, and (if the game has a
restart action) a "New" button — both icon buttons, back on the left, new pushed to the far
right by `margin-left: auto` on the last icon button, title in between.

```css
.topbar { display: flex; align-items: center; justify-content: flex-start; margin-top: var(--space-2); gap: var(--space-2); }
.topbar h1 { font-size: 20px; font-weight: 600; }
.topbar .icon-btn:last-child { margin-left: auto; }
.icon-btn { width: 44px; height: 44px; border-radius: var(--radius-sm); background: var(--btn);
  border: 0.5px solid var(--btn-border); font-size: 18px; display: flex; align-items: center;
  justify-content: center; flex: none; }
```

```html
<div class="topbar">
  <button class="icon-btn" id="back-btn" aria-label="Back">←</button>
  <h1>🔴 Game Name</h1>
  <button class="icon-btn" id="new-btn" aria-label="New">🔄</button>
</div>
```

`back-btn` always navigates `location.href = '../index.html'`. `new-btn` is icon-only (no text
label) — set its accessible name via `aria-label`, translated in `applyLang()`, not via visible
text. If restarting is non-destructive (nothing to lose), skip the confirm step; if it discards
progress, route it through the confirm-row pattern below.

## Difficulty / mode picker

A row of equal-width toggle buttons, one active at a time — used for puzzle difficulty
(Sudoku, Minesweeper) and computer opponent strength (Pong) alike:

```css
.difficulty-row { display: flex; gap: var(--space-2); }
.diff-btn { flex: 1; padding: var(--space-2) 0; border-radius: var(--radius-sm); background: var(--btn);
  border: 0.5px solid var(--btn-border); font-size: var(--font-md); color: var(--muted); min-height: 40px; }
.diff-btn.active { background: var(--accent); color: #fff; border-color: transparent; }
```

```js
function renderDifficulty() {
  const row = document.getElementById('difficulty-row');
  row.innerHTML = '';
  for (const d of DIFFICULTIES) {
    const btn = document.createElement('button');
    btn.className = 'diff-btn' + (d.id === state.difficulty ? ' active' : '');
    btn.textContent = t(d.labelKey);
    btn.onclick = () => askDifficultyChange(d.id);
    row.appendChild(btn);
  }
}
```

Switching difficulty is destructive (it restarts the game), so it goes through
`askDifficultyChange()` → the same confirm-row as "New" (see below), with a `pendingDifficulty`
variable so confirm-yes knows what to switch to. The row itself stays visible and tappable even
after the game ends (win/loss), so the player can pick a new difficulty for their next game
without an extra step — see Pong's or Minesweeper's `askDifficultyChange`/`closeConfirm` for the
exact wiring, including restoring whichever panel (action row, lose banner, result overlay) was
actually showing before the confirm interrupted it.

## Status row / stat tiles

Score, timer, lives, turn indicator — small stat tiles in a row:

```css
.status-row { display: flex; gap: var(--space-3); }
.panel-box { flex: 1; background: var(--card); box-shadow: 0 1px 3px rgba(0,0,0,0.15), 0 0 0 0.5px var(--border);
  border-radius: var(--radius-md); padding: var(--space-3); text-align: center; }
.panel-box .label { font-size: var(--font-md); color: var(--muted); margin-bottom: var(--space-1); }
.panel-box .value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
```

For a single-line status (not tiled), Sudoku/Peg Solitaire instead use a plain flex row with
`justify-content: space-between` and `var(--font-md)` text — pick whichever reads better for the
data at hand, but don't invent a third pattern.

## Board

```css
.board-wrap { display: flex; justify-content: center; }
.board {
  display: grid;
  grid-template-columns: repeat(N, 1fr);
  grid-template-rows: repeat(N, 1fr);
  gap: 4px; /* or 0 for a seamless grid like Minesweeper */
  width: min(100%, 380px, calc(100dvh - Xpx));
  aspect-ratio: 1 / 1;
  background: var(--card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.15), 0 0 0 0.5px var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-2);
}
```

The `calc(100dvh - Xpx)` term is load-bearing: it caps the board so the whole page fits the
viewport height without scrolling, on both short and tall phones. `X` is "everything else on the
page" (topbar + status row + controls + safe-area padding) — measure it empirically for your
specific layout, same as every existing game does; don't skip this or a game will scroll on
small/landscape screens. For a canvas-based board (Tetris, Snake, Breakout, Pong, 2048's tile
animation-friendly cousins), the same `calc()` budgeting applies to the `<canvas>` element's CSS
`width` instead of a grid.

For a DOM-grid board (Minesweeper, Peg Solitaire — and Checkers), each cell is a `div.cell`
appended by a `renderBoard()` that clears and rebuilds `#board.innerHTML` from scratch on every
change; wire `onclick` per cell rather than delegating from the board container, and set
`role="button"` on interactive cells for accessibility.

## Selection / reachable-square highlighting

The tap-to-select-then-tap-to-act pattern (Peg Solitaire, and now Checkers): tapping a movable
piece selects it and highlights its legal destinations; tapping a highlighted square commits the
move; tapping the selected piece again deselects it.

```css
.cell.selected .piece { box-shadow: 0 0 0 3px var(--success), <existing piece shadow>; }
.cell.reachable { background: rgba(34,197,94,0.25); }
```

## Confirm-before-destructive-action

Any action that discards progress (starting a new game, switching difficulty mid-game) shows a
confirm row in place of the normal action row, rather than acting immediately:

```css
.confirm-row { display: flex; gap: var(--space-3); align-items: center; }
.confirm-row span { flex: 1; font-size: var(--font-md); color: var(--muted); }
.btn-secondary { padding: var(--space-3) 20px; border-radius: var(--radius-sm); border: 0.5px solid var(--btn-border);
  background: var(--btn); font-size: var(--font-md); color: var(--text); min-height: 48px; }
.btn-danger { padding: var(--space-3) 20px; border-radius: var(--radius-sm); background: var(--danger);
  color: #fff; font-size: var(--font-md); min-height: 48px; }
```

```html
<div class="confirm-row" id="confirm-row" style="display:none;">
  <span id="confirm-text">Start a new game? Progress will be lost.</span>
  <button class="btn-secondary" id="confirm-no">No</button>
  <button class="btn-danger" id="confirm-yes">Yes</button>
</div>
```

`askNewGame()` hides whatever's normally showing (action row, topbar new-btn) and shows this;
`closeConfirm()` reverses it, restoring the panel that was actually visible before (not always
the same one — see the difficulty-row note above).

## End-of-game feedback: the result-banner

Any game with a genuine win-or-lose ending (Minesweeper, Snake, Peg Solitaire, Pong, Checkers)
shows **both** outcomes the same way: a single in-flow banner, not a full-screen overlay — so the
final board (every mine, the snake's last position, the computer's winning position) stays
visible instead of being covered right when the player wants to see what happened. It replaces
the action row (or, for a game whose only bottom-row control is the topbar's `new-btn`, that
button) in place:

```css
.result-banner { display: flex; align-items: center; gap: var(--space-3); background: var(--card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.15), 0 0 0 0.5px var(--border); border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3); }
.result-text { flex: 1; min-width: 0; font-size: var(--font-md); font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-text.win { color: var(--success); }
.result-text.lose { color: var(--danger); }
.result-banner .action-btn { flex: none; padding: var(--space-2) var(--space-4); min-height: 44px; }
```

```html
<div class="result-banner" id="result-banner" style="display:none;">
  <span class="result-text" id="result-text"></span>
  <button class="action-btn" id="result-new-btn">New game</button>
</div>
```

A vs-computer or difficulty-picker game tracks the outcome in a `won` boolean set in `endGame()`
(or wherever the win/loss check lives), used for two things: picking `.result-text`'s `win`/`lose`
class + message, and telling `askNewGame()`/`closeConfirm()` — triggered by "New" or a difficulty
switch, both of which stay reachable after the match ends — which panel (`new-btn` vs.
`result-banner`) to hide/restore. See Checkers' or Pong's `endGame()`/`closeConfirm()` for the
exact wiring.

This is the current default for **any** new game with a win/lose ending — a full-screen overlay
for a win only (and something else for a loss) is the pattern this replaced; don't reintroduce
that asymmetry. The one exception is a genuine mid-game milestone that isn't the end of the game
(2048's "you reached 2048, keep playing or restart?" popup) — that's a different situation (a
choice with two live options, not a completed match) and a blocking overlay is still right there.
Sudoku's solve celebration is also left as a full overlay, since Sudoku has no losing outcome to
be inconsistent with.

## i18n

Every game ships German (default) and English, switchable from the shell's settings page (not
from inside the game itself — see `CLAUDE.md`'s note on this). The pattern is always:

```js
const I18N = {
  de: { back: 'Zurück', new_game: '🔄 Neu', /* ... */ },
  en: { back: 'Back',   new_game: '🔄 New', /* ... */ },
};
function t(key) { return (I18N[state.lang] && I18N[state.lang][key]) || I18N.de[key] || key; }
```

One `applyLang()` function sets every piece of translatable UI text/aria-label in one place, and
is called on init and whenever `state.lang` changes. A key used only for an icon button's
`aria-label` doesn't need an emoji baked into the string (that's for a visible text label) —
match whichever the existing key already does rather than introducing a third convention.

## State & persistence

```js
const STORAGE_KEY = 'gamename_v1';
let state = { darkMode: true, lang: 'de', /* game-specific fields */ };
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.darkMode === 'boolean') state.darkMode = p.darkMode;
      if (typeof p.lang === 'string') state.lang = p.lang;
      // ...
    }
  } catch {}
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}
```

Every field is read back with a `typeof` guard, never trusted blindly — a corrupted or
older-shape value in storage should fall back to the hardcoded default, not crash the first
render.

## Touch/gesture handling

Every game blocks pinch-zoom and double-tap-zoom the same way (see `CLAUDE.md` for *why* the
`stopPropagation()` ordering matters):

```js
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.body.addEventListener('touchmove', e => {
  if (e.touches.length > 1) { e.preventDefault(); return; }
  e.stopPropagation();
}, { passive: false });
```

Copy this block verbatim into every new game.

## `init()`

```js
function init() {
  load();
  applyTheme();
  applyLang();   // or newGame() first if applyLang() reads game state (see Peg Solitaire vs Pong ordering)
  newGame();
}
init();
```

## Checklist for a new game

1. Copy the closest existing game as a starting file (grid board → Peg Solitaire/Minesweeper;
   canvas/physics → Pong/Breakout/Tetris/Snake).
2. Reuse the token block, topbar, and touch-handling block verbatim.
3. Pick difficulty-row (if there's a computer opponent or puzzle difficulty), status-row style,
   and end-of-game pattern (overlay vs. lose-banner) from the guidance above — don't invent new
   ones.
4. Write `I18N`/`t()`/`applyLang()` with both `de` and `en` from the start.
5. Add the subfolder + one `GAMES` entry in the shell's `index.html`; bump `APP_VERSION`.
