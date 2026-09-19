/* SSBMS - lokal tilstand, persistens og utgående kø
 *
 * Alle posisjoner lagres som avstand fra AO-origo (de, dn) i meter. Origo kommer
 * fra grid-sifrene i nøkkelen. Feil grid-siffer gir derfor korrekt dekryptert
 * innhold plottet med systematisk forskyvning - det er tilsiktet.
 */

const SSBMSStore = (() => {
  'use strict';

  const listeners = new Set();

  const state = {
    key: null,          // parsed nøkkel
    roomId: null,
    self: null,         // kallesignal
    units: new Map(),   // kallesignal -> record
    pois: new Map(),    // id -> record
    locs: new Map(),    // id -> record
    selfName: '',        // valgfritt klartekstnavn på egen enhet
    selfShowName: true,  // om navnet vises på kartet
    outbox: [],
    online: false,
    backend: 'lokal',
    emcon: false        // lyttemodus: ingen utsending
  };

  function uid() {
    return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(what) { listeners.forEach(fn => { try { fn(what, state); } catch (e) { console.error(e); } }); }

  /* ---------- koordinatoversettelse ---------- */

  function toLocal(e, n) {
    return { de: Math.round(e - state.key.originE), dn: Math.round(n - state.key.originN) };
  }
  function fromLocal(de, dn) {
    return { e: de + state.key.originE, n: dn + state.key.originN };
  }
  function recordLatLng(rec) {
    const { e, n } = fromLocal(rec.de, rec.dn);
    return SSBMSGeo.toLatLng(e, n, state.key.zone);
  }
  function recordUTM(rec) { return fromLocal(rec.de, rec.dn); }

  /* ---------- persistens ---------- */

  function storageKey(suffix) { return `ssbms:${state.roomId}:${suffix}`; }

  function persist() {
    if (!state.roomId) return;
    try {
      localStorage.setItem(storageKey('data'), JSON.stringify({
        units: [...state.units.values()],
        pois: [...state.pois.values()],
        locs: [...state.locs.values()]
      }));
      localStorage.setItem(storageKey('outbox'), JSON.stringify(state.outbox));
    } catch (e) { /* full disk / privat modus - ikke kritisk */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(storageKey('data'));
      if (raw) {
        const d = JSON.parse(raw);
        (d.units || []).forEach(r => state.units.set(r.id, r));
        (d.pois || []).forEach(r => state.pois.set(r.id, r));
        (d.locs || []).forEach(r => state.locs.set(r.id, r));
      }
      const ob = localStorage.getItem(storageKey('outbox'));
      if (ob) state.outbox = JSON.parse(ob) || [];
    } catch (e) { /* ignorer korrupt lagring */ }
  }

  /* Navn på egen enhet lagres per kallesignal, ikke per rom: samme operatør
     heter det samme i neste sesjon. */
  function loadSelfName(cs) {
    try {
      const raw = localStorage.getItem('ssbms:unit:' + cs);
      if (raw) {
        const d = JSON.parse(raw);
        state.selfName = d.name || '';
        state.selfShowName = d.showName !== false;
        return;
      }
    } catch (e) { /* ignorer */ }
    state.selfName = '';
    state.selfShowName = true;
  }

  function saveSelfName(name, showName) {
    state.selfName = (name || '').trim().slice(0, 28);
    state.selfShowName = showName !== false;
    try {
      localStorage.setItem('ssbms:unit:' + state.self,
        JSON.stringify({ name: state.selfName, showName: state.selfShowName }));
    } catch (e) { /* ignorer */ }
  }

  /** Visningsnavn: navn hvis satt, ellers kallesignalet. */
  function displayName(rec) {
    return (rec && rec.name) ? rec.name : (rec ? rec.cs : '');
  }

  function wipe() {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('ssbms:'))
        .forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ignorer */ }
    state.units.clear(); state.pois.clear(); state.locs.clear();
    state.outbox = [];
  }

  /* ---------- innkommende ---------- */

  const BUCKET = { pos: 'units', poi: 'pois', loc: 'locs' };

  function apply(rec, { local = false } = {}) {
    if (!rec || !rec.t || !rec.id) return false;
    const bucket = state[BUCKET[rec.t]];
    if (!bucket) return false;
    const prev = bucket.get(rec.id);
    if (prev && prev.ts > rec.ts) return false;   // eldre enn det vi har
    bucket.set(rec.id, rec);
    persist();
    emit(local ? 'local' : 'remote');
    return true;
  }

  /* ---------- utgående ---------- */

  let sendFn = async () => false;
  function setSender(fn) { sendFn = fn; }

  async function publish(rec) {
    apply(rec, { local: true });
    if (state.emcon) return;                       // lyttemodus: ingen utsending
    state.outbox.push({ kind: rec.t, ref: rec.id, rec });
    persist();
    flush();
  }

  let flushing = false;
  async function flush() {
    if (flushing || !state.online || state.emcon) return;
    flushing = true;
    try {
      while (state.outbox.length) {
        const item = state.outbox[0];
        const ok = await sendFn(item);
        if (!ok) break;
        state.outbox.shift();
        persist();
      }
    } finally {
      flushing = false;
      emit('outbox');
    }
  }

  function setOnline(v, backend) {
    const changed = state.online !== v;
    state.online = v;
    if (backend) state.backend = backend;
    if (changed) emit('conn');
    if (v) flush();
  }

  /* ---------- byggere ---------- */

  function now() { return Date.now(); }

  function makePosition({ e, n, acc, obs, note }) {
    const { de, dn } = toLocal(e, n);
    return {
      t: 'pos', id: state.self, cs: state.self,
      de, dn, acc: acc == null ? null : Math.round(acc),
      obs: obs || null, note: note || '',
      name: state.selfName || '',
      showName: state.selfShowName !== false,
      manual: false, deleted: false, ts: now()
    };
  }

  /**
   * Posisjon for en ANNEN enhet, plassert for hånd av denne brukeren.
   * Merkes manual:true slik at kartet kan skille rapportert fra observert
   * posisjon. Melder enheten selv inn senere, vinner den på tidsstempel.
   */
  function makeUnitPlacement({ cs, e, n, obs, note, name, showName }) {
    const { de, dn } = toLocal(e, n);
    return {
      t: 'pos', id: cs, cs, de, dn, acc: null,
      obs: obs || null, note: note || '',
      name: name || '',
      showName: showName !== false,
      manual: true, by: state.self, deleted: false, ts: now()
    };
  }

  function makePOI({ e, n, type, affil, count, desc, mov, ts, id }) {
    const { de, dn } = toLocal(e, n);
    return {
      t: 'poi', id: id || uid(), type, affil,
      de, dn,
      count: count == null ? null : count,
      desc: desc || '',
      mov: mov || null,
      obsTs: ts || now(),
      by: state.self, ts: now(), deleted: false
    };
  }

  function makeLoc({ e, n, kind, desc, id }) {
    const { de, dn } = toLocal(e, n);
    return {
      t: 'loc', id: id || uid(), kind, de, dn,
      desc: desc || '', by: state.self, ts: now(), deleted: false
    };
  }

  function remove(rec) {
    const copy = { ...rec, deleted: true, ts: now() };
    return publish(copy);
  }

  /* ---------- oppslag ---------- */

  function activePOIs() { return [...state.pois.values()].filter(r => !r.deleted); }
  function activeLocs() { return [...state.locs.values()].filter(r => !r.deleted); }
  function activeUnits() { return [...state.units.values()].filter(r => !r.deleted); }

  const STALE_MS = 10 * 60 * 1000;
  function isStale(rec) { return now() - rec.ts > STALE_MS; }

  function ageText(ts) {
    const s = Math.floor((now() - ts) / 1000);
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    return Math.floor(s / 3600) + ' t';
  }

  function zulu(ts) {
    const d = new Date(ts);
    const p = v => String(v).padStart(2, '0');
    return p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + 'Z';
  }

  return {
    state, on, emit, uid,
    toLocal, fromLocal, recordLatLng, recordUTM,
    restore, persist, wipe, loadSelfName, saveSelfName, displayName,
    apply, publish, remove, setSender, setOnline, flush,
    makePosition, makePOI, makeLoc, makeUnitPlacement,
    activePOIs, activeLocs, activeUnits,
    isStale, ageText, zulu, STALE_MS
  };
})();
