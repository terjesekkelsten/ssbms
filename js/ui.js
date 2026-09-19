/* SSBMS - hurtig-UI: radialmeny, sektorskive og ark */

const SSBMSUI = (() => {
  'use strict';

  const S = SSBMSSymbols;

  /* =========================================================
   *  Radialmeny for POI - ett sammenhengende grep
   *
   *  Indre ring  = type   (5 sektorer)
   *  Ytre ring   = farge  (4 sektorer)
   *  Slipp i midten = avbryt
   * ========================================================= */

  const R_CANCEL = 34;
  const R_TYPE_IN = 42, R_TYPE_OUT = 96;
  const R_AFF_IN = 100, R_AFF_OUT = 152;

  let radial = null;

  function polar(cx, cy, r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function arcPath(cx, cy, rIn, rOut, a0, a1) {
    const [x0, y0] = polar(cx, cy, rOut, a0);
    const [x1, y1] = polar(cx, cy, rOut, a1);
    const [x2, y2] = polar(cx, cy, rIn, a1);
    const [x3, y3] = polar(cx, cy, rIn, a0);
    const large = (a1 - a0) > 180 ? 1 : 0;
    return `M${x0} ${y0} A${rOut} ${rOut} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${rIn} ${rIn} 0 ${large} 0 ${x3} ${y3} Z`;
  }

  /**
   * Åpner radialmenyen.
   * @param x,y  skjermkoordinat (klientkoordinat)
   * @param defaults {type, affil, mode}
   *        mode 'drag'  fingeren/musa er fortsatt nede - valget avsluttes ved slipp
   *        mode 'click' pekeren er allerede sluppet (høyreklikk) - segmentene trykkes
   * @param onPick  ({type, affil}) => void  - kalles ved gyldig valg
   */
  function openRadial(x, y, defaults, onPick) {
    closeRadial();

    const size = 340, c = size / 2;
    const host = document.createElement('div');
    host.className = 'radial-host';
    // Hold menyen innenfor skjermen
    const left = Math.min(Math.max(x, c + 4), window.innerWidth - c - 4);
    const top = Math.min(Math.max(y, c + 4), window.innerHeight - c - 4);
    host.style.left = (left - c) + 'px';
    host.style.top = (top - c) + 'px';
    host.style.width = host.style.height = size + 'px';

    const typeN = S.POI_ORDER.length, affN = S.AFFIL_ORDER.length;
    const typeStep = 360 / typeN, affStep = 360 / affN;

    let svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;
    svg += `<circle cx="${c}" cy="${c}" r="${R_AFF_OUT}" class="radial-bg"/>`;

    S.POI_ORDER.forEach((t, i) => {
      const a0 = i * typeStep - 90 + 90, a1 = a0 + typeStep;
      svg += `<path class="radial-seg radial-type" data-type="${t}" d="${arcPath(c, c, R_TYPE_IN, R_TYPE_OUT, a0, a1)}"/>`;
      const [gx, gy] = polar(c, c, (R_TYPE_IN + R_TYPE_OUT) / 2, (a0 + a1) / 2);
      svg += `<g transform="translate(${gx - 17},${gy - 17}) scale(0.71)" class="radial-glyph" pointer-events="none">
                <g fill="#e8eef2" stroke="#e8eef2" stroke-linecap="round" stroke-linejoin="round">${S.glyph(t)}</g></g>`;
    });

    S.AFFIL_ORDER.forEach((k, i) => {
      const a0 = i * affStep - 90 + 45, a1 = a0 + affStep;
      const col = S.AFFIL[k].color;
      svg += `<path class="radial-seg radial-aff" data-aff="${k}" d="${arcPath(c, c, R_AFF_IN, R_AFF_OUT, a0, a1)}"
                style="--seg:${col}"/>`;
      const [lx, ly] = polar(c, c, (R_AFF_IN + R_AFF_OUT) / 2, (a0 + a1) / 2);
      svg += `<text x="${lx}" y="${ly}" class="radial-label" pointer-events="none">${S.AFFIL[k].label.toUpperCase()}</text>`;
    });

    svg += `<circle cx="${c}" cy="${c}" r="${R_CANCEL}" class="radial-cancel"/>`;
    svg += `<text x="${c}" y="${c}" class="radial-cancel-text" pointer-events="none">AVBRYT</text>`;
    svg += `</svg>`;
    host.innerHTML = svg;
    document.body.appendChild(host);

    const st = {
      host,
      type: defaults.type || 'personell',
      affil: defaults.affil || 'ukjent',
      committed: false,
      moved: false,
      cx: left, cy: top
    };
    radial = st;

    const paint = () => {
      host.querySelectorAll('.radial-type').forEach(el =>
        el.classList.toggle('on', el.dataset.type === st.type));
      host.querySelectorAll('.radial-aff').forEach(el =>
        el.classList.toggle('on', el.dataset.aff === st.affil));
    };
    paint();

    const hit = (clientX, clientY, target) => {
      // Et faktisk DOM-treff er mer presist enn geometri - særlig ved tapping,
      // der trykkpunktet kan lande så vidt utenfor ringbåndet.
      if (target && host.contains(target)) {
        const seg = target.closest('[data-aff],[data-type],.radial-cancel');
        if (seg) {
          if (seg.dataset.aff) return { zone: 'aff', value: seg.dataset.aff };
          if (seg.dataset.type) return { zone: 'type', value: seg.dataset.type };
          return { zone: 'cancel' };
        }
      }
      const dx = clientX - st.cx, dy = clientY - st.cy;
      const r = Math.hypot(dx, dy);
      if (r < R_CANCEL) return { zone: 'cancel' };
      let ang = Math.atan2(dy, dx) * 180 / Math.PI + 90;
      ang = ((ang % 360) + 360) % 360;
      if (r >= R_TYPE_IN && r <= R_TYPE_OUT) {
        return { zone: 'type', value: S.POI_ORDER[Math.floor(ang / typeStep) % typeN] };
      }
      if (r >= R_AFF_IN && r <= R_AFF_OUT) {
        const a = ((ang - 45) % 360 + 360) % 360;
        return { zone: 'aff', value: S.AFFIL_ORDER[Math.floor(a / affStep) % affN] };
      }
      if (r > R_AFF_OUT) return { zone: 'outside' };
      return { zone: 'gap' };
    };

    const onMove = ev => {
      const p = ev.touches ? ev.touches[0] : ev;
      if (Math.hypot(p.clientX - st.cx, p.clientY - st.cy) > R_CANCEL) st.moved = true;
      const h = hit(p.clientX, p.clientY, document.elementFromPoint(p.clientX, p.clientY));
      if (h.zone === 'type') st.type = h.value;
      if (h.zone === 'aff') { st.affil = h.value; st.committed = true; }
      paint();
      ev.preventDefault();
    };

    /* Slipper du fingeren uten å ha valgt noe - altså langtrykk, løft, og så
       trykke - skal menyen BLI STÅENDE. Før lukket den seg i det du løftet
       fingeren, som gjorde hele hurtigmenyen ubrukelig med mindre du traff
       riktig i ett sammenhengende drag. */
    const onUp = ev => {
      const p = ev.changedTouches ? ev.changedTouches[0] : ev;
      const h = hit(p.clientX, p.clientY, document.elementFromPoint(p.clientX, p.clientY));

      if (h.zone === 'type' || h.zone === 'aff') {
        cleanup();
        return onPick({ type: st.type, affil: st.affil });
      }
      if (h.zone === 'outside') { cleanup(); return; }
      if (h.zone === 'cancel' && st.moved) { cleanup(); return; }  // dratt tilbake til midten
      toClickMode();
    };

    /* Bytter fra dra-modus til trykkemodus uten å lukke menyen. */
    function toClickMode() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      if (st._outside) return;
      const outside = ev => {
        if (host.contains(ev.target)) return;
        cleanup();
      };
      setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
      st._outside = outside;
      host.classList.add('tapmode');
    }

    function cleanup() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      if (st._outside) window.removeEventListener('pointerdown', st._outside, true);
      closeRadial();
    }

    const dragMode = (defaults.mode || 'drag') === 'drag';
    if (dragMode) {
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', cleanup);
    } else {
      // Pekeren er allerede sluppet: lukk kun ved trykk utenfor menyen.
      const outside = ev => {
        if (host.contains(ev.target)) return;
        window.removeEventListener('pointerdown', outside, true);
        cleanup();
      };
      // Utsett ett tikk, slik at hendelsen som åpnet menyen ikke lukker den igjen.
      setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);
      st._outside = outside;
      host.classList.add('tapmode');
    }

    // Klikkmodus: hvis brukeren allerede har sluppet fingeren, virker tapping også.
    host.addEventListener('pointerdown', ev => {
      const h = hit(ev.clientX, ev.clientY, ev.target);
      if (h.zone === 'type') { st.type = h.value; paint(); }
      else if (h.zone === 'aff') { st.affil = h.value; cleanup(); onPick({ type: st.type, affil: st.affil }); }
      else if (h.zone === 'cancel') cleanup();
      ev.stopPropagation();
    });

    return st;
  }

  function isRadialOpen() { return !!radial; }

  function closeRadial() {
    if (radial && radial.host && radial.host.parentNode) radial.host.parentNode.removeChild(radial.host);
    radial = null;
  }

  /* =========================================================
   *  Sektorskive - 16 kiler, dra for finjustering
   * ========================================================= */

  /**
   * @param el       vertselement
   * @param value    {brg, width, range}
   * @param onChange (value) => void
   */
  function sectorDial(el, value, onChange) {
    const size = 260, c = size / 2, rOut = 112, rIn = 52;
    const v = { brg: 0, width: 30, range: 800, ...value };

    el.innerHTML = `<svg viewBox="0 0 ${size} ${size}" class="dial" width="100%" height="100%"></svg>`;
    const svg = el.querySelector('svg');

    function render() {
      let s = `<circle cx="${c}" cy="${c}" r="${rOut + 8}" class="dial-bg"/>`;
      for (let i = 0; i < 16; i++) {
        const a0 = i * 22.5 - 11.25, a1 = a0 + 22.5;
        s += `<path class="dial-wedge" data-brg="${i * 22.5}" d="${arcPath(c, c, rIn, rOut, a0, a1)}"/>`;
      }
      // Valgt sektor
      const a0 = v.brg - v.width / 2, a1 = v.brg + v.width / 2;
      s += `<path class="dial-sector" d="${arcPath(c, c, 0, rOut + 6, a0, a1)}" pointer-events="none"/>`;
      // Kardinalmerking
      ['N', 'Ø', 'S', 'V'].forEach((t, i) => {
        const [x, y] = polar(c, c, rOut + 20, i * 90);
        s += `<text x="${x}" y="${y}" class="dial-card" pointer-events="none">${t}</text>`;
      });
      const [hx, hy] = polar(c, c, rOut, v.brg);
      s += `<line x1="${c}" y1="${c}" x2="${hx}" y2="${hy}" class="dial-needle" pointer-events="none"/>`;
      s += `<circle cx="${c}" cy="${c}" r="6" class="dial-hub" pointer-events="none"/>`;
      s += `<text x="${c}" y="${c - 14}" class="dial-read" pointer-events="none">${String(Math.round(v.brg)).padStart(3, '0')}°</text>`;
      s += `<text x="${c}" y="${c + 12}" class="dial-read-sub" pointer-events="none">${SSBMSGeo.compass(v.brg)}</text>`;
      svg.innerHTML = s;
    }

    function angleAt(clientX, clientY) {
      const r = svg.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let a = Math.atan2(clientX - cx, cy - clientY) * 180 / Math.PI;
      return ((a % 360) + 360) % 360;
    }

    let dragging = false;
    svg.addEventListener('pointerdown', ev => {
      dragging = true;
      svg.setPointerCapture(ev.pointerId);
      const wedge = ev.target.closest('.dial-wedge');
      v.brg = wedge ? parseFloat(wedge.dataset.brg) : angleAt(ev.clientX, ev.clientY);
      render(); onChange({ ...v });
      ev.preventDefault();
    });
    svg.addEventListener('pointermove', ev => {
      if (!dragging) return;
      v.brg = Math.round(angleAt(ev.clientX, ev.clientY));
      render(); onChange({ ...v });
    });
    const end = () => { dragging = false; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    render();
    return {
      set(nv) { Object.assign(v, nv); render(); },
      get() { return { ...v }; }
    };
  }

  /* =========================================================
   *  Ark (bottom sheet / sidepanel)
   * ========================================================= */

  function sheet({ title, body, actions = [], onClose, wide = false }) {
    const back = document.createElement('div');
    back.className = 'sheet-backdrop';
    const el = document.createElement('div');
    el.className = 'sheet' + (wide ? ' wide' : '');
    el.innerHTML = `
      <div class="sheet-head">
        <h2>${title}</h2>
        <button class="sheet-x" aria-label="Lukk">✕</button>
      </div>
      <div class="sheet-body"></div>
      <div class="sheet-actions"></div>`;
    el.querySelector('.sheet-body').append(
      typeof body === 'string' ? Object.assign(document.createElement('div'), { innerHTML: body }) : body
    );

    const act = el.querySelector('.sheet-actions');
    actions.forEach(a => {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.className = 'btn ' + (a.kind || '');
      b.onclick = () => a.onClick(close);
      act.appendChild(b);
    });
    if (!actions.length) act.remove();

    function close() {
      back.remove(); el.remove();
      if (onClose) onClose();
    }
    el.querySelector('.sheet-x').onclick = close;
    back.onclick = close;

    document.body.append(back, el);
    requestAnimationFrame(() => { back.classList.add('in'); el.classList.add('in'); });
    return { el, close, body: el.querySelector('.sheet-body') };
  }

  function toast(msg, kind = '') {
    document.querySelectorAll('.toast').forEach(o => o.remove());
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 3200);
  }

  return { openRadial, closeRadial, isRadialOpen, sectorDial, sheet, toast, arcPath, polar };
})();
