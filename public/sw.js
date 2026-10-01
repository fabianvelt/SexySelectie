// Service worker: maakt de app installeerbaar en laat hem openen zonder netwerk.
// Strategie: eerst netwerk (zodat je altijd de nieuwste versie krijgt), bij
// geen verbinding de opgeslagen versie. De API wordt nooit gecachet.
const CACHE = 'sexyselectie-v1';
const SHELL = ['/', '/app.js', '/styles.css', '/legal.css', '/manifest.webmanifest', '/icons/icon-192.png', '/offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') return caches.match('/offline.html');
        return Response.error();
      }),
  );
});
