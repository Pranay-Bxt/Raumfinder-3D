// Fly (ultralight aircraft), Boat (steamer on the Elbe) and Bike (first person) modes.
import * as THREE from 'three';
import { WATER_Y } from './world.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (k, dt) => 1 - Math.exp(-k * dt);
const down = (keys, ...codes) => (codes.some((c) => keys.has(c)) ? 1 : 0);
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, flatShading: true, ...o });
function part(g, geo, m, x = 0, y = 0, z = 0) { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; }
function strut(g, m, a, b, r = 0.03) {
  const d = new THREE.Vector3().subVectors(b, a), o = part(g, new THREE.CylinderGeometry(r, r, d.length(), 5), m);
  o.position.copy(a).addScaledVector(d, 0.5);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return o;
}

// ---------------------------------------------------------------- ultralight
function makeUltralight() {
  const g = new THREE.Group();
  const white = mat('#f4f2ec'), red = mat('#c8372d'), dark = mat('#22262b'), alu = mat('#aab0b6', { roughness: 0.4, metalness: 0.6 }), tyre = mat('#18191b');
  // cockpit pod
  const pod = part(g, new THREE.CapsuleGeometry(0.52, 1.7, 4, 10).rotateX(Math.PI / 2), white, 0, 0.55, -0.35);
  pod.scale.set(1, 0.95, 1);
  part(g, new THREE.SphereGeometry(0.5, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-0.9), mat('#7fb4d6', { transparent: true, opacity: 0.45, roughness: 0.1 }), 0, 0.72, -0.75);
  part(g, new THREE.BoxGeometry(1.06, 0.14, 1.5), red, 0, 0.42, -0.3);
  // high wing
  part(g, new THREE.BoxGeometry(10.4, 0.13, 1.45), white, 0, 1.55, -0.25);
  for (const s of [-1, 1]) { part(g, new THREE.BoxGeometry(1.5, 0.14, 1.47), red, s * 4.45, 1.55, -0.25); part(g, new THREE.BoxGeometry(1.2, 0.14, 1.47), red, s * 1.4, 1.55, -0.25); }
  for (const s of [-1, 1]) {
    strut(g, alu, new THREE.Vector3(s * 0.5, 0.25, -0.5), new THREE.Vector3(s * 2.9, 1.5, -0.55));
    strut(g, alu, new THREE.Vector3(s * 0.5, 0.25, 0.2), new THREE.Vector3(s * 2.9, 1.5, 0.15));
    strut(g, alu, new THREE.Vector3(s * 0.35, 1.0, -0.6), new THREE.Vector3(s * 0.35, 1.5, -0.6), 0.025);
  }
  // tail
  strut(g, alu, new THREE.Vector3(0, 0.75, 0.9), new THREE.Vector3(0, 0.95, 5.0), 0.07);
  strut(g, alu, new THREE.Vector3(0, 1.5, 0.3), new THREE.Vector3(0, 1.0, 4.6), 0.025);
  part(g, new THREE.BoxGeometry(3.1, 0.07, 0.85), white, 0, 0.98, 4.9);
  part(g, new THREE.BoxGeometry(0.07, 1.2, 0.95), red, 0, 1.6, 4.95);
  // engine + propeller (nose)
  part(g, new THREE.BoxGeometry(0.5, 0.42, 0.6), dark, 0, 0.62, -1.75);
  const prop = new THREE.Group(); prop.position.set(0, 0.62, -2.12); g.add(prop);
  part(prop, new THREE.BoxGeometry(0.11, 1.75, 0.04), dark);
  part(prop, new THREE.ConeGeometry(0.11, 0.26, 8).rotateX(-Math.PI / 2), red, 0, 0, -0.1);
  const disc = part(prop, new THREE.CircleGeometry(0.88, 20), new THREE.MeshBasicMaterial({ color: '#cfd6dc', transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
  disc.castShadow = false;
  // gear
  for (const [x, z] of [[-0.85, -0.2], [0.85, -0.2], [0, -1.55]]) {
    part(g, new THREE.CylinderGeometry(0.2, 0.2, 0.12, 10).rotateZ(Math.PI / 2), tyre, x, -0.32, z);
    strut(g, alu, new THREE.Vector3(x * 0.45, 0.2, z * 0.8), new THREE.Vector3(x, -0.3, z), 0.03);
  }
  // pilot
  part(g, new THREE.SphereGeometry(0.17, 8, 6), mat('#e7c9a5'), 0, 0.98, -0.45);
  part(g, new THREE.SphereGeometry(0.19, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), mat('#e3b23c'), 0, 1.0, -0.43);
  g.userData.prop = prop;
  return g;
}

export class FlyMode {
  constructor(camera, scene, world) {
    this.camera = camera; this.world = world;
    this.craft = makeUltralight(); this.craft.visible = false; scene.add(this.craft);
    this.pos = new THREE.Vector3(); this.yaw = 0; this.pitch = 0; this.roll = 0; this.speed = 30;
    this.camYaw = 0; this.camPitch = 0.28; this.cockpit = false; this.agl = 0; this.note = '';
  }
  enter(x, z, yaw) {
    const e = this.world.ext;
    this.pos.set(clamp(x, e.minX + 50, e.maxX - 50), 0, clamp(z, e.minZ + 50, e.maxZ - 50));
    this.yaw = yaw; this.pitch = 0; this.roll = 0; this.speed = 30; this.camYaw = 0; this.camPitch = 0.28;
    // start one block back so the place you were looking at comes into view
    this.pos.x += Math.sin(yaw) * 220; this.pos.z += Math.cos(yaw) * 220;
    this.pos.y = this.world.heightAt(this.pos.x, this.pos.z) + 55;
    this.craft.visible = true; this.snap = true;
  }
  exit() { this.craft.visible = false; }
  drag(dx, dy) { this.camYaw -= dx * 0.005; this.camPitch = clamp(this.camPitch + dy * 0.004, -0.3, 1.3); }
  update(dt, keys) {
    const turn = down(keys, 'KeyA', 'ArrowLeft') - down(keys, 'KeyD', 'ArrowRight');
    const climb = down(keys, 'KeyW', 'ArrowUp') - down(keys, 'KeyS', 'ArrowDown');
    const thr = down(keys, 'KeyE', 'ShiftLeft', 'ShiftRight') - down(keys, 'KeyQ', 'ControlLeft');
    let steer = turn;
    // stay over the map: bank back toward the centre when leaving it
    const e = this.world.ext, out = Math.max(e.minX - this.pos.x, this.pos.x - e.maxX, e.minZ - this.pos.z, this.pos.z - e.maxZ);
    this.note = '';
    if (out > 150) {
      const want = Math.atan2(this.pos.x, this.pos.z); // heading that points at the origin
      let diff = ((want - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (Math.abs(diff) > 0.15) { steer = clamp(diff * 2, -1, 1); this.note = 'edge of map - turning back'; }
    }
    this.roll += (steer * 0.72 - this.roll) * ease(2.6, dt);
    this.yaw += ((9.81 * Math.tan(this.roll)) / this.speed) * 1.7 * dt;
    this.pitch += (climb * 0.3 - this.pitch) * ease(2.2, dt);
    this.speed = clamp(this.speed + thr * 9 * dt - Math.sin(this.pitch) * 3 * dt, 17, 48);
    const cp = Math.cos(this.pitch), fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    this.pos.x += fx * cp * this.speed * dt; this.pos.z += fz * cp * this.speed * dt; this.pos.y += Math.sin(this.pitch) * this.speed * dt;
    // obstacle clearance: a bit above the roofs, never into them
    const ahead = this.speed * 1.6;
    const roof = Math.max(this.world.heightAt(this.pos.x, this.pos.z), this.world.heightAt(this.pos.x + fx * ahead, this.pos.z + fz * ahead));
    const floor = roof + 14;
    if (this.pos.y < floor) { this.pos.y += (floor - this.pos.y) * ease(3, dt) + 0.02; if (this.pitch < 0.06) this.pitch += (0.06 - this.pitch) * ease(5, dt); }
    this.pos.y = Math.min(this.pos.y, 480);
    this.agl = this.pos.y - this.world.heightAt(this.pos.x, this.pos.z);
    const c = this.craft;
    c.position.copy(this.pos);
    c.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    c.userData.prop.rotation.z += dt * 55;
    if (this.cockpit) {
      this.camera.position.copy(this.pos).add(new THREE.Vector3(0, 1.02, -0.55).applyEuler(c.rotation));
      this.camera.rotation.set(this.pitch - 0.05 + (this.camPitch - 0.28) * -0.8, this.yaw + this.camYaw, this.roll, 'YXZ');
    } else {
      if (!this.dragging) this.camYaw *= 1 - Math.min(1, 0.8 * dt);
      const a = this.yaw + this.camYaw, dist = 19, cpi = Math.cos(this.camPitch);
      const want = new THREE.Vector3(this.pos.x + Math.sin(a) * dist * cpi, this.pos.y + 1.2 + Math.sin(this.camPitch) * dist, this.pos.z + Math.cos(a) * dist * cpi);
      if (this.snap) { this.camera.position.copy(want); this.snap = false; } else this.camera.position.lerp(want, ease(5, dt));
      this.camera.up.set(Math.sin(this.roll * 0.35) * Math.cos(this.yaw), 1, -Math.sin(this.roll * 0.35) * Math.sin(this.yaw)).normalize();
      this.camera.lookAt(this.pos.x + fx * 7, this.pos.y + 1.4, this.pos.z + fz * 7);
      this.camera.up.set(0, 1, 0);
    }
  }
  get heading() { return ((-this.yaw * 180) / Math.PI % 360 + 360) % 360; }
}

// ---------------------------------------------------------------- boat
function makeBoat() {
  const g = new THREE.Group();
  const white = mat('#f1efe8'), dark = mat('#23272c', { roughness: 0.8 }), wood = mat('#9a6b3f', { roughness: 0.9 }), green = mat('#1f5a3e'), gold = mat('#d9a93a', { roughness: 0.5 });
  const L = 44, B = 6.4;
  const s = new THREE.Shape();
  s.moveTo(0, L / 2); s.quadraticCurveTo(B / 2, L / 2 - 6, B / 2, L / 4); s.lineTo(B / 2, -L / 2 + 3); s.quadraticCurveTo(B / 2 - 0.4, -L / 2, 0, -L / 2 - 0.6);
  s.quadraticCurveTo(-B / 2 + 0.4, -L / 2, -B / 2, -L / 2 + 3); s.lineTo(-B / 2, L / 4); s.quadraticCurveTo(-B / 2, L / 2 - 6, 0, L / 2);
  const ex = (depth, y, m, sc = 1) => { const o = part(g, new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 6 }).rotateX(-Math.PI / 2), m, 0, y, 0); o.scale.set(sc, 1, sc); };
  ex(1.0, -0.5, dark); ex(0.7, 0.5, white); ex(0.12, 1.2, wood, 0.97);
  part(g, new THREE.BoxGeometry(4.6, 1.9, 22), white, 0, 2.25, 3);
  part(g, new THREE.BoxGeometry(5.4, 0.14, 26), green, 0, 3.27, 3);
  part(g, new THREE.BoxGeometry(3.0, 1.5, 4.2), white, 0, 4.05, -7.5);
  part(g, new THREE.BoxGeometry(3.4, 0.12, 4.8), green, 0, 4.86, -7.5);
  for (const sx of [-1, 1]) {
    part(g, new THREE.CylinderGeometry(2.6, 2.6, 1.7, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2), white, sx * (B / 2 + 0.75), 0.5, -1);
    const badge = part(g, new THREE.CircleGeometry(0.8, 12), gold, sx * (B / 2 + 1.62), 1.7, -1); badge.rotation.y = (sx * Math.PI) / 2;
  }
  part(g, new THREE.CylinderGeometry(0.6, 0.7, 2.4, 10), mat('#e3b23c'), 0, 4.4, 0.5);
  part(g, new THREE.CylinderGeometry(0.63, 0.63, 0.5, 10), dark, 0, 5.4, 0.5);
  part(g, new THREE.CylinderGeometry(0.06, 0.06, 3.2, 5), dark, 0, 2.9, -19);
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute([-2.5, 0, 20, 2.5, 0, 20, 13, 0, 95, -13, 0, 95], 3));
  wg.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 0.75, 1, 1, 1, 0.75, 1, 1, 1, 0, 1, 1, 1, 0], 4));
  wg.setIndex([0, 1, 2, 0, 2, 3]);
  const wake = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  wake.position.y = 0.06; wake.renderOrder = 7;
  g.add(wake);
  g.userData.wake = wake;
  return g;
}

export class BoatMode {
  constructor(camera, scene, world, start) {
    this.camera = camera; this.world = world;
    this.boat = makeBoat(); this.boat.visible = false;
    scene.add(this.boat);
    this.x = 0; this.z = 0; this.heading = 0; this.speed = 0; this.camYaw = 0; this.camPitch = 0.3; this.t = 0;
    // widest stretch of open water near the requested start (mid-channel, not the bank)
    let best = null, bestC = -1;
    for (let dx = -300; dx <= 300; dx += 15)
      for (let dz = -300; dz <= 300; dz += 15) {
        const x = start[0] + dx, z = start[1] + dz;
        let c = 0;
        search: for (; c < 200; c += 8)
          for (let a = 0; a < 6.283; a += 0.785) if (world.riverAt(x + Math.cos(a) * c, z + Math.sin(a) * c) < 0.9) break search;
        c -= Math.hypot(dx, dz) * 0.05;
        if (c > bestC) { bestC = c; best = [x, z]; }
      }
    this.home = best || start;
    let bestRun = -1;
    for (let a = 0; a < 6.283; a += 0.13) {
      let run = 0;
      while (run < 1500 && world.isWater(this.home[0] - Math.sin(a) * run, this.home[1] - Math.cos(a) * run)) run += 15;
      const score = run + (-Math.sin(a) > 0 ? 40 : 0);
      if (score > bestRun) { bestRun = score; this.homeHeading = a; }
    }
    this.reset();
  }
  reset() { this.x = this.home[0]; this.z = this.home[1]; this.heading = this.homeHeading; this.speed = 0; this.camYaw = 0; }
  enter() { this.boat.visible = true; this.snap = true; }
  exit() { this.boat.visible = false; }
  drag(dx, dy) { this.camYaw -= dx * 0.005; this.camPitch = clamp(this.camPitch + dy * 0.004, 0.06, 1.2); }
  update(dt, keys) {
    this.t += dt;
    const thr = down(keys, 'KeyW', 'ArrowUp') - down(keys, 'KeyS', 'ArrowDown');
    const turn = down(keys, 'KeyA', 'ArrowLeft') - down(keys, 'KeyD', 'ArrowRight');
    this.speed = clamp(this.speed + thr * 4.2 * dt - this.speed * 0.28 * dt, -5, 15);
    this.heading += turn * dt * 0.5 * clamp(Math.abs(this.speed) / 5, 0.22, 1) * (this.speed < -0.2 ? -1 : 1);
    const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
    const nx = this.x + fx * this.speed * dt, nz = this.z + fz * this.speed * dt, s = Math.sign(this.speed) || 1;
    if (this.world.isWater(nx, nz) && this.world.isWater(nx + fx * 20 * s, nz + fz * 20 * s)) { this.x = nx; this.z = nz; }
    else this.speed *= -0.25;
    const b = this.boat;
    b.position.set(this.x, WATER_Y + Math.sin(this.t * 1.3) * 0.07, this.z);
    b.rotation.set(Math.sin(this.t * 0.9) * 0.008, this.heading, -turn * 0.02 * Math.min(1, Math.abs(this.speed) / 6) + Math.sin(this.t * 1.1) * 0.01, 'YXZ');
    b.userData.wake.material.opacity = clamp(this.speed / 14, 0, 1) * 0.5;
    this.camYaw *= 1 - Math.min(1, (Math.abs(this.speed) > 1 && !this.dragging ? 0.6 : 0) * dt);
    const a = this.heading + this.camYaw, dist = 78, cp = Math.cos(this.camPitch);
    const want = new THREE.Vector3(this.x + Math.sin(a) * dist * cp, WATER_Y + 4 + Math.sin(this.camPitch) * dist, this.z + Math.cos(a) * dist * cp);
    if (this.snap) { this.camera.position.copy(want); this.snap = false; }
    else this.camera.position.lerp(want, ease(3.5, dt));
    this.camera.lookAt(this.x + fx * 10, WATER_Y + 5, this.z + fz * 10);
  }
  get compass() { return ((-this.heading * 180) / Math.PI % 360 + 360) % 360; }
}

// ---------------------------------------------------------------- bicycle (first person)
function makeHandlebars() {
  const rig = new THREE.Group();
  const black = mat('#141516', { roughness: 0.6 }), chrome = mat('#c9ced3', { roughness: 0.25, metalness: 0.9 }), frame = mat('#b3261e', { roughness: 0.45, metalness: 0.2 });
  const steerG = new THREE.Group(); rig.add(steerG);
  const cyl = (r, l) => new THREE.CylinderGeometry(r, r, l, 8);
  part(steerG, cyl(0.014, 0.6).rotateZ(Math.PI / 2), chrome, 0, 0, 0);                    // bar
  for (const s of [-1, 1]) {
    part(steerG, cyl(0.021, 0.13).rotateZ(Math.PI / 2), black, s * 0.265, 0, 0);          // grips
    strut(steerG, chrome, new THREE.Vector3(s * 0.19, 0.005, -0.01), new THREE.Vector3(s * 0.27, -0.01, -0.075), 0.006); // brake levers
  }
  part(steerG, new THREE.SphereGeometry(0.03, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), chrome, -0.13, 0.014, 0); // bell
  strut(steerG, black, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.07, 0.09), 0.018);                    // stem
  strut(steerG, frame, new THREE.Vector3(0, -0.07, 0.09), new THREE.Vector3(0, -0.2, 0.12), 0.02);               // head tube
  for (const s of [-1, 1]) strut(steerG, frame, new THREE.Vector3(s * 0.045, -0.2, 0.11), new THREE.Vector3(s * 0.05, -0.62, -0.16), 0.012); // fork
  const wheel = part(steerG, new THREE.TorusGeometry(0.34, 0.021, 6, 28).rotateY(Math.PI / 2), black, 0, -0.62, -0.16);
  wheel.castShadow = false;
  part(steerG, new THREE.BoxGeometry(0.07, 0.05, 0.07), black, 0, -0.06, -0.06);          // headlight
  strut(rig, frame, new THREE.Vector3(0, -0.14, 0.12), new THREE.Vector3(0, -0.2, 0.75), 0.02); // top tube
  rig.userData.steer = steerG;
  rig.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return rig;
}

export class BikeMode {
  constructor(camera, scene, world, start) {
    this.camera = camera; this.world = world; this.home = start;
    this.body = new THREE.Group(); this.body.visible = false; scene.add(this.body);
    this.rig = makeHandlebars(); this.rig.position.set(0, -0.37, -0.6); this.body.add(this.rig);
    this.x = 0; this.z = 0; this.y = 0; this.heading = 0; this.speed = 0; this.steer = 0; this.lookYaw = 0; this.lookPitch = 0; this.t = 0; this.street = '';
  }
  ok(x, z) {
    const e = this.world.ext;
    if (x < e.minX + 8 || x > e.maxX - 8 || z < e.minZ + 8 || z > e.maxZ - 8) return false;
    if (this.world.solidAt(x, z)) return false;
    return this.world.riverAt(x, z) < 0.45 || this.world.bridgeAt(x, z);
  }
  /** start on the street nearest to (x, z) */
  enter(x, z) {
    let r = this.world.nearestRoad(x, z, 6);
    if (!r || r.d > 90 || !this.ok(r.x, r.z)) r = this.world.nearestRoad(this.home[0], this.home[1], 6) || { x: this.home[0], z: this.home[1], dx: 0, dz: -1 };
    this.x = r.x; this.z = r.z; this.heading = Math.atan2(-r.dx, -r.dz); this.speed = 0; this.steer = 0; this.lookYaw = 0; this.lookPitch = 0;
    this.y = this.surfaceY(this.x, this.z);
    this.body.visible = true;
  }
  exit() { this.body.visible = false; }
  surfaceY(x, z) { return this.world.bridgeAt(x, z) ? 0.2 : this.world.groundY(x, z) + 0.15; }
  drag(dx, dy) { this.lookYaw = clamp(this.lookYaw - dx * 0.004, -2.4, 2.4); this.lookPitch = clamp(this.lookPitch - dy * 0.004, -1.0, 0.9); }
  update(dt, keys) {
    this.t += dt;
    const pedal = down(keys, 'KeyW', 'ArrowUp'), brake = down(keys, 'KeyS', 'ArrowDown');
    const sIn = down(keys, 'KeyA', 'ArrowLeft') - down(keys, 'KeyD', 'ArrowRight');
    const top = down(keys, 'ShiftLeft', 'ShiftRight') ? 11.5 : 7;
    if (pedal) this.speed += 3.4 * dt * (1 - this.speed / top);
    else if (brake) this.speed = Math.max(-1.6, this.speed - (this.speed > 0 ? 7 : 2.2) * dt);
    else this.speed -= this.speed * 0.3 * dt;
    this.steer += (sIn - this.steer) * ease(7, dt);
    const v = Math.abs(this.speed);
    this.heading += this.steer * (1.9 / (1 + v * 0.13)) * dt * (v > 0.3 ? Math.sign(this.speed) : 0.55);
    const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
    const nx = this.x + fx * this.speed * dt, nz = this.z + fz * this.speed * dt;
    const px = nx + fx * 0.7 * Math.sign(this.speed || 1), pz = nz + fz * 0.7 * Math.sign(this.speed || 1);
    if (this.ok(px, pz)) { this.x = nx; this.z = nz; }
    else if (this.ok(px, this.z + fz * 0.7)) { this.x = nx; this.speed *= 1 - Math.min(1, 2 * dt); }
    else if (this.ok(this.x + fx * 0.7, pz)) { this.z = nz; this.speed *= 1 - Math.min(1, 2 * dt); }
    else this.speed = 0;
    this.y += (this.surfaceY(this.x, this.z) - this.y) * ease(10, dt);
    if (!this.dragging && v > 1) { this.lookYaw *= 1 - Math.min(1, 1.2 * dt); this.lookPitch *= 1 - Math.min(1, 1.2 * dt); }
    const lean = this.steer * 0.07 * Math.min(1, v / 5);
    const bob = Math.sin(this.t * (3 + v * 0.9)) * 0.012 * Math.min(1, v / 2);
    const cam = this.camera;
    cam.position.set(this.x, this.y + 1.62 + bob, this.z);
    cam.rotation.set(this.lookPitch - 0.07, this.heading + this.lookYaw, lean, 'YXZ');
    this.body.position.copy(cam.position);
    this.body.rotation.set(0, this.heading, lean, 'YXZ');
    this.rig.userData.steer.rotation.y = this.steer * 0.42;
    if ((this.tick = (this.tick || 0) + 1) % 10 === 0) { const r = this.world.nearestRoad(this.x, this.z, 7); this.street = r && r.d < 16 && r.name ? r.name : ''; }
  }
  get compass() { return ((-this.heading * 180) / Math.PI % 360 + 360) % 360; }
}
