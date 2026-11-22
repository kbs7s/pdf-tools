// Offline support: serve from cache, refresh the cache in the background.
const CACHE = 'pdf-tools-v2';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'i18n.js', 'icon.svg', 'icon-192.png', 'manifest.webmanifest',
  'lib/pdf-lib.min.js', 'lib/jszip.min.js', 'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => cached);
    return cached || fresh;
  }));
});
