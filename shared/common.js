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
      if (typeof p.theme === 'string') state.theme = p.theme;
      if (typeof p.lang === 'string') state.lang = p.lang;
    }
  } catch {}
}

// state.theme ('dark'/'light'/'ios') is the source of truth where a game/the shell tracks it;
// a game that only ever set state.darkMode (no theme field) falls back to the dark/light pair
// exactly as before — this keeps every existing game's flat light/dark behavior unchanged while
// letting the shell (and any game opting in later) add the additional iOS-styled option.
function applyTheme() {
  const theme = state.theme || (state.darkMode ? 'dark' : 'light');
  const isLight = theme === 'light', isIos = theme === 'ios';
  // Toggled on <html> too, not just <body> — shared/common.css reads var(--bg) on <html> itself
  // (see the comment there), which only resolves to the right theme if <html> actually carries
  // the matching class rather than always falling back to :root's dark default.
  document.documentElement.classList.toggle('light', isLight);
  document.documentElement.classList.toggle('ios', isIos);
  document.body.classList.toggle('light', isLight);
  document.body.classList.toggle('ios', isIos);
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
