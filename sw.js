// Offline support.
// - Pages (index.html) and content/**/*.json: network first (3 s timeout), falling
//   back to the cache, so edits show up without a version bump when online.
// - Everything else in SHELL: precached on install and served cache first.
// Bump VERSION whenever a shell file changes (CI checks this on pull requests).
// A new version waits until the user taps "Reload" in the app (no auto skipWaiting).
const VERSION = 'v13';
const CACHE = `langhub-${VERSION}`;
const NETWORK_TIMEOUT = 3000;
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/languages.js',
  './js/coach.js',
  './js/coachviews.js',
  './js/listen.js',
  './js/review.js',
  './js/recommend.js',
  './js/picks.js',
  './js/server.js',
  './js/serverviews.js',
  './js/shadow.js',
  './js/shadowkit.js',
  './js/videos.js',
  './js/yt.js',
  './content/it/clips.json',
  './content/it/scenes.json',
  './content/it/cards.json',
  './content/it/articles.json',
  './content/it/videos.json',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache: 'reload' skips the browser's HTTP cache (GitHub Pages sends max-age=600),
    // so a new version is never filled with files from the old one.
    await c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    // Migration: pages from v7 and older can't show the "Reload" prompt (they only say
    // "it will load next time", which never happens while the app stays in memory), so
    // take over directly when one of their caches is still here.
    const keys = await caches.keys();
    if (keys.some((k) => /^langhub-v[1-7]$/.test(k))) self.skipWaiting();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('langhub-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const cacheable = (res) => res && res.ok && res.type === 'basic';

/** Network first with a timeout; the cache answers if the network is slow or down. */
function networkFirst(e, key, fallbackKey) {
  const cached = caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true }))
    .then((hit) => hit || (fallbackKey ? caches.open(CACHE).then((c) => c.match(fallbackKey)) : undefined));
  const network = fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async (res) => {
    if (cacheable(res)) {
      // A navigation can't be answered with a redirected response, so copy it.
      const body = res.redirected ? new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res.clone();
      const c = await caches.open(CACHE);
      await c.put(key, body.clone());
      return res.redirected ? body : res;
    }
    return res;
  });
  e.waitUntil(network.catch(() => {}));
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => cached.then(finish), NETWORK_TIMEOUT);
    network.then((res) => {
      clearTimeout(timer);
      // Prefer a good cached copy over a server error page.
      if (!res.ok) return cached.then((hit) => finish(hit || res));
      finish(res);
    }, () => {
      clearTimeout(timer);
      cached.then((hit) => finish(hit || Response.error()));
    });
  });
}

function cacheFirst(e) {
  return caches.open(CACHE).then((c) => c.match(e.request, { ignoreSearch: true })).then((hit) => {
    if (hit) return hit;
    return fetch(e.request).then((res) => {
      // Runtime-cache other same-origin files (e.g. the vendored voice SDK). Opaque and
      // error responses are never cached.
      if (cacheable(res)) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
      }
      return res;
    });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  const path = url.pathname.slice(scope.pathname.length);
  // Clip audio lives in its own cache (lhclips-v1), managed by the page.
  if (path.startsWith('clips-cache/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(e, url.origin + url.pathname, './index.html'));
  } else if (path.startsWith('content/') && path.endsWith('.json')) {
    e.respondWith(networkFirst(e, url.origin + url.pathname));
  } else {
    e.respondWith(cacheFirst(e).catch(() => Response.error()));
  }
});
