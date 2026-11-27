// Offline support.
// APP cache: the site itself (refreshed in the background, so updates arrive).
// LIB cache: the PDF/OCR/password engines in lib/. These never change for a given
// version, so they are served straight from the cache and kept across site updates.
const APP = 'pdf-tools-app-v5';
const LIB = 'pdf-tools-lib-1';
const APP_FILES = ['./', 'index.html', 'style.css', 'app.js', 'i18n.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'];
const CORE_LIBS = ['lib/pdf-lib.min.js', 'lib/jszip.min.js', 'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs'];
// Everything needed for every tool to work with no internet (about 17 MB, downloaded once).
const ALL_LIBS = [...CORE_LIBS, 'lib/qpdf/qpdf.js', 'lib/qpdf/qpdf.wasm',
  'lib/tesseract/tesseract.min.js', 'lib/tesseract/worker.min.js',
  'lib/tesseract/tesseract-core-lstm.wasm.js', 'lib/tesseract/tesseract-core-simd-lstm.wasm.js',
  'lib/tessdata/ara.traineddata.gz', 'lib/tessdata/eng.traineddata.gz'];
const abs = p => new URL(p, self.registration.scope).href;

self.addEventListener('install', e => {
  e.waitUntil(Promise.all([
    caches.open(APP).then(c => c.addAll(APP_FILES)),
    caches.open(LIB).then(async c => { for (const f of CORE_LIBS) if (!await c.match(abs(f))) await c.add(abs(f)); }),
  ]).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![APP, LIB, 'shared-files'].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// The page asks us to download the rest of the engines and reports progress back.
let filling = null;
async function fill() {
  const c = await caches.open(LIB);
  let have = 0, failed = false;
  const tell = async extra => { for (const cl of await self.clients.matchAll({ includeUncontrolled: true })) cl.postMessage({ type: 'offline', have, total: ALL_LIBS.length, ...extra }); };
  for (const f of ALL_LIBS) {
    if (!await c.match(abs(f))) {
      await tell({});
      try { const r = await fetch(abs(f), { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); await c.put(abs(f), r); }
      catch { failed = true; continue; }
    }
    have++;
  }
  await tell({ done: !failed, failed });
}
self.addEventListener('message', e => {
  if (e.data === 'offline-fill') { filling = filling || fill().finally(() => { filling = null; }); e.waitUntil(filling); }
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
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/lib/')) {
    // Engines: cache first, download once.
    e.respondWith(caches.open(LIB).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok && !e.request.headers.has('range')) c.put(url.origin + url.pathname, r.clone());
      return r;
    }));
    return;
  }
  // Site files: answer from the cache at once, refresh it in the background.
  e.respondWith(caches.open(APP).then(async cache => {
    let cached = await cache.match(e.request, { ignoreSearch: true });
    if (!cached && e.request.mode === 'navigate') cached = await cache.match(abs('./'));
    const fresh = fetch(e.request).then(r => { if (r.ok && r.type === 'basic') cache.put(e.request, r.clone()); return r; }).catch(() => cached || Response.error());
    return cached || fresh;
  }));
});
