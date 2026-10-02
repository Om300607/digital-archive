// Offline shell: network-first so new deployments show up immediately, cache as fallback.
const CACHE = 'digital-archive-v1';
const SHELL = [
  './', './index.html', './css/styles.css', './manifest.webmanifest',
  './src/ui/main.js', './src/ui/dom.js', './src/ui/views.js', './src/ui/detail.js', './src/ui/native.js',
  './src/services/archiveService.js', './src/storage/db.js', './src/storage/fileStore.js',
  './src/domain/errors.js', './src/domain/fileTypes.js', './src/domain/filters.js', './src/domain/fingerprint.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html'))),
  );
});
