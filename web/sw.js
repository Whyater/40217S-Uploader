// App shell cache. scripts/publish-web.sh replaces VERSION when it publishes,
// so every deploy gets a fresh cache and phones pick up the new app.
const VERSION = 'dev';
const CACHE_PREFIX = 'scourge-shell-';
const CACHE = CACHE_PREFIX + VERSION;
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './transport.js',
  './releases.js',
  './map.html',
  './mapdata.js',
  './mapstore.js',
  './maptab.js',
  './mapcloud.js',
  './manifest.webmanifest',
  './protocol/index.js',
  './protocol/connection.js',
  './protocol/crc.js',
  './protocol/device.js',
  './protocol/errors.js',
  './protocol/framing.js',
  './protocol/md5.js',
  './protocol/program.js',
  './protocol/upload.js',
  './protocol/vendor/pako.mjs',
  './vendor/serial-polyfill.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // All or nothing: if any file fails, install fails and the previous worker
    // (with its complete cache) keeps serving. activate only runs after a full install.
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Release data belongs to releases.js; let the network (or its own cache) answer.
  if (url.pathname.includes('/build/')) return;
  // The map download is team data fetched from another origin, so it already
  // bypasses this worker. This keeps it that way if the relay is ever proxied
  // under this origin: it is never cached here.
  if (url.pathname.endsWith('/map')) return;
  event.respondWith((async () => {
    const shell = await caches.open(CACHE);
    const hit = await shell.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') {
        const page = await shell.match('./index.html') || await shell.match('./');
        if (page) return page;
      }
      throw e;
    }
  })());
});
