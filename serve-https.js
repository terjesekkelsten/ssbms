#!/usr/bin/env node
/* SSBMS - HTTPS-utviklingsserver
 *
 * Hvorfor denne finnes: Web Crypto (crypto.subtle), geolokasjon og service
 * worker er kun tilgjengelig i "secure context" - altså HTTPS eller localhost.
 * Åpner du appen fra telefonen på http://<PC-ens IP>:5173, er crypto.subtle
 * undefined og appen nekter å starte. Denne serveren gir HTTPS på eget nett,
 * med et selvsignert sertifikat som lages ved første kjøring.
 *
 *   node serve-https.js
 *
 * Telefonen vil vise en sertifikatadvarsel første gang. Det er forventet -
 * sertifikatet er ditt eget og ikke signert av noen kjent utsteder. Godta det,
 * så er origin en secure context og appen virker.
 *
 * Trafikken forlater ikke nettverket ditt.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PORT = parseInt(process.env.PORT || '5174', 10);
const ROOT = __dirname;
const CERT_DIR = path.join(ROOT, '.certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');

/* ---------- lokale IP-adresser ---------- */

function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/* ---------- sertifikat ---------- */

function loadSelfsigned() {
  try {
    return require('selfsigned');
  } catch (e) {
    console.log('Henter «selfsigned» for å lage et sertifikat (én gang)…');
    try {
      execSync('npm install selfsigned --no-save --silent', { cwd: ROOT, stdio: 'inherit' });
      return require('selfsigned');
    } catch (e2) {
      console.error('\nKlarte ikke installere «selfsigned».');
      console.error('Kjør manuelt:  npm install selfsigned --no-save');
      console.error('Eller bruk et av de andre alternativene i README.');
      process.exit(1);
    }
  }
}

async function ensureCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  }

  const selfsigned = loadSelfsigned();
  const addrs = localAddresses();

  // Sertifikatet må dekke alle adressene telefonen kan treffe PC-en på,
  // ellers får du en ekstra advarsel om navnefeil.
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
    { type: 7, ip: '127.0.0.1' },
    ...addrs.map(ip => ({ type: 7, ip }))
  ];

  console.log('Lager selvsignert sertifikat for:', ['localhost', os.hostname(), ...addrs].join(', '));

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 2);

  // selfsigned 5.x er async og bruker notBefore/notAfter; eldre 2.x er synkron
  // og bruker { days }. Vi sender begge og venter på resultatet uansett form.
  const pems = await Promise.resolve(selfsigned.generate(
    [{ name: 'commonName', value: addrs[0] || 'localhost' }],
    {
      days: 730, keySize: 2048, algorithm: 'sha256',
      notBeforeDate: notBefore, notAfterDate: notAfter,
      extensions: [{ name: 'subjectAltName', altNames }]
    }
  ));

  if (!pems || !pems.cert || !pems.private) {
    console.error('Sertifikatgenereringen ga ikke noe brukbart resultat.');
    console.error('Prøv:  npm install selfsigned@5 --no-save');
    process.exit(1);
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(CERT_FILE, pems.cert);
  fs.writeFileSync(KEY_FILE, pems.private);
  console.log('Sertifikat lagret i .certs/ (slett mappa for å lage nytt).\n');
  return { cert: pems.cert, key: pems.private };
}

/* ---------- statisk filserving ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8'
};

function serve(req, res) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'https://x').pathname);
  } catch (e) {
    res.writeHead(400); return res.end('Bad request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  // Ingen path traversal ut av prosjektmappa.
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  // Sertifikatet og nøkkelen serveres aldri.
  if (file.startsWith(CERT_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 – ' + rel);
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      // Utviklingsserver: aldri cache, så du slipper å lure på om endringen kom med.
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/'
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- start ---------- */

(async () => {
const { cert, key } = await ensureCert();

https.createServer({ cert, key }, serve).listen(PORT, '0.0.0.0', () => {
  const addrs = localAddresses();
  console.log('SSBMS kjører på HTTPS:\n');
  console.log('  PC:       https://localhost:' + PORT);
  addrs.forEach(a => console.log('  Telefon:  https://' + a + ':' + PORT));
  console.log('\nTelefonen viser en sertifikatadvarsel første gang.');
  console.log('Godta den (Safari: «Vis detaljer» → «Besøk dette nettstedet»,');
  console.log('Chrome: «Avansert» → «Fortsett»). Da er origin en secure context,');
  console.log('og crypto.subtle, GPS og offline-cache virker.\n');
  console.log('PC og telefon må være på samme nett, og brannmuren må slippe');
  console.log('inn port ' + PORT + '. Avslutt med Ctrl+C.');
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} er opptatt. Prøv: PORT=5175 node serve-https.js`);
  } else {
    console.error('Serveren startet ikke:', err.message);
  }
  process.exit(1);
});
})();
