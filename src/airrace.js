// Air race for the ultralight: fly through 10 checkpoint rings over Dresden landmarks, in order, as fast as you can
// (about 12 km, roughly 2.5-3.5 minutes). The next ring is striped black-and-yellow with a light beam, an arrow on
// the plane points the way, and the best time is remembered in this browser.
import * as THREE from 'three';

export const COURSE = [
  ['TU Hörsaalzentrum', 51.0293, 13.7302, 30],
  ['Hauptbahnhof', 51.0404, 13.7323, 45],
  ['Zwinger', 51.053, 13.7339, 38],
  ['Augustusbrücke', 51.0556, 13.7397, 30], // low over the Elbe
  ['Albertplatz', 51.0632, 13.7466, 40],
  ['Waldschlösschenbrücke', 51.0629, 13.7779, 30],
  ['Großer Garten', 51.0377, 13.763, 35],
  ['Gläserne Manufaktur', 51.0446, 13.7525, 30],
  ['Altmarkt', 51.0496, 13.7381, 42],
  ['Frauenkirche', 51.0519, 13.7416, 30], // finish
];
const RING_R = 20, PASS_R = 24, BEST_KEY = 'raumfinder-airrace-best';
const fmt = (s) => { const m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); };

function stripes() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 2;
  const x = c.getContext('2d'); x.fillStyle = '#FFD400'; x.fillRect(0, 0, 8, 2); x.fillStyle = '#111'; x.fillRect(8, 0, 8, 2);
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; t.repeat.set(18, 1);
  return t;
}

export class AirRace {
  /** project(lat, lon) -> [x, z]; ui: { panel, msg, btn } DOM elements; sound: { beep, bell } */
  constructor(scene, world, fly, project, ui, sound) {
    this.world = world; this.fly = fly; this.ui = ui; this.sound = sound; this.state = 'idle';
    // checkpoints: position, facing (average of the way in and the way out), clear of the buildings below
    const pts = COURSE.map(([name, la, lo, extra]) => { const [x, z] = project(la, lo); let h = 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) h = Math.max(h, world.heightAt(x + a * 40, z + b * 40)); return { name, x, z, y: Math.max(h + 22, world.groundY(x, z) + extra) }; });
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const ix = p.x - a.x, iz = p.z - a.z, ox = b.x - p.x, oz = b.z - p.z, il = Math.hypot(ix, iz) || 1, ol = Math.hypot(ox, oz) || 1;
      p.dx = ix / il + ox / ol; p.dz = iz / il + oz / ol; const l = Math.hypot(p.dx, p.dz) || 1; p.dx /= l; p.dz /= l;
      if (i === 0) { p.dx = ox / ol; p.dz = oz / ol; }
    });
    this.pts = pts;
    this.g = new THREE.Group(); this.g.visible = false; scene.add(this.g);
    const tex = stripes();
    this.matNext = new THREE.MeshBasicMaterial({ map: tex, fog: false });
    this.matLater = new THREE.MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.35, fog: false, depthWrite: false });
    this.matDone = new THREE.MeshBasicMaterial({ color: '#7dff9a', transparent: true, opacity: 0.0, fog: false, depthWrite: false });
    const ringGeo = new THREE.TorusGeometry(RING_R, 1.5, 10, 56);
    const beamGeo = new THREE.CylinderGeometry(1.1, 1.1, 1, 8, 1, true).translate(0, 0.5, 0);
    this.beamMat = new THREE.MeshBasicMaterial({ color: '#FFD400', transparent: true, opacity: 0.28, fog: false, depthWrite: false, blending: THREE.AdditiveBlending });
    this.rings = pts.map((p) => {
      const r = new THREE.Mesh(ringGeo, this.matLater); r.position.set(p.x, p.y, p.z); r.rotation.y = Math.atan2(p.dx, p.dz); r.renderOrder = 10;
      const beam = new THREE.Mesh(beamGeo, this.beamMat); beam.position.set(p.x, world.groundY(p.x, p.z), p.z); beam.scale.y = Math.max(1, p.y - RING_R - beam.position.y); beam.visible = false;
      this.g.add(r, beam); return { r, beam };
    });
    // finish flag colours on the last ring
    this.rings[this.rings.length - 1].r.scale.setScalar(1.15);
    // arrow above the plane pointing to the next ring
    const arrow = new THREE.Group();
    const am = new THREE.MeshBasicMaterial({ color: '#FFD400', fog: false });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.6, 12).rotateX(Math.PI / 2).translate(0, 0, 0.8), am); arrow.add(cone);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.4, 8).rotateX(Math.PI / 2).translate(0, 0, -0.6), am); arrow.add(shaft);
    arrow.visible = false; scene.add(arrow); this.arrow = arrow;
    // ring burst when passing
    this.burst = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.burst.visible = false; scene.add(this.burst);
    this.prev = new THREE.Vector3(); this.V = new THREE.Vector3();
    try { this.best = +localStorage.getItem(BEST_KEY) || 0; } catch { this.best = 0; }
  }
  get active() { return this.state === 'count' || this.state === 'race'; }
  toggle() { if (this.active) this.stop(); else this.start(); }
  start() {
    // line up 650 m before the first ring, facing it, at its height
    const p = this.pts[0], f = this.fly;
    const sx = p.x - p.dx * 650, sz = p.z - p.dz * 650, yaw = Math.atan2(-p.dx, -p.dz); // the plane flies along (-sin yaw, -cos yaw)
    f.enter(sx, sz, yaw);
    f.pos.set(sx, Math.max(p.y, f.safeHeight(sx, sz) - 15), sz); f.yaw = yaw; f.pitch = 0; f.roll = 0; f.speed = 45; f.hist = []; f.snap = true; f.retryT = 3;
    this.next = 0; this.t = 0; this.cd = 3.2; this.splits = []; this.state = 'count'; this.g.visible = true; this.arrow.visible = true;
    this.prev.copy(f.pos); this.paint();
    this.ui.btn.style.display = 'none'; this.ui.panel.style.display = 'block';
    this.say('3', 'count');
  }
  stop() {
    this.state = 'idle'; this.g.visible = false; this.arrow.visible = false; this.burst.visible = false;
    this.ui.panel.style.display = 'none'; this.ui.msg.className = ''; this.ui.btn.style.display = '';
  }
  hide() { if (this.active || this.state === 'done') this.stop(); this.ui.btn.style.display = 'none'; }
  say(text, cls, ms = 0) {
    const m = this.ui.msg; m.innerHTML = text; m.className = 'show ' + cls;
    clearTimeout(this.sayT); if (ms) this.sayT = setTimeout(() => { if (m.innerHTML === text) m.className = ''; }, ms);
  }
  paint() {
    this.rings.forEach(({ r, beam }, i) => {
      r.material = i === this.next ? this.matNext : i < this.next ? this.matDone : this.matLater;
      r.visible = i >= this.next && i <= this.next + 2;
      beam.visible = i === this.next;
    });
  }
  update(dt) {
    if (this.state === 'idle') return;
    const f = this.fly;
    // ring + burst animation
    const nr = this.rings[Math.min(this.next, this.rings.length - 1)].r, pulse = 1 + Math.sin(performance.now() / 180) * 0.04;
    nr.scale.setScalar((this.next === this.rings.length - 1 ? 1.15 : 1) * pulse);
    if (this.burst.visible) { this.burst.scale.multiplyScalar(1 + dt * 2.4); this.burst.material.opacity = Math.max(0, this.burst.material.opacity - dt * 1.6); if (this.burst.material.opacity <= 0) this.burst.visible = false; }
    if (this.state === 'done') { this.arrow.visible = false; return; }
    if (this.state === 'count') {
      const before = Math.ceil(this.cd); this.cd -= dt; const now = Math.ceil(this.cd);
      if (now !== before) { if (now > 0) { this.say(String(now), 'count'); this.sound.beep(660, 0.12, 'square', 0.08); } else { this.say('GO!', 'go', 900); this.sound.beep(1320, 0.3, 'square', 0.1); this.state = 'race'; } }
    } else this.t += dt;
    const p = this.pts[this.next];
    // arrow just above the plane, pointing at the next ring
    this.arrow.position.set(f.pos.x, f.pos.y + 3.2, f.pos.z);
    this.arrow.lookAt(this.V.set(p.x, p.y, p.z));
    this.arrow.visible = f.state === 'fly';
    // passing through the ring: the path since last frame comes within PASS_R of the ring centre, near its plane
    if (this.state === 'race' && f.state === 'fly') {
      const ax = this.prev.x, ay = this.prev.y, az = this.prev.z, bx = f.pos.x, by = f.pos.y, bz = f.pos.z;
      const sa = (ax - p.x) * p.dx + (az - p.z) * p.dz, sb = (bx - p.x) * p.dx + (bz - p.z) * p.dz; // signed distance to the ring plane
      if ((sa <= 0 && sb > 0) || Math.hypot(bx - p.x, by - p.y, bz - p.z) < PASS_R * 0.6) {
        const k = sa === sb ? 1 : Math.min(1, Math.max(0, -sa / (sb - sa))), cx = ax + (bx - ax) * k, cy = ay + (by - ay) * k, cz = az + (bz - az) * k;
        if (Math.hypot(cx - p.x, cy - p.y, cz - p.z) < PASS_R) this.pass();
      }
    }
    if (this.state === 'done') return;
    this.prev.copy(f.pos);
    const d = Math.hypot(f.pos.x - p.x, f.pos.y - p.y, f.pos.z - p.z);
    this.ui.panel.innerHTML = `<b>CHECKPOINT ${Math.min(this.next + 1, 10)}/10</b> <span>${p.name}</span> <span>${d > 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'}</span> <b class="t">${fmt(this.t)}</b>${this.best ? ` <span>best ${fmt(this.best)}</span>` : ''} <span class="k">G stop</span>`;
  }
  pass() {
    const p = this.rings[this.next].r;
    this.burst.position.copy(p.position); this.burst.rotation.copy(p.rotation); this.burst.scale.setScalar(1); this.burst.material.opacity = 0.9; this.burst.visible = true;
    this.splits.push(this.t);
    this.next++;
    if (this.next >= this.pts.length) return this.finish();
    this.sound.beep(880, 0.1, 'square', 0.08); this.sound.beep(1320, 0.14, 'square', 0.08, 0.09);
    this.say(`${this.next}/10 &nbsp; ${fmt(this.t)}`, 'cp', 1300);
    this.paint();
  }
  finish() {
    this.state = 'done'; this.paint(); this.rings.forEach(({ beam }) => (beam.visible = false));
    const t = this.t, newBest = !this.best || t < this.best;
    if (newBest) { this.best = t; try { localStorage.setItem(BEST_KEY, String(t)); } catch { /* private mode */ } }
    const medal = t < 150 ? ['GOLD', '#FFD400'] : t < 195 ? ['SILVER', '#d9dde2'] : ['BRONZE', '#d08a4c'];
    this.sound.bell();
    this.say(`<em>FINISH!</em><strong>${fmt(t)}</strong><small style="color:${medal[1]}">${medal[0]}${newBest ? ' · NEW BEST' : ' · best ' + fmt(this.best)}</small><small>press G to race again</small>`, 'finish');
    this.ui.panel.innerHTML = `<b>FINISHED</b> <b class="t">${fmt(t)}</b> <span>best ${fmt(this.best)}</span> <span class="k">G race again</span>`;
    this.ui.btn.style.display = '';
  }
}
