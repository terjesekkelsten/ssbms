/* SSBMS - service worker
 *
 * To cacher:
 *   ssbms-app-v1    applikasjonsfilene, cache-first
 *   ssbms-tiles-v1  kartfliser, cache-first med nettverksoppfriskning.
 *                   Fylles både passivt (fliser du har sett) og aktivt
 *                   (Meny > Last ned kart for offline bruk).
 *
 * Tjenestearbeideren rører aldri data fra Supabase eller høydetjenesten -
 * de skal alltid være ferske, og feiler stille når enheten er uten samband.
 */

const APP_CACHE = 'ssbms-app-v1';
const TILE_CACHE = 'ssbms-tiles-v1';
const MAX_TILES = 12000;

const APP_FILES = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css',
  './vendor/leaflet.js', './vendor/leaflet.css',
  './vendor/proj4.js', './vendor/proj4leaflet.js', './vendor/supabase.js',
  './vendor/images/marker-icon.png', './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png', './vendor/images/layers.png', './vendor/images/layers-2x.png',
  './js/config.js', './js/keys.js', './js/geo.js', './js/symbols.js',
  './js/map.js', './js/store.js', './js/sync.js', './js/los.js',
  './js/ui.js', './js/app.js',
  './icons/icon.svg'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(APP_CACHE)
      .then(c => Promise.allSettled(APP_FILES.map(f => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== APP_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isTile(url) {
  return url.hostname === 'cache.kartverket.no' && url.pathname.includes('/wmts/');
}

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Kartfliser: cache-først. Offline er hele poenget.
  if (isTile(url)) {
    ev.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          cache.put(req, res.clone());
          trimTiles(cache);
        }
        return res;
      } catch (e) {
        // Gjennomsiktig flis i stedet for ødelagt kart
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"></svg>',
          { headers: { 'Content-Type': 'image/svg+xml' } }
        );
      }
    })());
    return;
  }

  // Alt annet på andre verter (Supabase, høydedata) går rett på nettet.
  if (url.origin !== self.location.origin) return;

  // Applikasjonsfiler: cache-først, oppdater i bakgrunnen.
  ev.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  })());
});

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      // FIFO: eldste oppføringer først
      await Promise.all(keys.slice(0, keys.length - MAX_TILES).map(k => cache.delete(k)));
    }
  } finally {
    trimming = false;
  }
}
