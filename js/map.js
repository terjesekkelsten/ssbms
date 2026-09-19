/* SSBMS - kart, projeksjon og rutenett
 *
 * Kartet kjører i UTM-sonen nøkkelen angir (EPSG:25832/25833/25835), ikke i
 * Web Mercator. Det gir rette rutenettlinjer og korrekt MGRS uten forvrengning.
 */

const SSBMSMap = (() => {
  'use strict';

  const TILE_BASE = 'https://cache.kartverket.no/v1/wmts/1.0.0';
  const LAYERS = {
    topograatone: 'Gråtone',
    topo: 'Topografisk',
    toporaster: 'Turkart',
    sjokartraster: 'Sjøkart'
  };

  let map = null;
  let zone = 33;
  let tileLayer = null;
  let gridLayer = null;
  // Gråtone er standard: symbolfargene (grønn/blå/grå/rød) er hele
  // lesbarheten i dette kartet, og et fargerikt grunnkart konkurrerer med dem.
  const DEFAULT_BASE = 'topograatone';
  let currentBase = DEFAULT_BASE;

  /* ---------- CRS ---------- */

  function buildCRS(z) {
    const m = SSBMSGeo.MATRIX[z];
    return new L.Proj.CRS(m.epsg, proj4.defs(m.epsg), {
      resolutions: SSBMSGeo.RESOLUTIONS,
      origin: m.origin,
      bounds: L.bounds(
        [m.origin[0], 9045984 - SSBMSGeo.RESOLUTIONS[0] * 256 * 64],
        [m.origin[0] + SSBMSGeo.RESOLUTIONS[0] * 256 * 64, 9045984]
      )
    });
  }

  function baseURL(layer, z) {
    return `${TILE_BASE}/${layer}/default/${SSBMSGeo.MATRIX[z].set}/{z}/{y}/{x}.png`;
  }

  /* ---------- rutenettlag ---------- */

  const GridLayer = L.Layer.extend({
    onAdd(m) {
      this._map = m;
      this._canvas = L.DomUtil.create('canvas', 'ssbms-grid-canvas');
      this._canvas.style.position = 'absolute';
      this._canvas.style.pointerEvents = 'none';
      this._canvas.style.zIndex = 250;
      m.getPanes().overlayPane.appendChild(this._canvas);
      m.on('move zoom moveend zoomend resize viewreset', this._redraw, this);
      this._redraw();
    },
    onRemove(m) {
      m.off('move zoom moveend zoomend resize viewreset', this._redraw, this);
      if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
      this._canvas = null;
    },
    setVisible(v) { this._visible = v; this._redraw(); },
    setNight(v) { this._night = v; this._redraw(); },

    _redraw() {
      const m = this._map, cv = this._canvas;
      if (!m || !cv) return;

      const size = m.getSize();
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== size.x * dpr || cv.height !== size.y * dpr) {
        cv.width = size.x * dpr;
        cv.height = size.y * dpr;
        cv.style.width = size.x + 'px';
        cv.style.height = size.y + 'px';
      }
      L.DomUtil.setPosition(cv, m.containerPointToLayerPoint([0, 0]));

      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      if (this._visible === false) return;

      // Viewport-hjørner -> UTM
      const corners = [[0, 0], [size.x, 0], [0, size.y], [size.x, size.y]]
        .map(p => {
          const ll = m.containerPointToLatLng(p);
          return SSBMSGeo.toUTM(ll.lat, ll.lng, zone);
        });
      const minE = Math.min(...corners.map(c => c.e));
      const maxE = Math.max(...corners.map(c => c.e));
      const minN = Math.min(...corners.map(c => c.n));
      const maxN = Math.max(...corners.map(c => c.n));

      const res = SSBMSGeo.RESOLUTIONS[Math.round(m.getZoom())] || m.getZoom();
      const step = SSBMSGeo.gridStep(res);
      if ((maxE - minE) / step > 400) return; // sikkerhetsventil

      const major = step * 10;
      const line = this._night ? 'rgba(255,60,60,0.55)' : 'rgba(20,20,20,0.45)';
      const lineMajor = this._night ? 'rgba(255,80,80,0.9)' : 'rgba(0,0,0,0.75)';
      const label = this._night ? '#ff4d4d' : '#111';
      const halo = this._night ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)';

      const toPt = (e, n) => {
        const ll = SSBMSGeo.toLatLng(e, n, zone);
        return m.latLngToContainerPoint([ll.lat, ll.lng]);
      };

      ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
      ctx.lineJoin = 'round';

      // Loddrette linjer (konstant østing)
      for (let e = Math.floor(minE / step) * step; e <= maxE; e += step) {
        const isMajor = Math.abs(e % major) < 1e-6;
        const a = toPt(e, minN), b = toPt(e, maxN);
        ctx.beginPath();
        ctx.strokeStyle = isMajor ? lineMajor : line;
        ctx.lineWidth = isMajor ? 1.6 : 0.8;
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

        if (a.x > 46 && a.x < size.x - 16) {
          drawLabel(ctx, gridLabel(e, step), a.x, 14, label, halo);
        }
      }

      // Vannrette linjer (konstant nording)
      for (let n = Math.floor(minN / step) * step; n <= maxN; n += step) {
        const isMajor = Math.abs(n % major) < 1e-6;
        const a = toPt(minE, n), b = toPt(maxE, n);
        ctx.beginPath();
        ctx.strokeStyle = isMajor ? lineMajor : line;
        ctx.lineWidth = isMajor ? 1.6 : 0.8;
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

        if (a.y > 30 && a.y < size.y - 6) {
          drawLabel(ctx, gridLabel(n, step), 22, a.y - 4, label, halo);
        }
      }
    }
  });

  function gridLabel(v, step) {
    // Prinsipalsiffer: to store siffer for 1 km-ruter, slik de leses over samband.
    const km = Math.floor(Math.abs(v) / 1000) % 100;
    if (step >= 10000) return String(Math.floor(Math.abs(v) / 1000) % 1000).padStart(2, '0');
    if (step >= 1000) return String(km).padStart(2, '0');
    const sub = Math.floor((Math.abs(v) % 1000) / step);
    return String(km).padStart(2, '0') + '·' + sub;
  }

  function drawLabel(ctx, text, x, y, color, halo) {
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /* ---------- oppsett ---------- */

  function init(containerId, z, center) {
    zone = z;
    // Brukerens siste kartvalg overlever reload.
    try {
      const saved = localStorage.getItem('ssbms:baseLayer');
      if (saved && LAYERS[saved]) currentBase = saved;
    } catch (e) { /* privat modus */ }
    map = L.map(containerId, {
      crs: buildCRS(z),
      center: center || [59.9, 10.6],
      zoom: 12,
      minZoom: 3,
      maxZoom: 18,
      zoomControl: false,
      attributionControl: true,
      tap: false,
      doubleClickZoom: false,   // dobbelttrykk er reservert til hurtighandling
      preferCanvas: true
    });

    L.control.zoom({ position: 'topright' }).addTo(map);
    map.attributionControl.setPrefix('').addAttribution('© Kartverket');

    tileLayer = L.tileLayer(baseURL(currentBase, z), {
      maxNativeZoom: 18,
      minZoom: 3,
      tileSize: 256,
      crossOrigin: true,
      className: 'ssbms-tiles'
    }).addTo(map);

    gridLayer = new GridLayer();
    gridLayer._visible = true;
    map.addLayer(gridLayer);

    return map;
  }

  function setBaseLayer(name) {
    if (!LAYERS[name] || !tileLayer) return;
    currentBase = name;
    tileLayer.setUrl(baseURL(name, zone));
    try { localStorage.setItem('ssbms:baseLayer', name); } catch (e) { /* privat modus */ }
  }

  function setNight(on) {
    document.body.classList.toggle('night', on);
    if (gridLayer) gridLayer.setNight(on);
  }

  function setGridVisible(v) { if (gridLayer) gridLayer.setVisible(v); }

  function getZone() { return zone; }
  function getMap() { return map; }
  function getBaseLayer() { return currentBase; }
  function refreshGrid() { if (gridLayer) gridLayer._redraw(); }

  /** Alle flise-URLer som dekker gitt utsnitt - brukes til offline-nedlasting. */
  function tileURLsForBounds(bounds, zFrom, zTo) {
    const urls = [];
    const m = SSBMSGeo.MATRIX[zone];
    for (let z = zFrom; z <= zTo; z++) {
      const res = SSBMSGeo.RESOLUTIONS[z];
      if (!res) continue;
      const sw = SSBMSGeo.toUTM(bounds.getSouth(), bounds.getWest(), zone);
      const ne = SSBMSGeo.toUTM(bounds.getNorth(), bounds.getEast(), zone);
      const nw = SSBMSGeo.toUTM(bounds.getNorth(), bounds.getWest(), zone);
      const se = SSBMSGeo.toUTM(bounds.getSouth(), bounds.getEast(), zone);
      const minE = Math.min(sw.e, nw.e), maxE = Math.max(ne.e, se.e);
      const minN = Math.min(sw.n, se.n), maxN = Math.max(ne.n, nw.n);
      const span = 256 * res;
      const x0 = Math.floor((minE - m.origin[0]) / span);
      const x1 = Math.floor((maxE - m.origin[0]) / span);
      const y0 = Math.floor((m.origin[1] - maxN) / span);
      const y1 = Math.floor((m.origin[1] - minN) / span);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if (x < 0 || y < 0) continue;
          urls.push(`${TILE_BASE}/${currentBase}/default/${m.set}/${z}/${y}/${x}.png`);
        }
      }
    }
    return urls;
  }

  return {
    init, getMap, getZone, setBaseLayer, getBaseLayer, DEFAULT_BASE,
    setNight, setGridVisible, refreshGrid, tileURLsForBounds,
    LAYERS
  };
})();
