// DVB tram line 11: DVB-yellow articulated tram model, the real route, ambient trams, stop signs
// and a tram-driver simulator (cab view, speed limits, stops, doors, passengers, scoring).
import * as THREE from 'three';
import * as AUDIO from './audio.js';

export const DVB_YELLOW = '#FFD400';
const SEC = [15.2, 14.2, 15.2], GAP = 1.1;
export const TRAM_LEN = SEC[0] + SEC[1] + SEC[2] + 2 * GAP;
const RAIL_Y = 0.2;
const DOORS_FROM_FRONT = [4.2, 9.6, 16.4, 25.2, 32.4, 38.6]; // door centres, metres behind the nose

const M = {
  body: new THREE.MeshStandardMaterial({ color: DVB_YELLOW, roughness: 0.3, metalness: 0.12 }),
  skirt: new THREE.MeshStandardMaterial({ color: '#3b3f45', roughness: 0.7, metalness: 0.2 }),
  roof: new THREE.MeshStandardMaterial({ color: '#c4c8cc', roughness: 0.6, metalness: 0.3 }),
  equip: new THREE.MeshStandardMaterial({ color: '#9aa0a7', roughness: 0.6, metalness: 0.4 }),
  glass: new THREE.MeshStandardMaterial({ color: '#10161d', roughness: 0.12, metalness: 0.7, emissive: '#ffd08a', emissiveIntensity: 0 }),
  door: new THREE.MeshStandardMaterial({ color: '#d9dcdf', roughness: 0.4, metalness: 0.2 }),
  dark: new THREE.MeshStandardMaterial({ color: '#17191c', roughness: 0.9 }),
  bellows: new THREE.MeshStandardMaterial({ color: '#2b2e33', roughness: 0.95 }),
  head: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4d2', emissiveIntensity: 0.35 }),
  tail: new THREE.MeshStandardMaterial({ color: '#8a1010', emissive: '#ff2a1a', emissiveIntensity: 0.6 }),
  steel: new THREE.MeshStandardMaterial({ color: '#8d949b', roughness: 0.35, metalness: 0.85 }),
};
/** call each frame with the night factor (0 day .. 1 night) so windows and lamps light up */
export function setTramNight(f) { M.glass.emissiveIntensity = 0.95 * f; M.head.emissiveIntensity = 0.35 + 3 * f; M.tail.emissiveIntensity = 0.6 + 1.2 * f; }

function mesh(g, geo, mat, x = 0, y = 0, z = 0) { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; }
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

function signTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.userData = { c, draw(text) {
    const x = c.getContext('2d');
    x.fillStyle = '#0b0b0b'; x.fillRect(0, 0, 512, 64);
    x.fillStyle = '#ff9a1a'; x.font = '62px VT323, ui-monospace, monospace'; x.textBaseline = 'middle';
    x.fillText('11', 14, 34); x.font = '50px VT323, ui-monospace, monospace'; x.fillText(text, 84, 35);
    t.needsUpdate = true;
  } };
  t.userData.draw('Bühlau');
  return t;
}

function nose(g, L, sign, tex) {
  // plan shape: rounded cab front; sign = -1 for the front (-z), +1 for the rear
  const s = new THREE.Shape();
  s.moveTo(-1.2, 0); s.lineTo(1.2, 0); s.lineTo(1.2, 0.9);
  s.bezierCurveTo(1.2, 1.8, 0.75, 2.25, 0, 2.25); s.bezierCurveTo(-0.75, 2.25, -1.2, 1.8, -1.2, 0.9); s.closePath();
  const n = new THREE.Group();
  const body = mesh(n, new THREE.ExtrudeGeometry(s, { depth: 2.35, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2), M.body, 0, 0.8, 0);
  mesh(n, box(2.1, 0.22, 2.0), M.roof, 0, 3.27, -1.05);
  const ws = mesh(n, box(2.05, 1.2, 0.07), M.glass, 0, 2.45, -1.82); ws.rotation.x = 0.5;
  g.userData.ws = (g.userData.ws || []).concat(ws);
  mesh(n, box(2.3, 0.55, 0.9), M.skirt, 0, 0.55, -0.95).scale.set(0.98, 1, 1.02);
  for (const x of [-0.8, 0.8]) mesh(n, box(0.28, 0.14, 0.06), sign < 0 ? M.head : M.tail, x, 1.05, -2.27);
  if (sign < 0) {
    // destination sign on top of the windscreen, tilted like the glass and facing forward
    const tilt = new THREE.Group(); tilt.position.set(0, 3.0, -1.84); tilt.rotation.x = 0.5;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.21), new THREE.MeshBasicMaterial({ map: tex }));
    plane.rotation.y = Math.PI; plane.position.z = -0.06; tilt.add(plane); n.add(tilt);
  }
  // n is built facing -z already (shape y -> -z); place at the section end
  n.position.z = sign * (L / 2);
  if (sign > 0) n.rotation.y = Math.PI;
  g.add(n);
}

function section(L, { front, rear, pantograph, tex }) {
  const g = new THREE.Group();
  mesh(g, box(2.4, 2.35, L), M.body, 0, 1.975, 0);
  mesh(g, box(2.36, 0.5, L - 0.3), M.skirt, 0, 0.55, 0);
  mesh(g, box(2.1, 0.3, L - 0.6), M.roof, 0, 3.3, 0);
  for (let i = -1; i <= 1; i++) mesh(g, box(1.3, 0.28, 2.6), M.equip, 0, 3.58, i * (L / 3.2));
  // window band
  for (const sx of [-1, 1]) mesh(g, box(0.05, 0.95, L - 1.4), M.glass, sx * 1.2, 2.45, 0);
  // bogies
  for (const z of [-(L / 2 - 3.1), L / 2 - 3.1]) { mesh(g, box(1.7, 0.4, 3.0), M.dark, 0, 0.32, z); for (const sx of [-1, 1]) mesh(g, new THREE.CylinderGeometry(0.34, 0.34, 0.12, 14).rotateZ(Math.PI / 2), M.steel, sx * 0.74, 0.34, z - 0.9); }
  g.userData.leaves = [];
  if (front) nose(g, L, -1, tex);
  if (rear) nose(g, L, 1, tex);
  if (pantograph) {
    const p = new THREE.Group(); p.position.set(0, 3.7, 0.5); g.add(p);
    const strut = (a, b) => { const d = new THREE.Vector3().subVectors(b, a), o = mesh(p, new THREE.CylinderGeometry(0.035, 0.035, d.length(), 5), M.dark); o.position.copy(a).addScaledVector(d, 0.5); o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); };
    strut(new THREE.Vector3(0, 0, 0.6), new THREE.Vector3(0, 1.0, -0.4)); strut(new THREE.Vector3(0, 1.0, -0.4), new THREE.Vector3(0, 0.2, -1.4));
    mesh(p, box(1.7, 0.05, 0.14), M.dark, 0, 1.0, -0.4);
  }
  return g;
}

/** build a three-section DVB tram; faces -z. Returns { group, sec[], bell[], setPose, setDestination, setDoors } */
export function makeTram() {
  const tex = signTexture();
  const group = new THREE.Group();
  const sec = [section(SEC[0], { front: true, tex }), section(SEC[1], { pantograph: true }), section(SEC[2], { rear: true })];
  sec.forEach((s, i) => { s.position.y = RAIL_Y; group.add(s); });
  const bellows = [0, 1].map(() => { const b = mesh(group, box(2.25, 2.45, GAP + 0.3), M.bellows, 0, 1.95 + RAIL_Y, 0); return b; });
  // doors on both sides: dark opening + two sliding leaves
  const leaves = [];
  sec.forEach((s, si) => {
    const startZ = si === 0 ? -SEC[0] / 2 : si === 1 ? -SEC[1] / 2 : -SEC[2] / 2;
    const offset = [0, SEC[0] + GAP, SEC[0] + SEC[1] + 2 * GAP][si];
    for (const df of DOORS_FROM_FRONT) {
      const zFromFront = df;
      if (zFromFront < offset + 1.0 || zFromFront > offset + SEC[si] - 1.0) continue;
      const lz = zFromFront - offset + startZ;
      for (const sx of [-1, 1]) {
        mesh(s, box(0.06, 1.85, 1.3), M.dark, sx * 1.2, 1.55, lz);
        for (const k of [-1, 1]) { const l = mesh(s, box(0.07, 1.8, 0.64), M.door, sx * 1.225, 1.55, lz + k * 0.33); l.userData = { side: sx, base: lz + k * 0.33, dir: k }; leaves.push(l); }
      }
    }
  });
  const T = { group, sec, bellows, leaves, tex, yaw: 0 };
  T.setDestination = (txt) => tex.userData.draw(txt);
  /** hide the front windscreen glass when looking out of the cab */
  T.setCab = (on) => (sec[0].userData.ws || []).forEach((w) => (w.visible = !on));
  T.setDoors = (open, side = 1) => { for (const l of leaves) if (l.userData.side === side) l.position.z = l.userData.base + l.userData.dir * open * 0.62; };
  const a = {}, b = {};
  /** place all sections along the route with the nose at arc length s */
  T.setPose = (route, s) => {
    let sf = s;
    const ends = [];
    for (let i = 0; i < 3; i++) { ends.push([sf, sf - SEC[i]]); sf -= SEC[i] + GAP; }
    sec.forEach((g, i) => {
      const f = route.at(ends[i][0], a), r = route.at(ends[i][1], b);
      g.position.set((f.x + r.x) / 2, RAIL_Y, (f.z + r.z) / 2);
      g.rotation.y = Math.atan2(-(f.x - r.x), -(f.z - r.z));
    });
    for (let i = 0; i < 2; i++) {
      const f = route.at(ends[i][1], a), r = route.at(ends[i + 1][0], b);
      bellows[i].position.set((f.x + r.x) / 2, RAIL_Y + 1.95, (f.z + r.z) / 2);
      bellows[i].rotation.y = Math.atan2(-(f.x - r.x), -(f.z - r.z));
    }
  };
  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return T;
}

// ---------------------------------------------------------------------------------------------
export class TramRoute {
  constructor(flat, stops) {
    const n = flat.length / 2;
    this.n = n; this.xs = new Float64Array(n); this.zs = new Float64Array(n); this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.xs[i] = flat[i * 2]; this.zs[i] = flat[i * 2 + 1]; if (i) this.cum[i] = this.cum[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.zs[i] - this.zs[i - 1]); }
    this.L = this.cum[n - 1];
    this.stops = stops;
    // legal speed from curve radius, in 5 km/h steps (max 50 km/h, min 15)
    const step = 5, m = Math.floor(this.L / step) + 2;
    this.lim = new Float32Array(m);
    const p = {}, q = {};
    for (let k = 0; k < m; k++) {
      const s = k * step, h1 = this.at(s - 14, p), a1 = Math.atan2(h1.tz, h1.tx), h2 = this.at(s + 14, q), a2 = Math.atan2(h2.tz, h2.tx);
      let d = Math.abs(a2 - a1); if (d > Math.PI) d = Math.PI * 2 - d;
      const R = d > 1e-3 ? 28 / d : 1e9;
      const kmh = Math.floor(Math.min(50, Math.sqrt(1.25 * R) * 3.6) / 5) * 5;
      this.lim[k] = Math.max(15, kmh) / 3.6;
    }
  }
  at(s, o = {}) {
    const { n, cum, xs, zs } = this;
    let i;
    if (s <= 0) i = 0; else if (s >= this.L) i = n - 2;
    else { let lo = 0, hi = n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; } i = lo; }
    const dx = xs[i + 1] - xs[i], dz = zs[i + 1] - zs[i], l = cum[i + 1] - cum[i] || 1, t = (s - cum[i]) / l;
    o.x = xs[i] + dx * t; o.z = zs[i] + dz * t; o.tx = dx / l; o.tz = dz / l;
    return o;
  }
  limitAt(s) { return this.lim[Math.max(0, Math.min(this.lim.length - 1, Math.floor(s / 5)))]; }
  /** tram.json -> route (optionally driven backwards) with the trip from stop `from` to stop `to` */
  static build(tram, opt = {}) {
    let flat = tram.pts, stops = tram.stops.map((s) => ({ ...s }));
    if (opt.reverse) {
      const n = flat.length / 2, r = new Array(flat.length);
      for (let i = 0; i < n; i++) { r[i * 2] = flat[(n - 1 - i) * 2]; r[i * 2 + 1] = flat[(n - 1 - i) * 2 + 1]; }
      flat = r;
      const L = tram.length;
      stops = stops.map((s) => ({ ...s, s: L - s.s })).reverse();
    }
    const route = new TramRoute(flat, stops);
    for (const s of route.stops) s.haltS = s.s + 12; // the nose stops 12 m past the stop sign
    if (opt.from) {
      const i0 = route.stops.findIndex((s) => s.name === opt.from), i1 = route.stops.findIndex((s) => s.name === opt.to);
      route.trip = route.stops.slice(i0, i1 + 1);
    }
    return route;
  }
}

export const ROUTES = [
  { id: 'zw-nb', label: 'Zellescher Weg → Bahnhof Neustadt', from: 'Zellescher Weg', to: 'Bahnhof Neustadt', reverse: false, dest: 'Bahnhof Neustadt', note: '6.2 km · 12 stops · past Hauptbahnhof and Postplatz' },
  { id: 'nb-zw', label: 'Bahnhof Neustadt → Zellescher Weg', from: 'Bahnhof Neustadt', to: 'Zellescher Weg', reverse: true, dest: 'Zschertnitz', note: 'The return run · 12 stops' },
  { id: 'zw-hbf', label: 'Zellescher Weg → Hauptbahnhof Nord', from: 'Zellescher Weg', to: 'Hauptbahnhof Nord', reverse: false, dest: 'Bühlau', note: 'Short practice run · 5 stops · 2.4 km' },
];

// ---------------------------------------------------------------------------------------------
function stopSignTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = DVB_YELLOW; x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill();
  x.lineWidth = 5; x.strokeStyle = '#1a1a1a'; x.beginPath(); x.arc(64, 64, 59, 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#0b6b35'; x.font = 'bold 84px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('H', 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class TramNetwork {
  constructor(scene, route) {
    this.route = route; this.group = new THREE.Group(); scene.add(this.group);
    // yellow line along the real track
    const n = route.n, pos = [], idx = [];
    const p = {};
    for (let i = 0; i < n; i++) {
      const a = route.at(route.cum[i], p), rx = -a.tz, rz = a.tx;
      pos.push(a.x + rx * 0.45, 0.4, a.z + rz * 0.45, a.x - rx * 0.45, 0.4, a.z - rz * 0.45);
      if (i < n - 1) { const k = i * 2; idx.push(k, k + 3, k + 1, k, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    this.line = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: DVB_YELLOW, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10 }));
    this.line.renderOrder = 9; this.group.add(this.line);
    // DVB stop signs
    const tex = stopSignTexture(), pole = new THREE.CylinderGeometry(0.04, 0.04, 3.2, 6).translate(0, 1.6, 0), disk = new THREE.CircleGeometry(0.4, 28).translate(0, 3.1, 0);
    const poleM = new THREE.MeshStandardMaterial({ color: '#4a4d52', roughness: 0.6, metalness: 0.5 }), diskM = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, side: THREE.DoubleSide, emissive: '#ffd400', emissiveMap: tex, emissiveIntensity: 0.0 });
    this.signMat = diskM;
    for (const st of route.stops) {
      const a = route.at(st.s, {}), rx = -a.tz, rz = a.tx, lat = (st.x - a.x) * rx + (st.z - a.z) * rz;
      const x = Math.abs(lat) > 1.8 ? st.x : a.x + rx * 3.1, z = Math.abs(lat) > 1.8 ? st.z : a.z + rz * 3.1;
      const s = new THREE.Group(); s.position.set(x, 0.1, z);
      s.add(new THREE.Mesh(pole, poleM), new THREE.Mesh(disk, diskM));
      s.rotation.y = Math.atan2(a.tx, a.tz);
      s.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.group.add(s);
    }
    // ambient trams shuttling along the whole line
    this.ambient = [];
    const count = 5;
    for (let i = 0; i < count; i++) {
      const t = makeTram(); t.setDestination(i % 2 ? 'Bühlau' : 'Zschertnitz'); this.group.add(t.group);
      const idx = Math.min(route.stops.length - 2, Math.floor(((route.stops.length - 1) / count) * i) + 1);
      this.ambient.push({ t, s: route.stops[idx].haltS, v: 0, dwell: 3 + i * 4, next: idx + 1 });
    }
    this.ambientVisible = true;
  }
  setVisible(on) { this.group.visible = on; }
  setLineVisible(on) { this.line.visible = on; }
  setAmbientVisible(on) { this.ambientVisible = on; for (const a of this.ambient) a.t.group.visible = on; }
  update(dt, night) {
    this.signMat.emissiveIntensity = 0.1 + 0.5 * night;
    if (!this.ambientVisible) return;
    const r = this.route;
    for (const a of this.ambient) {
      const st = r.stops[a.next];
      if (!st) { a.s = 30; a.next = 0; a.v = 0; continue; }
      const dist = st.haltS - a.s;
      if (a.dwell > 0) { a.dwell -= dt; a.v = 0; }
      else {
        const vmax = Math.min(r.limitAt(a.s + 20), r.limitAt(a.s));
        const vStop = Math.sqrt(Math.max(0, 2 * 0.9 * Math.max(0, dist - 0.3)));
        const want = Math.min(vmax, vStop);
        a.v += Math.max(-1.2 * dt, Math.min(1.0 * dt, want - a.v));
        a.s += a.v * dt;
        if (dist < 0.6 && a.v < 0.4) { a.v = 0; a.dwell = 10 + Math.random() * 12; a.next++; }
      }
      a.t.setDoors(a.dwell > 1.2 && a.v === 0 ? 1 : 0, 1);
      a.t.setPose(r, a.s);
    }
  }
}

// ---------------------------------------------------------------------------------------------
const HUD = `
<div class="tm-frame"><i class="pl"></i><i class="pr"></i><i class="bot"></i></div>
<div class="tm-top"><b class="tm-line">11</b><span class="tm-dest"></span><span class="tm-clock">0:00</span></div>
<div class="tm-toast"></div>
<div class="tm-dash">
  <div class="tm-left">
    <div class="tm-speed"><b>0</b><small>km/h</small></div>
    <div class="tm-limit"><span>50</span></div>
  </div>
  <div class="tm-mid">
    <div class="tm-next"><small>Next stop</small><b></b><span></span></div>
    <div class="tm-bar"><i></i><u></u></div>
    <div class="tm-status"></div>
  </div>
  <div class="tm-right">
    <div class="tm-meter"><small>Traction</small><div class="tm-trac"><i></i></div></div>
    <div class="tm-meter"><small>Brake</small><div class="tm-brk"><i></i></div></div>
    <div class="tm-info"><span>Doors <b class="tm-doors">closed</b></span><span>On board <b class="tm-aboard">0</b></span><span class="tm-late">on time</span><span>Score <b class="tm-score">0</b></span></div>
  </div>
</div>
<div class="tm-help"><kbd>W</kbd> traction · <kbd>S</kbd> brake · <kbd>X</kbd> emergency brake · <kbd>Space</kbd> doors · <kbd>H</kbd> bell · <kbd>C</kbd> camera · drag to look · <kbd>Esc</kbd> exit</div>`;

export class TramGame {
  constructor(scene, camera, world, people) {
    this.scene = scene; this.camera = camera; this.world = world; this.people = people;
    this.tram = makeTram(); this.tram.group.visible = false; scene.add(this.tram.group);
    this.spot = new THREE.SpotLight('#fff1cf', 0, 140, 0.42, 0.55, 1.6); this.spot.visible = false; scene.add(this.spot, this.spot.target);
    this.hud = document.createElement('div'); this.hud.id = 'tram'; this.hud.innerHTML = HUD; document.body.appendChild(this.hud);
    const q = (s) => this.hud.querySelector(s);
    this.el = { speed: q('.tm-speed b'), limit: q('.tm-limit span'), limitBox: q('.tm-limit'), dest: q('.tm-dest'), next: q('.tm-next b'), dist: q('.tm-next span'), bar: q('.tm-bar i'), halt: q('.tm-bar u'), status: q('.tm-status'),
      doors: q('.tm-doors'), toast: q('.tm-toast'), clock: q('.tm-clock'), score: q('.tm-score'), aboard: q('.tm-aboard'), trac: q('.tm-trac i'), brk: q('.tm-brk i'), late: q('.tm-late') };
    this.menu = document.createElement('div'); this.menu.id = 'tmmenu';
    this.menu.innerHTML = `<div class="tm-card"><h2><b>11</b> DVB tram simulator</h2><p>Drive a yellow DVB tram on the real line 11. Pick a run:</p><div class="tm-routes"></div><p class="tm-sub"><kbd>W</kbd> accelerate · <kbd>S</kbd> brake · <kbd>Space</kbd> open and close doors · stop at the halt marker at every stop · watch the speed limit.</p><button class="tm-cancel">Back to the map</button></div>`;
    document.body.appendChild(this.menu);
    const list = this.menu.querySelector('.tm-routes');
    ROUTES.forEach((r) => { const b = document.createElement('button'); b.className = 'tm-route'; b.innerHTML = `<b>${r.label}</b><small>${r.note}</small>`; b.onclick = () => this.onPick && this.onPick(r); list.appendChild(b); });
    this.menu.querySelector('.tm-cancel').onclick = () => this.onCancel && this.onCancel();
    this.end = document.createElement('div'); this.end.id = 'tmend'; document.body.appendChild(this.end);
    this.active = false; this.cabCam = true; this.lookYaw = 0; this.lookPitch = 0; this.toastT = 0;
  }
  showMenu(on) { this.menu.style.display = on ? 'flex' : 'none'; }
  exit() { this.active = false; this.tram.group.visible = false; this.hud.style.display = 'none'; this.menu.style.display = 'none'; this.end.style.display = 'none'; this.spot.visible = false; AUDIO.engine(false); }
  toast(msg, cls = '') { const t = this.el.toast; t.textContent = msg; t.className = 'tm-toast show ' + cls; this.toastT = 2.6; }

  start(def, route) {
    this.def = def; this.route = route; this.trip = route.trip;
    this.s = this.trip[0].haltS; this.v = 0; this.pow = 0; this.brk = 0; this.door = 0; this.doorTarget = 0;
    this.phase = 'run'; this.stopIdx = 1; this.finished = false; this.clock = 0; this.aboard = 14;
    this.hardBrakeT = 0; this.overT = 0; this.overCool = 0;
    this.stats = { acc: [], punct: [], speeding: 0, hard: 0, missed: 0, left: 0, carried: 0, served: 1, over: 0 };
    this.t0s = this.trip[0].s;
    this.exp = this.trip.map((st, i) => (st.s - this.t0s) / 10 + i * 15);
    this.tram.setDestination(def.dest);
    this.tram.group.visible = true; this.tram.setDoors(0); this.tram.setPose(route, this.s);
    this.active = true; this.cabCam = true; this.lookYaw = this.lookPitch = 0;
    this.hud.style.display = 'block'; this.menu.style.display = 'none'; this.end.style.display = 'none';
    this.el.dest.textContent = def.dest; this.score = 0;
    this.people.arrangeStops(route, this.trip);
    AUDIO.initAudio();
    this.toast(`Line 11 to ${def.dest} — ready to depart`, 'ok');
    this.update(0, new Set());
  }
  drag(dx, dy) { this.lookYaw = Math.max(-1.6, Math.min(1.6, this.lookYaw - dx * 0.004)); this.lookPitch = Math.max(-0.7, Math.min(0.9, this.lookPitch - dy * 0.004)); if (!this.cabCam) this.lookPitch = Math.max(-0.1, this.lookPitch); }
  toggleCam() { this.cabCam = !this.cabCam; this.lookYaw = this.lookPitch = 0; }
  bell() { AUDIO.bell(); this.toast('Ding ding!', ''); }

  toggleDoors() {
    if (this.finished) return;
    if (this.phase === 'run') {
      if (this.v > 0.25) { this.toast('Doors are locked while the tram is moving', 'bad'); AUDIO.warn(); return; }
      const st = this.trip[this.stopIdx];
      const e = this.s - st.haltS;
      if (e < -35 || e > 45) { this.toast(this.stopIdx === 0 || e > 45 ? 'Not at the next stop' : 'Not at a stop yet', 'bad'); AUDIO.warn(); return; }
      this.phase = 'dwell'; this.doorTarget = 1; AUDIO.doorChime(true);
      const err = Math.abs(e), pts = err <= 2.5 ? 100 : err <= 5 ? 90 : err <= 10 ? 70 : err <= 20 ? 45 : 20;
      this.stats.acc.push(pts);
      const late = this.clock - this.exp[this.stopIdx], pp = late <= 20 ? 100 : Math.max(0, 100 - (late - 20) * 0.9);
      this.stats.punct.push(pp);
      const last = this.stopIdx === this.trip.length - 1;
      this.dw = { t: 0, a: 0, b: 0, alightT: last ? this.aboard : Math.min(this.aboard, Math.floor(Math.random() * 6)), boardT: last ? 0 : Math.min(this.people.waitersLeft(this.stopIdx), 99), timer: 0 };
      this.toast(`${st.name} — stop accuracy ${pts}`, pts >= 70 ? 'ok' : 'bad');
      this.stats.served++;
    } else if (this.phase === 'dwell' && this.door > 0.97) {
      const left = this.dw.boardT - this.dw.b;
      if (left > 0) { this.stats.left += left; this.toast(`${left} passenger${left > 1 ? 's' : ''} left behind`, 'bad'); }
      this.doorTarget = 0; AUDIO.doorChime(false);
    }
  }

  finish() {
    this.finished = true;
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const acc = avg(this.stats.acc), punct = avg(this.stats.punct);
    const comfort = Math.max(0, 100 - this.stats.hard * 12), safety = Math.max(0, 100 - this.stats.over * 8 - this.stats.missed * 25 - this.stats.left * 4);
    const total = Math.round(acc * 0.35 + punct * 0.2 + comfort * 0.2 + safety * 0.25);
    const stars = total >= 90 ? 5 : total >= 75 ? 4 : total >= 60 ? 3 : total >= 40 ? 2 : 1;
    const mm = Math.floor(this.clock / 60), ss = String(Math.floor(this.clock % 60)).padStart(2, '0');
    this.end.innerHTML = `<div class="tm-card"><h2>${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</h2><p><b>${this.def.label}</b> · ${mm}:${ss} min · ${this.stats.carried} passengers</p>
      <div class="tm-grid"><span>Stop accuracy</span><b>${Math.round(acc)}</b><span>Punctuality</span><b>${Math.round(punct)}</b><span>Ride comfort</span><b>${Math.round(comfort)}</b><span>Safety</span><b>${Math.round(safety)}</b></div>
      <p class="tm-sub">${this.stats.over} speeding warnings · ${this.stats.hard} hard brakings · ${this.stats.missed} missed stops · ${this.stats.left} passengers left behind</p>
      <div class="tm-row"><button class="tm-again">Drive another run</button><button class="tm-back">Back to the map</button></div></div>`;
    this.end.style.display = 'flex';
    this.end.querySelector('.tm-again').onclick = () => { this.end.style.display = 'none'; this.showMenu(true); this.active = false; };
    this.end.querySelector('.tm-back').onclick = () => this.onCancel && this.onCancel();
    this.score = total;
  }

  update(dt, keys, night = 0) {
    if (!this.active) return;
    const r = this.route, el = this.el;
    if (!this.finished) this.clock += dt;
    // ---- controls
    const wantPow = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0, wantBrk = keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0, emerg = keys.has('KeyX');
    this.pow += (wantPow - this.pow) * Math.min(1, dt * (wantPow ? 1.8 : 7));
    const bTarget = emerg ? 1 : wantBrk;
    this.brk += (bTarget - this.brk) * Math.min(1, dt * (bTarget ? 4 : 7));
    const locked = this.door > 0.02 || this.phase === 'dwell' || this.finished;
    let a = 0;
    if (!locked) a += this.pow * 1.35 * Math.max(0.14, 1 - this.v / 18);
    a -= this.brk * (emerg ? 2.9 : 1.35);
    const drag = this.v > 0.02 ? 0.03 + 0.0007 * this.v * this.v : 0;
    const prev = this.v;
    this.v = Math.max(0, this.v + (a - drag) * dt);
    if (this.v === 0 && prev === 0 && a > 0 && locked) this.pow = 0;
    this.s += this.v * dt;
    const decel = (prev - this.v) / Math.max(dt, 1e-3);
    this.hardBrakeT -= dt;
    if (decel > 1.9 && !emerg && this.hardBrakeT <= 0 && this.v > 1) { this.stats.hard++; this.hardBrakeT = 3; this.toast('Hard braking!', 'bad'); }
    if (emerg && this.v > 1 && this.hardBrakeT <= 0) { this.stats.hard++; this.hardBrakeT = 3; }
    // ---- speed limit
    const lim = r.limitAt(this.s), kmh = this.v * 3.6, limK = Math.round(lim * 3.6);
    this.overCool -= dt;
    if (kmh > limK + 4) { this.overT += dt; if (this.overT > 1.2 && this.overCool <= 0) { this.stats.over++; this.overCool = 5; this.toast(`Speeding! Limit ${limK} km/h`, 'bad'); AUDIO.warn(); } } else this.overT = Math.max(0, this.overT - dt);
    // ---- doors and passengers
    if (Math.abs(this.door - this.doorTarget) > 0.001) this.door += Math.sign(this.doorTarget - this.door) * Math.min(Math.abs(this.doorTarget - this.door), dt / 1.3);
    this.tram.setDoors(this.door, 1);
    if (this.phase === 'dwell') {
      const dw = this.dw, st = this.trip[this.stopIdx];
      if (this.door > 0.95 && this.doorTarget === 1) {
        dw.timer += dt;
        const doors = this.doorWorld(st);
        if (dw.a < dw.alightT && dw.timer > dw.a * 0.5 + 0.4) { dw.a++; this.aboard--; this.people.alight(doors); }
        if (dw.b < dw.boardT && dw.timer > dw.b * 0.55 + 0.9) { if (this.people.boardOne(this.stopIdx, doors)) { dw.b++; this.aboard++; this.stats.carried++; } else dw.boardT = dw.b; }
      }
      if (this.doorTarget === 0 && this.door <= 0.001) {
        this.door = 0; this.phase = 'run';
        if (this.stopIdx === this.trip.length - 1) this.finish(); else this.stopIdx++;
      }
    } else if (!this.finished) {
      const st = this.trip[this.stopIdx];
      if (st && this.s > st.haltS + 60) { this.stats.missed++; this.toast(`Missed the stop ${st.name}!`, 'bad'); AUDIO.warn(); if (this.stopIdx < this.trip.length - 1) this.stopIdx++; else this.finish(); }
    }
    // ---- vehicle and cameras
    this.tram.setPose(r, this.s);
    this.tram.setCab(this.cabCam);
    this.updateCamera(dt);
    AUDIO.engine(true, this.v, this.pow * (locked ? 0 : 1));
    // headlamp at night
    this.spot.visible = night > 0.15; this.spot.intensity = 1800 * night;
    if (this.spot.visible) { const f = r.at(this.s, {}); this.spot.position.set(f.x - f.tz * 0, 1.6, f.z); this.spot.target.position.set(f.x + f.tx * 40, 0.6, f.z + f.tz * 40); }
    this.hud.classList.toggle('ext', !this.cabCam);
    // ---- HUD
    el.speed.textContent = Math.round(kmh); el.speed.parentElement.classList.toggle('over', kmh > limK + 3);
    el.limit.textContent = limK; el.limitBox.classList.toggle('over', kmh > limK + 3);
    el.trac.style.width = (locked ? 0 : this.pow * 100) + '%'; el.brk.style.width = this.brk * 100 + '%';
    el.doors.textContent = this.door > 0.97 ? 'open' : this.door > 0.02 ? (this.doorTarget ? 'opening' : 'closing') : 'closed';
    el.doors.className = 'tm-doors ' + (this.door > 0.02 ? 'open' : '');
    el.aboard.textContent = this.aboard;
    const m = Math.floor(this.clock / 60), sec = String(Math.floor(this.clock % 60)).padStart(2, '0');
    el.clock.textContent = `${m}:${sec}`;
    const st = this.trip[Math.min(this.stopIdx, this.trip.length - 1)], dist = st.haltS - this.s;
    el.next.textContent = st.name;
    if (this.phase === 'dwell') {
      const dw = this.dw, doneB = dw.b >= dw.boardT, doneA = dw.a >= dw.alightT;
      el.dist.textContent = this.door > 0.97 ? `${dw.a}/${dw.alightT} out · ${dw.b}/${dw.boardT} in` : '';
      el.status.textContent = this.door > 0.97 ? (doneA && doneB ? 'Boarding finished — press Space to close the doors' : 'Boarding…') : 'Doors…';
      el.status.className = 'tm-status ' + (doneA && doneB && this.door > 0.97 ? 'ready' : '');
    } else {
      el.dist.textContent = dist > 0 ? (dist > 999 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m') : `${Math.round(-dist)} m past the marker`;
      const need = dist > 3 ? (this.v * this.v) / (2 * dist) : 0;
      let msg = this.v < 0.05 && this.door === 0 && !this.finished ? (Math.abs(dist) < 35 ? 'At the stop — press Space to open the doors' : 'Press W to depart') : '';
      if (dist > 8 && dist < 220 && need > 0.62 && this.v > 3) msg = 'Start braking!';
      const nextLim = this.upcomingLimit();
      if (!msg && nextLim) msg = `Speed limit ${nextLim.k} km/h in ${nextLim.d} m`;
      el.status.textContent = msg; el.status.className = 'tm-status ' + (msg === 'Start braking!' ? 'warn' : '');
    }
    // approach bar: 200 m of approach to the halt marker
    const prog = Math.max(0, Math.min(1, 1 - dist / 200));
    el.bar.style.width = prog * 100 + '%'; el.halt.style.left = '100%';
    const late = this.clock - this.exp[Math.min(this.stopIdx, this.exp.length - 1)];
    el.late.textContent = late <= 20 ? 'on time' : `+${Math.floor(late / 60)}:${String(Math.floor(late % 60)).padStart(2, '0')} late`;
    el.late.className = 'tm-late ' + (late > 40 ? 'bad' : '');
    const live = this.stats.acc.length ? Math.round((this.stats.acc.reduce((x, y) => x + y, 0) / this.stats.acc.length) * 0.6 + Math.max(0, 100 - this.stats.over * 8 - this.stats.hard * 6) * 0.4) : 0;
    el.score.textContent = this.finished ? this.score : live;
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) el.toast.className = 'tm-toast'; }
  }
  upcomingLimit() {
    const r = this.route, cur = r.limitAt(this.s);
    for (let d = 20; d <= 180; d += 10) { const l = r.limitAt(this.s + d); if (l < cur - 2.4) return { k: Math.round(l * 3.6), d: Math.round(d / 10) * 10 }; }
    return null;
  }
  /** world positions of the tram's right-hand doors */
  doorWorld(st) {
    const out = [], p = {};
    for (const df of DOORS_FROM_FRONT) { const a = this.route.at(this.s - df, p); out.push({ x: a.x - a.tz * 1.7, z: a.z + a.tx * 1.7, rx: -a.tz, rz: a.tx }); }
    return out;
  }
  updateCamera(dt) {
    const cam = this.camera, r = this.route, g = this.tram.sec[0];
    g.updateMatrixWorld(true);
    if (this.cabCam) {
      const p = g.localToWorld(new THREE.Vector3(-0.3, 2.28, -SEC[0] / 2 - 0.35));
      cam.position.copy(p);
      cam.rotation.set(this.lookPitch - 0.03, g.rotation.y + this.lookYaw, 0, 'YXZ');
    } else {
      const a = r.at(this.s - 26, {}), yaw = Math.atan2(-a.tx, -a.tz) + this.lookYaw, p = this.lookPitch + 0.22, d = 46;
      const want = new THREE.Vector3(a.x + Math.sin(yaw) * d * Math.cos(p), 3 + Math.sin(p) * d + 4, a.z + Math.cos(yaw) * d * Math.cos(p));
      const roof = this.world.heightAt(want.x, want.z); if (want.y < roof + 2.5) want.y = roof + 3; // never inside a building
      if (!this.camInit) { cam.position.copy(want); this.camInit = true; } else cam.position.lerp(want, 1 - Math.exp(-6 * dt));
      cam.up.set(0, 1, 0); cam.lookAt(a.x, 2.2, a.z);
    }
    if (this.cabCam) this.camInit = false;
  }
}
