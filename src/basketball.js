// Basketball: an outdoor court near Wundtstraße (placed on the nearest free, flat spot) and a shooting game.
// 10 shots from spots around the arc, 2 or 3 points each and a 5-point logo shot at the end. Move the mouse to aim,
// hold the button (or Space) and let go in the green part of the power bar. The ball bounces off the rim,
// the backboard and the ground for real, so you get swishes, rattles and bank shots.
import * as THREE from 'three';

const RIM_H = 3.05, RIM_R = 0.23, BALL_R = 0.12, BOARD_U = 1.2, RIM_U = BOARD_U + 0.15 + RIM_R; // from the baseline
const L = 28, Wd = 15, G = 9.81, H = 1 / 360; // fixed physics step: the live shot and the green-zone simulation behave the same
const SPOTS = [ // [distance from the rim (m), angle (deg, 0 = straight on), points, name]
  [4.6, 0, 2, 'Free throw'], [5.2, -35, 2, 'Left elbow'], [5.2, 35, 2, 'Right elbow'], [7.2, -45, 3, 'Left wing three'], [7.2, 45, 3, 'Right wing three'],
  [7.3, 0, 3, 'Top of the key'], [6.8, -86, 3, 'Left corner three'], [6.8, 86, 3, 'Right corner three'], [2.6, 25, 2, 'Close shot'], [12.4, 0, 5, 'LOGO SHOT'],
];
const BEST_KEY = 'raumfinder-hoops-best';

/** find a free flat spot near (x, z) for a 28 x 15 m court, clear trees off it, build the court; returns its frame */
export function buildCourt(scene, world, near) {
  const fits = (cx, cz, ux, uz) => {
    for (let a = -L / 2 - 1; a <= L / 2 + 1; a += 2) for (let b = -Wd / 2 - 1; b <= Wd / 2 + 1; b += 2) {
      const x = cx + ux * a - uz * b, z = cz + uz * a + ux * b;
      if (world.solidAt(x, z) || world.roadInside(x, z, true) > -0.5 || world.riverAt(x, z) > 0.15 || world.groundY(x, z) < -0.6) return false;
    }
    return true;
  };
  const road = world.nearestRoad(near[0], near[1], 7), ang0 = road ? Math.atan2(road.dz, road.dx) : 0;
  let best = null;
  for (let r = 0; r <= 220 && !best; r += 4) for (let k = 0; k < Math.max(1, Math.round(r * 0.8)) && !best; k++) {
    const t = (k / Math.max(1, Math.round(r * 0.8))) * Math.PI * 2, cx = near[0] + Math.cos(t) * r, cz = near[1] + Math.sin(t) * r;
    for (const a of [ang0, ang0 + Math.PI / 2, 0, Math.PI / 2]) { const ux = Math.cos(a), uz = Math.sin(a); if (fits(cx, cz, ux, uz)) { best = { cx, cz, ux, uz }; break; } }
  }
  if (!best) best = { cx: near[0], cz: near[1], ux: 1, uz: 0 };
  const c = best, y0 = Math.max(0.12, world.groundY(c.cx, c.cz) + 0.12);
  c.y = y0;
  c.W = (u, v, y) => new THREE.Vector3(c.cx + c.ux * u - c.uz * v, y0 + y, c.cz + c.uz * u + c.ux * v);
  // clear the trees standing on the court (and drop them from the leaf system)
  for (const im of world.treeGroup.children) {
    let dirty = false;
    im.userData.list.forEach((t, i) => {
      const dx = t[0] - c.cx, dz = t[1] - c.cz, u = dx * c.ux + dz * c.uz, v = -dx * c.uz + dz * c.ux;
      if (Math.abs(u) < L / 2 + 3 && Math.abs(v) < Wd / 2 + 3) { im.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); t[0] = NaN; dirty = true; }
    });
    if (dirty) im.instanceMatrix.needsUpdate = true;
  }
  const g = new THREE.Group(); scene.add(g); c.group = g;
  // surface with painted lines
  const cv = document.createElement('canvas'), S = 40; cv.width = (L + 2) * S; cv.height = (Wd + 2) * S;
  const x = cv.getContext('2d'), P = (u) => (u + L / 2 + 1) * S, Q = (v) => (v + Wd / 2 + 1) * S;
  x.fillStyle = '#1c1d20'; x.fillRect(0, 0, cv.width, cv.height);
  x.fillStyle = '#26282c'; x.fillRect(P(-L / 2), Q(-Wd / 2), L * S, Wd * S);
  x.strokeStyle = '#FFD400'; x.lineWidth = 0.05 * S;
  x.strokeRect(P(-L / 2), Q(-Wd / 2), L * S, Wd * S);
  x.beginPath(); x.moveTo(P(0), Q(-Wd / 2)); x.lineTo(P(0), Q(Wd / 2)); x.stroke();
  x.beginPath(); x.arc(P(0), Q(0), 1.8 * S, 0, Math.PI * 2); x.stroke();
  for (const s of [-1, 1]) {
    const base = s * L / 2, hu = s * (L / 2 - RIM_U);
    x.fillStyle = 'rgba(255,212,0,0.18)'; x.fillRect(Math.min(P(base), P(base - s * 5.8)), Q(-2.45), 5.8 * S, 4.9 * S);
    x.strokeRect(Math.min(P(base), P(base - s * 5.8)), Q(-2.45), 5.8 * S, 4.9 * S);
    x.beginPath(); x.arc(P(base - s * 5.8), Q(0), 1.8 * S, 0, Math.PI * 2); x.stroke();
    // three-point line: straight in the corners, arc of 6.75 m around the rim
    const a = Math.asin(6.6 / 6.75), du = Math.cos(a) * 6.75;
    x.beginPath(); x.moveTo(P(base), Q(-6.6)); x.lineTo(P(hu - s * du), Q(-6.6));
    if (s < 0) x.arc(P(hu), Q(0), 6.75 * S, -a, a, false); else x.arc(P(hu), Q(0), 6.75 * S, Math.PI + a, Math.PI - a, true);
    x.lineTo(P(base), Q(6.6)); x.stroke();
  }
  x.fillStyle = '#FFD400'; x.font = `${2.2 * S}px VT323, monospace`; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.save(); x.translate(P(0), Q(0)); x.rotate(-Math.PI / 2); x.globalAlpha = 0.85; x.fillText('RAUMFINDER', 0, -0.2 * S); x.restore();
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const surf = new THREE.Mesh(new THREE.PlaneGeometry(L + 2, Wd + 2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2 }));
  surf.position.copy(c.W(0, 0, 0)); surf.rotation.y = -Math.atan2(c.uz, c.ux); surf.receiveShadow = true; surf.userData.court = true;
  g.add(surf); c.surface = surf;
  // hoops at both ends: pole, arm, glass board with a yellow/black frame, orange rim, white net
  const pole = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.5, metalness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: '#dfe9ef', roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
  const frame = new THREE.MeshStandardMaterial({ color: '#FFD400', roughness: 0.4 }), rimM = new THREE.MeshStandardMaterial({ color: '#e25a12', roughness: 0.35, metalness: 0.6 });
  const netM = new THREE.LineBasicMaterial({ color: '#f2f2f2', transparent: true, opacity: 0.85 });
  c.hoops = [];
  for (const s of [1, -1]) {
    const h = new THREE.Group(); g.add(h);
    const at = (u, v, y) => c.W(s * (L / 2 - u), v, y);
    const addBox = (m, sx, sy, sz, u, v, y) => { const o = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); o.position.copy(at(u, v, y)); o.rotation.y = -Math.atan2(c.uz, c.ux); o.castShadow = true; h.add(o); return o; };
    addBox(pole, 0.16, 3.5, 0.16, -0.4, 0, 1.75); addBox(pole, 1.6, 0.12, 0.12, 0.4, 0, 3.4);
    addBox(glass, 0.03, 1.05, 1.8, BOARD_U, 0, 3.45);
    addBox(frame, 0.05, 0.06, 1.86, BOARD_U, 0, 3.95); addBox(frame, 0.05, 0.06, 1.86, BOARD_U, 0, 2.95);
    addBox(frame, 0.05, 1.05, 0.06, BOARD_U, 0.9, 3.45); addBox(frame, 0.05, 1.05, 0.06, BOARD_U, -0.9, 3.45);
    addBox(frame, 0.05, 0.45, 0.04, BOARD_U - 0.01, 0.29, 3.27); addBox(frame, 0.05, 0.45, 0.04, BOARD_U - 0.01, -0.29, 3.27); addBox(frame, 0.05, 0.04, 0.6, BOARD_U - 0.01, 0, 3.48);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(RIM_R, 0.012, 8, 32).rotateX(Math.PI / 2), rimM); rim.position.copy(at(RIM_U, 0, RIM_H)); h.add(rim);
    const np = []; // net: 12 strings tapering down
    for (let k = 0; k < 12; k++) { const t = (k / 12) * Math.PI * 2; const a = at(RIM_U, 0, RIM_H); np.push(a.x + Math.cos(t) * RIM_R, a.y, a.z + Math.sin(t) * RIM_R, a.x + Math.cos(t + 0.5) * RIM_R * 0.6, a.y - 0.42, a.z + Math.sin(t + 0.5) * RIM_R * 0.6); }
    const ng = new THREE.BufferGeometry(); ng.setAttribute('position', new THREE.Float32BufferAttribute(np, 3)); h.add(new THREE.LineSegments(ng, netM));
    c.hoops.push({ s, rim: at(RIM_U, 0, RIM_H), boardU: BOARD_U, net: { geo: ng, rest: Float32Array.from(np) } });
  }
  // floodlights on four masts: switch on at dusk and light the court
  const lampMat = new THREE.MeshStandardMaterial({ color: '#fffbe8', emissive: '#fff3c4', emissiveIntensity: 0.2 });
  for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const mu = su * (L / 2 - 3), mv = sv * (Wd / 2 + 1.6), base = c.W(mu, mv, 0), H8 = 8.5;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, H8, 8), pole); mast.position.copy(base).add(new THREE.Vector3(0, H8 / 2, 0)); mast.castShadow = true; g.add(mast);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.5), lampMat); head.position.copy(c.W(mu, mv - sv * 0.45, H8)); head.lookAt(c.W(mu * 0.4, 0, 0)); g.add(head);
  }
  const surfMat = surf.material;
  c.setNight = (n) => { lampMat.emissiveIntensity = 0.2 + n * 6; surfMat.emissive.set('#fff4d6'); surfMat.emissiveIntensity = n * 0.16; };
  return c;
}

export class Hoops {
  constructor(scene, camera, canvas, court, sound) {
    this.camera = camera; this.canvas = canvas; this.c = court; this.sound = sound;
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const x = cv.getContext('2d'); x.fillStyle = '#e06a1c'; x.fillRect(0, 0, 128, 64); x.strokeStyle = '#1a1009'; x.lineWidth = 2.5;
    x.beginPath(); x.moveTo(0, 32); x.lineTo(128, 32); x.moveTo(32, 0); x.lineTo(32, 64); x.moveTo(96, 0); x.lineTo(96, 64); x.stroke();
    x.beginPath(); x.ellipse(64, 32, 22, 32, 0, 0, Math.PI * 2); x.stroke();
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 }));
    this.ball.castShadow = true; this.ball.visible = false; scene.add(this.ball);
    // aim line on the floor
    this.guide = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 3).rotateX(-Math.PI / 2).translate(0, 0, -1.5), new THREE.MeshBasicMaterial({ color: '#FFD400', transparent: true, opacity: 0.7 }));
    this.guide.visible = false; scene.add(this.guide);
    this.hud = document.createElement('div'); this.hud.id = 'hp';
    this.hud.innerHTML = `<div class="hp-top"><b class="hp-title">Basketball · Wundtstraße</b><span class="hp-shot"></span><span class="hp-pts"></span><span class="hp-fire"></span><span class="hp-best"></span></div><div class="hp-clock"></div><div class="hp-spot"></div><div class="hp-msg"></div><div class="hp-power"><u></u><i></i></div><div class="hp-help">Move the mouse to aim · hold the mouse button or <kbd>Space</kbd>, let go in the green zone · <kbd>R</kbd> restart · <kbd>Esc</kbd> exit</div>`;
    document.body.appendChild(this.hud);
    this.q = (s) => this.hud.querySelector(s);
    try { this.best = +localStorage.getItem(BEST_KEY) || 0; } catch { this.best = 0; }
    this.hoop = court.hoops[0];
    // ball trail (white, or flames when on fire)
    this.NT = 22; this.trailPts = [];
    this.trailMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
    this.trail = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL_R, 10, 8), this.trailMat, this.NT); this.trail.frustumCulled = false; this.trail.visible = false; scene.add(this.trail);
    this.M = new THREE.Matrix4(); this.Q = new THREE.Quaternion(); this.S = new THREE.Vector3(); this.V = new THREE.Vector3();
    // hands holding the ball (forearms with yellow wristbands)
    const skin = new THREE.MeshStandardMaterial({ color: '#e0b08a', roughness: 0.8 }), band = new THREE.MeshStandardMaterial({ color: '#FFD400', roughness: 0.6 });
    this.hands = new THREE.Group(); this.hands.visible = false; scene.add(this.hands);
    this.arms = [-1, 1].map((sd) => {
      const a = new THREE.Group(); this.hands.add(a);
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.26).translate(0, 0, 0.13), skin); a.add(fore);
      const wrist = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.05).translate(0, 0, 0.05), band); a.add(wrist);
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.025, 0.09).translate(0, 0, -0.03), skin); a.add(palm);
      a.userData.side = sd; return a;
    });
    this.streak = 0; this.onFire = false; this.bestStreak = 0; this.netKick = 0; this.netAge = 9;
  }
  /** court frame relative to the hoop we shoot at: d = distance from the rim, a = angle */
  spotPos(d, adeg) {
    const a = (adeg * Math.PI) / 180, s = this.hoop.s, c = this.c, uRim = s * (L / 2 - RIM_U);
    return c.W(uRim - s * Math.cos(a) * d, Math.sin(a) * d, 0);
  }
  start() { this.ball.visible = true; this.hud.style.display = 'block'; this.reset(); }
  exit() { this.ball.visible = false; this.guide.visible = false; this.trail.visible = false; this.hands.visible = false; this.hud.style.display = 'none'; }
  reset() { this.i = 0; this.points = 0; this.made = 0; this.streak = 0; this.bestStreak = 0; this.setFire(false); this.newShot(); }
  setFire(on) { this.onFire = on; this.ball.material.emissive.set(on ? '#ff5a00' : '#000000'); this.trailMat.color.set(on ? '#ff7a18' : '#ffffff'); this.trailMat.opacity = on ? 0.75 : 0.35; this.q('.hp-fire').textContent = on ? 'ON FIRE +1' : this.streak >= 2 ? 'streak ' + this.streak : ''; }
  newShot() {
    const [d, a, pts, name] = SPOTS[this.i];
    this.spot = this.spotPos(d, a); this.pts = pts;
    const rim = this.hoop.rim, toRim = new THREE.Vector3(rim.x - this.spot.x, 0, rim.z - this.spot.z).normalize();
    this.dirBase = Math.atan2(toRim.x, toRim.z); this.aim = 0; this.power = 0; this.charging = false; this.phase = 'aim'; this.t = 0;
    this.clock = 10; this.sweep = Math.max(0.55, 0.85 - this.i * 0.03); this.trailPts = []; this.trail.visible = false; this.hands.visible = true; this.relT = -1;
    this.release0 = this.spot.clone().add(toRim.clone().multiplyScalar(0.35)); this.release0.y += 2.15;
    this.ball.position.copy(this.release0).add(new THREE.Vector3(0, -0.35, 0));
    // timing sensitivity: harder the further you are. The green zone is found by playing the shot out at every
    // power with the real physics, so it shows exactly where a straight shot goes in
    this.tol = Math.max(0.05, 0.13 - d * 0.006);
    const N = 40, ok = []; for (let k = 0; k <= N; k++) ok.push(this.simulate(k / N));
    let lo = -1, bl = -1, bh = -1;
    for (let k = 0; k <= N; k++) {
      if (ok[k] && lo < 0) lo = k;
      if ((!ok[k] || k === N) && lo >= 0) { const e = ok[k] ? k : k - 1; if (e - lo > bh - bl) { bl = lo; bh = e; } lo = -1; }
    }
    let zl = 0.45, zh = 0.55;
    if (bl >= 0) {
      // sharpen both edges to ~0.5% by bisection
      const edge = (inP, outP) => { for (let it = 0; it < 4; it++) { const m = (inP + outP) / 2; if (this.simulate(m)) inP = m; else outP = m; } return inP; };
      zl = bl > 0 ? edge(bl / N, (bl - 1) / N) : 0; zh = bh < N ? edge(bh / N, (bh + 1) / N) : 1;
    }
    if (zh - zl > 0.04) { zl += 0.01; zh -= 0.01; } // show it a hair inside the true edges
    this.zone = [zl, zh];
    this.q('.hp-power').classList.toggle('fire', this.onFire);
    this.q('.hp-power u').style.left = (zl * 100).toFixed(1) + '%'; this.q('.hp-power u').style.width = Math.max(1, (zh - zl) * 100).toFixed(1) + '%';
    this.q('.hp-spot').textContent = `${name} · ${pts} point${pts > 1 ? 's' : ''}`;
    this.msg(''); this.drawTop();
  }
  drawTop() {
    this.q('.hp-shot').textContent = `SHOT ${Math.min(this.i + 1, SPOTS.length)}/${SPOTS.length}`;
    this.q('.hp-pts').textContent = `${this.points} PTS`;
    this.q('.hp-best').textContent = this.best ? `best ${this.best}` : '';
  }
  msg(t, cls = '') { const m = this.q('.hp-msg'); m.innerHTML = t; m.className = 'hp-msg ' + cls; }
  aimAt(cx) { if (this.phase !== 'aim') return; const r = this.canvas.getBoundingClientRect(); this.aim = THREE.MathUtils.clamp(((cx - r.left) / r.width - 0.5) * -0.5, -0.25, 0.25); }
  nudge(d) { if (this.phase === 'aim') this.aim = THREE.MathUtils.clamp(this.aim + d, -0.25, 0.25); }
  press() { if (this.phase === 'aim') { this.charging = true; this.power = 0; this.dir = 1; } else if (this.phase === 'over') this.reset(); }
  /** launch velocity for a given power (0..1) and aim: the arc for this distance, faster or slower by the timing */
  launch(power, aim) {
    const rim = this.hoop.rim, p0 = this.release0, dir = this.dirBase + aim, d0 = SPOTS[this.i][0];
    const th = ((d0 < 3.5 ? 62 : d0 < 6 ? 55 : 50) * Math.PI) / 180; // steeper arc up close so the ball drops in over the front rim
    const dx = Math.hypot(rim.x - p0.x, rim.z - p0.z) + 0.05, dh = rim.y - p0.y; // aim a touch long: short shots clip the front rim
    const vIdeal = Math.sqrt((G * dx * dx) / (2 * Math.cos(th) ** 2 * Math.max(0.1, dx * Math.tan(th) - dh)));
    // range grows with v^2, so a speed error e moves the landing point by ~2*e*dx: scale so the green zone = in the basket
    const K = 0.11 / (2 * this.tol * dx), v = vIdeal * (1 + (power - 0.5) * K);
    return new THREE.Vector3(Math.sin(dir) * Math.cos(th) * v, Math.sin(th) * v, Math.cos(dir) * Math.cos(th) * v);
  }
  release() {
    if (this.phase !== 'aim' || !this.charging) return;
    this.charging = false;
    this.vel = this.launch(this.power, this.aim);
    this.ball.position.copy(this.release0); this.phase = 'flight'; this.t = 0; this.acc = 0; this.relT = 0;
    this.st = { scored: false, touched: false, prevY: this.release0.y, live: true };
    this.sound.beep(180, 0.08, 'sine', 0.12); this.trailPts = []; this.trail.visible = true;
  }
  /** one physics sub-step: gravity, move, bounce; returns true the moment the ball drops through the rim */
  step(b, v, h, st) {
    const rim = this.hoop.rim;
    v.y -= G * h; b.addScaledVector(v, h); this.collide(b, v, st);
    const made = !st.scored && st.prevY >= rim.y && b.y < rim.y && v.y < 0 && Math.hypot(b.x - rim.x, b.z - rim.z) < RIM_R - BALL_R * 0.35;
    if (made) st.scored = true;
    st.prevY = b.y;
    return made;
  }
  /** play a shot out without drawing it: does this power (straight aim) score? */
  simulate(power) {
    const b = this.release0.clone(), v = this.launch(power, 0), st = { scored: false, touched: false, prevY: b.y, live: false }, h = H, rim = this.hoop.rim;
    let above = false;
    for (let k = 0; k < 360 * 4; k++) {
      this.step(b, v, h, st);
      if (st.scored) return true;
      if (b.y > rim.y) above = true; else if (above && v.y < 0 && b.y < rim.y - 0.35) return false;
    }
    return false;
  }
  collide(b, v, st) {
    const rim = this.hoop.rim, c = this.c, s = this.hoop.s;
    // rim: a ring of points (only looked at when the ball is near it)
    const nearRim = Math.abs(b.y - rim.y) < 0.2 && Math.abs(Math.hypot(b.x - rim.x, b.z - rim.z) - RIM_R) < BALL_R + 0.05;
    if (nearRim) for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2, px = rim.x + Math.cos(a) * RIM_R, pz = rim.z + Math.sin(a) * RIM_R;
      const dx = b.x - px, dy = b.y - rim.y, dz = b.z - pz, d = Math.hypot(dx, dy, dz), md = BALL_R + 0.012;
      if (d < md && d > 1e-4) {
        const nx = dx / d, ny = dy / d, nz = dz / d, vn = v.x * nx + v.y * ny + v.z * nz;
        b.x += nx * (md - d); b.y += ny * (md - d); b.z += nz * (md - d);
        if (vn < 0) { v.x -= 1.4 * vn * nx; v.y -= 1.4 * vn * ny; v.z -= 1.4 * vn * nz; }
        // touching the rim from the inside: the rim and net steer it down into the basket
        const hx = b.x - rim.x, hz = b.z - rim.z, hd = Math.hypot(hx, hz);
        if (hd < RIM_R && v.y < 1) { v.x -= (hx / (hd || 1)) * 0.9; v.z -= (hz / (hd || 1)) * 0.9; v.y = Math.min(v.y, -0.3); }
        if (!st.touched && st.live) { this.sound.beep(320 + Math.random() * 60, 0.06, 'square', 0.05); this.netKick = Math.max(this.netKick, 0.35); this.netAge = 0; }
        st.touched = true;
      }
    }
    // backboard: plane at the board's u, 1.8 wide, 2.92-3.98 high
    const uBoard = s * (L / 2 - BOARD_U), du = (b.x - c.cx) * c.ux + (b.z - c.cz) * c.uz - uBoard, dv = -(b.x - c.cx) * c.uz + (b.z - c.cz) * c.ux, h = b.y - c.y;
    if (Math.abs(du) < BALL_R && Math.abs(dv) < 0.9 && h > 2.92 && h < 3.98) {
      const n = new THREE.Vector3(-s * c.ux, 0, -s * c.uz), vn = v.dot(n);
      if (vn < 0) { v.addScaledVector(n, -1.6 * vn); if (st.live) this.sound.beep(140, 0.07, 'triangle', 0.1); st.touched = true; }
      b.addScaledVector(n, BALL_R - Math.abs(du));
    }
    // ground
    if (b.y < c.y + BALL_R) { b.y = c.y + BALL_R; if (v.y < -0.8 && st.live) this.sound.beep(90, 0.06, 'sine', 0.12); v.y = Math.abs(v.y) > 0.6 ? -v.y * 0.62 : 0; v.x *= 0.9; v.z *= 0.9; }
  }
  /** the shot clock ran out: count it as a miss */
  violation() {
    this.charging = false; this.phase = 'result'; this.t = 0; this.acc = 0;
    this.vel = new THREE.Vector3(0, 1.5, 0); this.st = { scored: false, touched: false, prevY: this.ball.position.y, live: true };
    this.msg('SHOT CLOCK!', 'bad'); this.sound.buzzer && this.sound.buzzer();
    this.streak = 0; this.setFire(false); this.hands.visible = false;
  }
  update(dt, night = 0) {
    this.t += dt;
    if (this.phase === 'aim') { this.clock -= dt; if (this.clock <= 0) this.violation(); }
    const ck = this.q('.hp-clock'); ck.textContent = this.phase === 'aim' ? Math.ceil(Math.max(0, this.clock)) : ''; ck.classList.toggle('low', this.phase === 'aim' && this.clock < 3.5);
    if (this.charging) { this.power += this.dir * dt / this.sweep; if (this.power > 1) { this.power = 1; this.dir = -1; } if (this.power < 0) { this.power = 0; this.dir = 1; } }
    this.q('.hp-power i').style.left = (this.power * 100).toFixed(1) + '%';
    this.q('.hp-power').style.opacity = this.phase === 'aim' ? 1 : 0.35;
    const rim = this.hoop.rim;
    if (this.phase === 'aim') {
      // ball held up, bobbing a little; floor line shows where you aim
      const dir = this.dirBase + this.aim;
      this.ball.position.copy(this.release0).add(new THREE.Vector3(0, -0.4 - Math.sin(this.t * 3) * 0.03 + (this.charging ? 0.25 * this.power : 0), 0));
      this.guide.visible = true; this.guide.position.set(this.spot.x, this.c.y + 0.01, this.spot.z); this.guide.rotation.y = dir + Math.PI;
    } else this.guide.visible = false;
    if (this.phase === 'flight' || this.phase === 'result') {
      this.acc += dt; let guard = 0;
      while (this.acc >= H && guard++ < 60) {
        this.acc -= H; const h = H;
        // a basket: the ball drops down through the rim, close to its centre
        if (this.step(this.ball.position, this.vel, h, this.st)) {
          const bonus = this.onFire ? 1 : 0, got = this.pts + bonus;
          this.points += got; this.made++; this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak);
          const lit = !this.onFire && this.streak >= 3;
          if (lit || this.onFire) this.setFire(true); else this.setFire(false);
          const word = this.st.touched ? (this.pts >= 3 ? 'BUCKET!' : 'IN!') : 'SWISH!';
          this.msg(`+${got} &nbsp;${word}${lit ? '<small>ON FIRE! +1 per basket</small>' : bonus ? '<small>on fire bonus +1</small>' : ''}`, 'good');
          this.sound.beep(660, 0.12, 'square', 0.07); this.sound.beep(990, 0.18, 'square', 0.07, 0.1);
          if (!this.st.touched && this.sound.swish) this.sound.swish();
          if ((this.pts >= 3 || lit || this.onFire) && this.sound.cheer) this.sound.cheer(this.pts >= 5 || lit);
          this.netKick = 1; this.netAge = 0;
          this.vel.multiplyScalar(0.35);
        }
      }
      this.ball.rotation.x += dt * 8;
      if (this.phase === 'flight' && this.t > 1.2 && !this.st.scored && (this.ball.position.y < rim.y - 0.6 || this.t > 3)) { this.msg(this.st.touched ? 'Rattled out!' : 'Miss!', 'bad'); this.phase = 'result'; this.streak = 0; this.setFire(false); }
      if (this.phase === 'flight' && this.st.scored) this.phase = 'result';
      if (this.phase === 'result' && this.t > 3.2) {
        this.i++;
        if (this.i >= SPOTS.length) {
          this.phase = 'over';
          const nb = this.points > this.best; if (nb) { this.best = this.points; try { localStorage.setItem(BEST_KEY, String(this.points)); } catch { /* private */ } }
          const rate = this.points >= 24 ? 'Hall of fame!' : this.points >= 17 ? 'All-star!' : this.points >= 10 ? 'Starting five.' : this.points >= 5 ? 'Bench warmer.' : 'Keep practising!';
          this.msg(`<em>${this.points} POINTS</em><small>${this.made}/10 made · best streak ${this.bestStreak} · ${rate}${nb ? ' · NEW BEST' : ''}</small><small>click or press R to play again</small>`, 'end');
          if (nb && this.sound.cheer) this.sound.cheer(true);
          this.drawTop();
        } else this.newShot();
      }
      this.drawTop();
    }
    // ball trail
    if (this.trail.visible) {
      if (this.phase === 'flight' || (this.phase === 'result' && this.t < 1.6)) { this.trailPts.unshift(this.ball.position.clone()); if (this.trailPts.length > this.NT) this.trailPts.length = this.NT; }
      else if (this.trailPts.length) this.trailPts.pop();
      for (let k = 0; k < this.NT; k++) {
        const p = this.trailPts[k], sc = p ? (1 - k / this.NT) * (this.onFire ? 1.15 + Math.random() * 0.3 : 0.85) : 0;
        this.trail.setMatrixAt(k, this.M.compose(p || this.V.set(0, -1e4, 0), this.Q.identity(), this.S.set(sc + 1e-4, sc + 1e-4, sc + 1e-4)));
      }
      this.trail.instanceMatrix.needsUpdate = true;
    }
    if (this.onFire) this.ball.material.emissiveIntensity = 0.6 + Math.sin(this.t * 14) * 0.25;
    // hands: hold the ball while aiming, flick through on release, then drop out of view
    const back = new THREE.Vector3(this.spot.x - rim.x, 0, this.spot.z - rim.z).normalize();
    if (this.hands.visible) {
      const yaw = Math.atan2(-back.x, -back.z), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const fl = this.relT >= 0 ? Math.min(1, (this.relT += dt) / 0.25) : 0;
      if (this.relT > 0.4) this.hands.visible = false;
      const bp = this.phase === 'aim' ? this.ball.position : this.release0;
      this.arms.forEach((a) => {
        const sd = a.userData.side;
        a.position.set(bp.x + rx * sd * 0.13 + back.x * 0.04, bp.y - 0.09 + fl * 0.12, bp.z + rz * sd * 0.13 + back.z * 0.04);
        a.rotation.set(0, 0, 0); a.rotation.y = yaw; a.rotateX(-0.95 - fl * 0.7); a.rotateY(-sd * 0.18);
      });
    }
    // net: whips down on a swish, wobbles on a rim hit
    const net = this.hoop.net;
    if (net && (this.netKick > 0.001 || this.netAge < 3)) {
      this.netAge += dt; const k = this.netKick * Math.exp(-this.netAge * 3.2), w = Math.sin(this.netAge * 20) * k, P = net.geo.attributes.position.array, R = net.rest;
      for (let i = 0; i < P.length; i += 6) {
        P[i] = R[i]; P[i + 1] = R[i + 1]; P[i + 2] = R[i + 2];
        P[i + 3] = rim.x + (R[i + 3] - rim.x) * (1 - 0.35 * Math.abs(w)); P[i + 4] = R[i + 4] - 0.16 * Math.abs(k) - 0.05 * w; P[i + 5] = rim.z + (R[i + 5] - rim.z) * (1 - 0.35 * Math.abs(w));
      }
      net.geo.attributes.position.needsUpdate = true;
      if (this.netAge > 3) this.netKick = 0;
    }
    // camera: behind the shooter, looking at the rim (and a little after the ball while it flies)
    const want = this.spot.clone().addScaledVector(back, 2.6); want.y = this.c.y + 2.3;
    this.camera.position.lerp(want, 1 - Math.exp(-5 * dt));
    this.camera.up.set(0, 1, 0);
    const follow = this.phase === 'flight' ? 0.3 : 0;
    this.look = (this.look || new THREE.Vector3(rim.x, rim.y - 0.3, rim.z)).lerp(this.V.set(rim.x + (this.ball.position.x - rim.x) * follow, rim.y - 0.3 + (this.ball.position.y - rim.y) * follow, rim.z + (this.ball.position.z - rim.z) * follow), 1 - Math.exp(-4 * dt));
    this.camera.lookAt(this.look);
  }
}
