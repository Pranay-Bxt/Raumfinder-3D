import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { makeBoundary, keepInside } from './boundary.js';
import { Leaves } from './leaves.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { project, unproject } from './proj.js';
import { buildWorld } from './world.js';
import { Environment, sunPosition, nowBerlin, berlinToUtc } from './env.js';
import { Labels } from './labels.js';
import { FlyMode, BoatMode, BikeMode, CarMode } from './modes.js';
import { buildSports, Penalty } from './football.js';
import { TramRoute, TramNetwork, TramGame, setTramNight } from './tram.js';
import { People } from './people.js';
import { PhotoCam } from './photo.js';
import * as AUDIO from './audio.js';
import { Campus } from './campus.js';
import { FloorStack } from './floors.js';
import { IndoorView } from './indoor.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
// the pixel font is also used on canvas labels (floors, rooms, tram sign): start loading it right away
try { document.fonts.load('48px VT323'); } catch { /* labels fall back to a monospace font */ }
const progress = (pct, msg) => { $('#bar i').style.width = pct + '%'; if (msg) $('#loadMsg').textContent = msg; };
const nextFrame = () => new Promise((r) => setTimeout(r, 30));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- load ----------
const names = ['meta', 'buildings', 'roads', 'land', 'labels', 'trees'];
let done = 0;
const loaded = await Promise.all(names.map((n) => fetch(`./data/${n}.json`).then((r) => {
  if (!r.ok) throw new Error(`data/${n}.json missing - run "npm run data" first`);
  return r.json();
}).then((j) => { progress(10 + (++done / names.length) * 40); return j; }))).catch((e) => { $('#loadMsg').textContent = e.message; throw e; });
const data = Object.fromEntries(names.map((n, i) => [n, loaded[i]]));
// optional extras: official 3D building models and sports grounds
const opt = (u, t) => fetch(u).then((r) => (r.ok ? r[t]() : null)).catch(() => null);
const [lodJson, lodBin, sports, tramData, campusData, indoorData, roomIndex] = await Promise.all([opt('./data/lod2.json', 'json'), opt('./data/lod2.bin', 'arrayBuffer'), opt('./data/sports.json', 'json'), opt('./data/tram.json', 'json'), opt('./data/campus.json', 'json'), opt('./data/indoor.json', 'json'), opt('./data/rooms/index.json', 'json')]);
data.lod2 = lodJson && lodBin ? { ...lodJson, bin: lodBin } : null;
const { meta } = data;
const { minX, maxX, minZ, maxZ } = meta.ext;

// ---------- renderer ----------
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const PR = Math.min(devicePixelRatio, 1.5);
renderer.setPixelRatio(PR);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1.6, 2, 70000);
scene.add(camera);

progress(55, 'Building the city…');
await nextFrame();
const world = buildWorld(data, renderer);
scene.add(world.group);
// the digital wall around the map: you can see past it, not go past it
const boundary = makeBoundary(meta.ext);
scene.add(boundary.mesh);
const sportsWorld = sports ? buildSports(sports, world) : { group: new THREE.Group(), pitches: [] };
scene.add(sportsWorld.group);
// people, DVB tram line 11 and the tram simulator
const people = new People(scene, data.roads.ways, { world });
const leaves = new Leaves(scene, world); // fallen + wind-blown leaves near the camera
let tramNet = null, tramGame = null;
if (tramData) {
  tramNet = new TramNetwork(scene, TramRoute.build(tramData, {}));
  tramGame = new TramGame(scene, camera, world, people);
  people.arrangeStops(tramNet.route, tramNet.route.stops.map((st) => st));
} else { document.querySelector('[data-mode=tram]').style.display = 'none'; }
progress(90, 'Lighting…');
await nextFrame();
const env = new Environment(scene, camera, world, meta);

// post-processing: bloom for sun glints, lit windows and street lights
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.3, 0.7, 1.4);
composer.addPass(bloom);
composer.addPass(new OutputPass());
let effects = true;

// ---------- controls / modes ----------
const controls = new MapControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.07;
controls.rotateSpeed = 0.6; controls.panSpeed = 0.7; controls.zoomSpeed = 0.7; // a little slower and calmer than the defaults
controls.minDistance = 30; controls.maxDistance = 12000; controls.maxPolarAngle = 1.5; controls.zoomToCursor = true;
const fly = new FlyMode(camera, scene, world);
fly.onCrash = () => { AUDIO.initAudio(); AUDIO.boom(); $('#crash').className = 'show crash'; };
fly.onRewind = () => { AUDIO.rewind(); $('#crash').className = 'show rewind'; };
fly.onResume = () => { $('#crash').className = ''; };
const boat = new BoatMode(camera, scene, world, project(51.0562, 13.7425));
const bike = new BikeMode(camera, scene, world, project(51.0537, 13.7372));
const car = new CarMode(camera, scene, world, project(51.0537, 13.7372));
const penalty = new Penalty(scene, camera, canvas);
let mode = 'explore';
const keys = new Set();
const photo = new PhotoCam({
  canvas,
  render: () => { if (effects) composer.render(); else renderer.render(scene, camera); },
  caption: () => {
    const p = mode === 'bike' ? { x: bike.x, z: bike.z } : mode === 'car' ? { x: car.x, z: car.z } : camera.position;
    let near = null, nd = Infinity;
    for (const d of data.labels) if (d.k === 'district') { const dd = Math.hypot(d.x - p.x, d.z - p.z); if (dd < nd) { nd = dd; near = d; } }
    const where = mode === 'bike' && bike.street ? bike.street : mode === 'car' && car.street ? car.street : mode === 'tram' && tramGame.active ? 'Linie 11 — ' + tramGame.trip[Math.min(tramGame.stopIdx, tramGame.trip.length - 1)].name : near ? near.n : 'Dresden';
    const [lat, lon] = unproject(p.x, p.z);
    return { title: where, sub: `${near ? near.n + ' · ' : ''}${T.d}.${T.m}.${T.y} ${pad(T.min / 60 | 0)}:${pad(T.min % 60)} · ${season} · ${lat.toFixed(4)}°N ${lon.toFixed(4)}°E · ${photo.on ? photo.mm() + ' mm' : 'wide'}` };
  },
});
if (tramGame) {
  tramGame.onPick = (def) => { tramNet.setAmbientVisible(false); tramNet.setLineVisible(false); tramGame.start(def, TramRoute.build(tramData, { from: def.from, to: def.to, reverse: def.reverse })); showHint(); };
  tramGame.onCancel = () => setMode('explore');
}

const HINTS = {
  explore: 'Drag to move · scroll to zoom · right-drag to turn · click a building for details · <kbd>/</kbd> search',
  fly: 'Ultralight: <kbd>A</kbd> <kbd>D</kbd> bank · <kbd>W</kbd> <kbd>S</kbd> climb / descend · <kbd>E</kbd> <kbd>Q</kbd> throttle · <kbd>C</kbd> cockpit view · drag to look · <kbd>Esc</kbd> exit',
  boat: 'Steamer: <kbd>W</kbd> <kbd>S</kbd> throttle · <kbd>A</kbd> <kbd>D</kbd> rudder · drag to look around · <kbd>R</kbd> back to the pier · <kbd>Esc</kbd> exit',
  penalty: '',
  tram: '',
  car: 'Car: <kbd>W</kbd> gas · <kbd>S</kbd> brake / reverse · <kbd>A</kbd> <kbd>D</kbd> steer · <kbd>Shift</kbd> boost · <kbd>C</kbd> driver view · <kbd>P</kbd> photo · drag to look · <kbd>Esc</kbd> exit',
  bike: 'Bicycle: <kbd>W</kbd> pedal · <kbd>S</kbd> brake · <kbd>A</kbd> <kbd>D</kbd> steer · <kbd>Shift</kbd> sprint · <kbd>F</kbd> camera viewfinder · <kbd>P</kbd> quick photo · drag to look · <kbd>Esc</kbd> exit',
};
let hintTimer;
function showHint() {
  const h = $('#hint'); h.innerHTML = HINTS[mode]; h.style.opacity = 0.95;
  clearTimeout(hintTimer); hintTimer = setTimeout(() => (h.style.opacity = 0), 10000);
}
function setMode(m) {
  if (m === mode) return;
  tween = null;
  // where the current mode "is", so the next one starts there
  const here = mode === 'explore' ? [controls.target.x, controls.target.z] : mode === 'fly' ? [fly.pos.x, fly.pos.z] : mode === 'boat' ? [boat.x, boat.z] : mode === 'penalty' ? [penalty.p.cx, penalty.p.cz] : mode === 'tram' ? (tramGame.active ? (({ x, z }) => [x, z])(tramGame.route.at(tramGame.s)) : [camera.position.x, camera.position.z]) : mode === 'car' ? [car.x, car.z] : [bike.x, bike.z];
  const d = camera.getWorldDirection(new THREE.Vector3());
  const yaw = Math.atan2(-d.x, -d.z);
  if (mode === 'boat') boat.exit();
  if (mode === 'fly') { fly.exit(); $('#crash').className = ''; }
  if (mode === 'bike') bike.exit();
  if (mode === 'car') car.exit();
  if (mode === 'penalty') penalty.exit();
  if (mode === 'tram') { tramGame.exit(); tramNet.setAmbientVisible(true); tramNet.setLineVisible($('[data-layer=tramline]').checked); camera.up.set(0, 1, 0); }
  photo.setOn(false);
  if (campus && campus.isOpen && m !== 'explore') campus.close();
  if (m === 'explore') {
    const keep = camera.position.clone().sub(new THREE.Vector3(here[0], 0, here[1]));
    controls.target.set(clamp(here[0], minX, maxX), 0, clamp(here[1], minZ, maxZ));
    const dist = clamp(keep.length(), 260, 1200);
    camera.position.set(controls.target.x + Math.sin(yaw) * dist * 0.75, dist * 0.6, controls.target.z + Math.cos(yaw) * dist * 0.75);
    camera.rotation.z = 0; camera.up.set(0, 1, 0);
  }
  mode = m;
  controls.enabled = m === 'explore';
  if (m === 'fly') fly.enter(here[0], here[1], yaw);
  if (m === 'boat') boat.enter();
  if (m === 'bike') bike.enter(here[0], here[1]);
  if (m === 'car') car.enter(here[0], here[1]);
  if (m === 'penalty') penalty.start(nextPitch);
  if (m === 'tram') {
    // show the route menu, looking along line 11 at Zellescher Weg
    tramNet.setAmbientVisible(false); tramGame.showMenu(true);
    const st = tramNet.route.stops.find((q) => q.name === 'Zellescher Weg') || tramNet.route.stops[2], a = tramNet.route.at(st.s, {});
    camera.position.set(a.x - a.tz * 9 - a.tx * 24, 7, a.z + a.tx * 9 - a.tz * 24); camera.up.set(0, 1, 0); camera.lookAt(a.x + a.tx * 30, 1.5, a.z + a.tz * 30);
    AUDIO.initAudio();
  }
  $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#hud').style.display = m === 'explore' || m === 'penalty' || m === 'tram' ? 'none' : 'block';
  $('#left').style.display = $('#tools').style.display = m === 'penalty' || m === 'tram' ? 'none' : '';
  if (m === 'penalty' || m === 'tram') closePops();
  clearSelection();
  showHint();
  canvas.focus();
}
$$('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
  AUDIO.initAudio();
  if (e.code === 'KeyU' && (mode === 'explore' || mode === 'fly' || mode === 'bike' || mode === 'boat' || mode === 'car')) { toggleUI(); return; }
  if (e.code === 'Escape') { if (closePops()) return; if (campus && campus.isOpen) { campus.close(); return; } if (photo.on) { photo.setOn(false); return; } setMode('explore'); return; }
  if (mode === 'tram') {
    if (e.code === 'Space') { if (!e.repeat && tramGame.active) tramGame.toggleDoors(); e.preventDefault(); return; }
    if (e.code === 'KeyH') { tramGame.bell(); return; }
    if (e.code === 'KeyC') { tramGame.toggleCam(); return; }
  }
  if (e.code === 'KeyP' && mode !== 'penalty' && !(mode === 'tram' && !tramGame.active)) { photo.capture(); return; }
  if (e.code === 'KeyF' && mode === 'bike') { photo.toggle(); return; }
  if (e.code === 'Enter' && photo.on) { photo.capture(); return; }
  if (e.code === 'KeyC' && mode === 'fly') { fly.cockpit = !fly.cockpit; fly.snap = true; return; }
  if (e.code === 'KeyC' && mode === 'car') { car.cockpit = !car.cockpit; car.snap = true; return; }
  if (e.code === 'KeyR' && mode === 'boat') { boat.reset(); boat.snap = true; return; }
  if (mode === 'penalty') {
    if (e.code === 'KeyR') { penalty.reset(); return; }
    if (e.code === 'Space') { if (!e.repeat) penalty.press(); e.preventDefault(); return; }
    const nudge = { ArrowLeft: [0.25, 0], ArrowRight: [-0.25, 0], ArrowUp: [0, 0.15], ArrowDown: [0, -0.15] }[e.code];
    if (nudge) { penalty.nudge(...nudge); e.preventDefault(); return; }
  }
  const m = { Digit1: 'explore', Digit2: 'fly', Digit3: 'boat', Digit4: 'bike', Digit5: tramGame ? 'tram' : undefined, Digit6: 'car' }[e.code];
  if (m) { setMode(m); return; }
  keys.add(e.code);
  if (mode !== 'explore' && (e.code.startsWith('Arrow') || e.code === 'Space')) e.preventDefault();
});
addEventListener('keyup', (e) => { keys.delete(e.code); if (mode === 'penalty' && e.code === 'Space') penalty.release(); });
addEventListener('blur', () => keys.clear());

// pointer: drag-look in fly/boat/bike, click-to-inspect in explore
let down = null;
const setDrag = (v) => { boat.dragging = fly.dragging = bike.dragging = car.dragging = v; };
canvas.addEventListener('pointerdown', (e) => { down = { moved: 0 }; setDrag(true); if (mode === 'penalty' && e.button === 0) penalty.press(); });
addEventListener('pointermove', (e) => {
  if (mode === 'penalty') penalty.aim(e.clientX, e.clientY);
  if (!down) return;
  down.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
  if (mode === 'fly') fly.drag(e.movementX, e.movementY);
  if (mode === 'boat') boat.drag(e.movementX, e.movementY);
  if (mode === 'bike') bike.drag(e.movementX, e.movementY);
  if (mode === 'car') car.drag(e.movementX, e.movementY);
  if (mode === 'tram' && tramGame.active) tramGame.drag(e.movementX, e.movementY);
});
addEventListener('pointerup', (e) => {
  setDrag(false);
  if (mode === 'penalty') penalty.release();
  if (down && down.moved < 6 && photo.on && e.target === canvas) photo.capture();
  if (down && down.moved < 6 && mode === 'explore' && e.target === canvas) pick(e.clientX, e.clientY);
  down = null;
});

canvas.addEventListener('wheel', (e) => { if (photo.on) { e.preventDefault(); e.stopImmediatePropagation(); photo.zoom(e.deltaY); } }, { passive: false, capture: true });
addEventListener('pointerdown', () => AUDIO.initAudio(), { once: true });

// ---------- camera tween ----------
let tween = null;
function flyTo(x, z, dist = 520) {
  if (mode !== 'explore') setMode('explore');
  const off = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.radius = dist; sph.phi = clamp(sph.phi, 0.75, 1.2);
  tween = { t: 0, fromT: controls.target.clone(), toT: new THREE.Vector3(x, 0, z), fromO: off, toO: new THREE.Vector3().setFromSpherical(sph) };
}
function stepTween(dt) {
  if (!tween) return;
  tween.t = Math.min(1, tween.t + dt / 2.1);
  const k = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
  controls.target.lerpVectors(tween.fromT, tween.toT, k);
  camera.position.copy(controls.target).add(tween.fromO.clone().lerp(tween.toO, k));
  if (tween.t >= 1) tween = null;
}

// ---------- labels, search, presets ----------
let campus = null, floorStack = new FloorStack(scene), indoorView = new IndoorView(scene), lastCampus = null;
if (campusData) for (const b of campusData.buildings) { const [x, z] = project(b.points[0][0], b.points[0][1]); data.labels.push({ n: b.name.length > 30 ? b.name.slice(0, 29) + '…' : b.name, k: 'campus', id: b.id, x, z, p: 0 }); }
const labels = new Labels($('#labels'), data.labels, camera, (l) => { if (l.k === 'campus' && campus) campus.open(l.id); else flyTo(l.x, l.z, l.k === 'district' ? 900 : 380); });
const pipFlat = (x, z, r) => { let ins = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const ax = r[i], az = r[i + 1], bx = r[j], bz = r[j + 1]; if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) ins = !ins; } return ins; };
/** the 3D model(s) of a campus building: official LoD2 models first, then simple OpenStreetMap footprints */
function campusRows(b) {
  const rows = [], seen = new Set();
  const probes = b.points.map(([la, lo]) => project(la, lo));
  // a building made of several parts: also probe where its mapped rooms are, so every part is found
  const lv = indoorData && indoorData.levels[b.id];
  if (lv) { const all = Object.values(lv).flat(), step = Math.max(1, Math.floor(all.length / 70)); for (let i = 0; i < all.length; i += step) { const r = all[i][3]; let cx = 0, cz = 0; for (let k = 0; k < r.length; k += 2) { cx += r[k]; cz += r[k + 1]; } probes.push([cx / (r.length / 2), cz / (r.length / 2)]); } }
  for (const [px, pz] of probes) {
    let hit = null;
    for (const m of world.bGroup.children) {
      const lod = m.userData.src === 'lod2', ids = m.userData.idxs;
      for (let li = 0; li < ids.length && !hit; li++) {
        const ring = lod ? data.lod2.rows[ids[li]][10] : data.buildings[ids[li]][11][0];
        if (ring && ring.length >= 6 && pipFlat(px, pz, ring)) hit = { m, li, ring, h: m.userData.totalH[li], lod };
      }
      if (hit) break;
    }
    if (hit && !seen.has(hit.m.id + ':' + hit.li)) { seen.add(hit.m.id + ':' + hit.li); rows.push(hit); }
  }
  return rows;
}
/** fly to a TU Dresden building and highlight its 3D model; returns its height */
function showCampusBuilding(b) {
  if (mode !== 'explore') setMode('explore');
  clearSelection();
  const rows = campusRows(b);
  const pts = b.points.map(([la, lo]) => project(la, lo));
  const cx = pts.reduce((q, p) => q + p[0], 0) / pts.length, cz = pts.reduce((q, p) => q + p[1], 0) / pts.length;
  const span = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cz)), 20);
  flyTo(cx, cz, Math.max(190, Math.min(520, span * 2.6 + 150)));
  if (!rows.length) { lastCampus = null; return { height: 0 }; }
  // merged highlight of all parts of the building
  const parts = rows.map((r) => {
    const ts = r.m.userData.triStart, idx = r.m.geometry.index.array, pos = r.m.geometry.attributes.position.array, n = (ts[r.li + 1] - ts[r.li]) * 3, hp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = idx[ts[r.li] * 3 + i] * 3; hp[i * 3] = pos[v]; hp[i * 3 + 1] = pos[v + 1]; hp[i * 3 + 2] = pos[v + 2]; }
    return hp;
  });
  const all = new Float32Array(parts.reduce((q, p) => q + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(all, 3));
  highlight = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#FFD400', transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
  highlight.renderOrder = 8; scene.add(highlight); selected = true;
  const H = Math.max(...rows.map((r) => r.h));
  lastCampus = { b, rings: rows.map((r) => r.ring), H };
  $('#info').innerHTML = '<h3>' + esc(b.name) + ' (' + b.code + ')</h3><div class="sub">TU Dresden' + (b.address ? ' · ' + esc(b.address) : '') + '</div>'
    + '<div class="row"><span>Height</span><b>' + H.toFixed(1) + ' m</b></div><div class="row"><span>Parts</span><b>' + rows.length + '</b></div>';
  return { height: H };
}
/** show the chosen floor of a campus building as a box in 3D */
const roomFiles = new Map();
let floorTok = 0;
/** room outlines imported from the Campus Navigator plans, loaded once per building */
function loadRooms(id) {
  if (!roomIndex || !roomIndex.buildings[id]) return Promise.resolve(null);
  if (!roomFiles.has(id)) roomFiles.set(id, fetch('./data/rooms/' + id + '.json').then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return roomFiles.get(id);
}
// buildings whose outline is symmetric: rooms are stored in plan coordinates with several orientation candidates;
// the chosen one (default: best overlap) is remembered per browser
const orientKey = (id) => 'campus-orient-' + id;
function getOrient(id) { try { return +localStorage.getItem(orientKey(id)) || 0; } catch { return 0; } }
function setOrient(id, k) { try { localStorage.setItem(orientKey(id), String(k)); } catch { /* private mode: not remembered */ } }
function worldRooms(data) {
  const k = getOrient(data.id) % data.cands.length;
  data._w ||= {};
  if (data._w[k]) return data._w[k];
  const C = data.cands[k].A, out = {};
  for (const [lv, recs] of Object.entries(data.levels)) {
    const Bm = data.base[lv]; if (!Bm) continue;
    const M = [C[0] * Bm[0] + C[1] * Bm[3], C[0] * Bm[1] + C[1] * Bm[4], C[0] * Bm[2] + C[1] * Bm[5] + C[2], C[3] * Bm[0] + C[4] * Bm[3], C[3] * Bm[1] + C[4] * Bm[4], C[3] * Bm[2] + C[4] * Bm[5] + C[5]];
    out[lv] = recs.map((r) => { const q = r[3], o = new Array(q.length); for (let i = 0; i < q.length; i += 2) { o[i] = +(M[0] * q[i] + M[1] * q[i + 1] + M[2]).toFixed(2); o[i + 1] = +(M[3] * q[i] + M[4] * q[i + 1] + M[5]).toFixed(2); } return [r[0], r[1], r[2], o, r[4]]; });
  }
  return (data._w[k] = out);
}
async function orientCampus(b, step) {
  const d = await loadRooms(b.id);
  if (!d || !d.uncertain) return null;
  const n = d.cands.length, k = (((getOrient(b.id) + step) % n) + n) % n;
  setOrient(b.id, k);
  if (step && campus && campus.floor != null) await showCampusFloor(b, campus.floor);
  return { k, n };
}
async function showCampusFloor(b, floorId) {
  if (!lastCampus || lastCampus.b !== b) return;
  const tok = ++floorTok;
  const nav = await loadRooms(b.id);
  if (tok !== floorTok || !lastCampus || lastCampus.b !== b) return;
  const levels = (b.floors || []).map((f) => parseInt(f.id, 10)).sort((p, q) => p - q);
  const sel = parseInt(floorId, 10), recs = (nav && (nav.uncertain ? worldRooms(nav) : nav.levels)[sel]) || (indoorData && indoorData.levels[b.id] && indoorData.levels[b.id][sel]);
  const r = floorStack.show(lastCampus.rings, lastCampus.H, levels.length ? levels : [0], sel, !(recs && recs.length));
  if (recs && recs.length && r) indoorView.show(recs, sel * r.floorHeight, r.floorHeight); else indoorView.clear();
  lastCampus.level = sel;
}
/** a room was chosen (search or click): highlight it and fly close */
function focusRoom(ref) {
  const p = indoorView.focus(ref);
  if (p) { flyTo(p.x, p.z, 75); showRoomInfo(p.rec); }
  return p;
}
/** a room that is not in the 3D data: say so, give its floor, and keep the official plan one click away */
function noRoomInfo(b, lvl, ref, why = 'estimated') {
  const fid = lvl < 0 ? String(lvl) : String(lvl).padStart(2, '0');
  selected = true;
  $('#info').innerHTML = '<h3>Room ' + esc(ref) + '</h3><div class="sub">' + esc(b.name) + ' (' + b.code + ') · Etage ' + lvl + '</div><div class="row"><span style="color:#e8c45a">' + (why === 'unplaced' ? 'Etage ' + lvl + ' is certain (from the TU floor plan), but the plan of this floor could not be lined up with the 3D building yet, so the room is not drawn. Find it on the official plan:' : 'Floor estimated from the room number. This room is not mapped in 3D yet; find it on the official plan.') + '</span></div>';
  const r = document.createElement('div'); r.className = 'row'; r.innerHTML = '<button class="chip on">Open floor plan (Etage ' + lvl + ')</button>'; r.firstChild.onclick = () => campus.openFloor(b.id, fid); $('#info').appendChild(r);
}
function showRoomInfo(rec) {
  if (!lastCampus) return;
  const b = lastCampus.b, lvl = lastCampus.level, fid = lvl < 0 ? String(lvl) : String(lvl).padStart(2, '0'), nb = indoorView.neighbours(rec);
  $('#info').innerHTML = '<h3>Room ' + esc(rec[1] || rec[2] || '(unnamed)') + '</h3><div class="sub">' + esc(b.name) + ' (' + b.code + ') · Etage ' + lvl + (rec[2] && rec[1] ? ' · ' + esc(rec[2]) : '') + '</div>'
    + (nb.length ? '<div class="row"><span>Next to</span><b>' + nb.map(esc).join(', ') + '</b></div>' : '')
    + '<div class="row"><span style="color:var(--dim)">' + (b.navRooms ? 'Room outline: TU Dresden Campus Navigator (© TU Dresden)' : 'Mapped in OpenStreetMap') + '</span></div>';
  const r = document.createElement('div'); r.className = 'row'; r.innerHTML = '<button class="chip on">Open floor plan (Etage ' + lvl + ')</button>';
  r.firstChild.onclick = () => campus.openFloor(b.id, fid); $('#info').appendChild(r);
}
function addCampusButton(ring) {
  const cb = campus && campus.byRing(ring);
  if (!cb) return;
  const r = document.createElement('div'); r.className = 'row';
  r.innerHTML = '<button class="chip on">Rooms &amp; floor plans (' + cb.code + ')</button>';
  r.firstChild.onclick = () => campus.open(cb.id);
  $('#info').appendChild(r);
}
if (campusData) {
  campus = new Campus(campusData, { show3D: showCampusBuilding, floor: showCampusFloor, room: (b, lvl, ref) => focusRoom(ref), noRoom: noRoomInfo, orient: orientCampus, closed: () => clearSelection() }, indoorData, roomIndex);
  $('#campusBtn').onclick = () => campus.toggle();
} else $('#campusBtn').style.display = 'none';
const findLabel = (q) => data.labels.find((l) => l.k !== 'street' && l.n === q) || data.labels.find((l) => l.k !== 'street' && l.n.includes(q));
const PRESETS = [
  ['Frauenkirche', 51.0519, 13.7416, 330], ['Zwinger', 51.053, 13.7339, 420], ['Semperoper', 51.0545, 13.7354, 360], ['Residenzschloss', 51.0527, 13.7368, 360],
  ['Brühlsche Terrasse', 51.0537, 13.742, 420], ['Augustusbrücke', 51.0556, 13.7397, 480], ['Goldener Reiter', 51.0584, 13.7414, 380], ['Hauptbahnhof', 51.0404, 13.7323, 600],
  ['Großer Garten', 51.0378, 13.7628, 1100], ['Altmarkt', 51.0496, 13.7381, 450], ['Neustadt', 51.0655, 13.7505, 900], ['Whole map', 51.052, 13.745, 6500],
];
for (const [name, lat, lon, dist] of PRESETS) {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = name;
  b.onclick = () => {
    const l = ['Whole map', 'Neustadt', 'Großer Garten'].includes(name) ? null : findLabel(name);
    const [x, z] = l ? [l.x, l.z] : project(lat, lon);
    flyTo(x, z, dist);
  };
  $('#presets').appendChild(b);
}
const KIND_NAME = { poi: 'Landmark', district: 'District', station: 'Station', stop: 'Tram stop', street: 'Street', campus: 'TU Dresden building', room: 'Room' };
const search = $('#search'), results = $('#results');
let hits = [], sel = 0;
function renderHits() {
  results.innerHTML = '';
  hits.forEach((h, i) => {
    const d = document.createElement('div');
    if (i === sel) d.className = 'sel';
    d.innerHTML = `<span></span><small>${KIND_NAME[h.k]}</small>`;
    d.firstChild.textContent = h.n;
    d.onmousedown = (e) => { e.preventDefault(); go(h); };
    results.appendChild(d);
  });
  results.style.display = hits.length ? 'block' : 'none';
}
function go(h) { if (h.k === 'room' && campus) { search.blur(); results.style.display = 'none'; campus.selectRoom(h.room); return; } if (h.k === 'campus' && campus) { search.blur(); results.style.display = 'none'; campus.open(h.id); return; } flyTo(h.x, h.z, h.k === 'district' ? 900 : h.k === 'street' ? 420 : 340); search.blur(); results.style.display = 'none'; setInfoPlace(h); }
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  if (!q) { hits = []; renderHits(); return; }
  const starts = [], has = [];
  for (const l of data.labels) { const n = l.n.toLowerCase(); if (n.startsWith(q)) starts.push(l); else if (n.includes(q)) has.push(l); }
  const rank = (a, b) => a.p - b.p || a.n.length - b.n.length;
  const roomHits = campus ? campus.searchRooms(q).slice(0, 4).map((r) => ({ n: campus.byId(r.id).code + ' ' + r.ref, k: 'room', room: r, p: -1 })) : [];
  hits = roomHits.concat(starts.sort(rank), has.sort(rank)).slice(0, 8); sel = 0; renderHits();
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { sel = Math.min(hits.length - 1, sel + 1); renderHits(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderHits(); e.preventDefault(); }
  else if (e.key === 'Enter' && hits[sel]) go(hits[sel]);
  else if (e.key === 'Escape') search.blur();
});
search.addEventListener('blur', () => setTimeout(() => (results.style.display = 'none'), 120));

// ---------- inspector ----------
const ray = new THREE.Raycaster();
let highlight = null, selected = false;
function clearSelection() { if (highlight) { scene.remove(highlight); highlight.geometry.dispose(); highlight = null; } selected = false; floorStack.clear(); indoorView.clear(); }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex6 = (n) => '#' + n.toString(16).padStart(6, '0');
function pick(cx, cy) {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  const hit = world.bGroup.visible ? ray.intersectObjects(world.bGroup.children, false)[0] : null;
  const pitchHit = ray.intersectObjects(sportsWorld.pitches, false)[0];
  if (indoorView.active) { const rec = indoorView.pick(ray); if (rec) { indoorView.focus(rec[1] || rec[2]); showRoomInfo(rec); return; } }
  clearSelection();
  if (pitchHit && (!hit || pitchHit.distance < hit.distance)) { nextPitch = pitchHit.object.userData.pitch; setMode('penalty'); return; }
  if (!hit) return;
  const { idxs, triStart: ts, totalH, src: hitSrc } = hit.object.userData;
  if (hitSrc === 'lod2') { const li = pickIndex(ts, hit.faceIndex); highlightTris(hit.object, ts, hit.faceIndex); showLod2(data.lod2.rows[idxs[li]], totalH[li], hit.point); return; }
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= hit.faceIndex) lo = mid; else hi = mid; }
  const b = data.buildings[idxs[lo]], idx = hit.object.geometry.index.array, pos = hit.object.geometry.attributes.position.array;
  const n = (ts[lo + 1] - ts[lo]) * 3, hp = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = idx[ts[lo] * 3 + i] * 3; hp[i * 3] = pos[v]; hp[i * 3 + 1] = pos[v + 1]; hp[i * 3 + 2] = pos[v + 2]; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  highlight = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#e9b44c', transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
  highlight.renderOrder = 8; scene.add(highlight);
  selected = true;
  const [id, name, kind, , minH, , , flags, levels, wc, rc] = b;
  const h = totalH[lo];
  const official = flags & 128;
  const src = flags & 1 ? ['ok', 'surveyed height tag'] : flags & 2 ? ['ok', official ? 'official storey count' : 'from floor count'] : ['est', 'estimated'];
  const source = official
    ? '<span style="color:var(--dim)">Official register (GeoSN)</span>'
    : `<a href="https://www.openstreetmap.org/${flags & 32 ? 'relation' : 'way'}/${id}" target="_blank" rel="noopener">OpenStreetMap ↗</a>`;
  const [lat, lon] = unproject(hit.point.x, hit.point.z);
  const sw = (c) => `<i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${hex6(c)};border:1px solid rgba(255,255,255,.4);vertical-align:-1px"></i>`;
  $('#info').innerHTML = `<h3>${esc(name || (kind === 'yes' || kind === 'part' ? 'Building' : kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())))}</h3>
    <div class="sub">${esc(kind.replace(/_/g, ' '))}${flags & 4 ? ' · 3D part' : ''}</div>
    <div class="row"><span>Height</span><b>${h.toFixed(1)} m <span class="tag ${src[0]}">${src[1]}</span></b></div>
    ${levels ? `<div class="row"><span>Floors</span><b>${levels}</b></div>` : ''}
    ${minH > 0 ? `<div class="row"><span>Starts at</span><b>${minH.toFixed(1)} m</b></div>` : ''}
    <div class="row"><span>Roof</span><b>${sw(rc)} ${['flat', 'gabled', 'hipped', 'pyramidal', 'dome', 'onion', 'skillion'][b[6]]} <span class="tag ${flags & 64 ? 'ok">colour from aerial photo' : 'ok">colour from map tag'}</span></b></div>
    <div class="row"><span>Walls</span><b>${sw(wc)}</b></div>
    <div class="row"><span>${lat.toFixed(5)}° N ${lon.toFixed(5)}° E</span>${source}</div>`;
  addCampusButton(b[11][0]);
}
let nextPitch = null;
function pickIndex(ts, face) { let lo = 0, hi = ts.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= face) lo = mid; else hi = mid; } return lo; }
function highlightTris(obj, ts, face) {
  const lo = pickIndex(ts, face), idx = obj.geometry.index.array, pos = obj.geometry.attributes.position.array;
  const n = (ts[lo + 1] - ts[lo]) * 3, hp = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = idx[ts[lo] * 3 + i] * 3; hp[i * 3] = pos[v]; hp[i * 3 + 1] = pos[v + 1]; hp[i * 3 + 2] = pos[v + 2]; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  highlight = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#e9b44c', transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
  highlight.renderOrder = 8; scene.add(highlight);
  selected = true;
}
function showLod2(row, h, point) {
  const [, name, kind, , roof, wc, rc, addr, , flags] = row;
  const [lat, lon] = unproject(point.x, point.z);
  const sw = (c) => '<i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + hex6(c) + ';border:1px solid rgba(255,255,255,.4);vertical-align:-1px"></i>';
  const nice = kind === 'yes' ? '' : kind.replace(/_/g, ' ');
  const title = name || addr || (nice ? nice.replace(/^./, (c) => c.toUpperCase()) : 'Building');
  const sub = [name && addr, nice].filter(Boolean).join(' · ') || 'Official 3D model';
  $('#info').innerHTML = '<h3>' + esc(title) + '</h3><div class="sub">' + esc(sub) + '</div>'
    + '<div class="row"><span>Height</span><b>' + h.toFixed(1) + ' m <span class="tag ok">measured</span></b></div>'
    + '<div class="row"><span>Roof</span><b>' + sw(rc) + ' ' + esc(roof) + ' <span class="tag ok">' + (flags & 64 ? 'colour from aerial photo' : 'real shape') + '</span></b></div>'
    + '<div class="row"><span>Walls</span><b>' + sw(wc) + '</b></div>'
    + '<div class="row"><span>' + lat.toFixed(5) + '° N ' + lon.toFixed(5) + '° E</span><span style="color:var(--dim)">Official 3D model (GeoSN)</span></div>';
  addCampusButton(row[10]);
}
function setInfoPlace(l) {
  const [lat, lon] = unproject(l.x, l.z);
  selected = true;
  $('#info').innerHTML = `<h3>${esc(l.n)}</h3><div class="sub">${KIND_NAME[l.k]} · Dresden</div><div class="row"><span>${lat.toFixed(5)}° N ${lon.toFixed(5)}° E</span></div>`;
}
const districts = data.labels.filter((l) => l.k === 'district');
let infoTick = 0;
function updateInfo() {
  if (selected || infoTick++ % 12) return;
  const p = mode === 'explore' ? controls.target : mode === 'boat' ? boat.boat.position : mode === 'fly' ? fly.pos : camera.position;
  const [lat, lon] = unproject(p.x, p.z);
  let near = null, nd = Infinity;
  for (const d of districts) { const dd = Math.hypot(d.x - p.x, d.z - p.z); if (dd < nd) { nd = dd; near = d; } }
  const dist = camera.position.distanceTo(controls.target);
  $('#info').innerHTML = `<h3>${esc(near ? near.n : 'Dresden')}</h3><div class="sub">Dresden · Saxony</div>
    <div class="row"><span>${lat.toFixed(4)}° N ${lon.toFixed(4)}° E</span><span>${mode === 'explore' ? (dist > 1000 ? (dist / 1000).toFixed(1) + ' km out' : Math.round(dist) + ' m out') : ''}</span></div>`;
}

// ---------- time, seasons & weather ----------
let T = nowBerlin(), live = true, season = 'autumn';
const pad = (n) => String(n).padStart(2, '0');
let sunTimes = {};
function computeSunTimes() {
  let rise = null, set = null, noon = 720, best = -9, prev = null;
  for (let m = 0; m < 1440; m += 2) {
    const a = sunPosition(berlinToUtc({ ...T, min: m }), meta.origin.lat, meta.origin.lon).altitude * 57.2958 + 0.83;
    if (prev !== null) { if (prev < 0 && a >= 0) rise = m; if (prev >= 0 && a < 0) set = m; }
    if (a > best) { best = a; noon = m; }
    prev = a;
  }
  sunTimes = { rise: rise ?? 0, set: set ?? 1439, noon };
  const pc = (m) => ((m / 1439) * 100).toFixed(1) + '%', st = $('#time').style;
  st.setProperty('--sr0', pc(sunTimes.rise - 60)); st.setProperty('--sr', pc(sunTimes.rise)); st.setProperty('--sr1', pc(sunTimes.rise + 70));
  st.setProperty('--ss0', pc(sunTimes.set - 70)); st.setProperty('--ss', pc(sunTimes.set)); st.setProperty('--ss1', pc(sunTimes.set + 60));
  $('#sr').textContent = `Sunrise ${pad(sunTimes.rise / 60 | 0)}:${pad(sunTimes.rise % 60)}`;
  $('#ss').textContent = `Sunset ${pad(sunTimes.set / 60 | 0)}:${pad(sunTimes.set % 60)}`;
}
function applyTime() {
  const ms = berlinToUtc(T);
  env.setTime(ms);
  const tz = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;
  $('#clock').innerHTML = `${pad(T.min / 60 | 0)}:${pad(T.min % 60)}<small>${tz}</small>`;
  $('#time').value = T.min;
  $('#date').value = `${T.y}-${pad(T.m)}-${pad(T.d)}`;
  $('#sunAlt').textContent = `Sun ${env.alt >= 0 ? '+' : ''}${env.alt.toFixed(0)}° ${env.alt > 0 ? 'above' : 'below'} horizon`;
  $('#nowBtn').classList.toggle('on', live);
}
const SEASON_DATE = { spring: [4, 20], summer: [7, 15], autumn: [10, 25], winter: [1, 15] };
function setSeason(s, moveDate) {
  season = s;
  $$('[data-s]').forEach((x) => x.classList.toggle('on', x.dataset.s === s));
  $('[data-w=rain]').textContent = s === 'winter' ? 'Snow' : 'Rain';
  if (moveDate) { [T.m, T.d] = SEASON_DATE[s]; live = false; computeSunTimes(); }
  env.setSeason(s);
  people.setSeason(s);
  leaves.setSeason(s);
  applyTime();
}
$$('[data-s]').forEach((b) => (b.onclick = () => setSeason(b.dataset.s, true)));
$('#time').addEventListener('input', (e) => { T.min = +e.target.value; live = false; applyTime(); });
$('#date').addEventListener('change', (e) => { const [y, m, d] = e.target.value.split('-').map(Number); if (y) { T = { ...T, y, m, d }; live = false; computeSunTimes(); applyTime(); } });
$('#nowBtn').onclick = () => { T = nowBerlin(); live = true; computeSunTimes(); applyTime(); };
$$('[data-t]').forEach((b) => (b.onclick = () => {
  T.min = { sunrise: sunTimes.rise + 12, noon: sunTimes.noon, golden: sunTimes.set - 40, night: 22 * 60 + 30 }[b.dataset.t];
  T.min = clamp(T.min, 0, 1439); live = false; applyTime();
}));
setInterval(() => { if (live) { T = nowBerlin(); applyTime(); } }, 30000);
$$('[data-w]').forEach((b) => (b.onclick = () => {
  $$('[data-w]').forEach((x) => x.classList.toggle('on', x === b));
  env.setWeather(b.dataset.w);
  leaves.setWeather(b.dataset.w);
}));

// ---------- layers / share ----------
// settings live in popups: each toolbar button toggles its own popup (one open at a time)
function closePops() { let any = false; $$('.pop.open').forEach((p) => { p.classList.remove('open'); any = true; }); $$('#tools [data-pop]').forEach((b) => b.classList.remove('on')); return any; }
$$('#tools [data-pop]').forEach((b) => (b.onclick = () => {
  const p = $('#' + b.dataset.pop), open = !p.classList.contains('open');
  closePops();
  if (open) { p.classList.add('open'); b.classList.add('on'); }
}));
$$('.pop .pop-x').forEach((x) => (x.onclick = () => closePops()));
function toggleUI() { closePops(); document.body.classList.toggle('noui'); }
$('#uiBtn').onclick = toggleUI; $('#uiRestore').onclick = toggleUI;
$$('[data-layer]').forEach((c) => c.addEventListener('change', () => {
  const on = c.checked;
  switch (c.dataset.layer) {
    case 'buildings': world.bGroup.visible = on; if (!on) clearSelection(); break;
    case 'roads': Object.values(world.roadMeshes).forEach((m) => (m.visible = on)); world.bridges.visible = on; break;
    case 'trees': world.treeGroup.visible = on; break;
    case 'labels': labels.setEnabled(on); break;
    case 'shadows': env.shadows = on; env.apply(); break;
    case 'effects': effects = on; break;
    case 'aerial': world.setAerial(on); break;
    case 'people': people.setEnabled(on); break;
    case 'leaves': leaves.setEnabled(on); break;
    case 'tramline': if (tramNet) tramNet.setLineVisible(on); break;
  }
}));
function viewHash() {
  const [lat, lon] = unproject(controls.target.x, controls.target.z);
  const s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  return `#c=${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(s.radius)},${Math.round(s.phi * 57.2958)},${Math.round(s.theta * 57.2958)}&t=${T.min}&d=${T.y}-${pad(T.m)}-${pad(T.d)}&s=${season}`;
}
$('#shareBtn').onclick = async () => {
  history.replaceState(null, '', viewHash());
  try { await navigator.clipboard.writeText(location.href); $('#shareBtn').textContent = 'Link copied'; } catch { $('#shareBtn').textContent = 'Link in address bar'; }
  setTimeout(() => ($('#shareBtn').textContent = 'Share'), 1800);
};
(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const c = (h.get('c') || '').split(',').map(Number);
  const start = project(51.0527, 13.7395);
  controls.target.set(start[0], 0, start[1]);
  let sph = new THREE.Spherical(1150, 1.05, 0.5);
  if (c.length === 5 && c.every(isFinite)) {
    const [x, z] = project(c[0], c[1]);
    if (x > minX && x < maxX && z > minZ && z < maxZ) { controls.target.set(x, 0, z); sph = new THREE.Spherical(clamp(c[2], 30, 12000), c[3] / 57.2958, c[4] / 57.2958); }
  }
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
  const t = +h.get('t'), d = (h.get('d') || '').split('-').map(Number);
  if (h.has('t') && t >= 0 && t < 1440) { T.min = t; live = false; }
  if (d.length === 3 && d.every((v) => v > 0)) { T = { ...T, y: d[0], m: d[1], d: d[2] }; live = false; }
  if (SEASON_DATE[h.get('s')]) season = h.get('s');
})();

// ---------- loop ----------
let vw = 0, vh = 0;
function fitViewport() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h || (w === vw && h === vh)) return;
  vw = w; vh = h;
  renderer.setSize(w, h, false); composer.setPixelRatio(PR); composer.setSize(w, h); camera.aspect = w / h;
}
computeSunTimes();
setSeason(season, false);
$('#stats').textContent = `${meta.counts.buildings.toLocaleString()} buildings · ${((maxX - minX) / 1000).toFixed(1)} × ${((maxZ - minZ) / 1000).toFixed(1)} km · ${meta.photoRoofs ? meta.photoRoofs.toLocaleString() + ' real roof colours' : meta.heightTaggedPct + '% surveyed heights'}`;
const clock = new THREE.Timer();
const focus = new THREE.Vector3();
function frame() {
  clock.update();
  const dt = Math.min(0.05, clock.getDelta()), time = clock.getElapsed();
  let range, near = 2;
  if (mode === 'explore') {
    stepTween(dt);
    controls.target.x = clamp(controls.target.x, minX, maxX);
    controls.target.z = clamp(controls.target.z, minZ, maxZ);
    controls.target.y = 0;
    controls.update();
    if (camera.position.y < 4) camera.position.y = 4;
    if (keepInside(camera.position, meta.ext, 25)) { camera.lookAt(controls.target); if (camera.position.y < 700) boundary.hit(camera.position.x, camera.position.y, camera.position.z); }
    focus.copy(controls.target); range = camera.position.distanceTo(controls.target) * 0.9;
    near = clamp(camera.position.y * 0.03, 1, 30);
  } else if (mode === 'fly') {
    fly.update(dt, keys);
    focus.copy(fly.pos); range = Math.max(380, fly.pos.y * 3);
    near = 0.4;
    $('#hud').innerHTML = `<b>${Math.round(fly.speed * 3.6)}</b> km/h <span>·</span> <b>${Math.round(fly.agl)}</b> m above roofs <span>·</span> <b>${String(Math.round(fly.heading) % 360).padStart(3, '0')}°</b>${fly.note ? ` <span>· ${fly.note}</span>` : ''}`;
  } else if (mode === 'boat') {
    boat.update(dt, keys);
    focus.set(boat.x, 0, boat.z); range = 420; near = 1.5;
    $('#hud').innerHTML = `<b>${Math.abs(boat.speed * 3.6).toFixed(0)}</b> km/h${boat.speed < -0.3 ? ' astern' : ''} <span>·</span> <b>${String(Math.round(boat.compass) % 360).padStart(3, '0')}°</b> <span>· on the Elbe</span>`;
  } else if (mode === 'tram') {
    if (tramGame.active) {
      tramGame.update(dt, keys, env.nightF);
      const a = tramGame.route.at(tramGame.s, {});
      focus.set(a.x, 0, a.z);
    } else focus.set(camera.position.x, 0, camera.position.z);
    range = 260; near = 0.12;
  } else if (mode === 'penalty') {
    penalty.update(dt);
    focus.set(penalty.p.cx, 0, penalty.p.cz); range = 140; near = 0.1;
  } else if (mode === 'car') {
    car.update(dt, keys, env.nightF);
    focus.set(car.x, 0, car.z); range = 260; near = 0.2;
    $('#hud').innerHTML = `<b>${Math.abs(car.speed * 3.6).toFixed(0)}</b> km/h${car.speed < -0.3 ? ' reverse' : ''} <span>·</span> <b>${String(Math.round(car.compass) % 360).padStart(3, '0')}°</b>${car.street ? ` <span>·</span> ${esc(car.street)}` : ''}`;
  } else {
    bike.update(dt, keys);
    focus.set(bike.x, 0, bike.z); range = 170; near = 0.1;
    $('#hud').innerHTML = `<b>${Math.abs(bike.speed * 3.6).toFixed(0)}</b> km/h <span>·</span> <b>${String(Math.round(bike.compass) % 360).padStart(3, '0')}°</b>${bike.street ? ` <span>·</span> ${esc(bike.street)}` : ''}`;
  }
  fitViewport();
  labels.near = mode === 'bike' || mode === 'car';
  labels.setEnabled(mode !== 'penalty' && mode !== 'tram' && $('[data-layer=labels]').checked);
  setTramNight(env.nightF);
  if (tramNet) tramNet.update(dt, env.nightF);
  people.update(dt, focus.x, focus.z, camera.position.y);
  leaves.update(dt, focus.x, focus.z, camera.position.y);
  const fov = mode === 'bike' ? (photo.on ? photo.fov : 70) : mode === 'fly' ? 58 : mode === 'car' ? (car.cockpit ? 68 : 60) : mode === 'penalty' ? 46 : mode === 'tram' ? (tramGame.cabCam ? 62 : 52) : 50;
  if (camera.fov !== fov) camera.fov = fov;
  camera.near = near; camera.far = mode === 'bike' ? 25000 : 70000;
  // keep the 3D building visible beside the campus panel by shifting the view left
  const shift = campus && mode === 'explore' && vw > 0 && campus.panelWidth() < vw * 0.8 ? campus.panelWidth() / 2 : 0;
  if (shift > 0) camera.setViewOffset(vw, vh, shift, 0, vw, vh); else if (camera.view && camera.view.enabled) camera.clearViewOffset();
  camera.updateProjectionMatrix();
  boundary.update(time, dt, camera.position);
  if (mode === 'fly' && fly.bumped) { boundary.hit(fly.pos.x, fly.pos.y, fly.pos.z); fly.bumped = false; }
  if (mode === 'boat' && boat.bumped) { boundary.hit(boat.x, 6, boat.z); boat.bumped = false; }
  if (mode === 'bike' && bike.bumped) { boundary.hit(bike.x, 2, bike.z); bike.bumped = false; }
  if (mode === 'car' && car.bumped) { boundary.hit(car.x, 2, car.z); car.bumped = false; }
  env.update(time, focus, range, vh);
  labels.update();
  updateInfo();
  if (effects) {
    bloom.threshold = 1.45 - 0.7 * env.nightF; bloom.strength = 0.22 + 0.4 * env.nightF;
    composer.render();
  } else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
progress(100, 'Ready');
requestAnimationFrame(frame);
setTimeout(() => { $('#load').style.opacity = 0; setTimeout(() => $('#load').remove(), 700); showHint(); }, 150);
window.__dresden = { campus, people, leaves, tramNet, tramGame, photo, penalty, sportsWorld, startPenalty: (i = 0) => { nextPitch = sportsWorld.pitches[i].userData.pitch; setMode('penalty'); }, scene, camera, controls, world, env, fly, boat, bike, car, setMode, setSeason, flyTo, renderer, keys };
