const CACHE = 'gym-v10';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest', './seed/history.json',
  './assets/bodymap.svg', './icons/lucide.svg', './icons/gym.svg', './icons/gym-180.png',
  './icons/gym-192.png', './icons/gym-512.png', './icons/gym-maskable-512.png',
  './js/app.js', './js/db.js', './js/engine.js', './js/metrics.js', './js/import.js', './js/history.js', './js/program.js', './js/sync.js', './js/mock.js',
  './js/ui/common.js', './js/ui/import-wizard.js', './js/ui/library.js', './js/ui/plate.js', './js/ui/training.js',
  './js/ui/today.js', './js/ui/progress.js', './js/ui/program-ui.js', './js/coach.js', './js/ui/coach-ui.js'
];
const FONTS = ['./fonts/Geist-Variable.woff2'];
const scoped = path => new URL(path, self.registration.scope).href;
const assets = new Set([...SHELL, ...FONTS].map(scoped));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map(scoped));
    await Promise.allSettled(FONTS.map(path => cache.add(scoped(path))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(name => name.startsWith('gym-') && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const path = url.origin + url.pathname;
  if (!assets.has(path)) return;
  const key = request.mode === 'navigate' ? scoped('./index.html') : path;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(key);
    if (saved) return saved;
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  })());
});
