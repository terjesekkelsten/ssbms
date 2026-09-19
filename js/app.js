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
    layers.sectors = L.layerGroup().addTo(map);
    layers.pois = L.layerGroup().addTo(map);
    layers.units = L.layerGroup().addTo(map);
    losLayer = L.layerGroup().addTo(map);

    wireMap();
    wireToolbar();
    trackQuickbarHeight();
    St.on(() => { render(); renderStatus(); });

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

        case 'selfpos': {
          selfPos = { e: E, n: N, acc: null };
          const sticky = pending.sticky;
          pushPosition();
          const sec = sectorValue();
          SSBMSUI.toast('Egen posisjon satt: ' + G.toShortGrid(E, N) +
            (sec ? ` · sektor ${G.compass(sec.brg)} ${String(Math.round(sec.brg)).padStart(3, '0')}°` : ''));
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
    const bar = $('#modebar');
    if (!bar) return;
    if (!p) {
      bar.classList.remove('on');
      bar.innerHTML = '';
    } else {
      bar.classList.add('on');
      bar.innerHTML = `<span class="mb-dot"></span><span class="mb-text">${pendingLabel(p)}</span>
        <button class="mb-x" type="button">Avbryt</button>`;
      bar.querySelector('.mb-x').onclick = () => setPending(null);
    }
    document.body.classList.toggle('armed', !!p);
    updateQuickBar();
  }

  function pendingLabel(p) {
    switch (p.kind) {
      case 'poi': return `Trykk i kartet: ${S.POI[quick.type].label.toLowerCase()} / ${S.AFFIL[quick.affil].label.toLowerCase()}`;
      case 'loc': return `Trykk i kartet: ${S.LOC[p.locKind].label.toLowerCase()}`;
      case 'unit': return `Trykk i kartet: plasser ${p.cs}`;
      case 'selfpos': return 'Manuell posisjon — trykk i kartet';
      case 'los': return 'Siktlinje — trykk observasjonspunkt, så målpunkt';
      default: return 'Armert';
    }
  }

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && pending) { setPending(null); SSBMSUI.closeRadial(); }
  });

  function openRadialAt(x, y, latlng, mode) {
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
    syncLayer('pois', St.activePOIs(), r => r.id, rec => {
      const ll = St.recordLatLng(rec);
      const g = L.layerGroup();
      const m = L.marker([ll.lat, ll.lng], {
        icon: icon(S.poiSVG(rec.type, rec.affil), [34, 34]),
        title: `${S.POI[rec.type].label} · ${S.AFFIL[rec.affil].label}`
      });
      m.on('click', () => openPOISheet(rec));
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
      m.on('click', () => openLocSheet(rec));
      return m;
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

    const actions = [{ label: 'Kopier melding', onClick: () => copy(reportText(rec)) }];
    if (rec.id === St.state.self) {
      actions.unshift({ label: 'Navn', onClick: close => { close(); openSelfNameSheet(); } });
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
    const body = el('div', '', `
      <div class="kv"><span>Rute</span><b class="mono">${gridLine(rec)}</b></div>
      <div class="kv"><span>Meldt av</span><b>${rec.by || '—'}</b></div>
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

    $('#btnSector').onclick = openSectorSheet;
    $('#btnCentre').onclick = () => {
      if (!selfPos) return SSBMSUI.toast('Ingen egen posisjon ennå.', 'warn');
      const ll = G.toLatLng(selfPos.e, selfPos.n, SSBMSMap.getZone());
      map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 14));
    };
    $('#btnLos').onclick = startLos;
    $('#btnLoc').onclick = openLocPicker;
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

  /* ---------- lokasjoner ---------- */

  function openLocPicker() {
    const body = el('div', 'locpick', '');
    S.LOC_ORDER.forEach(k => {
      const b = el('button', 'locbtn', `${S.locSVG(k, 36)}<span>${S.LOC[k].label}</span>`);
      b.onclick = () => {
        sh.close();
        setPending({ kind: 'loc', locKind: k });
      };
      body.appendChild(b);
    });
    const sh = SSBMSUI.sheet({ title: 'Lokasjon', body });
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
      setPending({ kind: 'selfpos', sticky: true });
      return SSBMSUI.toast('Ingen GPS tilgjengelig - trykk i kartet for å sette posisjon.', 'warn');
    }
    watchId = navigator.geolocation.watchPosition(
      p => {
        const { e, n } = G.toUTM(p.coords.latitude, p.coords.longitude, SSBMSMap.getZone());
        selfPos = { e, n, acc: p.coords.accuracy };
        renderStatus();
      },
      err => {
        console.warn('GPS', err.message);
        SSBMSUI.toast('GPS: ' + err.message + ' - trykk i kartet for å sette posisjon.', 'warn');
        if (!pending) setPending({ kind: 'selfpos', sticky: true });
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    setInterval(() => { if (selfPos && !St.state.emcon) pushPosition(); }, CFG.defaults.positionIntervalMs);
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
      $('#ownAcc').textContent = selfPos.acc != null ? '±' + Math.round(selfPos.acc) + ' m' : 'manuell';
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
    const pois = St.activePOIs().sort((a, b) => b.ts - a.ts);
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
      `<h3>Observasjoner (${pois.length})</h3>` +
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
      <button class="mi" id="mManual">${isArmed('selfpos') ? '📍 Manuell posisjon PÅ - trykk for å gå tilbake til GPS' : '📍 Sett egen posisjon manuelt'}</button>
      <button class="mi" id="mUnit">👥 Plasser enhet fra troppen</button>
      <button class="mi" id="mSelfName">🏷 Navn på egen enhet (${St.state.selfName || 'ikke satt'})</button>
      <button class="mi" id="mLabels">${labelsOn ? '🙈 Skjul alle enhetsnavn (kun her)' : '👁 Vis alle enhetsnavn'}</button>
      <button class="mi" id="mOffline">⬇ Last ned kart for offline bruk</button>
      <button class="mi" id="mExport">💾 Eksporter GeoJSON</button>
      <button class="mi" id="mKey">🔑 Vis sesjonsinfo</button>
      <button class="mi danger" id="mWipe">🗑 Slett alt og logg ut</button>`);
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
      if (on) SSBMSUI.toast('Tilbake til GPS.');
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
    body.querySelector('#mExport').onclick = () => { sh.close(); exportGeoJSON(); };
    body.querySelector('#mKey').onclick = () => { sh.close(); showSessionInfo(); };
    body.querySelector('#mWipe').onclick = () => {
      if (!confirm('Slette all lokal data og logge ut? Kan ikke angres.')) return;
      St.wipe();
      if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
      location.reload();
    };
  }

  function showSessionInfo() {
    const k = St.state.key;
    const body = el('div', '', `
      <div class="kv"><span>Kallesignal</span><b>${St.state.self}</b></div>
      <div class="kv"><span>Rom-ID</span><b class="mono small">${St.state.roomId}</b></div>
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

    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: feat }, null, 2)],
      { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ssbms-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}Z.geojson`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
