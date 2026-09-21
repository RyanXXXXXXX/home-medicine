// Worker network boundary: only immutable bundled engine/model GETs are permitted.
// Images enter through postMessage as bytes; no user text or image enters a URL.
const assetBase = new URL('./vendor/ocr/', self.location.href);
const allowed = new Set(['worker.min.js', 'chi_sim.traineddata.gz', 'eng.traineddata.gz', 'tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'].map(name => new URL(name, assetBase).href));
const nativeFetch = self.fetch.bind(self), nativeImport = self.importScripts.bind(self);
self.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  self.postMessage({ status: 'fatal', data: String(event.reason?.message || event.reason || 'Worker promise failed') });
});
self.fetch = async (input, options = {}) => {
  const request = new Request(input, options);
  if (!allowed.has(request.url) || request.method !== 'GET' || request.body) return Promise.reject(new Error('OCR only permits bundled static resources'));
  try {
    const response = await nativeFetch(request, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch { throw new Error(`Bundled resource unavailable: ${new URL(request.url).pathname.split('/').pop()}`); }
};
self.importScripts = (...urls) => {
  const resolved = urls.map(url => new URL(url, self.location.href).href);
  if (resolved.some(url => !allowed.has(url))) throw new Error('Unbundled OCR script blocked');
  return nativeImport(...resolved);
};
for (const key of ['XMLHttpRequest', 'WebSocket', 'EventSource']) self[key] = class { constructor() { throw new Error('OCR network transport disabled'); } };
self.importScripts(new URL('worker.min.js', assetBase).href);
