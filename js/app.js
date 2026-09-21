/* SSBMS - hovedlogikk */

(() => {
  'use strict';

  const CFG = window.SSBMS_CONFIG;
  const S = SSBMSSymbols;
  const G = SSBMSGeo;
  const St = SSBMSStore;

  let map = null;
  const layers = {};
  const markers = { units: new Map(), pois: new Map(), locs: new Map() };
  let selfSector = null;
  let selfObs = { brg: 0, width: CFG.defaults.observationWidth, range: CFG.defaults.observationRange };
  let selfPos = null;             // {e, n, acc}
  let watchId = null;
  let quick = { type: 'personell', affil: 'ukjent' };
  let losLayer = null;
  let draftLayer = null;

  /* GPS-bryter. Var tidligere implisitt: en manuell posisjon ble satt, og
     neste watchPosition-oppdatering overskrev den uten et ord. Er du under
     tett skog eller i en kjeller er den manuelle posisjonen den RIKTIGE, og
     da skal maskinen ikke overprøve deg. Manuell posisjon slår derfor GPS av
     til du slår den på igjen. */
  let gpsOn = true;

  /* Aldersfilter for observasjoner. 0 = vis alle. Huskes mellom økter, men
     vises alltid som et merke i topplinja: et filter som skjuler halve
     situasjonsbildet uten at du ser det er en felle — særlig hvis det sto på
     fra forrige økt. Filteret måler mot observasjonstidspunktet (obsTs), ikke
     mot når posten sist ble endret: en observasjon du retter en skrivefeil i
     blir ikke ferskere av det. */
  const AGE_OPTIONS = [
    { label: 'Vis alle',    tag: '',        ms: 0 },
    { label: '15 minutter', tag: '≤15 MIN', ms: 15 * 60 * 1000 },
    { label: '1 time',      tag: '≤1 T',    ms: 60 * 60 * 1000 },
    { label: '4 timer',     tag: '≤4 T',    ms: 4 * 3600 * 1000 },
    { label: '12 timer',    tag: '≤12 T',   ms: 12 * 3600 * 1000 },
    { label: '24 timer',    tag: '≤24 T',   ms: 24 * 3600 * 1000 }
  ];
  let ageFilterMs = Number(localStorage.getItem('ssbms:agefilter')) || 0;

  /* Tegnevalg. Farge huskes mellom økter — man holder seg som regel til én. */
  let drawPick = {
    color: localStorage.getItem('ssbms:drawcolor') || 'sort',
    dash: localStorage.getItem('ssbms:drawdash') === '1',
    style: 'line'
  };

  /* Én tilstand avgjør hva neste kartklikk gjør. Tidligere hadde lokasjons-
     plassering sin egen map.once-lytter samtidig som manuell posisjon lyttet
     på det samme klikket - begge kjørte, og egen posisjon ble flyttet når man
     plasserte en sanplass. Nå går alt gjennom denne ene maskinen. */
  /* Lokal visningsinnstilling: skjuler ALLE enhetsnavn på denne enheten.
     Per-enhet-avhukingen ligger i selve posten og gjelder for hele troppen. */
  let labelsOn = localStorage.getItem('ssbms:labels') !== '0';

  /* Null = alt i orden. Ellers: hvorfor offline-cachen ikke er tilgjengelig.
     Dette vises vedvarende i topplinja - en toast forsvinner, og at kartet
     ikke finnes uten dekning er ikke noe du skal oppdage i felt. */
  let swReason = null;

  let pending = null;   // {kind:'poi'|'loc'|'unit'|'selfpos'|'los', ...}
  const isArmed = k => !!pending && pending.kind === k;

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  /* =========================================================
   *  Innlogging
   * ========================================================= */

  /* Web Crypto (crypto.subtle) finnes KUN i secure context: HTTPS eller
     localhost. Åpner du appen på http://192.168.x.x fra telefonen, er
     crypto.subtle undefined, og nøkkelutledningen kræsjer. Vi fanger det her
     og sier hva som faktisk er galt, i stedet for å la en TypeError boble opp. */
  function cryptoReady() {
    return !!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function');
  }

  function showInsecureContext() {
    const secure = window.isSecureContext !== false;
    const box = document.querySelector('.loginbox');
    const origin = location.origin || (location.protocol + '//' + location.host);
    box.innerHTML = `
      <div class="brand">
        <div class="logo">SS<span>BMS</span></div>
        <p class="tag">Super Simple Battlefield Management System</p>
      </div>
      <div class="blocker">
        <h2>Kryptering er ikke tilgjengelig her</h2>
        ${secure ? `
          <p>Nettleseren mangler Web Crypto (<code>crypto.subtle</code>). Det er
          uvanlig — prøv en oppdatert Chrome, Safari, Firefox eller Edge.</p>`
        : `
          <p>Nettleseren gir bare tilgang til Web Crypto over <b>HTTPS</b> eller på
          <b>localhost</b>. Du er på <code>${escapeHtml(origin)}</code>, som regnes
          som usikker, og da er <code>crypto.subtle</code> utilgjengelig.</p>
          <p>Det samme gjelder GPS og offline-cache — ingen av dem virker over ren HTTP.</p>
          <h3>Tre veier videre</h3>
          <ol>
            <li><b>Deploy til Vercel.</b> Alt går over HTTPS der. Mest pålitelig, og
              du skulle dit uansett.</li>
            <li><b>HTTPS på eget nett:</b> kjør <code>node serve-https.js</code> på PC-en
              og åpne <code>https://&lt;PC-ens IP&gt;:5174</code> på telefonen. Godta
              sertifikatadvarselen én gang. Trafikken forlater ikke nettet ditt.
              <br><span class="muted">Merk: nettleseren nekter service worker på
              selvsignert sertifikat, så offline-cache av kart virker ikke på denne
              veien. Alt annet gjør det.</span></li>
            <li><b>Test på PC-en</b> via <code>http://localhost:5173</code> — localhost
              regnes alltid som sikker.</li>
          </ol>
          <p class="caveat">Dette bør ikke omgås. Over ren HTTP er selve transporten
          ukryptert uansett hva appen gjør med innholdet — for et BMS er det verre
          enn at appen nekter å starte.</p>`}
      </div>`;
  }

  function initLogin() {
    if (!cryptoReady()) return showInsecureContext();
    const input = $('#keyInput');
    const csSel = $('#callsign');
    const err = $('#loginErr');

    CFG.callsigns.forEach(c => {
      const o = document.createElement('option');
      o.value = o.textContent = c;
      csSel.appendChild(o);
    });
    const custom = document.createElement('option');
    custom.value = '__custom';
    custom.textContent = 'Annet…';
    csSel.appendChild(custom);

    csSel.onchange = () => {
      $('#callsignCustom').style.display = csSel.value === '__custom' ? 'block' : 'none';
    };

    const saved = localStorage.getItem('ssbms:lastCallsign');
    if (saved && CFG.callsigns.includes(saved)) csSel.value = saved;

    // Hent lagret navn for valgt kallesignal
    const syncName = () => {
      const cs = csSel.value === '__custom' ? ($('#callsignCustom').value || '').trim().toUpperCase() : csSel.value;
      St.loadSelfName(cs);
      $('#unitName').value = St.state.selfName;
      $('#unitShowName').checked = St.state.selfShowName;
    };
    csSel.addEventListener('change', syncName);
    $('#callsignCustom').addEventListener('input', syncName);
    syncName();

    input.addEventListener('input', () => {
      const pos = input.selectionStart;
      const before = input.value.length;
      input.value = SSBMSKey.format(input.value);
      const after = input.value.length;
      input.setSelectionRange(pos + (after - before), pos + (after - before));
      const d = SSBMSKey.normalise(input.value);
      $('#keyCount').textContent = d.length + '/18';
      $('#keyCount').className = d.length === 18 ? 'ok' : '';
      if (d.length === 18) {
        const p = SSBMSKey.parse(d);
        err.textContent = p.ok ? '' : p.error;
        err.className = 'err' + (p.ok ? '' : ' show');
        if (p.ok) describeKey(p.key);
      } else {
        err.className = 'err';
        $('#keyInfo').textContent = '';
      }
    });

    $('#genKey').onclick = () => openKeyGenerator(input);

    $('#loginBtn').onclick = async () => {
      const parsed = SSBMSKey.parse(input.value);
      if (!parsed.ok) {
        err.textContent = parsed.error;
        err.className = 'err show';
        return;
      }
      let cs = csSel.value === '__custom'
        ? ($('#callsignCustom').value || '').trim().toUpperCase()
        : csSel.value;
      if (!cs) { err.textContent = 'Velg eller skriv et kallesignal.'; err.className = 'err show'; return; }
      localStorage.setItem('ssbms:lastCallsign', cs);
      St.state.self = cs;
      St.saveSelfName($('#unitName').value, $('#unitShowName').checked);

      if (!cryptoReady()) return showInsecureContext();
      $('#loginBtn').disabled = true;
      $('#loginBtn').textContent = 'Utleder nøkkel…';
      await new Promise(r => setTimeout(r, 30));
      try {
        await startSession(parsed.key, cs);
      } catch (e) {
        console.error(e);
        err.textContent = 'Oppstart feilet: ' + e.message;
        err.className = 'err show';
        $('#loginBtn').disabled = false;
        $('#loginBtn').textContent = 'Åpne kart';
      }
    };

    input.addEventListener('keydown', e => { if (e.key === 'Enter') $('#loginBtn').click(); });
  }

  function describeKey(key) {
    const ll = G.toLatLng(key.originE + 50000, key.originN + 50000, key.zone);
    const ok = isFinite(ll.lat) && Math.abs(ll.lat) <= 90;
    $('#keyInfo').innerHTML = ok
      ? `Sone <b>${key.zone}</b> · AO-origo <b>${(key.originE / 1000).toFixed(0)} km Ø / ${(key.originN / 1000).toFixed(0)} km N</b>`
      : `<span class="warn">Grid-sifrene peker utenfor gyldig område for sone ${key.zone}.</span>`;
  }

  function openKeyGenerator(input) {
    const body = el('div', 'genwrap', `
      <p class="muted">Generatoren lager en gyldig nøkkel. Grid-sifrene settes fra
      posisjonen du oppgir - alle i troppen må bruke <b>samme</b> nøkkel.</p>
      <label>Breddegrad <input id="gLat" type="number" step="0.0001" value="59.8900"></label>
      <label>Lengdegrad <input id="gLng" type="number" step="0.0001" value="10.5200"></label>
      <label>UTM-sone
        <select id="gZone"><option value="32">32 (Sør-Norge)</option>
        <option value="33">33 (Midt/nasjonal)</option><option value="35">35 (Finnmark)</option></select>
      </label>
      <button class="btn primary" id="gMake">Lag nøkkel</button>
      <div class="genout" id="gOut"></div>`);

    const sh = SSBMSUI.sheet({ title: 'Generer nøkkel', body });

    body.querySelector('#gMake').onclick = () => {
      const lat = parseFloat(body.querySelector('#gLat').value);
      const lng = parseFloat(body.querySelector('#gLng').value);
      const zone = parseInt(body.querySelector('#gZone').value, 10);
      const { e, n } = G.toUTM(lat, lng, zone);
      // Origo rundes NED til hel km / hel 10 km, slik at AO ligger nord-øst for origo.
      const originE = Math.floor(e / 1000) * 1000;
      const originN = Math.floor(n / 10000) * 10000;
      const key = SSBMSKey.build({ session: SSBMSKey.randomSession(), originE, originN, zone });
      body.querySelector('#gOut').innerHTML =
        `<div class="keybig">${SSBMSKey.format(key)}</div>
         <p class="muted">Origo: ${(originE / 1000).toFixed(0)} km Ø / ${(originN / 1000).toFixed(0)} km N, sone ${zone}.
         Del hele nøkkelen på et sikkert vis. Skriv den ikke ned sammen med hva den er til.</p>`;
      const b = el('button', 'btn', 'Bruk denne');
      b.onclick = () => {
        input.value = SSBMSKey.format(key);
        input.dispatchEvent(new Event('input'));
        sh.close();
      };
      body.querySelector('#gOut').appendChild(b);
    };
  }

  /* =========================================================
   *  Sesjon
   * ========================================================= */

  async function startSession(key, callsign) {
    St.state.self = callsign;
    const info = await SSBMSSync.start(key);

    $('#login').remove();
    $('#app').style.display = 'block';

    const centre = G.toLatLng(key.originE + 25000, key.originN + 25000, key.zone);
    map = SSBMSMap.init('map', key.zone, [centre.lat, centre.lng]);

    layers.locs = L.layerGroup().addTo(map);
    layers.draws = L.layerGroup().addTo(map);
    layers.sectors = L.layerGroup().addTo(map);
    layers.pois = L.layerGroup().addTo(map);
    layers.units = L.layerGroup().addTo(map);
    losLayer = L.layerGroup().addTo(map);
    draftLayer = L.layerGroup().addTo(map);

    wireMap();
    wireToolbar();
    trackQuickbarHeight();
    St.on(() => { render(); renderStatus(); });
    St.setDropHandler((item, reason) => {
      const hva = { pos: 'Posisjonen', poi: 'Observasjonen', loc: 'Lokasjonen',
                    drw: 'Tegningen', pho: 'Bildet' }[item.rec && item.rec.t] || 'En post';
      SSBMSUI.toast(`${hva} ble ikke delt: ${reason}. Den ligger fortsatt på din enhet.`, 'warn');
    });

    startGeolocation();
    render();
    renderStatus();
    setInterval(() => { render(); renderStatus(); }, 20000);

    renderBackendTag();
    // Å tro at du deler når du ikke gjør det, er den verste feilen dette
    // systemet kan gjøre. En toast som forsvinner er ikke nok.
    if (info.backend !== 'supabase' && !sessionStorage.getItem('ssbms:sharingSeen')) {
      sessionStorage.setItem('ssbms:sharingSeen', '1');
      setTimeout(openSharingSheet, 400);
    }
    registerServiceWorker();
  }

  /* Service worker = offline-cache for kartfliser. Den nekter å registrere seg
     på et sertifikat nettleseren ikke stoler på, selv når du har klikket deg
     forbi advarselen. Det er en Chrome/Safari-regel, ikke noe vi kan slå av.
     Så: si tydelig fra i stedet for å la brukeren tro offline virker. */
  function registerServiceWorker() {
    const fail = reason => {
      swReason = reason;
      console.warn('[ssbms] Offline-cache utilgjengelig:', reason);
      renderStatus();
    };
    if (!navigator.serviceWorker) return fail('service worker støttes ikke i denne konteksten');
    navigator.serviceWorker.register('sw.js')
      .then(() => { swReason = null; renderStatus(); })
      .catch(err => {
        const msg = String((err && err.message) || err);
        fail(/certificate|SSL/i.test(msg)
          ? 'nettleseren godtar ikke service worker på et sertifikat den ikke stoler på'
          : msg);
      });
  }

  /* =========================================================
   *  Kartinteraksjon
   * ========================================================= */

  function wireMap() {
    let pressTimer = null, pressPt = null, moved = false;

    const container = map.getContainer();

    container.addEventListener('pointerdown', ev => {
      if (ev.button === 2) return;
      if (ev.target.closest('.leaflet-marker-icon, .leaflet-control')) return;
      moved = false;
      pressPt = { x: ev.clientX, y: ev.clientY };
      pressTimer = setTimeout(() => {
        if (moved) return;
        const ll = map.mouseEventToLatLng(ev);
        openRadialAt(ev.clientX, ev.clientY, ll, 'drag');
      }, 380);
    });
    container.addEventListener('pointermove', ev => {
      if (!pressPt) return;
      if (Math.hypot(ev.clientX - pressPt.x, ev.clientY - pressPt.y) > 12) {
        moved = true; clearTimeout(pressTimer);
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t =>
      container.addEventListener(t, () => { clearTimeout(pressTimer); pressPt = null; }));

    container.addEventListener('contextmenu', ev => {
      if (ev.target.closest('.leaflet-control')) return;
      ev.preventDefault();
      openRadialAt(ev.clientX, ev.clientY, map.mouseEventToLatLng(ev), 'click');
    });

    map.on('click', e => {
      if (SSBMSUI.isRadialOpen()) return;   // hurtigmenyen eier trykket
      if (!pending) return;
      const { e: E, n: N } = G.toUTM(e.latlng.lat, e.latlng.lng, SSBMSMap.getZone());

      switch (pending.kind) {
        case 'los':
          return handleLosClick(e.latlng);

        case 'poi':
          // Forblir armert: flere observasjoner på rad uten å velge type på nytt.
          return placePOI(e.latlng, quick.type, quick.affil);

        case 'loc': {
          const kind = pending.locKind;
          setPending(null);
          St.publish(St.makeLoc({ e: E, n: N, kind }));
          SSBMSUI.toast(`${S.LOC[kind].label} · ${G.toShortGrid(E, N)}`);
          return;
        }

        case 'unit': {
          const cs = pending.cs, meta = pending.meta;
          setPending(null);
          placeUnit(cs, E, N, meta);
          return;
        }

        case 'draw': {
          pending.pts.push({ e: E, n: N });
          renderDraft();
          renderModebar();
          return;
        }

        case 'selfpos': {
          selfPos = { e: E, n: N, acc: null };
          const sticky = pending.sticky;
          // Manuell posisjon vinner over GPS til brukeren sier noe annet.
          const hadGps = gpsOn;
          if (hadGps) setGps(false, { quiet: true });
          pushPosition();
          const sec = sectorValue();
          SSBMSUI.toast('Egen posisjon satt: ' + G.toShortGrid(E, N) +
            (sec ? ` · sektor ${G.compass(sec.brg)} ${String(Math.round(sec.brg)).padStart(3, '0')}°` : '') +
            (hadGps ? ' · GPS av' : ''));
          if (!sticky) setPending(null);
          return;
        }
      }
    });

    map.on('mousemove', e => {
      const { e: E, n: N } = G.toUTM(e.latlng.lat, e.latlng.lng, SSBMSMap.getZone());
      $('#cursorGrid').textContent = G.toMGRS(E, N, SSBMSMap.getZone(), e.latlng.lat, 4);
    });
    map.on('zoomend', renderStatus);
  }

  /* Armering er alltid synlig. En usynlig modus som spiser kartklikk er
     nøyaktig det som gjorde den forrige feilen vanskelig å oppdage. */
  function setPending(p) {
    pending = p;
    if (draftLayer && (!p || p.kind !== 'draw')) draftLayer.clearLayers();
    renderModebar();
    document.body.classList.toggle('armed', !!p);
    updateQuickBar();
  }

  function renderModebar() {
    const bar = $('#modebar');
    if (!bar) return;
    const p = pending;
    if (!p) {
      bar.classList.remove('on');
      bar.innerHTML = '';
      return;
    }
    bar.classList.add('on');
    const done = p.kind === 'draw' && p.pts.length >= 2;
    bar.innerHTML = `<span class="mb-dot"></span><span class="mb-text">${pendingLabel(p)}</span>
      ${done ? '<button class="mb-ok" type="button">Ferdig</button>' : ''}
      ${p.kind === 'draw' && p.pts.length ? '<button class="mb-undo" type="button">Angre</button>' : ''}
      <button class="mb-x" type="button">Avbryt</button>`;
    bar.querySelector('.mb-x').onclick = () => setPending(null);
    const ok = bar.querySelector('.mb-ok');
    if (ok) ok.onclick = finishDraw;
    const un = bar.querySelector('.mb-undo');
    if (un) un.onclick = () => { p.pts.pop(); renderDraft(); renderModebar(); };
  }

  function pendingLabel(p) {
    switch (p.kind) {
      case 'poi': return `Trykk i kartet: ${S.POI[quick.type].label.toLowerCase()} / ${S.AFFIL[quick.affil].label.toLowerCase()}`;
      case 'loc': return `Trykk i kartet: ${S.LOC[p.locKind].label.toLowerCase()}`;
      case 'unit': return `Trykk i kartet: plasser ${p.cs}`;
      case 'selfpos': return 'Manuell posisjon — trykk i kartet';
      case 'los': return 'Siktlinje — trykk observasjonspunkt, så målpunkt';
      case 'draw': return `${p.dash ? 'Stiplet ' : ''}${p.style === 'arrow' ? 'pil' : 'strek'} (${
        S.DRAW[p.color].label.toLowerCase()}) — ${
        p.pts.length < 2 ? 'trykk i kartet' : p.pts.length + ' punkter'}`;
      case 'link': return p.a
        ? `Koble fra ${p.aLabel} — trykk det andre punktet`
        : 'Koble — trykk første observasjon eller lokasjon';
      default: return 'Armert';
    }
  }

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && pending) { setPending(null); SSBMSUI.closeRadial(); }
  });

  /* Modus som eier hvert enkelt kartklikk - tegning, kobling, siktlinje -
     må ikke få hurtigmenyen over seg. Et langtrykk midt i en strek skal legge
     et punkt, ikke plassere en observasjon. */
  const RADIAL_BLOCKED = ['draw', 'link', 'los'];

  function openRadialAt(x, y, latlng, mode) {
    if (pending && RADIAL_BLOCKED.includes(pending.kind)) return;
    if (navigator.vibrate) navigator.vibrate(12);
    SSBMSUI.openRadial(x, y, { ...quick, mode }, ({ type, affil }) => {
      quick.type = type; quick.affil = affil;
      updateQuickBar();
      placePOI(latlng, type, affil);
    });
  }

  function placePOI(latlng, type, affil) {
    const { e, n } = G.toUTM(latlng.lat, latlng.lng, SSBMSMap.getZone());
    const rec = St.makePOI({ e, n, type, affil });
    St.publish(rec);
    if (navigator.vibrate) navigator.vibrate(20);
    SSBMSUI.toast(`${S.POI[type].label} / ${S.AFFIL[affil].label} · ${G.toShortGrid(e, n)}`);
  }

  /* =========================================================
   *  Tegning
   * ========================================================= */

  /* ---------- aldersfilter ---------- */

  /** Observasjonstid: da det ble sett, ikke da posten sist ble redigert. */
  function obsTime(rec) { return rec.obsTs || rec.ts; }

  function hiddenByAge(rec) {
    return !!ageFilterMs && rec.t === 'poi' && (Date.now() - obsTime(rec)) > ageFilterMs;
  }

  /** Observasjonene som skal tegnes og listes nå. */
  function visiblePOIs() { return St.activePOIs().filter(r => !hiddenByAge(r)); }

  function setAgeFilter(ms) {
    ageFilterMs = ms || 0;
    localStorage.setItem('ssbms:agefilter', String(ageFilterMs));
    const b = $('#btnAge');
    if (b) b.classList.toggle('on', !!ageFilterMs);
    render();
    renderStatus();
    const opt = AGE_OPTIONS.find(o => o.ms === ageFilterMs);
    SSBMSUI.toast(ageFilterMs
      ? `Viser kun observasjoner fra siste ${opt.label.toLowerCase()}.`
      : 'Viser alle observasjoner.');
  }

  function openAgeSheet() {
    const body = el('div', 'menu', '');
    AGE_OPTIONS.forEach(o => {
      const hides = o.ms ? St.activePOIs().filter(r => (Date.now() - obsTime(r)) > o.ms).length : 0;
      const b = el('button', 'mi' + (o.ms === ageFilterMs ? ' warnrow' : ''),
        `${o.ms === ageFilterMs ? '✓ ' : ''}${o.ms ? 'Siste ' + o.label.toLowerCase() : 'Vis alle observasjoner'}` +
        (hides ? ` <span class="muted small">— skjuler ${hides}</span>` : ''));
      b.onclick = () => { sh.close(); setAgeFilter(o.ms); };
      body.appendChild(b);
    });
    body.appendChild(el('p', 'muted small',
      'Filteret gjelder observasjoner, både på kartet og i lista. Enheter, ' +
      'lokasjoner og tegninger skjules aldri. Ingenting slettes — filteret er ' +
      'kun din visning, og de andre i troppen ser fortsatt alt.'));
    const sh = SSBMSUI.sheet({ title: 'Skjul gamle observasjoner', body });
  }

  function icon(svg, size, anchor, cls) {
    return L.divIcon({
      html: svg, className: cls || 'sym', iconSize: size,
      iconAnchor: anchor || [size[0] / 2, size[1] / 2]
    });
  }

  function render() {
    renderUnits();
    renderPOIs();
    renderLocs();
    renderDraws();
    renderSectors();
    renderList();
  }

  function syncLayer(layerKey, records, keyFn, build) {
    const store = markers[layerKey];
    const seen = new Set();
    records.forEach(rec => {
      const id = keyFn(rec);
      seen.add(id);
      const existing = store.get(id);
      if (existing) { layers[layerKey].removeLayer(existing); }
      const m = build(rec);
      if (m) { m.addTo(layers[layerKey]); store.set(id, m); }
    });
    [...store.keys()].forEach(id => {
      if (!seen.has(id)) { layers[layerKey].removeLayer(store.get(id)); store.delete(id); }
    });
  }

  function renderUnits() {
    syncLayer('units', St.activeUnits(), r => r.id, rec => {
      const ll = St.recordLatLng(rec);
      const self = rec.id === St.state.self;
      const stale = St.isStale(rec);
      const g = L.layerGroup();

      const m = L.marker([ll.lat, ll.lng], {
        icon: icon(S.unitSVG(rec.cs, { self, stale, manual: !!rec.manual }), [44, 44]),
        zIndexOffset: self ? 1000 : 500,
        title: rec.name ? `${rec.cs} — ${rec.name}` : rec.cs
      });
      m.on('click', () => openUnitSheet(rec));
      g.addLayer(m);

      // Navnet vises når BÅDE posten tillater det (synkes til alle) og den
      // lokale visningsbryteren er på.
      if (labelsOn && rec.showName !== false && rec.name) {
        g.addLayer(L.marker([ll.lat, ll.lng], {
          icon: L.divIcon({
            html: `<div class="ulabel-wrap"><span class="unit-label${self ? ' self' : ''}${stale ? ' stale' : ''}">${escapeHtml(rec.name)}</span></div>`,
            className: 'sym ulabel', iconSize: [180, 22], iconAnchor: [90, -20]
          }),
          interactive: false, zIndexOffset: self ? 999 : 400
        }));
      }
      return g;
    });
  }

  function renderPOIs() {
    syncLayer('pois', visiblePOIs(), r => r.id, rec => {
      const ll = St.recordLatLng(rec);
      const g = L.layerGroup();
      const m = L.marker([ll.lat, ll.lng], {
        icon: icon(S.poiSVG(rec.type, rec.affil), [34, 34]),
        title: `${S.POI[rec.type].label} · ${S.AFFIL[rec.affil].label}`
      });
      m.on('click', () => {
        if (isArmed('link')) return handleLinkClick(rec);
        openPOISheet(rec);
      });
      g.addLayer(m);

      if (rec.mov && rec.mov.brg != null) {
        const arrow = L.marker([ll.lat, ll.lng], {
          icon: L.divIcon({
            html: `<div class="mov-arrow" style="transform:rotate(${rec.mov.brg}deg)">
                     ${S.movementArrowSVG(S.AFFIL[rec.affil].color, 44)}</div>`,
            className: 'sym mov', iconSize: [24, 44], iconAnchor: [12, 44]
          }),
          interactive: false
        });
        g.addLayer(arrow);
      }

      if (rec.count) {
        g.addLayer(L.marker([ll.lat, ll.lng], {
          icon: L.divIcon({
            html: `<span class="count-badge">${rec.count}</span>`,
            className: 'sym', iconSize: [20, 20], iconAnchor: [-10, 24]
          }),
          interactive: false
        }));
      }
      return g;
    });
  }

  function renderLocs() {
    syncLayer('locs', St.activeLocs(), r => r.id, rec => {
      const ll = St.recordLatLng(rec);
      const m = L.marker([ll.lat, ll.lng], {
        icon: icon(S.locSVG(rec.kind), [32, 32]),
        title: S.LOC[rec.kind].label
      });
      m.on('click', () => {
        if (isArmed('link')) return handleLinkClick(rec);
        openLocSheet(rec);
      });
      return m;
    });
  }


  /* =========================================================
   *  Tegning: streker, piler og koblinger
   * ========================================================= */

  /** Kort, lesbart navn på en post. Brukes i koblingsarket og i meldingene. */
  function recLabel(rec) {
    if (!rec) return '—';
    if (rec.t === 'poi') return `${S.POI[rec.type].label}${rec.count ? ' ×' + rec.count : ''} (${S.AFFIL[rec.affil].label.toLowerCase()})`;
    if (rec.t === 'loc') return S.LOC[rec.kind].label;
    if (rec.t === 'pos') return St.displayName(rec) || rec.cs;
    return '—';
  }

  /** Alt som kan være ende i en kobling. */
  function linkTargets() { return [...visiblePOIs(), ...St.activeLocs()]; }

  /** Slår opp posten en kobling peker på - observasjon, enhet eller lokasjon. */
  function findRec(id) {
    return St.state.pois.get(id) || St.state.units.get(id) || St.state.locs.get(id) || null;
  }

  /**
   * Punktene en tegning skal følge, i UTM.
   * En koblet strek leser posisjonen til de to postene nå, ikke da den ble
   * tegnet: flytter observasjonen seg, følger streken med. Er en av endene
   * slettet, returneres null og streken tegnes ikke - en kobling til noe som
   * ikke finnes er verre enn ingen kobling.
   */
  function drawUTM(rec) {
    if (rec.link) {
      const a = findRec(rec.link.a), b = findRec(rec.link.b);
      if (!a || !b || a.deleted || b.deleted) return null;
      // Skjult av aldersfilteret teller som borte: en strek til noe brukeren
      // ikke ser, er verre enn ingen strek.
      if (hiddenByAge(a) || hiddenByAge(b)) return null;
      return [St.recordUTM(a), St.recordUTM(b)];
    }
    return (rec.pts || []).map(([de, dn]) => St.fromLocal(de, dn));
  }

  function utmToLatLngs(pts) {
    const z = SSBMSMap.getZone();
    return pts.map(pt => { const l = G.toLatLng(pt.e, pt.n, z); return [l.lat, l.lng]; });
  }

  /** Legger en strek i et lag, med kontrastkant under og valgfritt pilhode. */
  function paintLine(layer, pts, { color, style, dashed, opacity = 1, onClick }) {
    const latlngs = utmToLatLngs(pts);
    const c = S.drawColor(color), halo = S.drawHalo(color);

    /* Kontrastkanten MÅ ha samme stiplemønster som streken. Med heltrukken
       kant under en stiplet strek fylles mellomrommene av kanten, og det hele
       leses som en heltrukken strek i to farger. Mønsteret skaleres etter
       strekbredden, ellers blir kanten synlig i hvert mellomrom. */
    const DASH = '9 8';
    const HALO_DASH = '9.5 7.5';

    L.polyline(latlngs, {
      color: halo, weight: 7, opacity: 0.5 * opacity, interactive: false,
      lineCap: dashed ? 'butt' : 'round', lineJoin: 'round',
      dashArray: dashed ? HALO_DASH : null
    }).addTo(layer);
    const line = L.polyline(latlngs, {
      color: c, weight: 3.2, opacity: 0.95 * opacity,
      lineCap: dashed ? 'butt' : 'round', lineJoin: 'round',
      dashArray: dashed ? DASH : null,
      interactive: !!onClick
    });
    if (onClick) line.on('click', ev => { L.DomEvent.stop(ev.originalEvent || ev); onClick(); });
    line.addTo(layer);

    if (style === 'arrow' && pts.length >= 2) {
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      const brg = G.bearing(prev.e, prev.n, last.e, last.n);
      const ll = latlngs[latlngs.length - 1];
      L.marker(ll, {
        icon: L.divIcon({
          html: `<div class="draw-arrow" style="transform:rotate(${brg}deg)">${S.arrowHeadSVG(color, 24)}</div>`,
          className: 'sym', iconSize: [24, 24], iconAnchor: [12, 12]
        }),
        interactive: false, zIndexOffset: 300
      }).addTo(layer);
    }
  }

  function renderDraws() {
    if (!layers.draws) return;
    layers.draws.clearLayers();
    St.activeDraws().forEach(rec => {
      const pts = drawUTM(rec);
      if (!pts || pts.length < 2) return;
      paintLine(layers.draws, pts, {
        color: rec.color, style: rec.style,
        // Poster fra før stiplevalget mangler feltet. De var stiplet hvis de
        // var koblinger, og skal fortsatt se like ut.
        dashed: rec.dash === undefined ? !!rec.link : !!rec.dash,
        onClick: () => openDrawSheet(rec)
      });
    });
  }

  /** Streken slik den ser ut mens den tegnes, med markør på hvert satt punkt. */
  function renderDraft() {
    if (!draftLayer) return;
    draftLayer.clearLayers();
    if (!isArmed('draw')) return;
    const pts = pending.pts;
    if (pts.length >= 2) {
      paintLine(draftLayer, pts, { color: pending.color, style: pending.style, dashed: !!pending.dash, opacity: 0.7 });
    }
    utmToLatLngs(pts).forEach(ll => {
      L.circleMarker(ll, {
        radius: 5, color: S.drawColor(pending.color), weight: 2,
        fillColor: S.drawColor(pending.color), fillOpacity: 0.8, interactive: false
      }).addTo(draftLayer);
    });
  }

  function finishDraw() {
    if (!isArmed('draw') || pending.pts.length < 2) return;
    const rec = St.makeDraw({ pts: pending.pts, style: pending.style, color: pending.color, dash: pending.dash });
    const style = pending.style, n = pending.pts.length;
    setPending(null);
    St.publish(rec);
    SSBMSUI.toast(`${style === 'arrow' ? 'Pil' : 'Strek'} med ${n} punkter delt.`);
  }

  function handleLinkClick(rec) {
    if (!pending.a) {
      pending.a = rec.id;
      pending.aLabel = recLabel(rec);
      renderModebar();
      SSBMSUI.toast(`${recLabel(rec)} valgt. Trykk det andre punktet.`);
      return;
    }
    if (pending.a === rec.id) return SSBMSUI.toast('Velg et annet punkt.', 'warn');
    const link = { a: pending.a, b: rec.id };
    const color = pending.color, style = pending.style, dash = pending.dash;
    const fra = pending.aLabel, til = recLabel(rec);
    setPending(null);
    St.publish(St.makeDraw({ pts: [], style, color, dash, link }));
    SSBMSUI.toast(`Koblet: ${fra} → ${til}.`);
  }

  function openDrawSheet(rec) {
    const linked = !!rec.link;
    const dashNow = rec.dash === undefined ? linked : !!rec.dash;
    const body = el('div', 'drawsheet', `
      <div class="kv"><span>Type</span><b>${dashNow ? 'Stiplet ' : ''}${rec.style === 'arrow' ? 'pil' : 'strek'}${linked ? ' (kobling)' : ''}</b></div>
      <div class="kv"><span>Tegnet av</span><b>${escapeHtml(rec.by || '—')}</b></div>
      <div class="kv"><span>Tid</span><b>${St.zulu(rec.ts)} (${St.ageText(rec.ts)} siden)</b></div>
      ${linked ? `<div class="kv"><span>Kobler</span><b>${escapeHtml(recLabel(findRec(rec.link.a)))} → ${escapeHtml(recLabel(findRec(rec.link.b)))}</b></div>
      <p class="muted small">Koblingen følger de to punktene. Flyttes et av dem, flytter streken seg med. Slettes et av dem, forsvinner streken.</p>` : ''}
      <label>Farge</label>
      <div class="colpick" id="dCol"></div>
      <label>Form
        <select id="dStyle">
          <option value="line"${rec.style === 'line' ? ' selected' : ''}>Strek</option>
          <option value="arrow"${rec.style === 'arrow' ? ' selected' : ''}>Pil</option>
        </select></label>
      <label class="chk"><input type="checkbox" id="dDash" ${dashNow ? 'checked' : ''}> Stiplet</label>
      <label>Merknad <input id="dDesc" value="${escapeHtml(rec.desc || '')}" placeholder="valgfritt"></label>`);

    let col = rec.color;
    const cp = body.querySelector('#dCol');
    S.DRAW_ORDER.forEach(k => {
      const b = el('button', 'colbtn' + (k === col ? ' on' : ''), `<i style="background:${S.DRAW[k].color}"></i><span>${S.DRAW[k].label}</span>`);
      b.onclick = () => {
        col = k;
        cp.querySelectorAll('.colbtn').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      };
      cp.appendChild(b);
    });

    SSBMSUI.sheet({
      title: linked ? 'Kobling' : (rec.style === 'arrow' ? 'Pil' : 'Strek'), body,
      actions: [
        { label: 'Lagre', kind: 'primary', onClick: close => {
            St.publish({
              ...rec, color: col,
              style: body.querySelector('#dStyle').value,
              dash: body.querySelector('#dDash').checked,
              desc: body.querySelector('#dDesc').value,
              ts: Date.now()
            });
            close();
          } },
        { label: 'Slett', kind: 'danger', onClick: close => { St.remove(rec); close(); } }
      ]
    });
  }

  function renderSectors() {
    layers.sectors.clearLayers();
    St.activeUnits().forEach(rec => {
      if (!rec.obs || St.isStale(rec)) return;
      const { e, n } = St.recordUTM(rec);
      const { brg, width, range } = rec.obs;
      const pts = [[e, n]];
      const steps = Math.max(8, Math.round(width / 3));
      for (let i = 0; i <= steps; i++) {
        const a = (brg - width / 2 + (width * i) / steps) * Math.PI / 180;
        pts.push([e + range * Math.sin(a), n + range * Math.cos(a)]);
      }
      const latlngs = pts.map(([E, N]) => {
        const p = G.toLatLng(E, N, SSBMSMap.getZone());
        return [p.lat, p.lng];
      });
      const self = rec.id === St.state.self;
      L.polygon(latlngs, {
        className: 'obs-sector' + (self ? ' self' : ''),
        interactive: false, weight: 1.4,
        color: self ? '#00e676' : '#00c853',
        fillColor: self ? '#00e676' : '#00c853',
        fillOpacity: 0.12, opacity: 0.6
      }).addTo(layers.sectors);
    });
  }

  /* =========================================================
   *  Ark: enhet, POI, lokasjon
   * ========================================================= */

  function gridLine(rec) {
    const { e, n } = St.recordUTM(rec);
    const ll = St.recordLatLng(rec);
    return G.toMGRS(e, n, SSBMSMap.getZone(), ll.lat, 5);
  }

  function openUnitSheet(rec) {
    const obs = rec.obs;
    const { e, n } = St.recordUTM(rec);
    const body = el('div', '', `
      <div class="kv"><span>Kallesignal</span><b>${rec.cs}</b></div>
      <div class="kv"><span>Navn</span><b>${rec.name ? escapeHtml(rec.name) : '<span class="muted">ikke satt</span>'}${
        rec.name && rec.showName === false ? ' <span class="muted small">(skjult på kart)</span>' : ''}</b></div>
      <div class="kv"><span>Kilde</span><b class="${rec.manual ? 'warn' : 'good'}">${rec.manual
        ? 'Plassert for hånd av ' + escapeHtml(rec.by || '—')
        : (rec.id === St.state.self ? 'Egen GPS' : 'Rapportert av enheten')}</b></div>
      <div class="kv"><span>Rute</span><b class="mono">${gridLine(rec)}</b></div>
      <div class="kv"><span>UTM</span><b class="mono small">${Math.round(e)} Ø / ${Math.round(n)} N</b></div>
      <div class="kv"><span>${rec.manual ? 'Plassert' : 'Rapportert'}</span><b>${St.zulu(rec.ts)} (${St.ageText(rec.ts)} siden)</b></div>
      ${rec.acc != null ? `<div class="kv"><span>Nøyaktighet</span><b>±${rec.acc} m</b></div>` : ''}
      ${obs ? `<div class="kv"><span>Observerer</span><b>${G.compass(obs.brg)} (${String(Math.round(obs.brg)).padStart(3, '0')}°), sektor ${obs.width}°, ut til ${G.formatDistance(obs.range)}</b></div>` : ''}
      ${rec.note ? `<div class="kv"><span>Merknad</span><b>${escapeHtml(rec.note)}</b></div>` : ''}
      <div class="report">${reportText(rec)}</div>
      ${rec.manual ? `<p class="caveat">Håndplassert posisjon. Melder ${escapeHtml(rec.cs)} inn egen
        posisjon, overtar den automatisk.</p>` : ''}`);

    body.appendChild(photoBlock(rec.id, rec.id === St.state.self
      ? 'Bilder fra din sektor' : 'Bilder knyttet til ' + rec.cs));

    const actions = [{ label: 'Kopier melding', onClick: () => copy(reportText(rec)) }];
    if (rec.id === St.state.self) {
      actions.unshift({ label: 'Navn', onClick: close => { close(); openSelfNameSheet(); } });
      // Snarvei: sektoren justeres oftest rett etter at man har sett på egen
      // enhet, og veien om FAB-en var ett trykk for mye i mørket.
      actions.unshift({ label: 'Sektor og retning', kind: 'primary', onClick: close => { close(); openSectorSheet(); } });
    }
    if (rec.manual) {
      actions.unshift({ label: 'Flytt / sektor', onClick: close => { close(); openManualUnitEditor(rec); } });
      actions.push({ label: 'Fjern', kind: 'danger', onClick: close => { St.remove(rec); close(); } });
    }
    SSBMSUI.sheet({ title: 'Enhet ' + rec.cs, body, actions });
  }

  /** Navn på egen enhet. Lagres lokalt per kallesignal og sendes med posisjonen. */
  function openSelfNameSheet() {
    const body = el('div', 'unitplace', `
      <label>Navn <span class="opt">valgfritt</span>
        <input id="nName" maxlength="28" value="${escapeHtml(St.state.selfName || '')}"
               placeholder="f.eks. Troppssjef"></label>
      <label class="chk"><input type="checkbox" id="nShow" ${St.state.selfShowName !== false ? 'checked' : ''}>
        Vis navnet på kartet</label>
      <p class="muted small">Avhukingen gjelder for hele troppen — skrur du den av,
      skjules navnet hos alle. Vil du bare rydde ditt eget kart, bruk
      «Skjul alle enhetsnavn» i menyen.</p>`);
    SSBMSUI.sheet({
      title: 'Navn på ' + St.state.self, body,
      actions: [{ label: 'Lagre', kind: 'primary', onClick: close => {
        St.saveSelfName(body.querySelector('#nName').value, body.querySelector('#nShow').checked);
        pushPosition();
        close();
        SSBMSUI.toast('Navn lagret.');
      } }]
    });
  }

  /** Redigering av en håndplassert enhet: ny rute eller ny sektor. */
  function openManualUnitEditor(rec) {
    const zone = SSBMSMap.getZone();
    const cur = St.recordUTM(rec);
    const obs = rec.obs || { brg: 0, width: CFG.defaults.observationWidth, range: CFG.defaults.observationRange };
    const v = { ...obs };

    const body = el('div', 'unitplace', `
      <label>Navn <span class="opt">valgfritt</span>
        <input id="eName" maxlength="28" value="${escapeHtml(rec.name || '')}" placeholder="f.eks. Lag 1 skarpskytter"></label>
      <label class="chk"><input type="checkbox" id="eShow" ${rec.showName !== false ? 'checked' : ''}> Vis navnet på kartet</label>

      <label>Rute
        <input id="eGrid" autocomplete="off" spellcheck="false"
               value="${G.toMGRS(cur.e, cur.n, zone, St.recordLatLng(rec).lat, 5)}"></label>
      <div class="gridprev" id="ePrev"></div>
      <label><input type="checkbox" id="eHasObs" ${rec.obs ? 'checked' : ''}> Enheten har oppgitt sektor</label>
      <div id="eObsWrap" style="${rec.obs ? '' : 'display:none'}">
        <div id="eDial" class="dialbox"></div>
        <label>Sektorbredde <b id="eW">${v.width}°</b>
          <input id="eWin" type="range" min="10" max="180" step="5" value="${v.width}"></label>
        <label>Rekkevidde <b id="eR">${G.formatDistance(v.range)}</b>
          <input id="eRin" type="range" min="100" max="4000" step="100" value="${v.range}"></label>
      </div>
      <label>Merknad <input id="eNote" value="${escapeHtml(rec.note || '')}" placeholder="valgfritt"></label>`);

    const sh = SSBMSUI.sheet({
      title: 'Rediger ' + rec.cs, body,
      actions: [
        { label: 'Slipp på kart', onClick: close => {
            const meta = {
              name: body.querySelector('#eName').value,
              showName: body.querySelector('#eShow').checked,
              obs: body.querySelector('#eHasObs').checked ? { ...v, brg: Math.round(v.brg) } : null,
              note: body.querySelector('#eNote').value
            };
            close();
            setPending({ kind: 'unit', cs: rec.cs, meta });
          } },
        { label: 'Lagre', kind: 'primary', onClick: close => {
            const g = G.parseGrid(body.querySelector('#eGrid').value, zone, gridRef());
            if (!g) return SSBMSUI.toast('Ruta kan ikke tolkes.', 'warn');
            placeUnit(rec.cs, g.e, g.n, {
              obs: body.querySelector('#eHasObs').checked ? { ...v, brg: Math.round(v.brg) } : null,
              note: body.querySelector('#eNote').value,
              name: body.querySelector('#eName').value,
              showName: body.querySelector('#eShow').checked
            });
            close();
          } }
      ]
    });

    const dial = SSBMSUI.sectorDial(body.querySelector('#eDial'), v, nv => { v.brg = nv.brg; });
    body.querySelector('#eHasObs').onchange = ev => {
      body.querySelector('#eObsWrap').style.display = ev.target.checked ? '' : 'none';
    };
    body.querySelector('#eWin').oninput = ev => {
      v.width = +ev.target.value; body.querySelector('#eW').textContent = v.width + '°'; dial.set({ width: v.width });
    };
    body.querySelector('#eRin').oninput = ev => {
      v.range = +ev.target.value; body.querySelector('#eR').textContent = G.formatDistance(v.range);
    };
    const gi = body.querySelector('#eGrid');
    const prev = () => {
      const g = G.parseGrid(gi.value, zone, gridRef());
      const box = body.querySelector('#ePrev');
      box.className = 'gridprev ' + (g ? 'ok' : 'bad');
      box.textContent = g
        ? G.toMGRS(g.e, g.n, zone, G.toLatLng(g.e, g.n, zone).lat, 5)
        : 'Kan ikke tolkes.';
    };
    gi.addEventListener('input', prev);
    prev();
  }

  function reportText(rec) {
    const obs = rec.obs;
    const parts = [`${rec.cs}${rec.name ? ' (' + rec.name + ')' : ''} i ${gridLine(rec)}`];
    if (obs) parts.push(`observerer mot ${G.compass(obs.brg)} (${String(Math.round(obs.brg)).padStart(3, '0')}°), sektor ${obs.width}°, ut til ${G.formatDistance(obs.range)}`);
    parts.push(`tid ${St.zulu(rec.ts)}`);
    return parts.join(', ') + '.';
  }

  function openPOISheet(rec) {
    const alder = St.ageText(obsTime(rec));
    const gammel = !!ageFilterMs && (Date.now() - obsTime(rec)) > ageFilterMs;
    const body = el('div', '', `
      <div class="kv"><span>Rute</span><b class="mono">${gridLine(rec)}</b></div>
      <div class="kv"><span>Observert</span><b>${St.zulu(obsTime(rec))}
        <span class="age${St.isStale(rec) ? ' stale' : ''}">· ${alder} siden</span></b></div>
      <div class="kv"><span>Meldt av</span><b>${rec.by || '—'}</b></div>
      ${gammel ? '<p class="caveat">Denne observasjonen er eldre enn aldersfilteret ditt og vises ikke på kartet nå.</p>' : ''}
      <div class="grid2">
        <label>Type
          <select id="pType">${S.POI_ORDER.map(t =>
            `<option value="${t}"${t === rec.type ? ' selected' : ''}>${S.POI[t].label}</option>`).join('')}</select></label>
        <label>Tilhørighet
          <select id="pAff">${S.AFFIL_ORDER.map(a =>
            `<option value="${a}"${a === rec.affil ? ' selected' : ''}>${S.AFFIL[a].label}</option>`).join('')}</select></label>
        <label>Antall <input id="pCount" type="number" min="0" step="1" value="${rec.count ?? ''}" placeholder="—"></label>
        <label>Tidspunkt <input id="pTime" type="datetime-local" value="${toLocalInput(rec.obsTs || rec.ts)}"></label>
      </div>
      <label>Beskrivelse <textarea id="pDesc" rows="2" placeholder="Fritekst">${escapeHtml(rec.desc || '')}</textarea></label>
      <div class="grid2">
        <label>Bevegelse retning (°) <input id="pMovB" type="number" min="0" max="359" value="${rec.mov ? Math.round(rec.mov.brg) : ''}" placeholder="—"></label>
        <label>Fart <input id="pMovS" type="text" value="${rec.mov && rec.mov.speed ? escapeHtml(rec.mov.speed) : ''}" placeholder="f.eks. til fots"></label>
      </div>`);

    body.appendChild(photoBlock(rec.id, 'Bilder'));

    SSBMSUI.sheet({
      title: S.POI[rec.type].label, body,
      actions: [
        {
          label: 'Lagre', kind: 'primary', onClick: close => {
            const b = body.querySelector('#pMovB').value;
            const upd = {
              ...rec,
              type: body.querySelector('#pType').value,
              affil: body.querySelector('#pAff').value,
              count: body.querySelector('#pCount').value === '' ? null : parseInt(body.querySelector('#pCount').value, 10),
              desc: body.querySelector('#pDesc').value,
              obsTs: fromLocalInput(body.querySelector('#pTime').value) || rec.obsTs,
              mov: b === '' ? null : { brg: parseFloat(b), speed: body.querySelector('#pMovS').value },
              ts: Date.now()
            };
            St.publish(upd);
            close();
          }
        },
        { label: 'Slett', kind: 'danger', onClick: close => { St.remove(rec); close(); } }
      ]
    });
  }

  function openLocSheet(rec) {
    const body = el('div', '', `
      <div class="kv"><span>Rute</span><b class="mono">${gridLine(rec)}</b></div>
      <div class="kv"><span>Meldt av</span><b>${rec.by || '—'}</b></div>
      <label>Type <select id="lKind">${S.LOC_ORDER.map(k =>
        `<option value="${k}"${k === rec.kind ? ' selected' : ''}>${S.LOC[k].label}</option>`).join('')}</select></label>
      <label>Beskrivelse <textarea id="lDesc" rows="2">${escapeHtml(rec.desc || '')}</textarea></label>`);
    SSBMSUI.sheet({
      title: S.LOC[rec.kind].label, body,
      actions: [
        {
          label: 'Lagre', kind: 'primary', onClick: close => {
            St.publish({
              ...rec, kind: body.querySelector('#lKind').value,
              desc: body.querySelector('#lDesc').value, ts: Date.now()
            });
            close();
          }
        },
        { label: 'Slett', kind: 'danger', onClick: close => { St.remove(rec); close(); } }
      ]
    });
  }

  /* =========================================================
   *  Verktøylinje
   * ========================================================= */

  function wireToolbar() {
    $('#btnNight').onclick = e => {
      const on = !document.body.classList.contains('night');
      SSBMSMap.setNight(on);
      e.currentTarget.classList.toggle('on', on);
      localStorage.setItem('ssbms:night', on ? '1' : '0');
    };
    if (localStorage.getItem('ssbms:night') === '1') { SSBMSMap.setNight(true); $('#btnNight').classList.add('on'); }

    $('#btnGrid').onclick = e => {
      const on = !e.currentTarget.classList.contains('on');
      SSBMSMap.setGridVisible(on);
      e.currentTarget.classList.toggle('on', on);
    };
    $('#btnGrid').classList.add('on');

    $('#btnLayer').onclick = () => {
      const keys = Object.keys(SSBMSMap.LAYERS);
      const next = keys[(keys.indexOf(SSBMSMap.getBaseLayer()) + 1) % keys.length];
      SSBMSMap.setBaseLayer(next);
      SSBMSUI.toast('Kart: ' + SSBMSMap.LAYERS[next]);
    };

    $('#btnAge').onclick = openAgeSheet;
    $('#btnAge').classList.toggle('on', !!ageFilterMs);

    $('#btnSector').onclick = openSectorSheet;
    $('#btnCentre').onclick = () => {
      if (!selfPos) return SSBMSUI.toast('Ingen egen posisjon ennå.', 'warn');
      const ll = G.toLatLng(selfPos.e, selfPos.n, SSBMSMap.getZone());
      map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 14));
    };
    $('#btnLos').onclick = startLos;
    $('#btnLoc').onclick = openMissionSheet;
    $('#btnUnit').onclick = () => openUnitPlacer();
    $('#btnMenu').onclick = openMenu;
    $('#btnList').onclick = () => $('#side').classList.toggle('open');
    $('#sideClose').onclick = () => $('#side').classList.remove('open');

    // Hurtiglinje
    const qb = $('#quickbar');
    S.POI_ORDER.forEach(t => {
      const b = el('button', 'qt', `<span class="qglyph">${wrapGlyph(t)}</span><span>${S.POI[t].short}</span>`);
      b.onclick = () => {
        // Trykk på den allerede valgte typen avvæpner.
        if (isArmed('poi') && quick.type === t) return setPending(null);
        quick.type = t;
        setPending({ kind: 'poi' });
      };
      b.dataset.type = t;
      qb.appendChild(b);
    });
    const qa = $('#quickaff');
    S.AFFIL_ORDER.forEach(a => {
      const b = el('button', 'qa', S.AFFIL[a].label);
      b.style.setProperty('--c', S.AFFIL[a].color);
      b.dataset.aff = a;
      b.onclick = () => { quick.affil = a; if (isArmed('poi')) setPending({ kind: 'poi' }); else updateQuickBar(); };
      qa.appendChild(b);
    });
    updateQuickBar();
  }

  /* Hurtiglinja varierer i høyde mellom telefon og PC. Mål den, i stedet for
     å gjette, slik at kartet og flytknappene alltid ligger rett over den. */
  function trackQuickbarHeight() {
    const qw = $('#quickwrap');
    if (!qw) return;
    const apply = () => {
      document.documentElement.style.setProperty('--quickh', Math.ceil(qw.offsetHeight) + 'px');
      if (map) map.invalidateSize({ animate: false });
    };
    if (window.ResizeObserver) new ResizeObserver(apply).observe(qw);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', () => setTimeout(apply, 250));
    apply();
  }

  function wrapGlyph(t) {
    return `<svg viewBox="0 0 48 48" width="22" height="22"><g fill="currentColor" stroke="currentColor"
      stroke-linecap="round" stroke-linejoin="round">${S.glyph(t)}</g></svg>`;
  }

  function updateQuickBar() {
    const armed = isArmed('poi');
    document.querySelectorAll('.qt').forEach(b =>
      b.classList.toggle('on', armed && b.dataset.type === quick.type));
    document.querySelectorAll('.qa').forEach(b =>
      b.classList.toggle('on', b.dataset.aff === quick.affil));
    const hint = $('#quickHint');
    if (hint) {
      hint.textContent = armed
        ? `Trykk i kartet for å plassere. Trykk ${S.POI[quick.type].short} igjen for å avvæpne.`
        : 'Hold inne i kartet for hurtigmeny, eller velg type her.';
    }
  }

  /* ---------- sektor ---------- */

  function openSectorSheet() {
    const havePos = !!selfPos;
    const body = el('div', 'sectorwrap', `
      ${havePos ? '' : `<p class="caveat" id="sNoPos">Du har ingen egen posisjon ennå, og en sektor
        uten utgangspunkt betyr ingenting. Still inn retning, bredde og rekkevidde her —
        så lagres de i det du setter posisjonen din i kartet.</p>`}
      <div id="dial" class="dialbox"></div>
      <label>Sektorbredde <b id="wOut">${selfObs.width}°</b>
        <input id="wIn" type="range" min="10" max="180" step="5" value="${selfObs.width}"></label>
      <label>Rekkevidde <b id="rOut">${G.formatDistance(selfObs.range)}</b>
        <input id="rIn" type="range" min="100" max="4000" step="100" value="${selfObs.range}"></label>
      <label>Merknad <input id="sNote" type="text" placeholder="valgfritt"></label>
      <div class="report" id="sPrev"></div>`);

    body.appendChild(photoBlock(St.state.self, 'Bilder fra sektoren'));

    const sh = SSBMSUI.sheet({
      title: 'Sektor og retning', body,
      actions: [
        havePos
          ? { label: 'Del', kind: 'primary', onClick: close => { close(); if (pushPosition()) SSBMSUI.toast('Sektor delt.'); } }
          : { label: 'Sett posisjon i kartet', kind: 'primary', onClick: close => {
              close();
              setPending({ kind: 'selfpos' });
              SSBMSUI.toast('Trykk der du står — sektoren blir med.');
            } },
        { label: 'Fjern sektor', onClick: close => { selfObs = { ...selfObs, cleared: true }; close(); pushPosition(); } }
      ]
    });

    const dial = SSBMSUI.sectorDial(body.querySelector('#dial'), selfObs, v => {
      selfObs.brg = v.brg; preview();
    });
    body.querySelector('#wIn').oninput = e => {
      selfObs.width = +e.target.value;
      body.querySelector('#wOut').textContent = selfObs.width + '°';
      dial.set({ width: selfObs.width }); preview();
    };
    body.querySelector('#rIn').oninput = e => {
      selfObs.range = +e.target.value;
      body.querySelector('#rOut').textContent = G.formatDistance(selfObs.range);
      preview();
    };
    body.querySelector('#sNote').oninput = preview;

    function preview() {
      selfObs.cleared = false;
      const note = body.querySelector('#sNote').value;
      body.querySelector('#sPrev').textContent =
        `${St.state.self} observerer mot ${G.compass(selfObs.brg)} (${String(Math.round(selfObs.brg)).padStart(3, '0')}°), ` +
        `sektor ${selfObs.width}°, ut til ${G.formatDistance(selfObs.range)}${note ? '. ' + note : ''}.`;
      selfObs.note = note;
      renderSectorPreview();
    }
    preview();
  }

  function renderSectorPreview() {
    if (!selfPos) return;
    const rec = { ...St.makePosition({ e: selfPos.e, n: selfPos.n, acc: selfPos.acc, obs: sectorValue() }) };
    St.apply(rec, { local: true });
  }

  function sectorValue() {
    if (selfObs.cleared) return null;
    return { brg: Math.round(selfObs.brg), width: selfObs.width, range: selfObs.range };
  }

  /* ---------- oppdrag: lokasjoner og tegning ---------- */

  /**
   * Ett ark for alt som beskriver oppdraget på kartet, i stedet for en FAB per
   * ting. Lokasjonene ligger øverst fordi de brukes oftest; tegningen under,
   * fordi den krever et valg av farge og form før den gir mening.
   */
  function openMissionSheet() {
    const body = el('div', 'mission', '');

    body.appendChild(el('h3', '', 'Lokasjoner'));
    const lp = el('div', 'locpick', '');
    S.LOC_ORDER.forEach(k => {
      const b = el('button', 'locbtn', `${S.locSVG(k, 36)}<span>${S.LOC[k].label}</span>`);
      b.onclick = () => { sh.close(); setPending({ kind: 'loc', locKind: k }); };
      lp.appendChild(b);
    });
    body.appendChild(lp);

    body.appendChild(el('h3', '', 'Tegning'));
    const cp = el('div', 'colpick', '');
    S.DRAW_ORDER.forEach(k => {
      const b = el('button', 'colbtn' + (k === drawPick.color ? ' on' : ''),
        `<i style="background:${S.DRAW[k].color}"></i><span>${S.DRAW[k].label}</span>`);
      b.onclick = () => {
        drawPick.color = k;
        localStorage.setItem('ssbms:drawcolor', k);
        cp.querySelectorAll('.colbtn').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      };
      cp.appendChild(b);
    });
    body.appendChild(cp);

    /* Stiplet er en egenskap ved streken, ikke en egen strektype: den skal
       kunne kombineres med både strek, pil og kobling. Derfor en bryter her,
       ved siden av fargen, og ikke fire knapper under. */
    const sp = el('div', 'colpick two', '');
    const styles = [
      { key: false, label: 'Heltrukket', svg: '<svg viewBox="0 0 48 12" width="52" height="12"><path d="M3 6 H45" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" fill="none"/></svg>' },
      { key: true,  label: 'Stiplet',    svg: '<svg viewBox="0 0 48 12" width="52" height="12"><path d="M3 6 H45" stroke="currentColor" stroke-width="3.4" stroke-linecap="butt" stroke-dasharray="9 7" fill="none"/></svg>' }
    ];
    styles.forEach(o => {
      const b = el('button', 'colbtn' + (o.key === drawPick.dash ? ' on' : ''), `${o.svg}<span>${o.label}</span>`);
      b.onclick = () => {
        drawPick.dash = o.key;
        localStorage.setItem('ssbms:drawdash', o.key ? '1' : '0');
        sp.querySelectorAll('.colbtn').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      };
      sp.appendChild(b);
    });
    body.appendChild(sp);

    const dp = el('div', 'locpick', '');
    const drawBtn = (label, svg, onClick) => {
      const b = el('button', 'locbtn', `${svg}<span>${label}</span>`);
      b.onclick = onClick;
      dp.appendChild(b);
    };
    const lineIcon = `<svg viewBox="0 0 48 48" width="36" height="36"><path d="M8 38 L40 10" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;
    const arrowIcon = `<svg viewBox="0 0 48 48" width="36" height="36"><path d="M8 38 L38 12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M26 10 L40 8 L38 22" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const linkIcon = `<svg viewBox="0 0 48 48" width="36" height="36"><circle cx="13" cy="35" r="6" fill="none" stroke="currentColor" stroke-width="3.4"/><circle cx="35" cy="13" r="6" fill="none" stroke="currentColor" stroke-width="3.4"/><path d="M17.5 30.5 L30.5 17.5" fill="none" stroke="currentColor" stroke-width="3.4" stroke-dasharray="5 4" stroke-linecap="round"/></svg>`;

    drawBtn('Strek', lineIcon, () => {
      sh.close();
      setPending({ kind: 'draw', style: 'line', color: drawPick.color, dash: drawPick.dash, pts: [] });
      SSBMSUI.toast('Trykk i kartet for hvert punkt. «Ferdig» når streken er klar.');
    });
    drawBtn('Pil', arrowIcon, () => {
      sh.close();
      setPending({ kind: 'draw', style: 'arrow', color: drawPick.color, dash: drawPick.dash, pts: [] });
      SSBMSUI.toast('Trykk start, så videre punkter. Pilhodet havner på det siste.');
    });
    drawBtn('Koble punkter', linkIcon, () => {
      if (linkTargets().length < 2) {
        return SSBMSUI.toast('Det må finnes minst to observasjoner eller lokasjoner å koble.', 'warn');
      }
      sh.close();
      setPending({ kind: 'link', style: 'arrow', color: drawPick.color, dash: drawPick.dash, a: null });
      SSBMSUI.toast('Trykk den første observasjonen eller lokasjonen.');
    });
    body.appendChild(dp);

    const n = St.activeDraws().length;
    body.appendChild(el('p', 'muted small',
      n ? `${n} tegning${n === 1 ? '' : 'er'} på kartet. Trykk på en strek for å endre farge eller slette den.`
        : 'Trykk på en ferdig strek i kartet for å endre farge eller slette den.'));

    const actions = [];
    if (n) actions.push({ label: 'Slett alle tegninger', kind: 'danger', onClick: close => {
      if (!confirm(`Slette alle ${n} tegninger? Dette gjelder for hele troppen.`)) return;
      St.activeDraws().forEach(r => St.remove(r));
      close();
      SSBMSUI.toast('Tegningene er slettet.');
    } });

    const sh = SSBMSUI.sheet({ title: 'Oppdrag', body, actions });
  }

  /* ---------- plassering av enheter i troppen ---------- */

  /** Referansepunkt for å løse korte ruter: egen posisjon, ellers kartsenter. */
  function gridRef() {
    if (selfPos) return { e: selfPos.e, n: selfPos.n };
    const c = map.getCenter();
    return G.toUTM(c.lat, c.lng, SSBMSMap.getZone());
  }

  function openUnitPlacer(preset) {
    const zone = SSBMSMap.getZone();
    const taken = new Set(St.activeUnits().map(u => u.id));
    const options = CFG.callsigns
      .map(c => `<option value="${c}"${c === preset ? ' selected' : ''}>${c}${taken.has(c) ? ' — allerede på kartet' : ''}</option>`)
      .join('');

    const body = el('div', 'unitplace', `
      <label>Kallesignal
        <select id="uCs">${options}<option value="__custom">Annet…</option></select></label>
      <input id="uCsCustom" placeholder="Eget kallesignal" style="display:none">

      <label>Navn <span class="opt">valgfritt</span>
        <input id="uName" maxlength="28" placeholder="f.eks. Lag 1 skarpskytter"></label>
      <label class="chk"><input type="checkbox" id="uShow" checked> Vis navnet på kartet</label>

      <label>Rute
        <input id="uGrid" inputmode="text" autocomplete="off" spellcheck="false"
               placeholder="32V NM 84837 39530  ·  84837 39530  ·  848 395"></label>
      <div class="gridprev" id="uPrev"></div>

      <p class="caveat" id="uWarn" style="display:none"></p>
      <p class="muted small">Enheter du plasserer selv merkes med stiplet ring og
      «plassert av ${St.state.self}». Melder enheten inn egen posisjon senere,
      overtar den automatisk.</p>`);

    const sh = SSBMSUI.sheet({
      title: 'Plasser enhet', body,
      actions: [
        { label: 'Slipp på kart', onClick: close => {
            const meta = { name: body.querySelector('#uName').value, showName: body.querySelector('#uShow').checked };
            close();
            setPending({ kind: 'unit', cs: callsign(), meta });
          } },
        { label: 'Plasser fra rute', kind: 'primary', onClick: close => {
            const r = parsed();
            if (!r) return SSBMSUI.toast('Ruta kan ikke tolkes.', 'warn');
            const meta = { name: body.querySelector('#uName').value, showName: body.querySelector('#uShow').checked };
            close();
            placeUnit(callsign(), r.e, r.n, meta);
          } }
      ]
    });

    const csSel = body.querySelector('#uCs');
    const csCustom = body.querySelector('#uCsCustom');
    csSel.onchange = () => {
      csCustom.style.display = csSel.value === '__custom' ? 'block' : 'none';
      const ex = St.state.units.get(callsign());
      if (ex) {
        body.querySelector('#uName').value = ex.name || '';
        body.querySelector('#uShow').checked = ex.showName !== false;
      }
      warn();
    };
    function callsign() {
      return (csSel.value === '__custom' ? csCustom.value.trim().toUpperCase() : csSel.value) || 'UKJENT';
    }
    function warn() {
      const w = body.querySelector('#uWarn');
      if (callsign() === St.state.self) {
        w.style.display = '';
        w.textContent = 'Dette er ditt eget kallesignal. Plasseringen blir overskrevet av din egen GPS ved neste rapport.';
      } else { w.style.display = 'none'; }
    }

    const input = body.querySelector('#uGrid');
    let last = null;
    function parsed() { return last; }
    function preview() {
      const ref = gridRef();
      last = G.parseGrid(input.value, zone, ref);
      const box = body.querySelector('#uPrev');
      if (!input.value.trim()) { box.className = 'gridprev'; box.textContent = ''; return; }
      if (!last) {
        box.className = 'gridprev bad';
        box.textContent = 'Kan ikke tolkes. Godtar MGRS, UTM eller kort feltrute.';
        return;
      }
      const ll = G.toLatLng(last.e, last.n, zone);
      const d = G.distance(ref.e, ref.n, last.e, last.n);
      const brg = G.bearing(ref.e, ref.n, last.e, last.n);
      box.className = 'gridprev ok';
      box.innerHTML = `<b class="mono">${G.toMGRS(last.e, last.n, zone, ll.lat, 5)}</b>
        <span>${last.format === 'kort' ? 'kort rute løst mot ' + (selfPos ? 'egen posisjon' : 'kartsenter') : last.format.toUpperCase()}
        · ${G.formatDistance(d)} i ${G.compass(brg)} (${String(Math.round(brg)).padStart(3, '0')}°)</span>`;
    }
    input.addEventListener('input', preview);
    csSel.dispatchEvent(new Event('change'));
    preview();
  }

  function placeUnit(cs, e, n, extra) {
    if (!cs) return;
    const prev = St.state.units.get(cs);
    const pick = (k, fallback) => (extra && extra[k] !== undefined) ? extra[k] : fallback;
    St.publish(St.makeUnitPlacement({
      cs, e, n,
      obs: pick('obs', prev && prev.manual ? prev.obs : null),
      note: pick('note', (prev && prev.manual ? prev.note : '')) || '',
      name: pick('name', prev ? prev.name : '') || '',
      showName: pick('showName', prev ? prev.showName !== false : true)
    }));
    // Panorer kun når punktet kan ligge utenfor skjermen - altså ved rute-
    // inntasting. Ble enheten sluppet i kartet, ser brukeren den allerede, og
    // å flytte utsnittet under fingeren er bare forstyrrende.
    const ll = G.toLatLng(e, n, SSBMSMap.getZone());
    if (!map.getBounds().pad(-0.08).contains([ll.lat, ll.lng])) map.panTo([ll.lat, ll.lng]);
    SSBMSUI.toast(`${cs} plassert i ${G.toShortGrid(e, n)}.`);
  }

  /* ---------- siktlinje ---------- */

  function startLos() {
    losLayer.clearLayers();
    setPending({ kind: 'los', a: null });
    document.body.classList.add('los-mode');
    if (selfPos) {
      const ll = G.toLatLng(selfPos.e, selfPos.n, SSBMSMap.getZone());
      pending.a = { lat: ll.lat, lng: ll.lng };
      L.circleMarker([ll.lat, ll.lng], { radius: 6, color: '#ffab00', weight: 2 }).addTo(losLayer);
      SSBMSUI.toast('Startpunkt satt til egen posisjon. Trykk på målpunkt.');
    } else {
      SSBMSUI.toast('Siktlinje: trykk på observasjonspunkt, så på målpunkt.');
    }
  }

  async function handleLosClick(latlng) {
    if (!pending.a) {
      pending.a = latlng;
      L.circleMarker(latlng, { radius: 6, color: '#ffab00', weight: 2 }).addTo(losLayer);
      return;
    }
    const zone = SSBMSMap.getZone();
    const a = G.toUTM(pending.a.lat, pending.a.lng, zone);
    const b = G.toUTM(latlng.lat, latlng.lng, zone);
    const dist = G.distance(a.e, a.n, b.e, b.n);
    setPending(null);
    document.body.classList.remove('los-mode');

    if (dist < 20) return SSBMSUI.toast('For kort strekning.', 'warn');
    if (dist > 30000) return SSBMSUI.toast('Maks 30 km per siktlinje.', 'warn');

    L.polyline([losPick0(a, zone), losPick0(b, zone)], {
      color: '#ffab00', weight: 1, dashArray: '4 4', interactive: false
    }).addTo(losLayer);

    SSBMSUI.toast('Henter terrengprofil…');
    const prof = await SSBMSLos.fetchProfile(a, b, zone, 200);
    if (!prof.ok) {
      losLayer.clearLayers();
      return SSBMSUI.toast('Høydedata utilgjengelig: ' + prof.error, 'warn');
    }
    const an = SSBMSLos.analyse(prof.points, CFG.defaults.observerHeight, CFG.defaults.targetHeight);
    drawLos(an, zone);
    openLosSheet(an, prof, dist);
  }

  function losPick0(p, zone) {
    const ll = G.toLatLng(p.e, p.n, zone);
    return [ll.lat, ll.lng];
  }

  function drawLos(an, zone) {
    losLayer.clearLayers();
    SSBMSLos.segments(an).forEach(seg => {
      const pts = seg.pts.map(p => losPick0(p, zone));
      if (pts.length < 2) return;
      L.polyline(pts, {
        color: seg.visible ? '#00e676' : '#ff1744',
        weight: 4, opacity: 0.85, lineCap: 'butt'
      }).addTo(losLayer);
    });
  }

  function openLosSheet(an, prof, dist) {
    const chart = profileChart(an);
    const body = el('div', '', `
      <div class="kv"><span>Avstand</span><b>${G.formatDistance(an.total)}</b></div>
      <div class="kv"><span>Sikt til endepunkt</span><b class="${an.endVisible ? 'good' : 'bad'}">${an.endVisible ? 'FRI' : 'SPERRET'}</b></div>
      ${an.firstBlockAt != null ? `<div class="kv"><span>Første sperre</span><b>${G.formatDistance(an.firstBlockAt)}</b></div>` : ''}
      <div class="kv"><span>Høyde start / mål</span><b>${Math.round(an.obsGround)} / ${Math.round(an.tgtGround)} moh.</b></div>
      ${!an.endVisible && an.requiredTargetHeight ? `<div class="kv"><span>Mål må være over</span><b>${an.requiredTargetHeight.toFixed(1)} m</b></div>` : ''}
      ${chart}
      <p class="caveat"><b>Forbehold:</b> analysen bruker terrengmodell (bar bakke) fra ${escapeHtml(prof.source)}.
      Skog, bygninger og annen vegetasjon er <b>ikke</b> med. I norsk terreng gir dette systematisk
      for optimistisk sikt. Dette er en terrengsperre-analyse, ikke en sikthetsvurdering.</p>`);
    SSBMSUI.sheet({
      title: 'Siktlinje', body, wide: true,
      actions: [{ label: 'Fjern fra kart', onClick: close => { losLayer.clearLayers(); close(); } }]
    });
  }

  function profileChart(an) {
    const W = 560, H = 190, pad = { l: 40, r: 10, t: 12, b: 24 };
    const pts = an.points;
    if (!pts.length) return '';
    const zs = pts.map(p => p.z);
    const zMin = Math.min(...zs, an.obsGround) - 5;
    const zMax = Math.max(...zs, an.obsGround + CFG.defaults.observerHeight) + 10;
    const x = d => pad.l + (d / an.total) * (W - pad.l - pad.r);
    const y = z => pad.t + (1 - (z - zMin) / (zMax - zMin)) * (H - pad.t - pad.b);

    let terrain = `M${pad.l} ${H - pad.b}`;
    pts.forEach(p => { terrain += ` L${x(p.d).toFixed(1)} ${y(p.z).toFixed(1)}`; });
    terrain += ` L${x(an.total).toFixed(1)} ${H - pad.b} Z`;

    let bars = '';
    pts.forEach((p, i) => {
      if (i === 0) return;
      const x0 = x(pts[i - 1].d), x1 = x(p.d);
      bars += `<rect x="${x0.toFixed(1)}" y="${H - pad.b + 2}" width="${Math.max(0.6, x1 - x0).toFixed(1)}" height="6"
        fill="${p.visible ? '#00e676' : '#ff1744'}"/>`;
    });

    const y0 = y(an.obsGround + CFG.defaults.observerHeight);
    const y1 = y(an.tgtGround + CFG.defaults.targetHeight);
    return `<svg class="profile" viewBox="0 0 ${W} ${H}" width="100%">
      <path d="${terrain}" fill="rgba(120,140,110,0.35)" stroke="#8a9a7a" stroke-width="1"/>
      <line x1="${x(0)}" y1="${y0}" x2="${x(an.total)}" y2="${y1}" stroke="#ffab00" stroke-width="1.4" stroke-dasharray="5 4"/>
      ${bars}
      <text x="${pad.l}" y="${H - 6}" class="ax">0</text>
      <text x="${W - pad.r}" y="${H - 6}" class="ax" text-anchor="end">${G.formatDistance(an.total)}</text>
      <text x="4" y="${pad.t + 8}" class="ax">${Math.round(zMax)} m</text>
      <text x="4" y="${H - pad.b}" class="ax">${Math.round(zMin)} m</text>
    </svg>`;
  }

  /* =========================================================
   *  Posisjon
   * ========================================================= */

  function startGeolocation() {
    if (!navigator.geolocation) {
      gpsOn = false;
      setPending({ kind: 'selfpos', sticky: true });
      SSBMSUI.toast('Ingen GPS tilgjengelig - trykk i kartet for å sette posisjon.', 'warn');
    } else {
      startWatch();
    }
    setInterval(() => { if (selfPos && !St.state.emcon) pushPosition(); }, CFG.defaults.positionIntervalMs);
  }

  function startWatch() {
    if (watchId != null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(
      p => {
        // Andre beltet: en oppdatering som allerede var i kø da GPS ble slått
        // av, skal heller ikke få lov til å flytte en manuell posisjon.
        if (!gpsOn) return;
        const { e, n } = G.toUTM(p.coords.latitude, p.coords.longitude, SSBMSMap.getZone());
        selfPos = { e, n, acc: p.coords.accuracy };
        renderStatus();
      },
      err => {
        console.warn('GPS', err.message);
        if (!gpsOn) return;
        SSBMSUI.toast('GPS: ' + err.message + ' - trykk i kartet for å sette posisjon.', 'warn');
        if (!pending) setPending({ kind: 'selfpos', sticky: true });
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }

  function stopWatch() {
    if (watchId == null) return;
    try { navigator.geolocation.clearWatch(watchId); } catch (e) { /* ignorer */ }
    watchId = null;
  }

  /**
   * Av/på for GPS. Å bare ignorere oppdateringene hadde holdt funksjonelt,
   * men watchPosition med enableHighAccuracy holder radioen i gang - og en
   * manuell posisjon settes gjerne nettopp når man vil spare batteri eller
   * ikke stoler på mottaket. Så vi stopper lytteren.
   */
  function setGps(on, { quiet = false } = {}) {
    if (gpsOn === on) { renderStatus(); return; }
    gpsOn = on;
    if (on) {
      startWatch();
      if (!quiet) SSBMSUI.toast('GPS på igjen. Posisjonen oppdateres automatisk.');
    } else {
      stopWatch();
      if (!quiet) SSBMSUI.toast('GPS av. Posisjonen står til du flytter den selv.', 'warn');
    }
    renderStatus();
  }

  /** @returns {boolean} om posisjonen faktisk ble sendt. */
  function pushPosition() {
    if (!selfPos) {
      SSBMSUI.toast('Ingen egen posisjon ennå. Sett den i kartet (Meny → Sett egen posisjon) eller vent på GPS.', 'warn');
      return false;
    }
    St.publish(St.makePosition({
      e: selfPos.e, n: selfPos.n, acc: selfPos.acc,
      obs: sectorValue(), note: selfObs.note || ''
    }));
    return true;
  }

  /* =========================================================
   *  Status og liste
   * ========================================================= */

  function renderBackendTag() {
    const t = $('#backendTag');
    if (!t) return;
    const shared = St.state.backend === 'supabase';
    t.textContent = shared ? 'SUPABASE' : 'KUN LOKALT';
    t.className = 'tag ' + (shared ? 'ok' : 'bad');
    t.title = shared
      ? 'Deler med alle som har samme nøkkel.'
      : 'Ingen deling mellom enheter — se Meny → Deling.';
  }

  function openSharingSheet() {
    const shared = St.state.backend === 'supabase';
    const body = el('div', '', shared ? `
      <div class="kv"><span>Status</span><b class="good">Deler via Supabase</b></div>
      <div class="kv"><span>Tilkobling</span><b class="${St.state.online ? 'good' : 'bad'}">${St.state.online ? 'På nett' : 'Av nett'}</b></div>
      <div class="kv"><span>Rom-ID</span><b class="mono small">${St.state.roomId}</b></div>
      <p class="muted small">Alle som taster samme nøkkel havner i samme rom.
      Innholdet krypteres før det sendes.</p>` : `
      <p class="caveat"><b>Ingenting deles mellom enheter nå.</b> Appen kjører i lokal modus:
      den synker bare mellom faner i samme nettleser på samme maskin. PC-en og mobilen
      ser derfor hver sine data, uansett at nøkkelen er lik.</p>

      <h3>Slik skrur du på deling</h3>
      <ol class="steps">
        <li>Lag et gratis prosjekt på <b>supabase.com</b>.</li>
        <li>Åpne <b>SQL Editor</b> og kjør innholdet i <code>supabase/schema.sql</code>.</li>
        <li>Gå til <b>Project Settings → API</b> og kopier <code>Project URL</code> og
            <code>anon public</code>-nøkkelen.</li>
        <li>Lim dem inn i <code>js/config.js</code>:
          <pre>supabase: {
  url: 'https://xxxx.supabase.co',
  anonKey: 'eyJhbGciOi…'
}</pre></li>
        <li>Last siden på nytt. Merket øverst skal si <b>SUPABASE</b>.</li>
      </ol>
      <p class="muted small">anon-nøkkelen er ment å ligge i klienten — den er offentlig.
      Innholdet krypteres uansett før det forlater enheten.</p>`);
    SSBMSUI.sheet({ title: 'Deling mellom enheter', body, wide: !shared });
  }

  function renderStatus() {
    const z = SSBMSMap.getZone();
    if (selfPos) {
      const ll = G.toLatLng(selfPos.e, selfPos.n, z);
      $('#ownGrid').textContent = G.toMGRS(selfPos.e, selfPos.n, z, ll.lat, 5);
      $('#ownAcc').textContent = selfPos.acc != null
        ? '±' + Math.round(selfPos.acc) + ' m'
        : (gpsOn ? 'manuell' : 'manuell · låst');
    } else {
      $('#ownGrid').textContent = 'venter på posisjon…';
      $('#ownAcc').textContent = '';
    }
    $('#zulu').textContent = St.zulu(Date.now());
    renderBackendTag();
    const conn = $('#connTag');
    conn.textContent = St.state.emcon ? 'LYTTER' : (St.state.online ? 'PÅ NETT' : 'AV NETT');
    conn.className = 'tag ' + (St.state.emcon ? 'emcon' : (St.state.online ? 'ok' : 'bad'));
    $('#queueTag').textContent = St.state.outbox.length ? St.state.outbox.length + ' i kø' : '';
    const at = $('#ageTag');
    if (at) {
      const opt = AGE_OPTIONS.find(o => o.ms === ageFilterMs) || AGE_OPTIONS[0];
      at.textContent = opt.tag;
      at.className = 'tag' + (ageFilterMs ? ' emcon' : '');
      at.title = ageFilterMs ? `Observasjoner eldre enn ${opt.label.toLowerCase()} er skjult.` : '';
    }
    const gt = $('#gpsTag');
    if (gt) {
      gt.textContent = gpsOn ? '' : 'GPS AV';
      gt.className = 'tag' + (gpsOn ? '' : ' emcon');
      gt.title = gpsOn ? '' : 'Manuell posisjon er låst. Slå på GPS igjen i menyen.';
    }
    const swTag = $('#swTag');
    if (swTag) {
      swTag.textContent = swReason ? 'INGEN OFFLINE' : '';
      swTag.className = 'tag' + (swReason ? ' bad' : '');
      swTag.title = swReason ? 'Offline-cache utilgjengelig: ' + swReason : '';
    }
  }

  function renderList() {
    const box = $('#sideBody');
    if (!box) return;
    const units = St.activeUnits().sort((a, b) => a.cs.localeCompare(b.cs));
    const pois = visiblePOIs().sort((a, b) => obsTime(b) - obsTime(a));
    const skjult = St.activePOIs().length - pois.length;
    const locs = St.activeLocs();

    box.innerHTML =
      `<h3>Enheter (${units.length})</h3>` +
      (units.map(r => `<div class="row${r.manual ? ' manual' : ''}" data-goto="${r.id}" data-kind="unit"
            title="${r.manual ? 'Plassert for hånd av ' + escapeHtml(r.by || '—') : 'Rapportert av enheten'}">
          <span class="dot" style="--c:${r.id === St.state.self ? '#00e676' : '#00c853'}"></span>
          <b>${r.cs}${r.manual ? ' <em class="mtag">M</em>' : ''}</b>
          ${r.name ? `<span class="rname">${escapeHtml(r.name)}</span>` : ''}
          <span class="mono">${G.toShortGrid(St.recordUTM(r).e, St.recordUTM(r).n)}</span>
          <span class="age ${St.isStale(r) ? 'stale' : ''}">${St.ageText(r.ts)}</span></div>`).join('') || '<p class="muted">Ingen.</p>') +
      `<h3>Observasjoner (${pois.length})${skjult
        ? ` <span class="muted small">— ${skjult} skjult av aldersfilteret</span>` : ''}</h3>` +
      (pois.map(r => `<div class="row" data-goto="${r.id}" data-kind="poi">
          <span class="dot" style="--c:${S.AFFIL[r.affil].color}"></span>
          <b>${S.POI[r.type].short}${r.count ? ' ×' + r.count : ''}</b>
          <span class="mono">${G.toShortGrid(St.recordUTM(r).e, St.recordUTM(r).n)}</span>
          <span class="age">${St.ageText(r.obsTs || r.ts)}</span></div>`).join('') || '<p class="muted">Ingen.</p>') +
      `<h3>Lokasjoner (${locs.length})</h3>` +
      (locs.map(r => `<div class="row" data-goto="${r.id}" data-kind="loc">
          <span class="dot" style="--c:${S.LOC[r.kind].color}"></span>
          <b>${S.LOC[r.kind].label}</b>
          <span class="mono">${G.toShortGrid(St.recordUTM(r).e, St.recordUTM(r).n)}</span></div>`).join('') || '<p class="muted">Ingen.</p>');

    box.querySelectorAll('[data-goto]').forEach(row => {
      row.onclick = () => {
        const id = row.dataset.goto;
        const rec = St.state.units.get(id) || St.state.pois.get(id) || St.state.locs.get(id);
        if (!rec) return;
        const ll = St.recordLatLng(rec);
        map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 14));
        if (window.innerWidth < 900) $('#side').classList.remove('open');
      };
    });
  }

  /* =========================================================
   *  Meny
   * ========================================================= */

  function openMenu() {
    const body = el('div', 'menu', `
      <button class="mi ${St.state.backend === 'supabase' ? '' : 'warnrow'}" id="mSharing">📡 Deling: ${
        St.state.backend === 'supabase' ? 'Supabase' : 'KUN LOKALT — ingen deling'}</button>
      <button class="mi" id="mEmcon">${St.state.emcon ? '🔇 Lyttemodus PÅ - trykk for å sende igjen' : '📡 Slå på lyttemodus (ingen utsending)'}</button>
      <button class="mi" id="mManual">${isArmed('selfpos') ? '📍 Manuell posisjon PÅ - trykk for å avbryte' : '📍 Sett egen posisjon manuelt'}</button>
      <button class="mi ${gpsOn ? '' : 'warnrow'}" id="mGps">${gpsOn
        ? '🛰 GPS på — posisjonen følger mottakeren'
        : '🛰 GPS AV — trykk for å slå på igjen'}</button>
      <button class="mi" id="mUnit">👥 Plasser enhet fra troppen</button>
      <button class="mi" id="mSelfName">🏷 Navn på egen enhet (${St.state.selfName || 'ikke satt'})</button>
      <button class="mi" id="mLabels">${labelsOn ? '🙈 Skjul alle enhetsnavn (kun her)' : '👁 Vis alle enhetsnavn'}</button>
      <button class="mi" id="mOffline">⬇ Last ned kart for offline bruk</button>
      <button class="mi" id="mUpdate">🔄 Tving oppdatering av appen</button>
      <button class="mi" id="mExport">💾 Eksporter GeoJSON</button>
      <button class="mi" id="mKey">🔑 Vis sesjonsinfo</button>
      <button class="mi danger" id="mWipe">🗑 Slett alt og logg ut</button>
      <p class="menufoot">SSBMS v${CFG.version} · ${CFG.released}</p>`);
    const sh = SSBMSUI.sheet({ title: 'Meny', body });

    body.querySelector('#mSharing').onclick = () => { sh.close(); openSharingSheet(); };
    body.querySelector('#mEmcon').onclick = () => {
      St.state.emcon = !St.state.emcon;
      sh.close(); renderStatus();
      SSBMSUI.toast(St.state.emcon ? 'Lyttemodus: ingenting sendes ut.' : 'Sender igjen.', St.state.emcon ? 'warn' : '');
      if (!St.state.emcon) St.flush();
    };
    body.querySelector('#mManual').onclick = () => {
      const on = isArmed('selfpos');
      sh.close();
      setPending(on ? null : { kind: 'selfpos', sticky: true });
      if (!on) SSBMSUI.toast('Trykk der du står. GPS slås av til du slår den på igjen.');
    };
    body.querySelector('#mGps').onclick = () => {
      sh.close();
      if (gpsOn) {
        setGps(false);
      } else {
        setGps(true);
        if (!navigator.geolocation) SSBMSUI.toast('Nettleseren gir ingen GPS her.', 'warn');
      }
    };
    body.querySelector('#mUnit').onclick = () => { sh.close(); openUnitPlacer(); };
    body.querySelector('#mSelfName').onclick = () => { sh.close(); openSelfNameSheet(); };
    body.querySelector('#mLabels').onclick = () => {
      labelsOn = !labelsOn;
      localStorage.setItem('ssbms:labels', labelsOn ? '1' : '0');
      sh.close(); render();
      SSBMSUI.toast(labelsOn ? 'Enhetsnavn vises.' : 'Enhetsnavn skjult på denne enheten.');
    };
    body.querySelector('#mOffline').onclick = () => { sh.close(); downloadTiles(); };
    body.querySelector('#mUpdate').onclick = () => { sh.close(); forceUpdate(); };
    body.querySelector('#mExport').onclick = () => { sh.close(); exportGeoJSON(); };
    body.querySelector('#mKey').onclick = () => { sh.close(); showSessionInfo(); };
    body.querySelector('#mWipe').onclick = () => {
      if (!confirm('Slette all lokal data og logge ut? Kan ikke angres.')) return;
      St.wipe();
      (async () => {
        try {
          if (window.caches) {
            const ks = await caches.keys();
            await Promise.all(ks.map(k => caches.delete(k)));
          }
          if (navigator.serviceWorker) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
          }
        } catch (e) { /* uansett: last på nytt */ }
        location.replace(location.pathname);
      })();
    };
  }

  function showSessionInfo() {
    const k = St.state.key;
    const body = el('div', '', `
      <div class="kv"><span>Appversjon</span><b class="mono">v${CFG.version} <span class="muted">(${CFG.released})</span></b></div>
      <div class="kv"><span>Kallesignal</span><b>${St.state.self}</b></div>
      <div class="kv"><span>Rom-ID</span><b class="mono small">${St.state.roomId}</b></div>
      <div class="kv"><span>Posisjonskilde</span><b class="${gpsOn ? 'good' : 'warn'}">${gpsOn ? 'GPS' : 'Manuell (GPS av)'}</b></div>
      <div class="kv"><span>UTM-sone</span><b>${k.zone} (EPSG:258${k.zone})</b></div>
      <div class="kv"><span>AO-origo</span><b>${(k.originE / 1000).toFixed(0)} km Ø / ${(k.originN / 1000).toFixed(0)} km N</b></div>
      <div class="kv"><span>Bakende</span><b>${St.state.backend}</b></div>
      <div class="kv"><span>Kryptering</span><b>AES-GCM 256, PBKDF2 ${SSBMSKey.PBKDF2_ITERATIONS.toLocaleString('nb-NO')} runder</b></div>
      <div class="kv"><span>Offline-cache</span><b class="${swReason ? 'bad' : 'good'}">${
        swReason ? 'Utilgjengelig' : 'Aktiv'}</b></div>
      ${swReason ? `<p class="caveat">Kartet vil <b>ikke</b> være tilgjengelig uten dekning:
        ${escapeHtml(swReason)}. På Vercel, med gyldig sertifikat, virker offline-cachen.</p>` : ''}
      <p class="caveat">Rom-ID og tidsstempler er synlige for tjenesten. Posisjoner og tekst er det ikke.
      Nøkkelens sesjonsdel er 10 siffer - se README om hva det faktisk beskytter mot.</p>`);
    SSBMSUI.sheet({ title: 'Sesjon', body });
  }

  /* En vei ut av en fastlåst cache uten å grave i nettleserinnstillinger.
     Tømmer appcachen og registrerer service workeren på nytt - kartflisene og
     sesjonsdataene røres ikke. */
  async function forceUpdate() {
    SSBMSUI.toast('Henter siste versjon…');
    try {
      if (window.caches) {
        const names = await caches.keys();
        await Promise.all(names.filter(n => n.startsWith('ssbms-app')).map(n => caches.delete(n)));
      }
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch (e) {
      console.warn('[ssbms] oppdatering:', e);
    }
    // Omgå nettleserens egen cache på selve omlastingen.
    location.replace(location.pathname + '?oppdatert=' + Date.now());
  }

  async function downloadTiles() {
    if (!window.caches) return SSBMSUI.toast('Nettleseren støtter ikke offline-cache.', 'warn');
    const z = Math.round(map.getZoom());
    const urls = SSBMSMap.tileURLsForBounds(map.getBounds(), z, Math.min(18, z + CFG.offline.extraZoomLevels));
    if (urls.length > CFG.offline.maxTiles) {
      return SSBMSUI.toast(`For stort utsnitt (${urls.length} fliser, maks ${CFG.offline.maxTiles}). Zoom inn.`, 'warn');
    }
    const body = el('div', '', `<p>Laster ned <b>${urls.length}</b> fliser for dette utsnittet.</p>
      <progress id="dlp" max="${urls.length}" value="0" style="width:100%"></progress>
      <p class="muted" id="dlt">0 / ${urls.length}</p>`);
    const sh = SSBMSUI.sheet({ title: 'Offline-kart', body });
    const cache = await caches.open('ssbms-tiles-v1');
    let done = 0, failed = 0;
    for (let i = 0; i < urls.length; i += 6) {
      await Promise.all(urls.slice(i, i + 6).map(async u => {
        try { await cache.add(new Request(u, { mode: 'cors' })); } catch (e) { failed++; }
        done++;
      }));
      body.querySelector('#dlp').value = done;
      body.querySelector('#dlt').textContent = `${done} / ${urls.length}${failed ? ' (' + failed + ' feilet)' : ''}`;
    }
    sh.close();
    SSBMSUI.toast(`Offline-kart lagret: ${done - failed} fliser.`);
  }

  function exportGeoJSON() {
    const z = SSBMSMap.getZone();
    const feat = [];
    const push = (rec, props) => {
      const ll = St.recordLatLng(rec);
      feat.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] },
        properties: { ...props, grid: gridLine(rec), tid: new Date(rec.ts).toISOString() }
      });
    };
    St.activeUnits().forEach(r => push(r, {
      kategori: 'enhet', kallesignal: r.cs, navn: r.name || null,
      sektor: r.obs || null, handplassert: !!r.manual, meldt_av: r.by || null
    }));
    St.activePOIs().forEach(r => push(r, {
      kategori: 'observasjon', type: r.type, tilhorighet: r.affil,
      antall: r.count, beskrivelse: r.desc, bevegelse: r.mov || null, meldt_av: r.by
    }));
    St.activeLocs().forEach(r => push(r, { kategori: 'lokasjon', type: r.kind, beskrivelse: r.desc }));

    St.activeDraws().forEach(r => {
      const pts = drawUTM(r);
      if (!pts || pts.length < 2) return;
      feat.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: utmToLatLngs(pts).map(([lat, lng]) => [lng, lat]) },
        properties: {
          kategori: 'tegning', form: r.style, farge: r.color,
          kobling: r.link || null, beskrivelse: r.desc || null,
          tegnet_av: r.by || null, tid: new Date(r.ts).toISOString()
        }
      });
    });

    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: feat }, null, 2)],
      { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ssbms-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}Z.geojson`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }


  /* =========================================================
   *  Bilder
   *
   *  Miniatyrer, ikke dokumentasjonsfoto. De går gjennom nøyaktig samme
   *  krypterte kanal som resten, og ssbms_put tar maks 20 000 tegn
   *  chiffertekst. Base64 inn i JSON, AES rundt, base64 ut igjen gir ca. 1,8x
   *  oppblåsing, så budsjettet er rundt 10 kB bilde. Vi komprimerer ned til
   *  det passer i stedet for å avvise brukeren med en filstørrelse.
   * ========================================================= */

  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      // imageOrientation: telefonbilder ligger som regel med EXIF-rotasjon.
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) { try { return await createImageBitmap(file); } catch (e2) { /* faller gjennom */ } }
    }
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('kan ikke leses')); };
      img.src = url;
    });
  }

  /**
   * Komprimerer til det faktisk passer gjennom ssbms_put.
   *
   * Den forrige utgaven gjettet på oppblåsingsfaktoren base64 → JSON → AES →
   * base64 og sammenlignet mot et antall bytes. Gjetningen traff ikke, og
   * resultatet var et bilde som ble avvist med «lar seg ikke komprimere nok»
   * uten at noen kunne se hvorfor. Nå krypteres hvert forsøk og chifferteksten
   * måles — det er nøyaktig det tallet serveren håndhever.
   *
   * Vi går fra stort til smått og returnerer det FØRSTE som passer, slik at du
   * får den beste kvaliteten budsjettet tillater, ikke den minste.
   */
  /**
   * JPEG-koding via toBlob, ikke toDataURL.
   *
   * Dette er den faktiske årsaken til «lar seg ikke komprimere nok» på iPhone:
   * WebKits toDataURL har historisk ignorert kvalitetsargumentet for JPEG og
   * levert noe i nærheten av 0,9 uansett hva man ber om. Kvalitetssløyfen
   * gjorde derfor ingenting — bare bredden hadde effekt — og selv nederste
   * trinn havnet over budsjettet. toBlob respekterer kvaliteten.
   *
   * toDataURL beholdes som reserve for nettlesere uten toBlob.
   */
  function encodeJPEG(cv, q) {
    const fallback = () => {
      const url = cv.toDataURL('image/jpeg', q);
      return url.slice(url.indexOf(',') + 1);
    };
    return new Promise(resolve => {
      if (!cv.toBlob) return resolve(fallback());
      let settled = false;
      const done = v => { if (!settled) { settled = true; resolve(v); } };
      // Safari har ved enkelte anledninger latt være å kalle tilbake i det
      // hele tatt. Da er en litt for stor reserve bedre enn et hengt ark.
      setTimeout(() => done(fallback()), 4000);
      cv.toBlob(blob => {
        if (!blob) return done(fallback());
        const fr = new FileReader();
        fr.onload = () => { const u = String(fr.result); done(u.slice(u.indexOf(',') + 1)); };
        fr.onerror = () => done(fallback());
        fr.readAsDataURL(blob);
      }, 'image/jpeg', q);
    });
  }

  async function compressPhoto(file, ref) {
    const src = await loadBitmap(file);
    const sw = src.width || src.naturalWidth;
    const sh = src.height || src.naturalHeight;
    if (!sw || !sh) throw new Error('tomt bilde');

    const max = CFG.photos.maxCipherChars;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    let best = null;   // minste forsøk, til feilmeldingen

    for (const w of CFG.photos.widths) {
      const scale = Math.min(1, w / Math.max(sw, sh));
      cv.width = Math.max(1, Math.round(sw * scale));
      cv.height = Math.max(1, Math.round(sh * scale));
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(src, 0, 0, cv.width, cv.height);

      for (const q of CFG.photos.qualities) {
        const b64 = await encodeJPEG(cv, q);
        const bytes = Math.round(b64.length * 0.75);
        best = { w: cv.width, h: cv.height, q, bytes, ct: null };

        // Chifferteksten er alltid større enn klarteksten. Er base64-strengen
        // alene over taket, er det ingen vits i å kryptere for å få vite det.
        if (b64.length >= max) continue;

        const ct = await SSBMSSync.cipherLength(St.makePhoto({ ref, img: b64 }));
        best.ct = ct;
        if (ct == null || ct <= max) return { b64, w: cv.width, h: cv.height, bytes, ct };
      }
    }
    return { failed: true, ...best };
  }

  /**
   * Filvelger. iPhone er grunnen til at dette er to knapper og ikke én:
   * capture="environment" åpner kameraet DIREKTE og fjerner «Fotobibliotek»
   * fra valgene. Uten attributtet får du bibliotek, filer og kamera i samme
   * arkivalg. Begge deler trengs — du tar bilde i øyeblikket, eller legger ved
   * et du tok før du hadde dekning.
   */
  function pickPhoto(ref, { camera }, done) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    if (camera) inp.setAttribute('capture', 'environment');
    inp.style.display = 'none';
    document.body.appendChild(inp);

    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      inp.remove();
      if (!file) return;
      SSBMSUI.toast('Komprimerer bilde…');
      try {
        const r = await compressPhoto(file, ref);
        if (r.failed) {
          console.warn('[ssbms] bilde for stort', r);
          return SSBMSUI.toast(
            `Bildet passer ikke: ${r.w}×${r.h} ga ${Math.round((r.ct || r.bytes * 1.35) / 1000)} kB kryptert, ` +
            `taket er ${Math.round(CFG.photos.maxCipherChars / 1000)} kB. Prøv et motiv med mindre detaljer.`, 'warn');
        }
        St.publish(St.makePhoto({ ref, img: r.b64 }));
        SSBMSUI.toast(`Bilde lagt ved — ${r.w}×${r.h}, ${Math.max(1, Math.round(r.bytes / 1024))} kB.`);
        if (done) done();
      } catch (e) {
        console.warn('[ssbms] bilde:', e);
        SSBMSUI.toast('Kunne ikke lese bildet: ' + ((e && e.message) || e), 'warn');
      }
    };
    inp.click();
  }

  /** Miniatyrstripe med knapp, til bruk nederst i et ark. */
  function photoBlock(ref, title) {
    const box = el('div', 'photobox', '');
    const redraw = () => {
      box.innerHTML = '';
      box.appendChild(el('h3', '', escapeHtml(title || 'Bilder')));
      const ps = St.photosFor(ref);
      const strip = el('div', 'photos', '');
      ps.forEach(rec => {
        const b = el('button', 'photo', `<img alt="" src="data:image/jpeg;base64,${rec.img}">`);
        b.onclick = () => openPhotoViewer(rec, redraw);
        strip.appendChild(b);
      });
      const cam = el('button', 'photo add', '<span>📷</span><em>Ta bilde</em>');
      cam.title = 'Ta bilde med kameraet';
      cam.onclick = () => pickPhoto(ref, { camera: true }, redraw);
      strip.appendChild(cam);

      const lib = el('button', 'photo add', '<span>🖼</span><em>Velg bilde</em>');
      lib.title = 'Velg et bilde du allerede har';
      lib.onclick = () => pickPhoto(ref, { camera: false }, redraw);
      strip.appendChild(lib);

      box.appendChild(strip);
      if (!ps.length) {
        box.appendChild(el('p', 'muted small',
          `Miniatyr på maks ${Math.round(CFG.photos.maxCipherChars / 1000)} kB kryptert, komprimert automatisk. ` +
          'Nok til å vise hva du ser — ikke til å lese et skilt.'));
      }
    };
    redraw();
    return box;
  }

  function openPhotoViewer(rec, done) {
    const body = el('div', 'photoview', `
      <img alt="" src="data:image/jpeg;base64,${rec.img}">
      <div class="kv"><span>Tatt av</span><b>${escapeHtml(rec.by || '—')}</b></div>
      <div class="kv"><span>Tid</span><b>${St.zulu(rec.ts)} (${St.ageText(rec.ts)} siden)</b></div>
      <label>Merknad <input id="phDesc" value="${escapeHtml(rec.desc || '')}" placeholder="valgfritt"></label>`);
    SSBMSUI.sheet({
      title: 'Bilde', body,
      actions: [
        { label: 'Lagre', kind: 'primary', onClick: close => {
            St.publish({ ...rec, desc: body.querySelector('#phDesc').value, ts: Date.now() });
            close(); if (done) done();
          } },
        { label: 'Slett', kind: 'danger', onClick: close => { St.remove(rec); close(); if (done) done(); } }
      ]
    });
  }

  /* =========================================================
   *  Hjelpere
   * ========================================================= */

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toLocalInput(ts) {
    const d = new Date(ts - new Date().getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }
  function fromLocalInput(v) { return v ? new Date(v).getTime() : null; }
  function copy(txt) {
    navigator.clipboard?.writeText(txt).then(
      () => SSBMSUI.toast('Kopiert.'),
      () => SSBMSUI.toast('Kopiering feilet.', 'warn'));
  }

  document.addEventListener('DOMContentLoaded', initLogin);
})();
