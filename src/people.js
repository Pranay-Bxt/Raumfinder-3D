// Pedestrians: people walking along real footways and sidewalks near the camera, passengers waiting
// at tram stops (they board when the tram's doors open) and passengers stepping off.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// everyone in Dresden yellow (DVB / Dynamo), a few shades so crowds don't look cloned
const PALETTE = {
  spring: ['#FFD400', '#FDE100', '#ffe14d', '#f7d23a', '#ffe680', '#f2c500'],
  summer: ['#FFD400', '#FDE100', '#ffea5c', '#fff07a', '#ffd84d', '#f5cf1f'],
  autumn: ['#FFD400', '#f2c200', '#e6b800', '#FDE100', '#d9a900', '#ffcd1a'],
  winter: ['#f2c200', '#e0ad00', '#FFD400', '#d19b00', '#e8b800', '#c79400'],
};
const SKIN = ['#f1c9a5', '#e0ac82', '#c68a63', '#8d5a3b', '#f4d6bd'];
const PANTS = ['#111111', '#1a1a1a', '#222428', '#151515', '#2a2a2a'];

const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; };

function offsetPoly(p, off) {
  const n = p.length / 2, o = new Float32Array(p.length);
  for (let i = 0; i < n; i++) {
    let ix = 0, iz = 0, ox = 0, oz = 0;
    if (i > 0) { ix = p[i * 2] - p[i * 2 - 2]; iz = p[i * 2 + 1] - p[i * 2 - 1]; const l = Math.hypot(ix, iz) || 1; ix /= l; iz /= l; }
    if (i < n - 1) { ox = p[i * 2 + 2] - p[i * 2]; oz = p[i * 2 + 3] - p[i * 2 + 1]; const l = Math.hypot(ox, oz) || 1; ox /= l; oz /= l; }
    if (i === 0) { ix = ox; iz = oz; } if (i === n - 1) { ox = ix; oz = iz; }
    let tx = ix + ox, tz = iz + oz; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    o[i * 2] = p[i * 2] - tz * off; o[i * 2 + 1] = p[i * 2 + 1] + tx * off;
  }
  return o;
}

/** write a column-major instance matrix: T * Ry(yaw) * S * T(pivot) * Rx(rx) */
function setM(arr, i, x, y, z, yaw, rx, sc, ox, oy, oz) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), c = Math.cos(rx), s = Math.sin(rx), e = i * 16;
  arr[e] = sc * cy; arr[e + 1] = 0; arr[e + 2] = -sc * sy; arr[e + 3] = 0;
  arr[e + 4] = sc * s * sy; arr[e + 5] = sc * c; arr[e + 6] = sc * s * cy; arr[e + 7] = 0;
  arr[e + 8] = sc * c * sy; arr[e + 9] = -sc * s; arr[e + 10] = sc * c * cy; arr[e + 11] = 0;
  arr[e + 12] = x + sc * (ox * cy + oz * sy); arr[e + 13] = y + sc * oy; arr[e + 14] = z + sc * (-ox * sy + oz * cy); arr[e + 15] = 1;
}

const FREE = 0, WALK = 1, WAIT = 2, BOARD = 3, ALIGHT = 4;

export class People {
  constructor(scene, roads, opts = {}) {
    this.walkN = opts.walkers ?? 520; this.waitN = 200; this.alightN = 48;
    this.N = this.walkN + this.waitN + this.alightN;
    this.R = 300; this.season = 'autumn'; this.enabled = true;
    // ---- footways and sidewalks
    this.walk = [];
    const add = (p, bridge) => { if (p.length >= 4) this.walk.push({ p, bridge }); };
    for (const [cls, bridge, w, pts, , , sw] of roads) {
      if (cls === 7 && w <= 3.6) add(Float32Array.from(pts), !!bridge);
      else if (cls === 6) add(Float32Array.from(pts), !!bridge);
      else if (sw && !bridge && cls >= 1 && cls <= 4) { const p = Float32Array.from(pts); add(offsetPoly(p, w / 2 + 1.15), false); add(offsetPoly(p, -(w / 2 + 1.15)), false); }
    }
    this.CS = 100; this.grid = new Map();
    this.walk.forEach((wk, wi) => {
      const p = wk.p, n = p.length / 2, seen = new Set();
      for (let k = 0; k < n - 1; k++) { const key = Math.floor(p[k * 2] / this.CS) + ',' + Math.floor(p[k * 2 + 1] / this.CS); let a = this.grid.get(key); if (!a) this.grid.set(key, (a = [])); a.push(wi, k); }
    });
    // ---- state
    const N = this.N;
    this.kind = new Uint8Array(N); this.x = new Float32Array(N); this.z = new Float32Array(N); this.yaw = new Float32Array(N); this.ph = new Float32Array(N);
    this.sp = new Float32Array(N); this.sc = new Float32Array(N); this.wi = new Int32Array(N); this.sg = new Int32Array(N); this.t = new Float32Array(N); this.dir = new Int8Array(N);
    this.tx = new Float32Array(N); this.tz = new Float32Array(N); this.tm = new Float32Array(N); this.grp = new Int16Array(N).fill(-1); this.y = new Float32Array(N);
    this.dirty = new Uint8Array(N).fill(1);
    // ---- instanced figure: torso, head, two legs, two arms
    const torso = new THREE.CapsuleGeometry(0.19, 0.46, 3, 8).translate(0, 1.14, 0), head = new THREE.SphereGeometry(0.115, 10, 8).translate(0, 1.66, 0);
    const leg = new THREE.BoxGeometry(0.115, 0.74, 0.14).translate(0, -0.37, 0), arm = new THREE.BoxGeometry(0.085, 0.58, 0.1).translate(0, -0.29, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    // fan scarf: a ring round the neck + one hanging end, black and yellow stripes
    const scv = document.createElement('canvas'); scv.width = 16; scv.height = 2;
    const sx = scv.getContext('2d'); sx.fillStyle = '#FFD400'; sx.fillRect(0, 0, 8, 2); sx.fillStyle = '#111'; sx.fillRect(8, 0, 8, 2);
    const stripes = new THREE.CanvasTexture(scv); stripes.wrapS = stripes.wrapT = THREE.RepeatWrapping; stripes.magFilter = THREE.NearestFilter; stripes.colorSpace = THREE.SRGBColorSpace;
    const ring = new THREE.TorusGeometry(0.135, 0.05, 6, 16).rotateX(Math.PI / 2).translate(0, 1.5, 0);
    { const uv = ring.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * 7); } // 7 stripe pairs round the neck
    const tail = new THREE.BoxGeometry(0.085, 0.36, 0.03).translate(-0.07, 1.3, 0.175);
    { const uv = tail.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getY(k) * 3); } // stripes across the hanging end
    const scarf = mergeGeometries([ring.toNonIndexed(), tail.toNonIndexed()]);
    const scarfMat = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.95 });
    const mk = (g) => { const m = new THREE.InstancedMesh(g, mat, N); m.castShadow = true; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); return m; };
    this.mT = mk(torso); this.mH = mk(head); this.mL = mk(leg); this.mR = mk(leg.clone()); this.mAL = mk(arm); this.mAR = mk(arm.clone());
    this.mS = new THREE.InstancedMesh(scarf, scarfMat, N); this.mS.castShadow = false; this.mS.frustumCulled = false; this.mS.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(this.mS);
    this.meshes = [this.mT, this.mH, this.mL, this.mR, this.mAL, this.mAR, this.mS];
    for (let i = 0; i < N; i++) { this.sc[i] = hash(i * 7 + 3) < 0.09 ? 0.72 + hash(i) * 0.1 : 0.92 + hash(i * 3) * 0.14; this.sp[i] = 1.0 + hash(i * 5) * 0.6; this.ph[i] = hash(i * 11) * 6.28; }
    this.recolor();
    this.zero();
    // ---- waiting groups per stop
    this.groups = []; this.waitNext = this.walkN; this.alightNext = this.walkN + this.waitN;
    this.focus = [0, 0];
  }
  zero() { for (const m of this.meshes) m.instanceMatrix.array.fill(0); }
  recolor() {
    const pal = PALETTE[this.season].map((c) => new THREE.Color(c)), skin = SKIN.map((c) => new THREE.Color(c)), pants = PANTS.map((c) => new THREE.Color(c));
    for (let i = 0; i < this.N; i++) {
      const c = pal[Math.floor(hash(i * 13 + 1) * pal.length)];
      this.mT.setColorAt(i, c); this.mAL.setColorAt(i, c); this.mAR.setColorAt(i, c);
      this.mH.setColorAt(i, skin[Math.floor(hash(i * 17 + 2) * skin.length)]);
      const pc = pants[Math.floor(hash(i * 19 + 5) * pants.length)];
      this.mL.setColorAt(i, pc); this.mR.setColorAt(i, pc);
    }
    for (const m of this.meshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  setSeason(s) { this.season = s; this.recolor(); }
  setEnabled(on) { this.enabled = on; for (const m of this.meshes) m.visible = on; }

  spawnWalker(i, fx, fz) {
    for (let tries = 0; tries < 10; tries++) {
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * this.R;
      const cell = this.grid.get(Math.floor((fx + Math.cos(a) * r) / this.CS) + ',' + Math.floor((fz + Math.sin(a) * r) / this.CS));
      if (!cell) continue;
      const e = (Math.floor(Math.random() * (cell.length / 2))) * 2;
      this.kind[i] = WALK; this.wi[i] = cell[e]; this.sg[i] = cell[e + 1]; this.t[i] = Math.random(); this.dir[i] = Math.random() < 0.5 ? 1 : -1;
      this.y[i] = this.walk[cell[e]].bridge ? 0.2 : 0.14;
      this.dirty[i] = 1;
      return true;
    }
    this.kind[i] = FREE; this.setHidden(i);
    return false;
  }
  setHidden(i) { for (const m of this.meshes) m.instanceMatrix.array.fill(0, i * 16, i * 16 + 16); this.dirty[i] = 0; }

  // ------------------------------------------------------------------ tram stops
  /** place waiting passengers at every stop of the trip, on the right-hand platform side of the route */
  arrangeStops(route, stops) {
    for (let i = this.walkN; i < this.walkN + this.waitN; i++) { this.kind[i] = FREE; this.setHidden(i); }
    this.waitNext = this.walkN; this.groups = [];
    const p = {};
    stops.forEach((st, gi) => {
      const last = gi === stops.length - 1, n = gi === 0 ? 0 : last ? 0 : 4 + Math.floor(Math.random() * 6), ids = [];
      for (let k = 0; k < n && this.waitNext < this.walkN + this.waitN; k++) {
        const i = this.waitNext++, a = route.at(st.s - 18 + Math.random() * 30, p), lat = 3.0 + Math.random() * 1.2;
        this.kind[i] = WAIT; this.x[i] = a.x - a.tz * lat; this.z[i] = a.z + a.tx * lat; this.y[i] = 0.14;
        this.yaw[i] = Math.atan2(a.tz, -a.tx) + (Math.random() - 0.5) * 0.8; // face the track
        this.dirty[i] = 1; ids.push(i);
      }
      this.groups.push(ids);
    });
  }
  waitersLeft(gi) { return (this.groups[gi] || []).filter((i) => this.kind[i] === WAIT).length; }
  boardOne(gi, doors) {
    const i = (this.groups[gi] || []).find((q) => this.kind[q] === WAIT);
    if (i == null) return false;
    let best = doors[0], bd = 1e9;
    for (const d of doors) { const dd = Math.hypot(d.x - this.x[i], d.z - this.z[i]); if (dd < bd) { bd = dd; best = d; } }
    this.kind[i] = BOARD; this.tx[i] = best.x; this.tz[i] = best.z; this.sp[i] = 1.5;
    return true;
  }
  alight(doors) {
    let i = -1;
    for (let k = 0; k < this.alightN; k++) { const q = this.walkN + this.waitN + ((this.alightNext - this.walkN - this.waitN + k) % this.alightN); if (this.kind[q] === FREE) { i = q; break; } }
    if (i < 0) return;
    this.alightNext = i + 1;
    const d = doors[Math.floor(Math.random() * doors.length)];
    this.kind[i] = ALIGHT; this.x[i] = d.x; this.z[i] = d.z; this.tx[i] = d.rx; this.tz[i] = d.rz; this.tm[i] = 0; this.sp[i] = 1.2 + Math.random() * 0.4; this.y[i] = 0.14; this.dirty[i] = 1;
    this.yaw[i] = Math.atan2(d.rx, d.rz);
  }

  // ------------------------------------------------------------------ per frame
  update(dt, fx, fz, camY) {
    const show = this.enabled && camY < 650;
    for (const m of this.meshes) m.visible = show;
    if (!show) return;
    dt = Math.min(dt, 0.05);
    const R2 = this.R * 1.2;
    let respawn = 0;
    const S = this.mS.instanceMatrix.array, A = this.mT.instanceMatrix.array, H = this.mH.instanceMatrix.array, L = this.mL.instanceMatrix.array, Rr = this.mR.instanceMatrix.array, AL = this.mAL.instanceMatrix.array, AR = this.mAR.instanceMatrix.array;
    for (let i = 0; i < this.N; i++) {
      const k = this.kind[i];
      if (k === FREE) continue;
      let walking = 0;
      if (k === WALK) {
        const wk = this.walk[this.wi[i]];
        if (!wk) { this.kind[i] = FREE; continue; }
        const p = wk.p, n = p.length / 2;
        let sg = this.sg[i], t = this.t[i];
        const ax = p[sg * 2], az = p[sg * 2 + 1], bx = p[sg * 2 + 2], bz = p[sg * 2 + 3], len = Math.hypot(bx - ax, bz - az) || 1;
        t += (this.dir[i] * this.sp[i] * dt) / len;
        if (t >= 1) { if (sg >= n - 2) { sg = n - 2; t = 1; this.dir[i] = -1; } else { sg++; t = 0; } }
        else if (t < 0) { if (sg <= 0) { sg = 0; t = 0; this.dir[i] = 1; } else { sg--; t = 1; } }
        this.sg[i] = sg; this.t[i] = t;
        this.x[i] = ax + (bx - ax) * t; this.z[i] = az + (bz - az) * t;
        this.yaw[i] = Math.atan2((bx - ax) * this.dir[i], (bz - az) * this.dir[i]);
        if (Math.hypot(this.x[i] - fx, this.z[i] - fz) > R2 && respawn++ < 24) { this.spawnWalker(i, fx, fz); continue; }
        walking = 1;
      } else if (k === BOARD) {
        const dx = this.tx[i] - this.x[i], dz = this.tz[i] - this.z[i], d = Math.hypot(dx, dz);
        if (d < 0.35) { this.kind[i] = FREE; this.setHidden(i); continue; }
        this.x[i] += (dx / d) * this.sp[i] * dt; this.z[i] += (dz / d) * this.sp[i] * dt; this.yaw[i] = Math.atan2(dx, dz); walking = 1;
      } else if (k === ALIGHT) {
        this.tm[i] += dt;
        this.x[i] += this.tx[i] * this.sp[i] * dt; this.z[i] += this.tz[i] * this.sp[i] * dt; walking = this.tm[i] < 6 ? 1 : 0;
        if (this.tm[i] > 7) { this.kind[i] = FREE; this.setHidden(i); continue; }
      }
      const sc = this.sc[i] * (k === ALIGHT && this.tm[i] > 5.5 ? Math.max(0.001, 7 - this.tm[i]) / 1.5 : 1);
      const ph = (this.ph[i] += dt * this.sp[i] * 5.2 * walking), sw = Math.sin(ph) * 0.62 * walking, bob = Math.abs(Math.sin(ph)) * 0.025 * walking;
      const x = this.x[i], z = this.z[i], y = this.y[i] + bob, yw = this.yaw[i];
      setM(A, i, x, y, z, yw, 0, sc, 0, 0, 0); setM(H, i, x, y, z, yw, 0, sc, 0, 0, 0); setM(S, i, x, y, z, yw, 0, sc, 0, 0, 0);
      setM(L, i, x, y, z, yw, sw, sc, -0.085, 0.78, 0); setM(Rr, i, x, y, z, yw, -sw, sc, 0.085, 0.78, 0);
      setM(AL, i, x, y, z, yw, -sw * 0.9, sc, -0.24, 1.52, 0); setM(AR, i, x, y, z, yw, sw * 0.9, sc, 0.24, 1.52, 0);
      this.dirty[i] = 0;
    }
    // initial fill of walkers (a few per frame so the first frames stay smooth)
    if (this.spawned == null) this.spawned = 0;
    let n = 0;
    while (this.spawned < this.walkN && n++ < 60) { this.spawnWalker(this.spawned, fx, fz); this.dirty[this.spawned] = 0; this.spawned++; }
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }
}
