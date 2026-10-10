// Inspection AI service worker: makes the app installable and lets the screens open without internet.
// AI checks (/api/...) always need internet and are never cached.
const CACHE = 'inspection-ai-v5.0.0';
const SHELL = [
  './', './index.html', './styles.css?v=5.0.0', './app.js?v=5.0.0', './live.js?v=5.0.0',
  './console.html', './console.css?v=5.0.0', './console.js?v=5.0.0', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/favicon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (always get the newest version), fall back to cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
