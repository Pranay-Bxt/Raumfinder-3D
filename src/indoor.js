// Rooms in 3D for the selected floor of a campus building: translucent coloured boxes for rooms, flat tiles
// for corridors, room-number labels, click a room to select it. Geometry comes from OpenStreetMap indoor
// mapping (community-mapped, may be incomplete); data/indoor.json is produced by tools/build-campus.mjs.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
const fitFont = (x, text, maxW, size, min = 18) => { let s = size; do { x.font = s + 'px VT323, ui-monospace, monospace'; } while (x.measureText(text).width > maxW && (s -= 2) > min); };

const PALETTE = ['#6fb7ff', '#7fe0b0', '#ffcf70', '#ff9fb2', '#b9a0ff', '#8fe3e8', '#f2a36b', '#a6e36f'].map((c) => new THREE.Color(c));
const CAT = { hoersaele: new THREE.Color('#ff9f43'), seminarraeume: new THREE.Color('#2ec4b6'), bibliotheken: new THREE.Color('#b08cff'), rechnerraeume: new THREE.Color('#6fb7ff') };
const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) s += r[j] * r[i + 1] - r[i] * r[j + 1]; return Math.abs(s / 2); };
const centroid = (r) => { let x = 0, z = 0; const n = r.length / 2; for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; } return [x / n, z / n]; };
function shapeOf(r) { const s = new THREE.Shape(); for (let i = 0; i < r.length; i += 2) { if (i) s.lineTo(r[i], -r[i + 1]); else s.moveTo(r[i], -r[i + 1]); } return s; }

function pill(text, on) {
  const c = document.createElement('canvas'); c.width = 192; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = on ? '#2ecc71' : 'rgba(8,16,30,0.78)';
  x.beginPath(); x.roundRect(3, 3, 186, 58, 29); x.fill();
  x.lineWidth = 3; x.strokeStyle = on ? '#fff' : 'rgba(255,255,255,.5)'; x.stroke();
  x.fillStyle = on ? '#04230f' : '#fff'; fitFont(x, text.slice(0, 11), 172, 48); x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text.slice(0, 11), 96, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class IndoorView {
  constructor(scene) { this.group = new THREE.Group(); scene.add(this.group); this.active = false; this.recs = []; this.tex = new Map(); this.focusG = null; }
  label(text, on) { const k = (on ? '*' : '') + text; let t = this.tex.get(k); if (!t) this.tex.set(k, (t = pill(text, on))); return t; }
  clear() {
    this.active = false; this.recs = [];
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry && o.geometry.dispose(); if (o.material) { o.material.map = null; o.material.dispose(); } }
    this.fill = null;
  }
  /** recs: [kind, ref, name, flatRing][]; y0: floor level height; fh: floor height */
  show(recs, y0, fh) {
    this.clear();
    if (!recs.length) return;
    this.recs = recs; this.y0 = y0; this.fh = fh;
    const geos = [], tri = [0], lines = [], rh = fh * 0.78;
    for (const rec of recs) {
      const [k, ref, , ring] = rec;
      const h = k === 'c' || k === 's' ? 0.15 : k === 'a' ? 0.3 : rh;
      const g = new THREE.ExtrudeGeometry(shapeOf(ring), { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0 + 0.06, 0);
      const col = k === 'c' ? new THREE.Color('#d8ecff') : k === 's' ? new THREE.Color('#aebccb') : k === 'a' ? new THREE.Color('#bfc3c8') : CAT[rec[4]] ? CAT[rec[4]] : PALETTE[(ref.charCodeAt(0) || 0) % PALETTE.length];
      const n = g.attributes.position.count, cs = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { cs[i * 3] = col.r; cs[i * 3 + 1] = col.g; cs[i * 3 + 2] = col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(cs, 3));
      g.deleteAttribute('uv');
      geos.push(g); tri.push(tri[tri.length - 1] + n / 3);
      if (k !== 'c' && k !== 's') for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) lines.push(ring[j], y0 + h + 0.08, ring[j + 1], ring[i], y0 + h + 0.08, ring[i + 1]);
    }
    this.tri = tri;
    const fill = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    fill.renderOrder = 12; this.group.add(fill); this.fill = fill;
    const ln = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthTest: false }));
    ln.renderOrder = 13; this.group.add(ln);
    let nl = 0;
    for (const rec of recs) {
      const [k, ref, , ring] = rec;
      if (k !== 'r' || !ref || nl > 260) continue;
      const a = ringArea(ring); if (a < 6) continue;
      const [cx, cz] = centroid(ring), w = Math.max(2.4, Math.min(5.5, Math.sqrt(a) * 0.55));
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.label(ref, false), transparent: true, depthTest: false }));
      sp.scale.set(w, w * 0.333, 1); sp.position.set(cx, y0 + rh + 0.7, cz); sp.renderOrder = 14; this.group.add(sp); nl++;
    }
    this.active = true;
    for (const o of this.group.children) o.frustumCulled = false;
  }
  /** which room did this ray hit? -> record or null */
  pick(ray) {
    if (!this.fill) return null;
    const h = ray.intersectObject(this.fill, false)[0];
    if (!h) return null;
    let lo = 0, hi = this.tri.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.tri[mid] <= h.faceIndex) lo = mid; else hi = mid; }
    const rec = this.recs[lo];
    return rec[0] === 'r' || rec[1] ? rec : null;
  }
  /** highlight every outline with this room number on the current floor; returns {x, z} of the first, or null */
  focus(ref) {
    if (this.focusG) { this.group.remove(this.focusG); this.focusG.traverse((o) => { o.geometry && o.geometry.dispose(); if (o.material) { o.material.map = null; o.material.dispose(); } }); this.focusG = null; }
    const want = String(ref).toLowerCase(), hits = this.recs.filter((r) => r[0] !== 'c' && (r[1].toLowerCase() === want || (r[2] && r[2].toLowerCase() === want)));
    if (!hits.length) return null;
    const g = new THREE.Group();
    for (const rec of hits) {
      const geo = new THREE.ExtrudeGeometry(shapeOf(rec[3]), { depth: this.fh * 0.86, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, this.y0 + 0.04, 0);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#2ecc71', transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      m.renderOrder = 15; g.add(m);
      const [cx, cz] = centroid(rec[3]), sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.label(rec[1] || rec[2], true), transparent: true, depthTest: false }));
      sp.scale.set(7, 2.33, 1); sp.position.set(cx, this.y0 + this.fh * 0.86 + 1.4, cz); sp.renderOrder = 16; g.add(sp);
    }
    g.traverse((o) => (o.frustumCulled = false));
    this.group.add(g); this.focusG = g;
    const [x, z] = centroid(hits[0][3]);
    return { x, z, rec: hits[0] };
  }
  /** room numbers of the rooms that touch (or nearly touch) this room, nearest first */
  neighbours(rec) {
    const A = rec[3];
    const seg = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)); return Math.hypot(px - (ax + dx * t), pz - (az + dz * t)); };
    const toPoly = (P, Q) => { let d = 1e9; for (let i = 0; i < P.length; i += 2) for (let k = 0, j = Q.length - 2; k < Q.length; j = k, k += 2) d = Math.min(d, seg(P[i], P[i + 1], Q[j], Q[j + 1], Q[k], Q[k + 1])); return d; };
    const out = new Map();
    for (const r of this.recs) {
      if (r === rec || r[0] !== 'r' || !r[1] || r[1] === rec[1]) continue;
      const d = Math.min(toPoly(A, r[3]), toPoly(r[3], A));
      if (d <= 1.6 && (!out.has(r[1]) || out.get(r[1]) > d)) out.set(r[1], d);
    }
    return [...out].sort((p, q) => p[1] - q[1]).map((e) => e[0]).slice(0, 6);
  }
}
