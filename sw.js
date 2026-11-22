// Offline support: serve from cache, refresh the cache in the background.
const CACHE = 'pdf-tools-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'i18n.js', 'icon.svg', 'icon-192.png', 'manifest.webmanifest',
  'lib/pdf-lib.min.js', 'lib/jszip.min.js', 'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'shared-files').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Files shared from other apps (Android share sheet) arrive as a POST to share-target.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open('shared-files');
      for (const k of await cache.keys()) await cache.delete(k);
      let i = 0;
      for (const f of form.getAll('file')) {
        if (!f || typeof f === 'string') continue;
        await cache.put(`shared/${i++}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'file') } }));
      }
      return Response.redirect('./#shared', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => cached);
    return cached || fresh;
  }));
});
