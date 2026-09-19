/* SSBMS - siktlinje mot Kartverkets høydedata
 *
 * FORBEHOLD - må vises i UI:
 * Terrengmodellen (DTM) er BAR BAKKE. Den inneholder ikke skog, bygninger eller
 * annen vegetasjon. I norsk terreng gir det systematisk for optimistiske
 * siktlinjer. Resultatet er en terrengsperre-analyse, ikke en sikthetsvurdering.
 */

const SSBMSLos = (() => {
  'use strict';

  const API = 'https://ws.geonorge.no/hoydedata/v1/profil';
  const EARTH_R = 6371000;
  const REFRACTION_K = 0.13;   // standard atmosfærisk refraksjon

  const cache = new Map();

  /**
   * Henter terrengprofil mellom to UTM-punkter.
   * @returns {Promise<{ok:boolean, points?:Array<{d:number,z:number,e:number,n:number}>, error?:string, source?:string}>}
   */
  async function fetchProfile(a, b, zone, samples = 180) {
    const key = `${zone}|${Math.round(a.e)}|${Math.round(a.n)}|${Math.round(b.e)}|${Math.round(b.n)}|${samples}`;
    if (cache.has(key)) return cache.get(key);

    const url = `${API}?koordsys=258${zone}` +
      `&punkter=${encodeURIComponent(JSON.stringify([[a.e, a.n], [b.e, b.n]]))}` +
      `&geojson=false&antall=${samples}`;

    let result;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const raw = extractPoints(json);
      if (!raw.length) throw new Error('Tomt svar fra høydetjenesten');

      const total = Math.hypot(b.e - a.e, b.n - a.n);
      const points = raw.map((p, i) => ({
        e: p.x, n: p.y, z: p.z,
        d: raw.length > 1 ? (i / (raw.length - 1)) * total : 0
      }));
      result = { ok: true, points, source: extractSource(json) };
    } catch (e) {
      result = { ok: false, error: e.message || String(e) };
    }

    cache.set(key, result);
    return result;
  }

  function extractPoints(json) {
    const arr = json && (json.punkter || json.points || json.Punkter);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(p => ({
        x: num(p.x ?? p.X ?? p.ost ?? p.east),
        y: num(p.y ?? p.Y ?? p.nord ?? p.north),
        z: num(p.z ?? p.Z ?? p.hoyde ?? p.height)
      }))
      .filter(p => isFinite(p.x) && isFinite(p.y) && isFinite(p.z));
  }

  function extractSource(json) {
    const d = json && (json.datakilder || json.Datakilder);
    if (Array.isArray(d) && d.length) {
      const first = d[0];
      return typeof first === 'string' ? first : (first.datakildenavn || first.navn || 'Kartverket');
    }
    return 'Kartverket';
  }

  function num(v) { return typeof v === 'number' ? v : parseFloat(v); }

  /**
   * Beregner sikt langs en profil.
   * @param points fra fetchProfile
   * @param obsHeight øyehøyde over bakken ved start (m)
   * @param tgtHeight målhøyde over bakken (m)
   */
  function analyse(points, obsHeight = 1.7, tgtHeight = 1.7) {
    if (!points || points.length < 2) return null;

    const z0 = points[0].z + obsHeight;
    let maxSlope = -Infinity;
    const out = [];
    let firstBlockAt = null;

    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const d = p.d;
      if (d <= 0) continue;
      const curv = (d * d * (1 - REFRACTION_K)) / (2 * EARTH_R);

      // Sperreprofil: bakken selv
      const groundSlope = (p.z - curv - z0) / d;
      // Synlighet for et mål med høyde tgtHeight
      const targetSlope = (p.z + tgtHeight - curv - z0) / d;

      const visible = targetSlope >= maxSlope;
      if (!visible && firstBlockAt === null) firstBlockAt = d;

      out.push({
        d, z: p.z, e: p.e, n: p.n, visible,
        clearance: (maxSlope === -Infinity) ? null
          : (z0 + maxSlope * d) - (p.z - curv)   // fri høyde over sperrelinjen
      });

      if (groundSlope > maxSlope) maxSlope = groundSlope;
    }

    const last = out[out.length - 1];
    return {
      points: out,
      endVisible: last ? last.visible : false,
      firstBlockAt,
      obsGround: points[0].z,
      tgtGround: points[points.length - 1].z,
      total: last ? last.d : 0,
      // Minste høyde målet må ha for å bli synlig fra observatøren
      requiredTargetHeight: last
        ? Math.max(0, z0 + maxSlope * last.d - (last.z - (last.d * last.d * (1 - REFRACTION_K)) / (2 * EARTH_R)))
        : null
    };
  }

  /** Slår sammen sammenhengende synlige/skjulte partier til segmenter for karttegning. */
  function segments(analysis) {
    if (!analysis) return [];
    const segs = [];
    let cur = null;
    for (const p of analysis.points) {
      if (!cur || cur.visible !== p.visible) {
        cur = { visible: p.visible, pts: [] };
        segs.push(cur);
      }
      cur.pts.push(p);
    }
    return segs;
  }

  function clearCache() { cache.clear(); }

  return { fetchProfile, analyse, segments, clearCache, REFRACTION_K };
})();
