// Football pitches (real outlines from OpenStreetMap) with full markings, 3D goals,
// running tracks, and a penalty shoot-out you can play on any pitch.
import * as THREE from 'three';
import earcut from 'earcut';

const NOISE = `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
`;
const PITCH_Y = 0.3, TRACK_Y = 0.27;

/** minimum-area oriented rectangle of a flat [x,z,...] ring */
function obb(r) {
  const n = r.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let dx = r[j * 2] - r[i * 2], dz = r[j * 2 + 1] - r[i * 2 + 1];
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    dx /= len; dz /= len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const a = r[k * 2] * dx + r[k * 2 + 1] * dz, b = -r[k * 2] * dz + r[k * 2 + 1] * dx;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const ar = (a1 - a0) * (b1 - b0);
    if (!best || ar < best.ar) best = { ar, dx, dz, a0, a1, b0, b1 };
  }
  const ca = (best.a0 + best.a1) / 2, cb = (best.b0 + best.b1) / 2;
  const o = { cx: ca * best.dx - cb * best.dz, cz: ca * best.dz + cb * best.dx, ux: best.dx, uz: best.dz, L: best.a1 - best.a0, W: best.b1 - best.b0 };
  if (o.W > o.L) { [o.L, o.W] = [o.W, o.L]; [o.ux, o.uz] = [-o.uz, o.ux]; }
  return o;
}
const inBox = (b, x, z, m = 0) => { const dx = x - b.cx, dz = z - b.cz; return Math.abs(dx * b.ux + dz * b.uz) <= b.L / 2 + m && Math.abs(-dx * b.uz + dz * b.ux) <= b.W / 2 + m; };

/** flat quad in the box's own frame; shader gets local metres in vLocal */
function boxQuad(b, margin, y) {
  const hl = b.L / 2 + margin, hw = b.W / 2 + margin, pos = [], loc = [];
  for (const [u, v] of [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]]) {
    pos.push(b.cx + b.ux * u - b.uz * v, y, b.cz + b.uz * u + b.ux * v); loc.push(u, v);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLocal', new THREE.Float32BufferAttribute(loc, 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.computeVertexNormals();
  return g;
}
function shaded(mat, uniforms, body) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = 'attribute vec2 aLocal; varying vec2 vLocal; varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = aLocal; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec2 vLocal; varying vec3 vWPos;\n' + Object.keys(uniforms).map((k) => `uniform ${typeof uniforms[k].value === 'number' ? 'float' : 'vec3'} ${k};`).join('\n') + '\n' + NOISE
      + sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + body);
  };
  // three.js caches programs by the hook's source text, which is identical for every material made here
  const key = Object.keys(uniforms).join(',') + body.length;
  mat.customProgramCacheKey = () => key;
  return mat;
}

function pitchMaterial(L, W, s, turf, snow) {
  return shaded(new THREE.MeshStandardMaterial({ roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }), { uL: { value: L }, uW: { value: W }, uS: { value: s }, uTurf: { value: turf }, uSnow: snow }, `
  {
    vec2 p = vLocal; float hl = uL * 0.5, hw = uW * 0.5, s = uS;
    float d = length(vWPos - cameraPosition), fd = 1.0 - smoothstep(150.0, 900.0, d);
    vec3 g1 = mix(vec3(0.20, 0.42, 0.15), vec3(0.16, 0.45, 0.2), uTurf), g2 = g1 * 1.16;
    float stripe = mod(floor((p.x + hl) / (uL / 14.0)), 2.0);
    vec3 col = mix(g1, g2, stripe * (0.4 + 0.6 * fd));
    col *= 0.9 + 0.2 * vn(p * 1.7) * (1.0 - uTurf * 0.6);
    // wear in the goalmouths and centre circle
    float wear = exp(-pow(length(vec2(abs(p.x) - (hl - 5.0 * s), p.y * 0.7)) / (5.0 * s), 2.0)) * 0.5 + exp(-pow(length(p) / 6.0, 2.0)) * 0.25;
    col = mix(col, vec3(0.42, 0.36, 0.25), wear * (1.0 - uTurf) * (0.6 + 0.4 * vn(p * 3.0)));
    float lw = 0.06, ax = abs(p.x), ay = abs(p.y);
    float aa = max(fwidth(p.x), 0.015);
    #define LINE(dist) (1.0 - smoothstep(lw, lw + aa, dist))
    float m = 0.0;
    m = max(m, LINE(abs(ax - hl)) * step(ay, hw + lw));
    m = max(m, LINE(abs(ay - hw)) * step(ax, hl + lw));
    m = max(m, LINE(ax));
    m = max(m, LINE(abs(length(p) - 9.15 * s)));
    m = max(m, step(length(p), 0.2));
    float pd = 16.5 * s, pw = 20.16 * s, gd = 5.5 * s, gw = 9.16 * s;
    m = max(m, LINE(abs(ax - (hl - pd))) * step(ay, pw + lw));
    m = max(m, LINE(abs(ay - pw)) * step(hl - pd - lw, ax) * step(ax, hl));
    m = max(m, LINE(abs(ax - (hl - gd))) * step(ay, gw + lw));
    m = max(m, LINE(abs(ay - gw)) * step(hl - gd - lw, ax) * step(ax, hl));
    vec2 spot = vec2(hl - 11.0 * s, 0.0);
    m = max(m, step(length(vec2(ax, p.y) - spot), 0.18));
    m = max(m, LINE(abs(length(vec2(ax, p.y) - spot) - 9.15 * s)) * step(ax, hl - pd));
    m = max(m, LINE(abs(length(vec2(hl - ax, hw - ay)) - 1.0)) * step(ax, hl) * step(ay, hw));
    m *= step(ax, hl + 0.2) * step(ay, hw + 0.2);
    col = mix(col, vec3(0.93), m * (0.35 + 0.65 * fd));
    col = mix(col, vec3(0.9, 0.92, 0.95), uSnow * (0.75 - 0.3 * m));
    diffuseColor.rgb = col;
  }`);
}

function trackMaterial(S, Rin, laneW, lanes, snow) {
  return shaded(new THREE.MeshStandardMaterial({ roughness: 0.8, transparent: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }), { uS: { value: S }, uR: { value: Rin }, uLane: { value: laneW }, uN: { value: lanes }, uSnow: snow }, `
  {
    vec2 p = vLocal; float ax = abs(p.x);
    float dist = ax <= uS * 0.5 ? abs(p.y) - uR : length(vec2(ax - uS * 0.5, p.y)) - uR;
    float total = uLane * uN;
    if (dist > total + 0.35) discard;
    vec3 col;
    float aa = max(fwidth(dist), 0.015);
    if (dist < -0.15) {
      col = vec3(0.21, 0.43, 0.17) * (0.9 + 0.2 * vn(p * 1.5));
    } else {
      col = vec3(0.66, 0.24, 0.17) * (0.9 + 0.18 * vn(p * 4.0));
      float k = dist / uLane, line = 1.0 - smoothstep(0.025, 0.025 + aa / uLane, abs(k - floor(k + 0.5)));
      line *= step(-0.1, dist) * step(dist, total + 0.1) * clamp(0.035 / aa, 0.0, 1.0);
      float kerb = 1.0 - smoothstep(0.08, 0.08 + aa, abs(dist + 0.08));
      col = mix(col, vec3(0.94), max(line * 0.9, kerb));
      // finish line on the home straight
      col = mix(col, vec3(0.94), (1.0 - smoothstep(0.05, 0.05 + aa, abs(p.x - uS * 0.5 + 0.5))) * step(0.0, p.y) * step(0.0, dist));
    }
    col = mix(col, vec3(0.9, 0.92, 0.95), uSnow * 0.8);
    diffuseColor.rgb = col;
  }`);
}

const WHITE = new THREE.MeshStandardMaterial({ color: '#f4f4f2', roughness: 0.35 });
let netTex = null;
function netMaterial() {
  if (!netTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.strokeStyle = 'rgba(245,245,245,0.95)'; x.lineWidth = 3;
    for (let i = 0; i <= 64; i += 16) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 64); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(64, i); x.stroke(); }
    netTex = new THREE.CanvasTexture(c); netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping; netTex.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.MeshStandardMaterial({ map: netTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.9 });
}
/** goal opening faces local -x (towards the pitch); origin at goal-line centre */
function makeGoal(w, h) {
  const g = new THREE.Group(), r = 0.06, depth = Math.min(2, h * 0.85);
  const cyl = (len) => new THREE.CylinderGeometry(r, r, len, 10);
  for (const s of [-1, 1]) { const post = new THREE.Mesh(cyl(h), WHITE); post.position.set(0, h / 2, (s * w) / 2); g.add(post); }
  const bar = new THREE.Mesh(cyl(w + 2 * r).rotateX(Math.PI / 2), WHITE); bar.position.set(0, h, 0); g.add(bar);
  for (const s of [-1, 1]) { const back = new THREE.Mesh(cyl(Math.hypot(depth, h)), WHITE); back.position.set(depth / 2, h / 2, (s * w) / 2); back.rotation.z = Math.atan2(depth, h); g.add(back); }
  const net = netMaterial();
  const plane = (sx, sy, rep) => { const m = net.clone(); m.map = netTex.clone(); m.map.repeat.set(rep[0], rep[1]); m.map.needsUpdate = true; return new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), m); };
  const slant = Math.hypot(depth, h);
  const back = plane(w, slant, [w / 0.12, slant / 0.12]); back.position.set(depth / 2, h / 2, 0); back.rotation.set(0, Math.PI / 2, 0); back.rotateX(-Math.atan2(depth, h)); g.add(back);
  for (const s of [-1, 1]) {
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(depth, 0), new THREE.Vector2(0, h)]);
    const geo = new THREE.ShapeGeometry(shape);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, geo.attributes.position.getX(i) / 0.12, geo.attributes.position.getY(i) / 0.12);
    const side = new THREE.Mesh(geo, net.clone()); side.material.map = netTex; side.position.z = (s * w) / 2; g.add(side);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = { w, h, depth };
  return g;
}

// ---------------------------------------------------------------------------
export function buildSports(sports, world) {
  const group = new THREE.Group();
  const snow = world.U.uSnow;
  const pitches = [], boxes = [];
  const stadiums = [];
  const sketched = [];
  for (const t of sports.tracks) {
    if (!t.outer) { sketched.push(t.bbox); continue; }
    const b = obb(t.outer);
    const ratio = b.L / b.W;
    if (b.W > 55 && b.W < 110 && ratio > 1.4 && ratio < 2.4) {
      // oval athletics track: fit a standard track (straights + bends, 1.22 m lanes) to the mapped outline
      const lanes = b.W > 80 ? 6 : 4, laneW = 1.22, Rout = b.W / 2, Rin = Rout - lanes * laneW, S = b.L - b.W;
      const m = new THREE.Mesh(boxQuad(b, 0.5, TRACK_Y), trackMaterial(S, Rin, laneW, lanes, snow));
      m.receiveShadow = true; group.add(m);
      stadiums.push(b); boxes.push(b);
    } else {
      // other tracks (sprint straights etc.): fill the mapped shape with tartan
      const fl = [...t.outer], holes = [];
      for (const h of t.holes) { holes.push(fl.length / 2); fl.push(...h); }
      const pos = []; for (let i = 0; i < fl.length; i += 2) pos.push(fl[i], TRACK_Y, fl[i + 1]);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(earcut(fl, holes.length ? holes : null).reverse()); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#a8402c', roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
      m.receiveShadow = true; group.add(m);
    }
  }
  for (const p of sports.pitches) {
    const b = obb(p.outer);
    if (b.L < 18 || b.W < 10) continue;
    const s = Math.max(0.42, Math.min(1, b.L / 105, b.W / 68));
    const turf = /artificial|tartan|rubber/.test(p.surface) ? 1 : 0;
    const mesh = new THREE.Mesh(boxQuad(b, 0.4, PITCH_Y), pitchMaterial(b.L, b.W, s, turf, snow));
    mesh.receiveShadow = true;
    const gw = s > 0.8 ? 7.32 : Math.max(3, 7.32 * s), gh = s > 0.8 ? 2.44 : Math.max(1.6, 2.44 * Math.sqrt(s));
    // a sketched track around a full-size pitch: standard 400 m oval aligned with the pitch
    if (b.L > 60 && !stadiums.some((st) => inBox(st, b.cx, b.cz)) && sketched.some((q) => b.cx > q[0] && b.cx < q[2] && b.cz > q[1] && b.cz < q[3])) {
      const lanes = 6, laneW = 1.22, Rin = 36.5, S = 84.39, st = { ...b, L: S + 2 * (Rin + lanes * laneW), W: 2 * (Rin + lanes * laneW) };
      const tm = new THREE.Mesh(boxQuad(st, 0.5, TRACK_Y), trackMaterial(S, Rin, laneW, lanes, snow));
      tm.receiveShadow = true; group.add(tm);
      stadiums.push(st); boxes.push(st);
    }
    const info = { ...b, s, gw, gh, name: p.name, id: p.id, inStadium: stadiums.some((st) => inBox(st, b.cx, b.cz)) };
    mesh.userData.pitch = info;
    group.add(mesh);
    for (const side of [-1, 1]) {
      const goal = makeGoal(gw, gh);
      goal.position.set(b.cx + b.ux * side * (b.L / 2), PITCH_Y, b.cz + b.uz * side * (b.L / 2));
      goal.rotation.y = Math.atan2(-b.uz * side, b.ux * side);
      group.add(goal);
    }
    pitches.push(mesh);
    boxes.push(b);
  }
  // no trees on pitches or tracks
  const M = new THREE.Matrix4(), v = new THREE.Vector3(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const im of world.treeGroup.children) {
    let changed = false;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, M); v.setFromMatrixPosition(M);
      if (boxes.some((b) => inBox(b, v.x, v.z, 1.5))) { im.setMatrixAt(i, zero); changed = true; }
    }
    if (changed) im.instanceMatrix.needsUpdate = true;
  }
  return { group, pitches };
}

// ---------------------------------------------------------------------------
function makeKeeper() {
  const g = new THREE.Group();
  const kit = new THREE.MeshStandardMaterial({ color: '#f2c12e', roughness: 0.7 }), dark = new THREE.MeshStandardMaterial({ color: '#1b1f27', roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: '#d9a982', roughness: 0.8 }), glove = new THREE.MeshStandardMaterial({ color: '#2fb35a', roughness: 0.6 });
  const box = (w, h, d, m, x, y, z, parent = g) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
  for (const s of [-1, 1]) { box(0.17, 0.82, 0.19, dark, 0, 0.42, s * 0.12); box(0.24, 0.1, 0.12, dark, -0.04, 0.05, s * 0.12); }
  box(0.27, 0.24, 0.48, dark, 0, 0.92, 0);
  box(0.3, 0.62, 0.52, kit, 0, 1.33, 0);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), skin); head.position.set(0, 1.79, 0); head.castShadow = true; g.add(head);
  const arms = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(0, 1.6, s * 0.3); g.add(pivot);
    box(0.13, 0.62, 0.13, kit, 0, -0.31, 0, pivot);
    box(0.15, 0.17, 0.12, glove, 0, -0.68, 0, pivot);
    pivot.rotation.x = s * 0.5;
    arms.push(pivot);
  }
  g.userData.arms = arms;
  return g;
}

export class Penalty {
  constructor(scene, camera, canvas) {
    this.scene = scene; this.camera = camera; this.canvas = canvas;
    this.root = new THREE.Group(); this.root.visible = false; scene.add(this.root);
    this.keeper = makeKeeper(); this.root.add(this.keeper);
    const tex = (() => { const c = document.createElement('canvas'); c.width = 128; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 128, 64); x.fillStyle = '#16181c';
      for (const [cx, cy] of [[16, 32], [48, 10], [48, 54], [80, 32], [112, 10], [112, 54]]) { x.beginPath(); for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; x.lineTo(cx + Math.cos(a) * 11, cy + Math.sin(a) * 11); } x.fill(); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45 }));
    this.ball.castShadow = true; this.root.add(this.ball);
    this.reticle = new THREE.Group();
    this.reticle.add(new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 32), new THREE.MeshBasicMaterial({ color: '#2ee6ff', transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide })));
    this.reticle.add(new THREE.Mesh(new THREE.CircleGeometry(0.05, 12), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, side: THREE.DoubleSide })));
    this.reticle.children.forEach((m) => (m.renderOrder = 50));
    this.root.add(this.reticle);
    this.ray = new THREE.Raycaster();
    this.hud = document.createElement('div');
    this.hud.id = 'pk';
    this.hud.innerHTML = `<div class="pk-top"><b class="pk-title"></b><span class="pk-dots"></span></div><div class="pk-msg"></div><div class="pk-power"><i></i></div><div class="pk-help">Move the mouse to aim · hold the mouse button to build power · release to shoot · <kbd>R</kbd> restart · <kbd>Esc</kbd> exit</div>`;
    document.body.appendChild(this.hud);
  }
  // pitch-local (u along the pitch towards the goal, v across, y up) -> world
  W(u, v, y) { const p = this.p; return new THREE.Vector3(p.cx + p.ux * u - p.uz * v, PITCH_Y + y, p.cz + p.uz * u + p.ux * v); }
  start(pitch) {
    this.p = pitch;
    this.hl = pitch.L / 2;
    this.spotU = this.hl - Math.max(7, 11 * pitch.s);
    this.root.visible = true; this.hud.style.display = 'block';
    this.hud.querySelector('.pk-title').textContent = (pitch.name || 'Football pitch') + ' · Penalties';
    this.reset();
  }
  reset() { this.shots = []; this.newShot(); }
  newShot() {
    this.phase = 'aim'; this.power = 0; this.charging = false; this.t = 0; this.result = '';
    this.aimV = 0; this.aimY = this.p.gh * 0.5;
    this.ball.position.copy(this.W(this.spotU, 0, 0.11)); this.ball.rotation.set(0, 0, 0);
    this.kV = 0; this.kRoll = 0; this.kLift = 0; this.dive = null;
    this.placeKeeper();
    this.msg('');
    this.drawDots();
  }
  exit() { this.root.visible = false; this.hud.style.display = 'none'; }
  msg(t, cls = '') { const m = this.hud.querySelector('.pk-msg'); m.textContent = t; m.className = 'pk-msg ' + cls; }
  drawDots() {
    const d = this.shots.map((s) => `<i class="${s ? 'g' : 'm'}"></i>`).join('') + '<i></i>'.repeat(Math.max(0, 5 - this.shots.length));
    this.hud.querySelector('.pk-dots').innerHTML = d + ` <b>${this.shots.filter(Boolean).length}</b>/5`;
  }
  aim(cx, cy) {
    if (this.phase !== 'aim') return;
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.camera);
    const p = this.p, gl = this.W(this.hl, 0, 0), n = new THREE.Vector3(p.ux, 0, p.uz);
    const hit = this.ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, gl), new THREE.Vector3());
    if (!hit) return;
    const d = hit.sub(gl);
    this.aimV = THREE.MathUtils.clamp(-d.x * p.uz + d.z * p.ux, -p.gw / 2 - 1.5, p.gw / 2 + 1.5);
    this.aimY = THREE.MathUtils.clamp(d.y + PITCH_Y - PITCH_Y, 0.12, p.gh + 1.2);
  }
  nudge(dv, dy) { if (this.phase === 'aim') { this.aimV = THREE.MathUtils.clamp(this.aimV + dv, -this.p.gw / 2 - 1.5, this.p.gw / 2 + 1.5); this.aimY = THREE.MathUtils.clamp(this.aimY + dy, 0.12, this.p.gh + 1.2); } }
  press() { if (this.phase === 'aim') { this.charging = true; this.power = 0; this.dir = 1; } else if (this.phase === 'over') this.reset(); }
  release() {
    if (this.phase !== 'aim' || !this.charging) return;
    this.charging = false;
    const pw = this.power, p = this.p;
    // inaccuracy grows with power; over-hit shots rise
    const err = 0.12 + 1.3 * Math.max(0, pw - 0.72) ** 1.3, a = Math.random() * Math.PI * 2, e = Math.sqrt(Math.random()) * err;
    const tv = this.aimV + Math.cos(a) * e, ty = Math.max(0.11, this.aimY + Math.sin(a) * e * 0.7 + Math.max(0, pw - 0.86) * 5);
    const speed = 14 + 17 * pw, dist = this.hl - this.spotU;
    this.shot = { tv, ty, T: dist / speed, arc: 0.9 * (1 - pw) + 0.15, speed };
    this.phase = 'flight'; this.t = 0;
    // the keeper guesses: reads the shot ~40% of the time, otherwise picks a side
    const read = Math.random() < 0.4 + 0.25 * (1 - pw);
    const guessV = read ? tv + (Math.random() - 0.5) * 0.8 : [-1, 0, 1][Math.floor(Math.random() * 3)] * p.gw * (0.25 + Math.random() * 0.2);
    const guessY = read ? ty : 0.5 + Math.random() * 0.9;
    this.dive = { v: THREE.MathUtils.clamp(guessV, -p.gw / 2 - 0.3, p.gw / 2 + 0.3), y: Math.min(guessY, p.gh + 0.2), delay: 0.06 + Math.random() * 0.12 };
  }
  placeKeeper() {
    const p = this.p, k = this.keeper;
    k.position.copy(this.W(this.hl - 0.35, this.kV, this.kLift));
    // model's z axis = across the goal (v), x axis = along the pitch; roll about x leans the keeper towards +v
    k.rotation.set(0, Math.atan2(-p.uz, p.ux), 0);
    k.rotateX(this.kRoll);
    const [l, r] = k.userData.arms;
    const up = this.phase === 'flight' || this.phase === 'result' ? 1 : 0;
    l.rotation.x = THREE.MathUtils.lerp(0.5, 2.6, up); r.rotation.x = THREE.MathUtils.lerp(-0.5, -2.6, up);
  }
  /** returns true while the game wants the frame */
  update(dt) {
    const p = this.p;
    this.t += dt;
    if (this.charging) { this.power += this.dir * dt / 0.95; if (this.power > 1) { this.power = 1; this.dir = -1; } if (this.power < 0) { this.power = 0; this.dir = 1; } }
    this.hud.querySelector('.pk-power i').style.width = (this.power * 100).toFixed(0) + '%';
    this.hud.querySelector('.pk-power').style.opacity = this.phase === 'aim' ? 1 : 0.3;
    // keeper idle sway / dive
    if (this.phase === 'aim') { this.kV = Math.sin(this.t * 2.1) * 0.35; this.kRoll = 0; this.kLift = 0; }
    else if (this.dive && this.phase === 'flight') {
      const k = THREE.MathUtils.clamp((this.t - this.dive.delay) / 0.45, 0, 1), e = 1 - (1 - k) ** 2;
      const reach = THREE.MathUtils.clamp(this.dive.v, -3.2, 3.2);
      const lean = Math.abs(reach) > 0.9 ? Math.sign(reach) * Math.min(1.35, 0.45 + Math.abs(reach) * 0.33) : 0;
      this.kV = THREE.MathUtils.lerp(this.kV, reach - Math.sin(lean) * 0.9, e * 0.35);
      this.kRoll = lean * e;
      this.kLift = Math.max(0, this.dive.y - 1.2) * 0.6 * Math.sin(Math.PI * Math.min(1, k * 1.2));
    }
    this.placeKeeper();
    // reticle
    this.reticle.visible = this.phase === 'aim';
    this.reticle.position.copy(this.W(this.hl - 0.02, this.aimV, this.aimY));
    this.reticle.lookAt(this.W(this.hl - 5, this.aimV, this.aimY));
    // ball flight
    if (this.phase === 'flight') {
      const s = this.t / this.shot.T, sh = this.shot;
      const u = THREE.MathUtils.lerp(this.spotU, this.hl, s), v = sh.tv * s, y = 0.11 + (sh.ty - 0.11) * s + sh.arc * 4 * s * (1 - s);
      this.ball.position.copy(this.W(u, v, y));
      this.ball.rotateZ(-sh.speed * dt / 0.11 * 0.3);
      if (s >= 1) this.judge();
    } else if (this.phase === 'result') {
      const b = this.after;
      b.vel.y -= 9.81 * dt;
      b.pos.addScaledVector(b.vel, dt);
      if (b.pos.y < 0.11) { b.pos.y = 0.11; b.vel.y *= -0.45; b.vel.x *= 0.8; b.vel.z *= 0.8; }
      if (b.net && b.pos.x > this.hl + 1.6) { b.pos.x = this.hl + 1.6; b.vel.x *= -0.15; }
      this.ball.position.copy(this.W(b.pos.x, b.pos.z, b.pos.y));
      if (this.t > 2.1) {
        if (this.shots.length >= 5) {
          const g = this.shots.filter(Boolean).length;
          this.phase = 'over';
          this.msg(`${g} / 5 — ${['Keeper wins!', 'Tough day.', 'Not bad.', 'Good finishing!', 'Great penalties!', 'Perfect! 5 out of 5!'][g]}  Click or press R to play again`, 'end');
        } else this.newShot();
      }
    }
    // camera behind the ball
    const camU = this.phase === 'flight' || this.phase === 'result' ? this.spotU - 4.2 : this.spotU - 5.2;
    const want = this.W(camU, 0, 1.75);
    this.camera.position.lerp(want, 1 - Math.exp(-6 * dt));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.W(this.hl, 0, p.gh * 0.45));
  }
  judge() {
    const p = this.p, sh = this.shot, r = 0.11, hw = p.gw / 2;
    // keeper body as a segment from feet to hands in the goal plane
    const lean = this.kRoll, baseV = this.kV, baseY = this.kLift + 0.1, len = 2.25 + 0.2;
    const tipV = baseV + Math.sin(lean) * len, tipY = baseY + Math.cos(lean) * len;
    const sx = tipV - baseV, sy = tipY - baseY, t = THREE.MathUtils.clamp(((sh.tv - baseV) * sx + (sh.ty - baseY) * sy) / (sx * sx + sy * sy), 0, 1);
    const dk = Math.hypot(sh.tv - (baseV + sx * t), sh.ty - (baseY + sy * t));
    const inside = Math.abs(sh.tv) < hw - r && sh.ty < p.gh - r;
    const post = Math.abs(Math.abs(sh.tv) - hw) < r + 0.06 && sh.ty < p.gh + 0.06;
    const bar = Math.abs(sh.ty - p.gh) < r + 0.06 && Math.abs(sh.tv) < hw + 0.06;
    const vel = new THREE.Vector3(sh.speed, (sh.ty - 0.11) / sh.T * 0.3, sh.tv / sh.T);
    let res, cls, net = false;
    if (inside && dk < 0.42) { res = 'SAVED!'; cls = 'save'; vel.set(-sh.speed * 0.25, 2.5, (Math.random() - 0.5) * 5); }
    else if (post || bar) { res = post ? 'Off the post!' : 'Off the bar!'; cls = 'miss'; vel.set(-sh.speed * 0.3, bar ? 3 : 1.5, (post ? -Math.sign(sh.tv) : 0) * 4); }
    else if (inside) { res = 'GOAL!'; cls = 'goal'; net = true; vel.multiplyScalar(0.55); }
    else { res = sh.ty > p.gh ? 'Over the bar!' : 'Wide!'; cls = 'miss'; }
    this.shots.push(cls === 'goal');
    this.after = { pos: new THREE.Vector3(this.hl, sh.ty, sh.tv), vel, net };
    this.phase = 'result'; this.t = 0;
    this.msg(res, cls);
    this.drawDots();
  }
}
