// Leaves: fallen leaves lying under the trees around you, and leaves that drop from the crowns, flutter and get
// blown along by gusty wind before settling and skittering over the ground. Autumn has the most; spring sheds
// blossom petals; summer only the odd green leaf; winter none. Only drawn near the camera.
import * as THREE from 'three';

const COLORS = {
  autumn: ['#d9822b', '#c4541f', '#e0a530', '#8f3b1b', '#b8732d', '#e3c04a', '#a8432a', '#7a4a24', '#f0b43c'],
  summer: ['#4f7a2e', '#6b8f3a', '#5a8a35', '#a8a04a'],
  spring: ['#f6c6d8', '#ffffff', '#f2a7c3', '#fbe3ec'],
  winter: ['#5e4630', '#6b5038'],
};
// per season: fallen leaves per tree, how many are in the air at once
const AMOUNT = { autumn: [55, 650], summer: [3, 45], spring: [6, 160], winter: [3, 0] };
const FALLEN_MAX = 14000, FLY_MAX = 650, R_FALLEN = 115, R_FLY = 75;

function leafTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.beginPath(); x.moveTo(32, 3); x.bezierCurveTo(56, 16, 56, 44, 32, 58); x.bezierCurveTo(8, 44, 8, 16, 32, 3); x.fill();
  x.strokeStyle = 'rgba(0,0,0,0.28)'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(32, 6); x.lineTo(32, 62); x.stroke(); // midrib + stem
  x.lineWidth = 1.2;
  for (let k = 0; k < 4; k++) { const y = 18 + k * 9; x.beginPath(); x.moveTo(32, y + 4); x.lineTo(20, y - 2); x.moveTo(32, y + 4); x.lineTo(44, y - 2); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
let seed = 1;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

export class Leaves {
  constructor(scene, world) {
    this.world = world; this.season = 'autumn'; this.enabled = true; this.windMul = 1; this.t = 0;
    // trees around the map, in a grid for quick "trees near me" lookups (conifers do not shed)
    this.CS = 50; this.grid = new Map();
    for (const im of world.treeGroup.children) for (const [x, z, r] of im.userData.list) {
      if (r[4] < 0.1) continue;
      const s = 2.6 + r[0] * 2.8, h = 2.05 * s * (0.85 + r[2] * 0.4);
      const k = Math.floor(x / this.CS) + ',' + Math.floor(z / this.CS);
      (this.grid.get(k) || this.grid.set(k, []).get(k)).push([x, z, s, h]);
    }
    const tex = leafTexture();
    const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide });
    // fallen: flat on the ground
    this.fallen = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.3, 0.3).rotateX(-Math.PI / 2), mat, FALLEN_MAX);
    this.fallen.count = 0; this.fallen.frustumCulled = false; this.fallen.receiveShadow = true;
    // flying: upright quads that tumble
    this.fly = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.24, 0.24), mat, FLY_MAX);
    this.fly.count = 0; this.fly.frustumCulled = false; this.fly.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fly.castShadow = false; this.fallen.castShadow = false;
    scene.add(this.fallen, this.fly);
    // flying leaf state
    const N = FLY_MAX;
    this.p = new Float32Array(N * 3); this.v = new Float32Array(N * 3); this.rot = new Float32Array(N * 3); this.spin = new Float32Array(N * 3);
    this.life = new Float32Array(N); this.ground = new Float32Array(N); this.ph = new Float32Array(N); this.gy = new Float32Array(N); this.alive = new Uint8Array(N);
    this.last = null; this.wind = new THREE.Vector2(1, 0.3);
    this.M = new THREE.Matrix4(); this.Q = new THREE.Quaternion(); this.E = new THREE.Euler(); this.V = new THREE.Vector3(); this.S = new THREE.Vector3();
    this.col = new THREE.Color();
  }
  treesNear(x, z, r) {
    const out = [], c0 = Math.floor((x - r) / this.CS), c1 = Math.floor((x + r) / this.CS), d0 = Math.floor((z - r) / this.CS), d1 = Math.floor((z + r) / this.CS);
    for (let a = c0; a <= c1; a++) for (let b = d0; b <= d1; b++) for (const t of this.grid.get(a + ',' + b) || []) if (Math.hypot(t[0] - x, t[1] - z) < r) out.push(t);
    return out;
  }
  setSeason(s) { this.season = s; this.last = null; for (let i = 0; i < FLY_MAX; i++) this.alive[i] = 0; }
  setWeather(w) { this.windMul = w === 'rain' ? 1.9 : w === 'fog' ? 0.45 : w === 'haze' ? 0.8 : 1; }
  setEnabled(on) { this.enabled = on; this.fallen.visible = this.fly.visible = on; }

  /** scatter fallen leaves under the trees around (fx, fz) */
  layFallen(fx, fz) {
    const per = AMOUNT[this.season][0], pal = COLORS[this.season].map((c) => new THREE.Color(c)), w = this.world;
    seed = (Math.floor(fx / 40) * 73856093) ^ (Math.floor(fz / 40) * 19349663) ^ this.season.length; // same spot -> same leaves
    let n = 0;
    for (const [x, z, s] of this.treesNear(fx, fz, R_FALLEN)) {
      const k = Math.round(per * (s / 4) * (0.6 + rnd() * 0.8));
      for (let j = 0; j < k && n < FALLEN_MAX; j++) {
        const a = rnd() * 6.283, d = Math.sqrt(rnd()) * s * 1.5, lx = x + Math.cos(a) * d + this.wind.x * rnd() * 2, lz = z + Math.sin(a) * d + this.wind.y * rnd() * 2;
        if (w.solidAt(lx, lz) || w.riverAt(lx, lz) > 0.35) continue;
        const sc = 0.75 + rnd() * 0.6;
        this.E.set((rnd() - 0.5) * 0.25, rnd() * 6.283, (rnd() - 0.5) * 0.25);
        this.fallen.setMatrixAt(n, this.M.compose(this.V.set(lx, w.surfaceAt(lx, lz) + 0.012 + rnd() * 0.01, lz), this.Q.setFromEuler(this.E), this.S.set(sc, sc, sc)));
        this.fallen.setColorAt(n, this.col.copy(pal[Math.floor(rnd() * pal.length)]).multiplyScalar(0.8 + rnd() * 0.25));
        n++;
      }
    }
    this.fallen.count = n;
    this.fallen.instanceMatrix.needsUpdate = true;
    if (this.fallen.instanceColor) this.fallen.instanceColor.needsUpdate = true;
    this.last = [fx, fz];
  }
  spawn(i, fx, fz, near) {
    const t = near[Math.floor(Math.random() * near.length)];
    const a = Math.random() * 6.283, d = Math.random() * t[2] * 0.9;
    this.p[i * 3] = t[0] + Math.cos(a) * d; this.p[i * 3 + 2] = t[1] + Math.sin(a) * d; this.p[i * 3 + 1] = t[3] * (0.45 + Math.random() * 0.5);
    this.v[i * 3] = 0; this.v[i * 3 + 1] = -0.4; this.v[i * 3 + 2] = 0;
    for (let k = 0; k < 3; k++) { this.rot[i * 3 + k] = Math.random() * 6.283; this.spin[i * 3 + k] = (Math.random() - 0.5) * 7; }
    this.ph[i] = Math.random() * 6.283; this.life[i] = 0; this.ground[i] = 0; this.alive[i] = 1;
    const pal = COLORS[this.season];
    this.fly.setColorAt(i, this.col.set(pal[Math.floor(Math.random() * pal.length)]));
    this.colorsDirty = true;
  }

  update(dt, fx, fz, camY) {
    const show = this.enabled && camY < 320;
    this.fallen.visible = this.fly.visible = show;
    if (!show) return;
    dt = Math.min(dt, 0.05); this.t += dt;
    // gusty wind that slowly turns
    const ang = 0.6 + Math.sin(this.t * 0.05) * 0.9, gust = 0.55 + 0.45 * Math.sin(this.t * 0.37) * Math.sin(this.t * 0.11 + 1) + Math.max(0, Math.sin(this.t * 0.9)) * 0.35;
    const ws = 2.2 * this.windMul * gust;
    this.wind.set(Math.cos(ang) * ws, Math.sin(ang) * ws);
    if (!this.last || Math.hypot(fx - this.last[0], fz - this.last[1]) > 35) this.layFallen(fx, fz);
    // leaves in the air
    const want = AMOUNT[this.season][1];
    const near = want ? this.treesNear(fx, fz, R_FLY) : [];
    let n = 0, spawned = 0;
    const w = this.world;
    for (let i = 0; i < FLY_MAX; i++) {
      if (i >= want || !near.length) { this.alive[i] = 0; continue; }
      if (!this.alive[i]) { if (spawned++ < 12) this.spawn(i, fx, fz, near); else continue; }
      const P = i * 3;
      this.life[i] += dt;
      if (this.ground[i] === 0) {
        // falling: drag towards the wind, sink, flutter sideways
        const fl = Math.sin(this.t * 2.6 + this.ph[i]);
        this.v[P] += (this.wind.x - this.v[P]) * Math.min(1, 1.6 * dt) + -this.wind.y * fl * 0.9 * dt;
        this.v[P + 2] += (this.wind.y - this.v[P + 2]) * Math.min(1, 1.6 * dt) + this.wind.x * fl * 0.9 * dt;
        this.v[P + 1] += (-0.65 + Math.sin(this.t * 3.1 + this.ph[i] * 2) * 0.45 + gust * 0.12 - this.v[P + 1]) * Math.min(1, 2.5 * dt);
        for (let k = 0; k < 3; k++) this.rot[P + k] += this.spin[P + k] * dt;
        this.p[P] += this.v[P] * dt; this.p[P + 1] += this.v[P + 1] * dt; this.p[P + 2] += this.v[P + 2] * dt;
        const gy = w.surfaceAt(this.p[P], this.p[P + 2]);
        if (this.p[P + 1] <= gy + 0.02) { this.p[P + 1] = gy + 0.02; this.gy[i] = gy; this.ground[i] = 0.001; this.rot[P] = -Math.PI / 2 + (Math.random() - 0.5) * 0.3; this.rot[P + 2] = 0; }
      } else {
        // on the ground: skitter along in the gusts, then lie still and fade out
        this.ground[i] += dt;
        const push = Math.max(0, gust - 0.75) * 2.2 * this.windMul * Math.max(0, 1 - this.ground[i] / 9);
        this.p[P] += this.wind.x * push * dt * 0.6; this.p[P + 2] += this.wind.y * push * dt * 0.6;
        this.rot[P + 1] += push * dt * 3 * Math.sin(this.ph[i]);
        this.p[P + 1] = this.gy[i] + 0.02 + Math.abs(Math.sin(this.t * 7 + this.ph[i])) * 0.05 * Math.min(1, push);
        if (this.ground[i] > 7 + (i % 5)) this.alive[i] = 0;
      }
      if (this.life[i] > 40 || Math.hypot(this.p[P] - fx, this.p[P + 2] - fz) > R_FLY * 1.4 || w.solidAt(this.p[P], this.p[P + 2])) { this.alive[i] = 0; continue; }
      const fade = this.ground[i] > 0 ? Math.max(0.001, Math.min(1, (8 + (i % 5) - this.ground[i]))) : 1;
      this.E.set(this.rot[P], this.rot[P + 1], this.rot[P + 2]);
      this.fly.setMatrixAt(i, this.M.compose(this.V.set(this.p[P], this.p[P + 1], this.p[P + 2]), this.Q.setFromEuler(this.E), this.S.set(fade, fade, fade)));
      n = i + 1;
    }
    // dead slots below n must not draw: park them out of sight
    for (let i = 0; i < n; i++) if (!this.alive[i]) this.fly.setMatrixAt(i, this.M.makeScale(0, 0, 0));
    this.fly.count = n;
    this.fly.instanceMatrix.needsUpdate = true;
    if (this.colorsDirty && this.fly.instanceColor) { this.fly.instanceColor.needsUpdate = true; this.colorsDirty = false; }
  }
}
