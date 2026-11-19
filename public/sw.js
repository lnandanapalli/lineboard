// Minimal offline support: cache the app shell. Supabase requests (other origin) are never cached.
const CACHE = 'lineboard-v1';
/** Build files kept for offline use (old ones from earlier deploys are dropped). */
const MAX_ASSETS = 80;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/assets/')) {
    // Hashed build files never change: cache first.
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then(async (c) => {
              await c.put(req, copy);
              // Every deploy brings new hashed files: keep the newest ones, drop the rest.
              const keys = (await c.keys()).filter((k) => new URL(k.url).pathname.startsWith('/assets/'));
              for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await c.delete(k);
            });
            return res;
          }),
      ),
    );
    return;
  }
  // Everything else (index.html, config.js, icons): network first, fall back to cache when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html'))),
  );
});
