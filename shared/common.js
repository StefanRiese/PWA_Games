// Shared helpers reused across every game in this repo. Loaded via
// <script src="../shared/common.js"></script> BEFORE each game's own inline <script> block, so
// these functions are already defined by the time a game's init() calls them. Extracted because
// this code was previously copy-pasted byte-for-byte into every single game file — see
// CLAUDE.md for the convention this establishes for new games.
//
// Each game still keeps its own `state`/`load()`/`save()` and its own STORAGE_KEY — only the
// shell-prefs read and the theme/pinch-zoom behavior are shared, since those are genuinely
// identical everywhere, unlike a game's own persisted state shape.

// Theme and language are configured only on the shell's settings page (see CLAUDE.md), not per
// game — read the shell's own storage key directly (same origin, so its localStorage is directly
// readable from any game page) so a game always matches whatever the player last chose there,
// instead of being stuck on its own copy from whenever it was last opened. Must be called AFTER
// a game's own load(), not before, so it wins.
function loadShellPrefs() {
  try {
    const raw = localStorage.getItem('pwa_games_v1');
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.darkMode === 'boolean') state.darkMode = p.darkMode;
      // 'ios' was this theme's original internal name before it was renamed to 'glossy' (only the
      // internal identifier changed, not the look) — map it forward so a value saved before the
      // rename still resolves correctly instead of silently falling back to dark/light.
      if (typeof p.theme === 'string') state.theme = p.theme === 'ios' ? 'glossy' : p.theme;
      if (typeof p.lang === 'string') state.lang = p.lang;
    }
  } catch {}
}

// state.theme ('dark'/'light'/'glossy') is the source of truth where a game/the shell tracks it;
// a game that only ever set state.darkMode (no theme field) falls back to the dark/light pair
// exactly as before — this keeps every existing game's flat light/dark behavior unchanged while
// letting the shell (and any game opting in later) add the additional glossy, iOS-inspired option.
// 'glossy' is purely the internal/state name — it was originally 'ios', renamed since the class/
// value shouldn't imply Apple's own OS; the UI-facing label has always been "Glossy".
function applyTheme() {
  const theme = state.theme || (state.darkMode ? 'dark' : 'light');
  const isLight = theme === 'light', isGlossy = theme === 'glossy';
  // Toggled on <html> too, not just <body> — shared/common.css reads var(--bg) on <html> itself
  // (see the comment there), which only resolves to the right theme if <html> actually carries
  // the matching class rather than always falling back to :root's dark default.
  document.documentElement.classList.toggle('light', isLight);
  document.documentElement.classList.toggle('glossy', isGlossy);
  document.body.classList.toggle('light', isLight);
  document.body.classList.toggle('glossy', isGlossy);
}

// Translation strings shared across every game — currently just the difficulty-tier labels,
// which must read identically everywhere. Games in this repo are never extracted/run standalone
// (see CLAUDE.md), so duplicating a translation that has to always match across a dozen files
// has no portability upside, only drift risk (exactly what happened before this existed: Snake
// used its own "Slow/Normal/Fast" wording instead of "Easy/Medium/Hard"). A game's own t()
// should fall back to sharedT(key) after checking its local I18N — see any game with a
// difficulty row for the exact pattern.
const SHARED_I18N = {
  de: { diff_easy: 'Leicht', diff_medium: 'Mittel', diff_hard: 'Schwer' },
  en: { diff_easy: 'Easy', diff_medium: 'Medium', diff_hard: 'Hard' },
};
function sharedT(key) {
  return SHARED_I18N[state.lang][key];
}

// Portrait-lock overlay (see shared/common.css's #rotate-overlay rule for why this exists at all —
// iOS has no real API to lock an installed PWA's orientation, so a blocking overlay in landscape
// is the only actual fallback). Injected here, once, into every page that loads common.js, rather
// than duplicating this markup into every game's own HTML. Built and appended eagerly at load
// time — safe because common.js is always loaded from inside <body>, after the body markup above
// it in the document already exists (same assumption the pinch-zoom listener below already
// makes). Bilingual text (DE/EN together) rather than picking one: this runs before a game's own
// `state`/`load()` have set `state.lang`, so sharedT()/state.lang aren't available yet — same
// reasoning as sw.js's OFFLINE_FALLBACK_HTML. The CSS media query (not JS) decides when it's
// actually shown, so this needs no resize/orientationchange listener of its own.
(function injectRotateOverlay() {
  const el = document.createElement('div');
  el.id = 'rotate-overlay';
  el.innerHTML = '<div class="icon">📱↻</div><div class="msg">Bitte drehe dein Gerät zurück ins Hochformat.<br/>Please rotate your device back to portrait.</div>';
  document.body.appendChild(el);
})();

// Shared icon set for topbar/control buttons (back, reset, pause, undo, rotate, hard-drop,
// sensor-calibrate, d-pad arrows) — small stroke-based SVGs using currentColor so they pick up
// whatever color a button already has (var(--text) via inheritance) with no per-theme work needed,
// unlike the colorful per-game identity icons in the shell's own GAMES array (which intentionally
// hardcode var(--accent)/var(--muted) to look "branded" rather than functional). Kept here, not
// copy-pasted into every game file, since — like SHARED_I18N above — these must read identically
// everywhere; see CLAUDE.md for the convention this follows.
const ICON_SVGS = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11A8 8 0 1 0 18.5 16.5"/><path d="M20 4v7h-7"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4.2" height="16" rx="1.2" fill="currentColor"/><rect x="13.8" y="4" width="4.2" height="16" rx="1.2" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11A8 8 0 1 1 5.5 16.5"/><path d="M4 4v7h7"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 3v6h6"/></svg>',
  drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="M7 9l5 5 5-5"/><path d="M5 19h14"/></svg>',
  calibrate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 4v2.4M12 17.6V20M4 12h2.4M17.6 12H20"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 6.5 18.5 16H5.5Z" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 17.5 5.5 8h13Z" fill="currentColor"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M6.5 12 16 5.5v13Z" fill="currentColor"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M17.5 12 8 18.5v-13Z" fill="currentColor"/></svg>',
};
// Matched by the button's exact (trimmed) text glyph rather than its aria-label — aria-labels are
// German in some games and English in others, but the glyph itself is language-independent. Only
// .icon-btn/.dpad-btn/.ctrl-btn are scanned (not every <button>) so a button that happens to
// contain one of these characters as part of a longer label (e.g. "🌙 Dunkel") is never touched —
// GLYPH_TO_ICON only matches a button whose *entire* trimmed content is one bare glyph.
const GLYPH_TO_ICON = {
  '←': 'back', '🔄': 'reset', '⏸': 'pause', '↩️': 'undo', '↩': 'undo',
  '⟳': 'rotate', '⤓': 'drop', '⚖️': 'calibrate',
  '▲': 'up', '▼': 'down', '◀': 'left', '▶': 'right',
};
function applyIconGlyph(btn) {
  const icon = ICON_SVGS[GLYPH_TO_ICON[btn.textContent.trim()]];
  if (icon && btn.innerHTML !== icon) btn.innerHTML = icon;
}
// Every button matched here is static HTML in every game (verified: none of these classes are ever
// document.createElement'd at runtime), so a load-time pass alone would cover most of them — except
// a pause/play button, which several games toggle between '⏸'/'▶' via `btn.textContent = ...` on
// every play/pause instead of just at load. A MutationObserver re-applies the icon whenever that
// happens, rather than editing every game's own pause-toggle code individually. The `btn.innerHTML
// !== icon` check above avoids the observer looping on the mutation its own replacement causes.
(function applyIconGlyphs() {
  const buttons = document.querySelectorAll('.icon-btn, .dpad-btn, .ctrl-btn');
  buttons.forEach(applyIconGlyph);
  const observer = new MutationObserver(mutations => {
    const seen = new Set();
    for (const m of mutations) {
      const btn = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (btn && !seen.has(btn)) { seen.add(btn); applyIconGlyph(btn); }
    }
  });
  buttons.forEach(btn => observer.observe(btn, { childList: true }));
})();

// Pinch/double-tap-zoom prevention, identical in every game in this repo: gesturestart/
// gesturechange preventDefault() (Safari-specific) plus a document-level multi-touch touchmove
// fallback for platforms without gesture events (e.g. Android Chrome). body's own touchmove
// listener handles the multi-touch case BEFORE calling stopPropagation() (not after) — otherwise
// stopPropagation() on a single-touch move would swallow the document-level listener's
// multi-touch check, leaving pinch-zoom unblocked on those platforms.
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.body.addEventListener('touchmove', e => {
  if (e.touches.length > 1) { e.preventDefault(); return; }
  e.stopPropagation();
}, { passive: false });
