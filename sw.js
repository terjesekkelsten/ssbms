/* SSBMS - service worker
 *
 * To cacher:
 *   ssbms-app-v2    applikasjonsfilene
 *   ssbms-tiles-v1  kartfliser
 *
 * STRATEGI - og hvorfor den ble endret:
 *
 * Første versjon var cache-først for ALT. Det ga et problem som bet med en gang
 * Supabase-nøklene ble lagt inn: en deployet endring i config.js var usynlig,
 * fordi nettleseren serverte den gamle fila fra cache. Verre - oppslaget brukte
 * ignoreSearch, så selv ?v=123 traff den gamle raden, og hard refresh hjalp ikke
 * pålitelig. Appen sa «KUN LOKALT» selv om riktig config lå ute.
 *
 * Nå:
 *   appfiler   nett først, med kort tidsavbrudd og cache som reserve.
 *              Er du på nett får du alltid siste versjon. Er du uten dekning
 *              faller den tilbake på cache umiddelbart.
 *   kartfliser cache først. Flisene endrer seg aldri for en gitt URL, og det er
 *              her offline-bruken faktisk ligger.
 *
 * Supabase og høydedata røres aldri - de skal alltid være ferske.
 */

const APP_CACHE = 'ssbms-app-v2';
const TILE_CACHE = 'ssbms-tiles-v1';
const MAX_TILES = 12000;
const NET_TIMEOUT_MS = 3500;

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
        // Rydder bort ssbms-app-v1 og alt annet som ikke er i bruk.
        keys.filter(k => k !== APP_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* En melding fra siden kan tvinge fram oppdatering uten at brukeren må grave
   i nettleserinnstillinger. Brukes av «Slett alt og logg ut». */
self.addEventListener('message', ev => {
  if (!ev.data) return;
  if (ev.data === 'skipWaiting') self.skipWaiting();
  if (ev.data === 'purgeApp') {
    ev.waitUntil(caches.delete(APP_CACHE).then(() => self.skipWaiting()));
  }
});

function isTile(url) {
  return url.hostname === 'cache.kartverket.no' && url.pathname.includes('/wmts/');
}

/** Nettverk med tidsavbrudd, slik at offline ikke gir lang venting.
 *
 * cache:'no-cache' tvinger en betinget forespørsel mot serveren. Uten den kan
 * nettleserens EGEN HTTP-cache svare før vi rekker å spørre, og da hjelper det
 * ikke at service workeren er nett-først - du får fortsatt gammel fil. */
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    let p;
    try { p = fetch(req, { cache: 'no-cache' }); }
    catch (e) { p = fetch(req); }          // noen forespørselstyper tåler ikke overstyring
    p.then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Kartfliser: cache først. Offline er hele poenget.
  if (isTile(url)) {
    ev.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) { cache.put(req, res.clone()); trimTiles(cache); }
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

  // Applikasjonsfiler: nett først, cache som reserve.
  ev.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);

    // Uten dekning: ikke bruk tid på å vente på et nettverk som ikke finnes.
    if (self.navigator && self.navigator.onLine === false) {
      const offlineHit = await cache.match(req, { ignoreSearch: true });
      if (offlineHit) return offlineHit;
    }

    try {
      const res = await fetchWithTimeout(req, NET_TIMEOUT_MS);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return new Response('Offline og ikke i cache: ' + url.pathname, {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
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
