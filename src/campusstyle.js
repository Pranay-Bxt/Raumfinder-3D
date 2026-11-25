// TU Dresden look for every campus building: navy blue roofs (TU Dresden blue) and a light neon underglow along
// the foot of the walls and on the ground around them (subtle by day, glowing at night).
import * as THREE from 'three';
import { project } from './proj.js';

export const TU_BLUE = '#00305D';
const pip = (x, z, r) => { let ins = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const ax = r[i], az = r[i + 1], bx = r[j], bz = r[j + 1]; if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) ins = !ins; } return ins; };

/** find the 3D building rows (mesh + index) of all campus buildings in one pass over the city */
function campusParts(world, data, campus, indoor) {
  const CS = 60, grid = new Map(), add = (x, z, id) => { const k = Math.floor(x / CS) + ',' + Math.floor(z / CS); (grid.get(k) || grid.set(k, []).get(k)).push([x, z, id]); };
  for (const b of campus.buildings) {
    for (const [la, lo] of b.points) { const [x, z] = project(la, lo); add(x, z, b.id); }
    const lv = indoor && indoor.levels && indoor.levels[b.id]; // mapped rooms help find every wing of a big building
    if (lv) { const all = Object.values(lv).flat(), step = Math.max(1, Math.floor(all.length / 70)); for (let i = 0; i < all.length; i += step) { const r = all[i][3]; let cx = 0, cz = 0; for (let k = 0; k < r.length; k += 2) { cx += r[k]; cz += r[k + 1]; } add(cx / (r.length / 2), cz / (r.length / 2), b.id); } }
  }
  const out = [];
  for (const m of world.bGroup.children) {
    const lod = m.userData.src === 'lod2', ids = m.userData.idxs;
    if (!ids) continue;
    for (let li = 0; li < ids.length; li++) {
      const ring = lod ? data.lod2.rows[ids[li]][10] : data.buildings[ids[li]][11][0];
      if (!ring || ring.length < 6) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
      let hit = null;
      for (let gx = Math.floor(x0 / CS); gx <= Math.floor(x1 / CS) && !hit; gx++) for (let gz = Math.floor(z0 / CS); gz <= Math.floor(z1 / CS) && !hit; gz++)
        for (const p of grid.get(gx + ',' + gz) || []) if (p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1 && pip(p[0], p[1], ring)) { hit = p[2]; break; }
      if (hit) out.push({ m, li, ring, id: hit });
    }
  }
  return out;
}

export function styleCampus(scene, world, data, campus, indoor) {
  const parts = campusParts(world, data, campus, indoor);
  // ---- navy roofs: repaint the roof vertices (aB.y = part > 0) of every campus building
  const navy = new THREE.Color(TU_BLUE), dirty = new Set();
  for (const { m, li } of parts) {
    const g = m.geometry, col = g.attributes.color, ab = g.attributes.aB, idx = g.index.array, ts = m.userData.triStart;
    for (let t = ts[li] * 3; t < ts[li + 1] * 3; t++) {
      const v = idx[t];
      if (ab.getY(v) > 0) { const s = 0.85 + 0.3 * ((v * 2654435761) % 1000) / 1000 * 0.3; col.setXYZ(v, navy.r * s, navy.g * s, navy.b * s); }
    }
    dirty.add(col);
  }
  dirty.forEach((c) => (c.needsUpdate = true));
  // ---- neon underglow: a glowing band up the foot of the walls and a soft glow on the ground around them
  const pos = [], alpha = [], idx = [];
  const quad = (a, b, c, d, aa, ab_, ac, ad) => { const n = pos.length / 3; pos.push(...a, ...b, ...c, ...d); alpha.push(aa, ab_, ac, ad); idx.push(n, n + 1, n + 2, n, n + 2, n + 3); };
  for (const { ring } of parts) {
    let area = 0; for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) area += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
    const sgn = area > 0 ? 1 : -1;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const ax = ring[j], az = ring[j + 1], bx = ring[i], bz = ring[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
      if (l < 0.5) continue;
      const ox = (sgn * dz) / l, oz = (-sgn * dx) / l; // outward normal
      const ga = world.groundY(ax, az), gb = world.groundY(bx, bz), y0a = Math.max(ga, 0) + 0.24, y0b = Math.max(gb, 0) + 0.24;
      // wall band (just outside the wall, fading upwards)
      quad([ax + ox * 0.12, y0a, az + oz * 0.12], [bx + ox * 0.12, y0b, bz + oz * 0.12], [bx + ox * 0.12, y0b + 2.4, bz + oz * 0.12], [ax + ox * 0.12, y0a + 2.4, az + oz * 0.12], 1, 1, 0, 0);
      // ground glow (fading outwards)
      quad([ax + ox * 0.1, y0a, az + oz * 0.1], [ax + ox * 3.2, y0a, az + oz * 3.2], [bx + ox * 3.2, y0b, bz + oz * 3.2], [bx + ox * 0.1, y0b, bz + oz * 0.1], 0.75, 0, 0, 0.75);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aA', new THREE.Float32BufferAttribute(alpha, 1)); g.setIndex(idx);
  const U = { uCol: { value: new THREE.Color('#38c8ff') }, uInt: { value: 1 }, uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    // add light to the colour only, leave the alpha channel alone (piling up alpha breaks the bloom pass)
    uniforms: U, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
    vertexShader: 'attribute float aA; varying float vA; varying vec3 vW; void main() { vA = aA; vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uCol; uniform float uInt, uTime; varying float vA; varying vec3 vW; void main() { float a = vA * vA * (0.85 + 0.15 * sin(uTime * 1.6 + (vW.x + vW.z) * 0.03)); gl_FragColor = vec4(uCol * uInt * a, 0.0); }',
  });
  const glow = new THREE.Mesh(g, mat); glow.renderOrder = 9; glow.frustumCulled = false; glow.name = 'campusGlow';
  scene.add(glow);
  const found = new Set(parts.map((p) => p.id));
  return {
    parts: parts.length, buildings: found.size,
    update(time, night) { U.uTime.value = time; U.uInt.value = 0.45 + 1.9 * night; glow.visible = world.bGroup.visible; },
  };
}
