/* MindSpark service worker — offline access to the app shell.
 *
 * Deliberately conservative. A service worker that caches too eagerly is
 * worse than none at all: it can pin users to a stale build that no reload
 * fixes. The rules here are:
 *
 *   - HTML is network-first, so a deploy is picked up on the next load and
 *     the cached copy is only a fallback when offline.
 *   - App CODE (js/css) is network-first, same as HTML. This project has no
 *     build step and no content hashing in filenames, so app.js keeps the
 *     same URL forever. Serving it cache-first pinned every browser that had
 *     loaded the app once to that exact build — no reload fixed it, and only
 *     a manual CACHE bump would have released it. That is not a theoretical
 *     risk: it silently shipped a stale app.js and made a deployed bug fix
 *     look like it had not worked.
 *   - Only genuinely immutable assets (icons) stay cache-first.
 *   - /api/* and cross-origin requests are never touched. Map data lives in
 *     SQLite or the user's own GitHub repo; serving a stale copy of it would
 *     be actively harmful, not merely unhelpful.
 *   - Only GET is handled. Anything else falls through to the network.
 */
const CACHE = 'mindspark-shell-v3';   // bumped: v1/v2 could pin clients to a stale app.js

const SHELL = [
  './',
  './index.html',
  './app.js',
  './templates.js',
  './styles.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  // addAll() is atomic — one 404 discards the whole cache. Fetch each entry
  // individually so a single missing optional asset can't block install.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch { /* offline at install time; fetched on demand later */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => (n !== CACHE && n.startsWith('mindspark-') ? caches.delete(n) : null)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // fonts, avatars, GitHub API
  if (url.pathname.startsWith('/api/')) return;      // never serve stale map data
  if (url.pathname === '/healthz') return;           // storage-mode probe must be live

  const isHTML = request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');
  // Treat app code like HTML: it changes on every deploy and its URL never does.
  const isAppCode = /\.(?:js|mjs|css|webmanifest)$/.test(url.pathname);

  if (isHTML || isAppCode) {
    // Network-first: always prefer a fresh shell, fall back when offline.
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
        return res;
      } catch {
        const hit = await caches.match(request);
        if (hit) return hit;
        // Only fall back to the shell for navigations — returning index.html
        // in place of a missing .js would be worse than a clean failure.
        if (isHTML) {
          return (await caches.match('./index.html')) ||
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        }
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // Immutable assets only (icons): cache-first is safe because their
  // contents never change without the filename changing.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const res = await fetch(request);
      if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
      return res;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
