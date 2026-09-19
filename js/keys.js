/* SSBMS - nøkkelhåndtering, krypto og grid-origo
 *
 * Nøkkelformat: 18 siffer
 *   d1..d10  sesjonshemmelighet  -> rom-ID + krypteringsnøkkel
 *   d11..d13 AO-origo østing     i km        (000-999  ->        0 .. 999 000 m)
 *   d14..d16 AO-origo nording    i 10 km     (000-999  ->        0 .. 9 990 000 m)
 *   d17      UTM-sone            2 | 3 | 5   (EPSG:25832 / 25833 / 25835)
 *   d18      Luhn-kontrollsiffer over d1..d10
 *
 * Designvalg (bevisst):
 *   - Kontrollsifferet dekker KUN sesjonsdelen. En tastefeil i sesjonsdelen
 *     avvises umiddelbart. En tastefeil i grid-delen slipper gjennom og gir
 *     korrekt dekryptert data plottet med systematisk forskyvning - som spesifisert.
 *   - Krypteringsnøkkelen utledes KUN av sesjonsdelen. Feil grid-siffer skal gi
 *     data, ikke dekrypteringsfeil.
 *
 * Sikkerhetsforbehold - les README:
 *   Sesjonsdelen er 10 siffer ~= 33 bit. PBKDF2 med høyt iterasjonstall hever
 *   kostnaden per gjetning, men dette er IKKE en passordsterk nøkkel. Den
 *   beskytter mot tilfeldig innsyn og mot at tjenesten leser innholdet, ikke mot
 *   en motstander som har fanget chiffertekst og har tid.
 */

const SSBMSKey = (() => {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const PBKDF2_ITERATIONS = 600000;
  const ZONE_BY_DIGIT = { '2': 32, '3': 33, '5': 35 };
  const DIGIT_BY_ZONE = { 32: '2', 33: '3', 35: '5' };

  /* ---------- Luhn ---------- */

  function luhnRemainder(digits) {
    // digits: string. Doubling starts from the rightmost position.
    let sum = 0;
    let dbl = true;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = digits.charCodeAt(i) - 48;
      if (dbl) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      dbl = !dbl;
      sum += n;
    }
    return sum % 10;
  }

  function luhnCheckDigit(digits) {
    return String((10 - luhnRemainder(digits)) % 10);
  }

  function luhnValid(digitsWithCheck) {
    const body = digitsWithCheck.slice(0, -1);
    return luhnCheckDigit(body) === digitsWithCheck.slice(-1);
  }

  /* ---------- parsing ---------- */

  function normalise(raw) {
    return String(raw || '').replace(/\D+/g, '');
  }

  function format(raw) {
    const d = normalise(raw).slice(0, 18);
    return d.replace(/(.{6})(?=.)/g, '$1 ').trim();
  }

  /**
   * Parser en 18-sifret nøkkel.
   * @returns {{ok:boolean, error?:string, key?:object}}
   */
  function parse(raw) {
    const d = normalise(raw);
    if (d.length !== 18) {
      return { ok: false, error: `Nøkkelen må være 18 siffer (fikk ${d.length}).` };
    }

    const session = d.slice(0, 10);
    const originEkm = parseInt(d.slice(10, 13), 10);
    const originN10km = parseInt(d.slice(13, 16), 10);
    const zoneDigit = d[16];
    const check = d[17];

    if (!(zoneDigit in ZONE_BY_DIGIT)) {
      return { ok: false, error: `Siffer 17 må være 2, 3 eller 5 (UTM-sone 32/33/35). Fikk ${zoneDigit}.` };
    }
    if (luhnCheckDigit(session) !== check) {
      return { ok: false, error: 'Kontrollsifferet stemmer ikke. Sjekk de 10 første sifrene og det siste.' };
    }

    return {
      ok: true,
      key: {
        raw: d,
        session,
        zone: ZONE_BY_DIGIT[zoneDigit],
        epsg: 'EPSG:258' + ZONE_BY_DIGIT[zoneDigit],
        originE: originEkm * 1000,
        originN: originN10km * 10000,
        gridDigits: d.slice(10, 17)
      }
    };
  }

  /**
   * Bygger en nøkkel fra komponenter. Brukes av nøkkelgeneratoren.
   */
  function build({ session, originE, originN, zone }) {
    const s = normalise(session).padStart(10, '0').slice(-10);
    const ekm = Math.round(originE / 1000);
    const n10 = Math.round(originN / 10000);
    if (ekm < 0 || ekm > 999) throw new Error('Origo-østing utenfor 0-999 km');
    if (n10 < 0 || n10 > 999) throw new Error('Origo-nording utenfor 0-9990 km');
    if (!(zone in DIGIT_BY_ZONE)) throw new Error('Sone må være 32, 33 eller 35');
    const body = s + String(ekm).padStart(3, '0') + String(n10).padStart(3, '0') + DIGIT_BY_ZONE[zone];
    return body + luhnCheckDigit(s);
  }

  function randomSession() {
    const b = new Uint32Array(2);
    crypto.getRandomValues(b);
    const n = (BigInt(b[0]) * 4294967296n + BigInt(b[1])) % 10000000000n;
    return String(n).padStart(10, '0');
  }

  /* ---------- utledning ---------- */

  function toHex(buf) {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha256Hex(str) {
    return toHex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
  }

  /**
   * Utleder rom-ID og AES-GCM-nøkkel fra sesjonsdelen.
   * Grid-sifrene inngår bevisst IKKE.
   */
  async function derive(key) {
    const roomId = (await sha256Hex('SSBMS|v1|room|' + key.session)).slice(0, 32);

    const material = await crypto.subtle.importKey(
      'raw', enc.encode(key.session), 'PBKDF2', false, ['deriveKey']
    );
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc.encode('SSBMS|v1|enc|' + roomId),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    return { roomId, aesKey };
  }

  /* ---------- kryptering ---------- */

  function b64(buf) {
    let s = '';
    const a = new Uint8Array(buf);
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }

  function unb64(str) {
    const s = atob(str);
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }

  async function encryptJSON(aesKey, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(obj))
    );
    return { iv: b64(iv), ct: b64(ct) };
  }

  async function decryptJSON(aesKey, payload) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(payload.iv) }, aesKey, unb64(payload.ct)
      );
      return JSON.parse(dec.decode(pt));
    } catch (e) {
      return null; // feil nøkkel eller manipulert data
    }
  }

  return {
    normalise, format, parse, build, randomSession,
    derive, encryptJSON, decryptJSON,
    luhnCheckDigit, luhnValid, sha256Hex,
    PBKDF2_ITERATIONS
  };
})();
