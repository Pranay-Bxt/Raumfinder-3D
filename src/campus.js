// Campus finder: pick a TU Dresden building from an A–Z grid (or click it in the 3D map), see it highlighted with
// its rooms floor by floor, and search a room number ("2031" in the selected building, or "APB 2031" anywhere).
// The official Campus Navigator floor plan opens behind a button, loaded live from navigator.tu-dresden.de.
import { project } from './proj.js';

const BASE = 'https://navigator.tu-dresden.de/';
const pip = (x, z, r) => { let ins = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const ax = r[i], az = r[i + 1], bx = r[j], bz = r[j + 1]; if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) ins = !ins; } return ins; };
const letterOf = (name) => name.trim().charAt(0).toUpperCase().replace('Ä', 'A').replace('Ö', 'O').replace('Ü', 'U');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Campus {
  /**
   * hooks.show3D(building) -> { height }; hooks.floor(building, floorId) -> Promise; hooks.room(building, level, ref);
   * hooks.noRoom(building, level, ref); hooks.orient(building, step) -> Promise<{k, n}>; hooks.closed()
   */
  constructor(data, hooks, indoor, roomIndex) {
    this.data = data; this.hooks = hooks; this.indoor = (indoor && indoor.levels) || {};
    this.b = null; this.floor = null; this.tab = 'plan'; this.isOpen = false; this.letter = 'all'; this.planOpen = false;
    for (const b of data.buildings) b.pts = b.points.map(([la, lo]) => project(la, lo));
    // rooms searchable per building: imported Navigator floor plans where available, otherwise OpenStreetMap
    this.roomRefs = {};
    for (const [id, levels] of Object.entries(this.indoor)) { const o = (this.roomRefs[id] = {}); for (const [lv, recs] of Object.entries(levels)) o[lv] = recs.filter((r) => r[0] !== 'c' && (r[1] || r[2])).map((r) => [r[1], r[2]]); }
    const imported = (roomIndex && roomIndex.buildings) || {};
    for (const [id, info] of Object.entries(imported)) {
      const o = (this.roomRefs[id] = {}); for (const [lv, refs] of Object.entries(info.levels)) o[lv] = refs.map((r) => [r, '']);
      // floors whose plan could not be lined up with the 3D building: rooms searchable, floor known, not drawn
      for (const [lv, refs] of Object.entries(info.unplaced || {})) (o[lv] ||= []).push(...refs.map((r) => [r, '', 'u']));
      const allFloors = [...new Set([...info.floors, ...Object.keys(info.unplaced || {}).map(Number)])].sort((p, q) => q - p);
      const b = data.buildings.find((x) => x.id === id);
      if (b) {
        b.navRooms = true; b.orientGuess = !!info.uncertain; b.estimated = false;
        b.floors = allFloors.map((l) => ({ id: l < 0 ? String(l) : String(l).padStart(2, '0'), label: 'Etage ' + l }));
        b.defaultFloor = b.floors.some((f) => f.id === '00') ? '00' : b.floors[0].id;
      }
    }
    const withRooms = data.buildings.filter((x) => x.navRooms || this.indoor[x.id]).length;

    this.el = document.createElement('div'); this.el.id = 'campus';
    this.el.innerHTML = `
      <div class="cp-head">
        <div><b>Find your classroom</b><small>TU Dresden · ${withRooms} of ${data.buildings.length} buildings with rooms in 3D</small></div>
        <div class="cp-hbtn"><button class="cp-planbtn" title="Official Campus Navigator floor plan">Floor plan</button><button class="cp-x" title="Close (Esc)">✕</button></div>
      </div>
      <div class="cp-main">
        <div class="cp-left">
          <div class="cp-az"></div>
          <div class="cp-gridwrap"><button class="cp-nav cp-prev" title="Scroll left">‹</button><div class="cp-grid"></div><button class="cp-nav cp-next-page" title="Scroll right">›</button></div>
          <div class="cp-b">
            <div class="cp-bhead"><div><h3></h3><p class="cp-addr"></p></div><button class="chip cp-3d">Show in 3D</button></div>
            <div class="cp-label">Floor <span class="cp-hint">(shown in 3D)</span></div><div class="cp-floors"></div>
            <p class="cp-est"></p><div class="cp-orient"></div>
          </div>
        </div>
        <div class="cp-right">
          <div class="cp-label">Find a room</div>
          <input class="cp-rsearch" placeholder="Room number, e.g. 2031 or APB 2031" autocomplete="off">
          <p class="cp-scope"></p>
          <div class="cp-rres"></div>
        </div>
      </div>
      <div class="cp-plan">
        <div class="cp-tabs"><button data-t="plan" class="on">Floor plan</button><button data-t="rooms">Official room search</button><button data-t="building">Building page</button><a class="cp-ext" target="_blank" rel="noopener">Open in new tab ↗</a><button class="cp-planclose" title="Back to the building list">✕</button></div>
        <iframe title="TU Dresden Campus Navigator" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
        <p class="cp-note">Live from <a href="${BASE}" target="_blank" rel="noopener">navigator.tu-dresden.de</a> (© TU Dresden). If it stays blank, your browser blocks embedded pages: use “Open in new tab”.</p>
      </div>`;
    document.body.appendChild(this.el);
    const q = (s) => this.el.querySelector(s);
    this.q = q;
    q('.cp-x').onclick = () => this.close();
    q('.cp-planbtn').onclick = () => this.showPlan(!this.planOpen);
    q('.cp-planclose').onclick = () => this.showPlan(false);
    q('.cp-3d').onclick = () => this.b && this.hooks.show3D(this.b);
    this.el.querySelectorAll('.cp-tabs button[data-t]').forEach((b) => (b.onclick = () => this.setTab(b.dataset.t)));
    const grid = q('.cp-grid');
    q('.cp-prev').onclick = () => grid.scrollBy({ left: -grid.clientWidth, behavior: 'smooth' });
    q('.cp-next-page').onclick = () => grid.scrollBy({ left: grid.clientWidth, behavior: 'smooth' });
    // mouse wheel scrolls the grid sideways
    grid.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { grid.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    const rs = q('.cp-rsearch');
    rs.addEventListener('input', () => this.renderRooms());
    rs.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && this.rhits && this.rhits[0]) this.selectRoom(this.rhits[0]); });
    // A–Z bar: letters that have buildings are clickable
    const have = new Set(data.buildings.map((b) => letterOf(b.name)));
    const az = q('.cp-az');
    for (const L of ['all', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
      const x = document.createElement('button'); x.textContent = L === 'all' ? 'All' : L; x.dataset.l = L;
      if (L !== 'all' && !have.has(L)) x.disabled = true;
      x.onclick = () => { this.letter = L; this.renderList(); grid.scrollLeft = 0; };
      az.appendChild(x);
    }
    this.renderList();
    this.renderScope();
  }
  byId(id) { return this.data.buildings.find((b) => b.id === id); }
  /** the campus building whose registered point lies inside a footprint (flat [x,z,...] ring) */
  byRing(ring) {
    if (!ring || ring.length < 6) return null;
    return this.data.buildings.find((b) => b.pts.some(([x, z]) => pip(x, z, ring))) || null;
  }
  panelWidth() { return this.isOpen ? this.el.offsetWidth : 0; }

  /** the A–Z building grid (3 rows, scrolls sideways) */
  renderList() {
    this.el.querySelectorAll('.cp-az button').forEach((x) => x.classList.toggle('on', x.dataset.l === this.letter));
    const grid = this.q('.cp-grid'); grid.innerHTML = '';
    const list = this.data.buildings.filter((b) => this.letter === 'all' || letterOf(b.name) === this.letter);
    for (const b of list) {
      const d = document.createElement('button');
      d.className = 'cp-card' + (this.b === b ? ' on' : '');
      const badge = b.navRooms ? (b.orientGuess ? '<i class="q" title="rooms in 3D, direction guessed">rooms ?</i>' : '<i class="ok" title="rooms in 3D">rooms ✓</i>') : this.indoor[b.id] ? '<i class="ok">rooms ✓</i>' : '';
      d.innerHTML = `<b>${esc(b.name)}</b><small>${esc(b.code)}${badge}</small>`;
      d.title = b.name + (b.address ? ' · ' + b.address : '');
      d.onclick = () => this.select(b);
      grid.appendChild(d);
    }
  }
  renderScope() {
    this.q('.cp-scope').textContent = this.b ? `Searching in ${this.b.name} (${this.b.code}). Type a code first, e.g. "WIL A222", to search another building.` : 'Type a room number with its building code, e.g. "APB 2031" or "WIL A222".';
  }
  open(id) {
    this.isOpen = true; this.el.style.display = 'flex';
    const b = id ? this.byId(id) : this.b;
    if (b) { this.letter = letterOf(b.name); this.select(b); this.scrollToCard(); } else this.renderList();
    this.q('.cp-rsearch').focus({ preventScroll: true });
  }
  close() { if (!this.isOpen) return; this.isOpen = false; this.el.style.display = 'none'; this.showPlan(false); this.hooks.closed && this.hooks.closed(); }
  toggle() { this.isOpen ? this.close() : this.open(); }
  scrollToCard() { const c = this.q('.cp-card.on'), g = this.q('.cp-grid'); if (c) g.scrollLeft = c.offsetLeft - g.offsetLeft - 4; }

  select(b, floorId) {
    this.b = b;
    this.el.classList.add('has-b');
    this.q('.cp-b h3').textContent = `${b.name} (${b.code})`;
    this.q('.cp-addr').textContent = b.address || '';
    const info = this.hooks.show3D(b) || {};
    let est = '';
    if (!b.floors && info.height) { // no floor list: estimate from the building height
      const n = Math.max(1, Math.min(12, Math.round(info.height / 3.8)));
      b.floors = []; for (let l = n - 1; l >= 0; l--) b.floors.push({ id: String(l).padStart(2, '0'), label: 'Etage ' + l });
      b.defaultFloor = '00'; b.estimated = true;
    }
    if (b.estimated) est = 'No rooms for this building yet; floors estimated from its height.';
    else if (b.navRooms && b.orientGuess) est = 'Rooms: TU Dresden Campus Navigator (© TU Dresden). Direction guessed from the building outline.';
    else if (b.navRooms) est = 'Rooms: TU Dresden Campus Navigator (© TU Dresden), aligned to the map.';
    else if (this.indoor[b.id]) est = 'Rooms: OpenStreetMap (community-mapped, may be incomplete).';
    this.q('.cp-est').textContent = est;
    const ob = this.q('.cp-orient'); ob.innerHTML = '';
    if (b.orientGuess && this.hooks.orient) {
      ob.innerHTML = '<button class="chip cp-next">Try next orientation</button> <span class="cp-or"></span><p>Outline is symmetric: if the rooms look turned or mirrored compared with the floor plan, try the next one.</p>';
      const say = (r) => { if (r) ob.querySelector('.cp-or').textContent = (r.k + 1) + ' of ' + r.n + (r.k ? ' · remembered' : ' · best match'); };
      Promise.resolve(this.hooks.orient(b, 0)).then(say);
      ob.querySelector('.cp-next').onclick = () => Promise.resolve(this.hooks.orient(b, 1)).then(say);
    }
    this.floor = floorId || b.defaultFloor || (b.floors && b.floors[0].id);
    const fl = this.q('.cp-floors'); fl.innerHTML = '';
    for (const f of b.floors || []) {
      const x = document.createElement('button'); x.className = 'chip'; x.textContent = f.label; x.dataset.f = f.id;
      x.onclick = () => { this.floor = f.id; this.hooks.floor && this.hooks.floor(b, f.id); this.markFloor(); if (this.planOpen) this.setTab('plan'); };
      fl.appendChild(x);
    }
    this.markFloor();
    this.renderList();
    this.renderScope();
    if (this.q('.cp-rsearch').value.trim()) this.renderRooms();
    const done = this.hooks.floor && this.hooks.floor(b, this.floor);
    if (this.planOpen) this.setTab('plan');
    return done;
  }
  markFloor() { this.q('.cp-floors').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.f === this.floor)); }

  /**
   * room search, e.g. "WIL A222", "wil/a222", "APB 2031" or just "2031" (then inside the selected building first).
   * Willers-Bau rooms that are not mapped still get their floor from the number (C103 -> Etage 0, A222 -> Etage 1).
   */
  searchRooms(text, scopeId = null) {
    const norm = (v) => v.toLowerCase().replace(/[\s/_.\-]/g, '');
    const parts = text.trim().toLowerCase().split(/[\s/]+/).filter(Boolean);
    let only = null, rest = norm(parts.join('')), explicit = false;
    if (parts.length >= 2 && this.byId(parts[0])) { only = parts[0]; rest = norm(parts.slice(1).join('')); explicit = true; }
    else if (parts.length === 1 && parts[0].length >= 5 && this.byId(parts[0].slice(0, 3))) { only = parts[0].slice(0, 3); rest = norm(parts[0].slice(3)); explicit = true; }
    if (!only && scopeId) only = scopeId;
    if (rest.length < 2) return [];
    const out = [];
    for (const [id, levels] of Object.entries(this.roomRefs)) {
      if (only && id !== only) continue;
      for (const [lv, refs] of Object.entries(levels)) for (const [rawRef, rawName, flag] of refs) {
        const ref = norm(rawRef), nm = norm(rawName || '');
        if (ref === rest || (rest.length >= 3 && ref.includes(rest)) || (nm && nm.includes(rest))) out.push({ id, level: +lv, ref: rawRef || rawName, name: rawRef ? rawName : '', score: ref === rest ? 0 : ref.startsWith(rest) ? 1 : 2, unplaced: flag === 'u' });
      }
    }
    const seen = new Set();
    const res = out.filter((r) => { const k = r.id + r.level + r.ref; return seen.has(k) ? false : (seen.add(k), true); }).sort((p, q) => p.score - q.score || p.ref.localeCompare(q.ref)).slice(0, 14);
    const m = rest.match(/^([abc])(\d)(\d\d)([a-z]?)$/);
    if (!res.some((r) => r.score === 0) && only === 'wil' && m && +m[2] >= 1 && +m[2] <= 4) {
      res.unshift({ id: 'wil', level: +m[2] - 1, ref: (m[1] + m[2] + m[3] + m[4]).toUpperCase(), name: '', score: 0, estimated: true });
    }
    // nothing in the selected building: search everywhere
    if (!res.length && only && !explicit) return this.searchRooms(text, null);
    return res;
  }
  renderRooms() {
    const box = this.q('.cp-rres'); box.innerHTML = '';
    const text = this.q('.cp-rsearch').value;
    this.rhits = this.searchRooms(text, this.b ? this.b.id : null);
    for (const r of this.rhits) {
      const b = this.byId(r.id), d = document.createElement('button');
      d.className = 'cp-room';
      d.innerHTML = '<b>' + esc(b.code) + ' ' + esc(r.ref || r.name) + '</b><small>' + esc(b.name) + ' · Etage ' + r.level + (r.estimated ? ' · floor estimated from the number' : r.unplaced ? ' · not drawn in 3D yet' : '') + '</small>';
      d.onclick = () => this.selectRoom(r); box.appendChild(d);
    }
    if (!this.rhits.length && text.trim().length >= 2) box.innerHTML = '<p class="cp-msg">No room found. Try the code first (e.g. "APB 2031"), or the official room search behind “Floor plan”.</p>';
  }
  selectRoom(r) {
    const b = this.byId(r.id), fid = r.level < 0 ? String(r.level) : String(r.level).padStart(2, '0');
    this.isOpen = true; this.el.style.display = 'flex';
    this.letter = letterOf(b.name);
    Promise.resolve(this.select(b, fid)).then(() => {
      this.scrollToCard();
      if (r.estimated || r.unplaced) this.hooks.noRoom && this.hooks.noRoom(b, r.level, r.ref, r.unplaced ? 'unplaced' : 'estimated'); else this.hooks.room && this.hooks.room(b, r.level, r.ref || r.name);
    });
  }
  /** open the panel on a building and floor, with the official floor plan showing */
  openFloor(id, floorId) { this.isOpen = true; this.el.style.display = 'flex'; this.select(this.byId(id), floorId); this.showPlan(true); }

  showPlan(on) {
    this.planOpen = on;
    this.el.classList.toggle('plan', on);
    this.q('.cp-planbtn').classList.toggle('on', on);
    if (on) this.setTab(this.b ? 'plan' : 'rooms'); else this.q('iframe').src = 'about:blank';
  }
  setTab(t) {
    this.tab = t;
    this.el.querySelectorAll('.cp-tabs button[data-t]').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
    const b = this.b;
    let url;
    if (t === 'rooms' || !b) url = BASE;
    else if (t === 'building') url = `${BASE}karten/dresden/geb/${encodeURIComponent(b.id)}`;
    else url = `${BASE}etplan/${encodeURIComponent(b.id)}/${this.floor || '00'}`;
    this.q('.cp-ext').href = url;
    if (this.planOpen) this.q('iframe').src = url;
  }
}
