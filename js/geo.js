/* SSBMS - projeksjon, UTM og MGRS
 *
 * Alle interne koordinater holdes i UTM (ETRS89 / EPSG:258xx) for den sonen
 * nøkkelen angir. WGS84 brukes kun mot GPS og mot Leaflets lat/lng-API.
 */

const SSBMSGeo = (() => {
  'use strict';

  proj4.defs('EPSG:25832', '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
  proj4.defs('EPSG:25833', '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
  proj4.defs('EPSG:25835', '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

  // Kartverkets WMTS-matrisesett (verifisert mot WMTSCapabilities.xml).
  // ScaleDenominator * 0.00028 m/px = oppløsning i meter per piksel.
  const SCALE_DENOMINATORS = [
    77371428.57142857, 38685714.28571428, 19342857.14285714, 9671428.57142857,
    4835714.285714285, 2417857.1428571427, 1208928.5714285714, 604464.2857142857,
    302232.1428571428, 151116.0714285714, 75558.0357142857, 37779.0178571429,
    18889.5089285714, 9444.7544642857, 4722.3772321429, 2361.1886160714,
    1180.5943080357, 590.2971540179, 295.1485770089
  ];

  const RESOLUTIONS = SCALE_DENOMINATORS.map(s => s * 0.00028);

  // Ulikt origo per sone - hentet fra capabilities.
  const MATRIX = {
    32: { set: 'utm32n', epsg: 'EPSG:25832', origin: [-2000000, 9045984] },
    33: { set: 'utm33n', epsg: 'EPSG:25833', origin: [-2500000, 9045984] },
    35: { set: 'utm35n', epsg: 'EPSG:25835', origin: [-3500000, 9045984] }
  };

  /* ---------- konvertering ---------- */

  function toUTM(lat, lng, zone) {
    const [e, n] = proj4('EPSG:4326', MATRIX[zone].epsg, [lng, lat]);
    return { e, n };
  }

  function toLatLng(e, n, zone) {
    const [lng, lat] = proj4(MATRIX[zone].epsg, 'EPSG:4326', [e, n]);
    return { lat, lng };
  }

  /** Standard UTM-sone for en lengdegrad, inkl. Norges særregel for belte V. */
  function nominalZone(lat, lng) {
    if (lat >= 56 && lat < 64 && lng >= 3 && lng < 12) return 32;
    if (lat >= 72 && lat < 84) {
      if (lng >= 0 && lng < 9) return 31;
      if (lng >= 9 && lng < 21) return 33;
      if (lng >= 21 && lng < 33) return 35;
      if (lng >= 33 && lng < 42) return 37;
    }
    return Math.floor((lng + 180) / 6) + 1;
  }

  /* ---------- MGRS ---------- */

  const COL_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // 24 bokstaver, uten I og O
  const ROW_ALPHA = 'ABCDEFGHJKLMNPQRSTUV';       // 20 bokstaver, uten I og O
  const BAND_ALPHA = 'CDEFGHJKLMNPQRSTUVWX';      // breddegradsbelter

  function latBand(lat) {
    if (lat >= 72 && lat <= 84) return 'X';
    if (lat < -80 || lat > 84) return '?';
    return BAND_ALPHA[Math.floor((lat + 80) / 8)] || '?';
  }

  /** 100 km-rutens to bokstaver. */
  function squareId(zone, e, n) {
    const set = ((zone - 1) % 6) + 1;
    const colOrigin = [0, 8, 16, 0, 8, 16][set - 1];
    const colIdx = Math.floor(e / 100000) - 1;
    const rowOrigin = (set % 2 === 1) ? 0 : 5;
    const rowIdx = Math.floor(n / 100000) % 20;
    if (colIdx < 0 || colIdx > 23) return '??';
    return COL_ALPHA[(colOrigin + colIdx) % 24] + ROW_ALPHA[(rowOrigin + rowIdx) % 20];
  }

  /**
   * MGRS-referanse.
   * @param precision antall siffer per akse (1=10km ... 5=1m). Standard 5.
   */
  function toMGRS(e, n, zone, lat, precision = 5) {
    if (!isFinite(e) || !isFinite(n)) return '—';
    const band = latBand(lat);
    const sq = squareId(zone, e, n);
    const div = Math.pow(10, 5 - precision);
    const ee = Math.floor((Math.floor(e) % 100000) / div);
    const nn = Math.floor((Math.floor(n) % 100000) / div);
    return `${zone}${band} ${sq} ${String(ee).padStart(precision, '0')} ${String(nn).padStart(precision, '0')}`;
  }

  /* ---------- MGRS inn ---------- */

  /** Snapper en verdi til den av kandidatene k*period som ligger nærmest ref. */
  function snapTo(value, ref, period) {
    return value + Math.round((ref - value) / period) * period;
  }

  /** 100 km-rutens bokstaver -> hjørnekoordinat. refN løser 2 000 km-syklusen. */
  function squareOrigin(zone, colLetter, rowLetter, refN) {
    const set = ((zone - 1) % 6) + 1;
    const colOrigin = [0, 8, 16, 0, 8, 16][set - 1];
    const ci = COL_ALPHA.indexOf(colLetter);
    if (ci < 0) return null;
    const colIdx = (ci - colOrigin + 24) % 24;
    if (colIdx > 7) return null;                 // ikke en gyldig rute i denne sonen
    const rowOrigin = (set % 2 === 1) ? 0 : 5;
    const ri = ROW_ALPHA.indexOf(rowLetter);
    if (ri < 0) return null;
    const rowIdx = (ri - rowOrigin + 20) % 20;
    return {
      e100k: (colIdx + 1) * 100000,
      n100k: snapTo(rowIdx * 100000, refN, 2000000)
    };
  }

  /** Deler en sifferstreng med like mange siffer på hver akse. */
  function splitDigits(str) {
    const d = str.replace(/\D+/g, '');
    if (d.length < 2 || d.length > 10 || d.length % 2) return null;
    const h = d.length / 2;
    const mult = Math.pow(10, 5 - h);
    return { de: parseInt(d.slice(0, h), 10) * mult, dn: parseInt(d.slice(h), 10) * mult, figures: d.length };
  }

  /**
   * Tolker en rutereferanse skrevet eller limt inn av brukeren.
   * Godtar:
   *   full MGRS       32V NM 12345 67890
   *   MGRS uten sone  NM 12345 67890
   *   UTM absolutt    584837 6639530  /  E584837 N6639530
   *   kort feltrute   848 395  /  84837 39530     (løses mot ref)
   *
   * @param ref {e,n} referansepunkt for å løse 100 km-ruta og 2 000 km-syklusen
   * @returns {{e,n,format,figures}|null}
   */
  function parseGrid(text, zone, ref) {
    const raw = String(text || '').toUpperCase().replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) return null;
    const refE = (ref && isFinite(ref.e)) ? ref.e : 500000;
    const refN = (ref && isFinite(ref.n)) ? ref.n : 6600000;

    // 1) Full MGRS med sone og breddegradsbelte
    let m = raw.match(/^(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*([\d ]+)$/);
    if (m) return fromSquare(parseInt(m[1], 10), m[3], m[4], m[5], refN, 'mgrs');

    // 2) MGRS uten sone - bruker sesjonens sone
    m = raw.match(/^([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*([\d ]+)$/);
    if (m) return fromSquare(zone, m[1], m[2], m[3], refN, 'mgrs');

    // 3) Rene tall, eventuelt med E/N-merking.
    //    Bokstaver utover E/Ø/N her betyr at dette var ment som MGRS, men er
    //    feilskrevet. Da avvises det heller enn å tolkes som en kort rute -
    //    en stille feiltolkning ville plassert enheten i feil 100 km-rute.
    const cleaned = raw.replace(/[EØN]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/[A-Z]/.test(cleaned)) return null;
    const nums = cleaned.match(/\d+/g);
    if (!nums || !nums.length) return null;

    if (nums.length === 2) {
      const a = parseInt(nums[0], 10), b = parseInt(nums[1], 10);
      // Nording i Norge er sjusifret. Da er dette absolutte UTM-koordinater.
      if (b >= 1000000 && nums[1].length >= 7) {
        return { e: a, n: b, format: 'utm', figures: null };
      }
      if (nums[0].length !== nums[1].length) return null;
      return fromShort(nums[0] + nums[1], refE, refN);
    }
    if (nums.length === 1) return fromShort(nums[0], refE, refN);
    return null;

    function fromSquare(z, col, row, digits, rN, format) {
      if (!MATRIX[z] && !(z >= 1 && z <= 60)) return null;
      const sq = squareOrigin(z, col, row, rN);
      const d = splitDigits(digits);
      if (!sq || !d) return null;
      return { e: sq.e100k + d.de, n: sq.n100k + d.dn, format, figures: d.figures };
    }

    function fromShort(digits, rE, rN) {
      const d = splitDigits(digits);
      if (!d) return null;
      // Kort rute er relativ til 100 km-ruta. Snap til den nærmeste rundt referansen,
      // slik at referanser like over en 100 km-grense treffer riktig.
      return {
        e: snapTo(Math.floor(rE / 100000) * 100000 + d.de, rE, 100000),
        n: snapTo(Math.floor(rN / 100000) * 100000 + d.dn, rN, 100000),
        format: 'kort', figures: d.figures
      };
    }
  }

  /** Kort feltreferanse: kun 100 m-siffer, slik det leses over samband. */
  function toShortGrid(e, n) {
    const ee = Math.floor((Math.floor(e) % 100000) / 100);
    const nn = Math.floor((Math.floor(n) % 100000) / 100);
    return String(ee).padStart(3, '0') + ' ' + String(nn).padStart(3, '0');
  }

  /* ---------- retning og avstand ---------- */

  const COMPASS_16 = ['N', 'NNØ', 'NØ', 'ØNØ', 'Ø', 'ØSØ', 'SØ', 'SSØ',
    'S', 'SSV', 'SV', 'VSV', 'V', 'VNV', 'NV', 'NNV'];

  function compass(deg) {
    const d = ((deg % 360) + 360) % 360;
    return COMPASS_16[Math.round(d / 22.5) % 16];
  }

  /** Grid-bearing i UTM-planet (kartnord, ikke geografisk nord). */
  function bearing(fromE, fromN, toE, toN) {
    const d = Math.atan2(toE - fromE, toN - fromN) * 180 / Math.PI;
    return ((d % 360) + 360) % 360;
  }

  function distance(fromE, fromN, toE, toN) {
    return Math.hypot(toE - fromE, toN - fromN);
  }

  function formatDistance(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  /** Meridiankonvergens: forskjell mellom kartnord og geografisk nord, i grader. */
  function convergence(lat, lng, zone) {
    const lng0 = (zone * 6) - 183;
    return Math.atan(Math.tan((lng - lng0) * Math.PI / 180) * Math.sin(lat * Math.PI / 180)) * 180 / Math.PI;
  }

  /* ---------- rutenett ---------- */

  const GRID_STEPS = [10, 100, 1000, 10000, 100000];

  /** Velger rutenettavstand slik at linjene ligger minst minPx fra hverandre. */
  function gridStep(resolution, minPx = 55) {
    for (const s of GRID_STEPS) {
      if (s / resolution >= minPx) return s;
    }
    return 100000;
  }

  return {
    RESOLUTIONS, SCALE_DENOMINATORS, MATRIX,
    toUTM, toLatLng, nominalZone,
    toMGRS, toShortGrid, latBand, squareId, parseGrid, squareOrigin,
    compass, bearing, distance, formatDistance, convergence,
    gridStep, COMPASS_16
  };
})();
