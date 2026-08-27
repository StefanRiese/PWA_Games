// Service Worker for the Klo-App launcher shell — see CLAUDE.md's "Offline/installability"
// section for the full design rationale (cache-first fetch, static cache name, shell-fallback
// chain, no-store/bfcache handling). This used to be generated as a template-literal string and
// registered from a Blob URL directly inside index.html's own <script> block; it now lives here
// as a real static file instead — registered via `navigator.serviceWorker.register('sw.js', ...)`
// — purely to make it independently readable/diffable, not a change in behavior. One side effect
// worth knowing: OFFLINE_FALLBACK_HTML's embedded `<script>...</script>` no longer needs the
// escaped-slash trick that was required while this lived inside an HTML file's own <script> block
// (see CLAUDE.md's `</script>`-footgun paragraph) — this file is parsed as plain JS, not scanned
// by an HTML parser, so a literal closing-script-tag substring inside a JS string here is inert.

const CACHE = 'pwa-games-shell';

// This file (sw.js) sits alongside index.html at the repo root, so its own location gives the
// same directory self.registration.scope would — no need for index.html to pass it in.
const SCOPE = new URL('./', self.location).pathname;
const SHELL = [SCOPE, SCOPE + 'index.html', SCOPE + 'manifest.json', SCOPE + 'games_icon.png'];
const SHARED_ASSETS = [SCOPE + 'shared/common.css', SCOPE + 'shared/common.js'];

// Shown for a navigation that's neither in Cache Storage nor reachable over the network (a
// brand-new game not yet cached, opened for the first time while offline) — replaces the
// browser's own generic connection-error page with something on-brand that at least offers a
// retry, following the "offline fallback page" pattern from
// https://web.dev/articles/offline-fallback-page. This is only the last-resort fallback — the
// fetch handler below tries the cached shell itself first, since that's always cached (SHELL[0]/
// SHELL[1], the two entries install() fails hard on) and is fully functional, unlike this static
// page. Deliberately bilingual (DE/EN together) rather than picking one: this Service Worker has
// no access to the page's own localStorage-stored language preference, and guessing wrong would
// be worse than showing both.
const OFFLINE_FALLBACK_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Offline</title>
<style>
  body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; background:#0b0c0f; color:#eef0f3; font-family:-apple-system,BlinkMacSystemFont,sans-serif; text-align:center; padding:24px; box-sizing:border-box; }
  .icon { font-size:48px; }
  h1 { font-size:18px; margin:0; font-weight:600; }
  p { margin:0; color:#8d94a1; font-size:14px; }
  button { margin-top:8px; padding:12px 28px; border-radius:10px; background:#2563eb; color:#fff; border:0; font-size:15px; font-weight:600; }
  button:active { filter:brightness(0.85); }
</style></head>
<body>
  <div class="icon">🚽</div>
  <h1>Keine Internetverbindung<br/>No internet connection</h1>
  <p>Diese Seite ist offline noch nicht verfügbar.<br/>This page isn't available offline yet.</p>
  <button onclick="location.reload()">Erneut versuchen / Try again</button>
  <script>window.addEventListener('online', () => location.reload());</script>
</body></html>`;

// Every game's URL lives in index.html's own GAMES array, which this file can't statically import
// (no build step) — so instead of duplicating that list here (drift risk if one copy is edited and
// not the other), install() fetches the live index.html and regex-extracts every `url: '...'`
// entry from its GAMES array, the same "fetch + regex the source text" technique checkForUpdates()
// already uses in index.html to read APP_VERSION. This keeps GAME_ASSETS genuinely derived from
// GAMES, not separately maintained — adding a game's entry to GAMES remains the only change needed
// for it to get cached too.
async function deriveGameAssetUrls() {
  try {
    const res = await fetch(SHELL[1]);
    if (!res.ok) return [];
    const text = await res.text();
    const urls = [];
    const re = /url:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(text))) urls.push(new URL(m[1], self.location.origin + SCOPE).pathname);
    return urls;
  } catch {
    return [];
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const results = await Promise.allSettled(SHELL.map(u =>
      fetch(u).then(r => { if (!r.ok) throw new Error('bad status ' + r.status); return c.put(u, r); })
    ));
    // Game pages (and the shared CSS/JS they depend on) are cached best-effort alongside the
    // shell — a failure here doesn't fail the whole install (unlike SHELL[0]/SHELL[1] above),
    // since a game that isn't cached yet just falls back to needing network for this one, same as
    // every game did before this feature existed; it isn't as critical as the shell itself being
    // available offline.
    const gameUrls = [...SHARED_ASSETS, ...(await deriveGameAssetUrls())];
    await Promise.allSettled(gameUrls.map(u =>
      fetch(u).then(r => { if (!r.ok) throw new Error('bad status ' + r.status); return c.put(u, r); })
    ));
    if (results[0].status === 'rejected' && results[1].status === 'rejected') {
      throw new Error('shell fetch failed');
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  event.respondWith((async () => {
    const isNavigate = event.request.mode === 'navigate';
    // Navigations get an explicit Cache-Control: no-store on the response itself (not just the
    // outgoing request), applied uniformly whether the response came from Cache Storage or a live
    // fetch — a no-store *request* alone still let iOS Safari's back-forward cache (bfcache)
    // restore a fully-rendered snapshot of a page from a previous visit without ever hitting this
    // fetch handler again on the next visit, which would silently hide a since-refreshed cache
    // entry (e.g. after checkForUpdates() writes a newer game page into Cache Storage) behind a
    // stale bfcache snapshot. A no-store response header opts the page out of bfcache eligibility
    // so every visit re-runs this handler and sees the current cache state.
    const stampNoStore = res => {
      if (!isNavigate) return res;
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };
    const cached = await caches.match(event.request);
    if (cached) return stampNoStore(cached);
    // Anything not in Cache Storage — a game added to GAMES since this cache was last populated,
    // or any other request this SW doesn't know about — falls through to a real network
    // round-trip. cache:'no-store' bypasses the *browser's* own HTTP cache, which otherwise still
    // silently re-serves stale bytes regardless of any SW-level caching.
    try {
      const res = await fetch(event.request, { cache: 'no-store' });
      return stampNoStore(res);
    } catch (err) {
      // A genuinely offline fetch throws (rather than resolving with an error status), so this
      // only ever fires for the real "nothing cached, no network" case — e.g. a game added to
      // GAMES since this cache was last refreshed, opened for the first time while offline. For a
      // navigation specifically, fall back to the cached shell itself rather than a dead-end
      // static page: the shell is always cached (it's SHELL[0]/SHELL[1], the two entries install()
      // fails hard on), fully functional, and lets the user get back into the app and open any
      // other already-cached game instead of being stuck. OFFLINE_FALLBACK_HTML (see its own
      // comment above) is only the very last resort, for the rare case where even the shell
      // somehow isn't cached yet either (e.g. the first-ever offline open before install() has
      // ever completed). Anything else (a sub-resource fetch, e.g. an asset a game references
      // directly) still just fails outright — a fallback page only makes sense for something the
      // user is actually looking at.
      if (isNavigate) {
        const shellFallback = (await caches.match(SHELL[1])) || (await caches.match(SHELL[0]));
        if (shellFallback) return stampNoStore(shellFallback);
        return new Response(OFFLINE_FALLBACK_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
        });
      }
      throw err;
    }
  })());
});
