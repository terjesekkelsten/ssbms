/* SSBMS - symbolikk
 *
 * Farge OG form bærer tilhørighet, slik at symbolene er lesbare i nattmodus,
 * i gråtone og for fargesvake. Rammeformene følger APP-6-logikken
 * (romb = fiendtlig, firkant = nøytral, kløverblad = ukjent), mens FARGENE
 * følger brukerens valgte skjema:
 *
 *   egne      grønn   (APP-6 bruker blå - bevisst avvik, se README)
 *   sivil     blå     (APP-6 bruker grønn for nøytral)
 *   ukjent    grå     (APP-6 bruker gul)
 *   fiendtlig rød     (samsvarer med APP-6)
 */

const SSBMSSymbols = (() => {
  'use strict';

  const AFFIL = {
    egne: { label: 'Egne', color: '#00c853', frame: 'friend' },
    sivil: { label: 'Sivil', color: '#2979ff', frame: 'neutral' },
    ukjent: { label: 'Ukjent', color: '#9e9e9e', frame: 'unknown' },
    fiendtlig: { label: 'Fiendtlig', color: '#ff1744', frame: 'hostile' }
  };
  const AFFIL_ORDER = ['egne', 'sivil', 'ukjent', 'fiendtlig'];

  const POI = {
    personell: { label: 'Personell', short: 'PERS' },
    kjoretoy: { label: 'Kjøretøy', short: 'KJT' },
    drone: { label: 'Drone', short: 'UAS' },
    ied: { label: 'IED', short: 'IED' },
    bygning: { label: 'Bygning', short: 'BYGG' }
  };
  const POI_ORDER = ['personell', 'kjoretoy', 'drone', 'ied', 'bygning'];

  const LOC = {
    infil: { label: 'Infil', color: '#00c853' },
    exfil: { label: 'Exfil', color: '#ffab00' },
    sanplass: { label: 'Sanplass', color: '#ff1744' },
    maal: { label: 'Mål', color: '#e040fb' }
  };
  const LOC_ORDER = ['infil', 'exfil', 'sanplass', 'maal'];

  /* ---------- tegning ---------- */

  /* Fire farger, bevisst få. Sort og hvit er de eneste som er lesbare på
     henholdsvis lyst og mørkt kart, så begge må finnes; rød og grønn bærer
     fiendtlig/eget slik resten av symbolikken gjør. Hver strek tegnes med en
     kontrastkant under seg, ellers forsvinner sort på skygge og hvit på snø. */
  const DRAW = {
    sort:  { label: 'Sort',  color: '#101418', halo: 'rgba(255,255,255,.85)' },
    rod:   { label: 'Rød',   color: '#ff1744', halo: 'rgba(0,0,0,.75)' },
    gronn: { label: 'Grønn', color: '#00c853', halo: 'rgba(0,0,0,.75)' },
    hvit:  { label: 'Hvit',  color: '#ffffff', halo: 'rgba(0,0,0,.8)' }
  };
  const DRAW_ORDER = ['sort', 'rod', 'gronn', 'hvit'];
  const drawColor = c => (DRAW[c] || DRAW.sort).color;
  const drawHalo  = c => (DRAW[c] || DRAW.sort).halo;

  /** Pilhode som peker rett opp; roteres av kartlaget. */
  function arrowHeadSVG(colorKey, size = 22) {
    const c = drawColor(colorKey), h = drawHalo(colorKey);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">
      <path d="M12 3 L20 20 L12 16 L4 20 Z" fill="${c}" stroke="${h}" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;
  }

  /* ---------- rammer ---------- */

  function framePath(kind) {
    switch (kind) {
      case 'hostile':  // romb
        return '<path d="M24 5 L43 24 L24 43 L5 24 Z"/>';
      case 'neutral':  // firkant
        return '<rect x="7" y="7" width="34" height="34"/>';
      case 'unknown':  // kløverblad (forenklet quatrefoil)
        return '<path d="M17 9a8 8 0 0 1 14 0a8 8 0 0 1 8 14a8 8 0 0 1 -8 14a8 8 0 0 1 -14 0a8 8 0 0 1 -8 -14a8 8 0 0 1 8 -14 Z"/>';
      default:         // venn: avrundet rektangel med flat bunn
        return '<path d="M8 30 V18 a16 12 0 0 1 32 0 V30 a2 2 0 0 1 -2 2 H10 a2 2 0 0 1 -2 -2 Z"/>';
    }
  }

  /* ---------- glyfer ---------- */

  function glyph(type) {
    switch (type) {
      case 'personell':
        return '<circle cx="24" cy="19" r="4.2"/><path d="M17 33 v-5 a7 7 0 0 1 14 0 v5" fill="none" stroke-width="3"/>';
      case 'kjoretoy':
        return '<rect x="14" y="20" width="20" height="8" rx="1.5"/><circle cx="19" cy="30" r="2.6"/><circle cx="29" cy="30" r="2.6"/>';
      case 'drone':
        return '<circle cx="24" cy="24" r="3"/><path d="M24 24 L15 16 M24 24 L33 16 M24 24 L15 32 M24 24 L33 32" fill="none" stroke-width="2.4"/><circle cx="15" cy="16" r="2.4" fill="none" stroke-width="2"/><circle cx="33" cy="16" r="2.4" fill="none" stroke-width="2"/><circle cx="15" cy="32" r="2.4" fill="none" stroke-width="2"/><circle cx="33" cy="32" r="2.4" fill="none" stroke-width="2"/>';
      case 'ied':
        return '<path d="M24 13 L35 33 H13 Z" fill="none" stroke-width="3"/><path d="M24 21 v6" stroke-width="3"/><circle cx="24" cy="30" r="1.8"/>';
      case 'bygning':
        return '<path d="M13 32 V21 L24 15 L35 21 v11 Z" fill="none" stroke-width="2.8"/><rect x="21" y="25" width="6" height="7"/>';
      default:
        return '<circle cx="24" cy="24" r="4"/>';
    }
  }

  function svgWrap(inner, size) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}">${inner}</svg>`;
  }

  /**
   * Full POI-markør: ramme i tilhørighetsfarge + glyf.
   */
  function poiSVG(type, affiliation, size = 34) {
    const a = AFFIL[affiliation] || AFFIL.ukjent;
    const inner =
      `<g fill="none" stroke="#000" stroke-width="5" stroke-linejoin="round" opacity="0.55">${framePath(a.frame)}</g>` +
      `<g fill="${a.color}" fill-opacity="0.22" stroke="${a.color}" stroke-width="2.6" stroke-linejoin="round">${framePath(a.frame)}</g>` +
      `<g fill="${a.color}" stroke="${a.color}" stroke-linecap="round" stroke-linejoin="round">${glyph(type)}</g>`;
    return svgWrap(inner, size);
  }

  function locSVG(kind, size = 32) {
    const c = (LOC[kind] || LOC.maal).color;
    let inner = `<circle cx="24" cy="24" r="17" fill="#000" fill-opacity="0.45"/>` +
      `<circle cx="24" cy="24" r="16" fill="none" stroke="${c}" stroke-width="3"/>`;
    switch (kind) {
      case 'infil':
        inner += `<path d="M24 33 V15 M17 22 L24 15 L31 22" fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
        break;
      case 'exfil':
        inner += `<path d="M24 15 V33 M17 26 L24 33 L31 26" fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
        break;
      case 'sanplass':
        inner += `<path d="M24 14 V34 M14 24 H34" stroke="${c}" stroke-width="6" stroke-linecap="butt"/>`;
        break;
      case 'maal':
        inner += `<circle cx="24" cy="24" r="8" fill="none" stroke="${c}" stroke-width="3"/>` +
          `<path d="M24 6 V14 M24 34 V42 M6 24 H14 M34 24 H42" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`;
        break;
    }
    return svgWrap(inner, size);
  }

  /**
   * Egen/vennlig enhet: sirkel med kallesignal.
   * manual=true gir stiplet ring - posisjonen er meldt av noen andre, ikke
   * rapportert av enheten selv. Det skillet må være synlig på kartet.
   */
  function unitSVG(callsign, { self = false, stale = false, manual = false } = {}) {
    const c = self ? '#ffffff' : AFFIL.egne.color;
    const fill = self ? '#00c853' : 'rgba(0,0,0,0.6)';
    const op = stale ? 0.45 : 1;
    const text = String(callsign || '??').slice(0, 5);
    const fs = text.length > 4 ? 12 : text.length > 3 ? 14 : 16;
    const dash = manual ? ' stroke-dasharray="4.6 3.4"' : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="44" height="44" opacity="${op}">
      <circle cx="24" cy="24" r="18" fill="#000" fill-opacity="0.5"/>
      <circle cx="24" cy="24" r="16" fill="${fill}" stroke="${c}" stroke-width="2.5"${dash}/>
      <text x="24" y="24" text-anchor="middle" dominant-baseline="central"
            font-family="ui-monospace,Menlo,Consolas,monospace" font-weight="700"
            font-size="${fs}" fill="${self ? '#062e13' : c}">${text}</text>
      ${manual ? '<circle cx="38" cy="11" r="5.5" fill="#0d1117" stroke="' + c + '" stroke-width="1.6"/>' +
                 '<text x="38" y="11.5" text-anchor="middle" dominant-baseline="central" font-family="ui-monospace,monospace" font-weight="700" font-size="8" fill="' + c + '">M</text>' : ''}
    </svg>`;
  }

  /** Tynn bevegelsespil, brukes som eget lag over en POI. */
  function movementArrowSVG(color, lengthPx = 46) {
    const w = lengthPx;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 ${w}" width="24" height="${w}">
      <path d="M12 ${w - 4} V8" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M6.5 13 L12 5 L17.5 13" stroke="${color}" stroke-width="2" fill="none"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function dataURI(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  return {
    AFFIL, AFFIL_ORDER, POI, POI_ORDER, LOC, LOC_ORDER, DRAW, DRAW_ORDER,
    drawColor, drawHalo, arrowHeadSVG,
    poiSVG, locSVG, unitSVG, movementArrowSVG, glyph, framePath, dataURI
  };
})();
