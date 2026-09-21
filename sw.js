const VERSION = 'home-medicine-v1.1.1';
const BASE = new URL('./', self.location.href);
const CACHE = `${VERSION}:${BASE.pathname}`;
const FILES = ['./', './index.html', './styles.css', './app.js', './core.js', './db.js', './backup.js', './photos.js', './ocr.js', './ocr-parser.js', './ocr-ui.js', './ocr-worker.js', './vendor/ocr/ASSETS.json', './vendor/ocr/chi_sim.traineddata.gz', './vendor/ocr/eng.traineddata.gz', './vendor/ocr/LICENSE-core', './vendor/ocr/LICENSE-tesseract-js', './vendor/ocr/tesseract-core-lstm.wasm.js', './vendor/ocr/tesseract-core-simd-lstm.wasm.js', './vendor/ocr/tesseract-core-simd.wasm.js', './vendor/ocr/tesseract-core.wasm.js', './vendor/ocr/tesseract.min.js', './vendor/ocr/worker.min.js', './manifest.json', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(path => new Request(new URL(path, BASE).href, { cache: 'reload' })))).then(() => self.skipWaiting()));
  // Complete the cache before activation. Never reload an open editor; the next
  // user-initiated reload receives this version, even with other PWA windows open.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('home-medicine-') && name.endsWith(`:${BASE.pathname}`) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (request.mode === 'navigate') return (await cache.match(new URL('./index.html', BASE))) || fetch(request);
    return (await cache.match(request, { ignoreSearch: true })) || fetch(request);
  })());
});
