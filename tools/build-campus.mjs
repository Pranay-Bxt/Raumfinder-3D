// Builds data/campus.json: TU Dresden buildings in the map, matched to OpenStreetMap buildings through the
// "cn_tud:token" tag (= the Campus Navigator building code). Floor numbers come from OSM indoor "level" tags.
// No floor plans or room data from navigator.tu-dresden.de are stored.
//   node tools/build-campus.mjs   (needs raw/v3_buildings.json and raw/v3_indoor.json from the data build)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, unproject } from '../src/proj.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tud = new Map(fs.readFileSync(path.join(ROOT, 'tools/tud-buildings.tsv'), 'utf8').trim().split('\n').map((l) => { const [id, name] = l.split('\t'); return [id.toLowerCase(), name]; }));
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'raw', f), 'utf8')).elements;
const osm = read('tud_tokens_geom.json'), indoorFile = fs.existsSync(path.join(ROOT, 'raw/v4_indoor.json')) ? 'v4_indoor.json' : 'v3_indoor.json', indoor = fs.existsSync(path.join(ROOT, 'raw', indoorFile)) ? read(indoorFile) : [];
const geom = (e) => (e.geometry || (e.members || []).filter((m) => m.role !== 'inner').flatMap((m) => m.geometry || [])).filter(Boolean).map((p) => project(p.lat, p.lon));
const pip = (p, r) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) ins = !ins; } return ins; };
const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(s / 2); };
/** a point inside the ring, as close to the centroid as possible */
function inside(r) {
  const c = r.reduce((s, p) => [s[0] + p[0] / r.length, s[1] + p[1] / r.length], [0, 0]);
  if (pip(c, r)) return c;
  let best = null, bd = 1e9;
  const x0 = Math.min(...r.map((p) => p[0])), x1 = Math.max(...r.map((p) => p[0])), z0 = Math.min(...r.map((p) => p[1])), z1 = Math.max(...r.map((p) => p[1]));
  for (let x = x0; x <= x1; x += 1.5) for (let z = z0; z <= z1; z += 1.5) if (pip([x, z], r)) { const d = Math.hypot(x - c[0], z - c[1]); if (d < bd) { bd = d; best = [x, z]; } }
  return best;
}
const EXCLUDE = /$^/; // every building on the user's list is included

const groups = new Map();
for (const e of osm) {
  const t = e.tags && e.tags['cn_tud:token']; if (!t) continue;
  const id = t.toLowerCase(), ring = geom(e);
  if (!tud.has(id) || ring.length < 3 || EXCLUDE.test(tud.get(id))) continue;
  (groups.get(id) || groups.set(id, []).get(id)).push({ e, ring, a: area(ring) });
}
// OSM indoor levels per building (+ the room outlines themselves)
const levels = new Map();
const KIND = { room: 'r', corridor: 'c', area: 'a' };
function parseLevels(str) {
  const out = [];
  for (const raw of String(str || '').split(';')) {
    const v = raw.trim(); let m;
    if (/^-?\d+$/.test(v)) out.push(+v);
    else if ((m = v.match(/^(-?\d+)-(-?\d+)$/)) && +m[2] - +m[1] <= 12) for (let l = +m[1]; l <= +m[2]; l++) out.push(l);
  }
  return out;
}
const rooms = {};
for (const f of indoor) {
  const g = geom(f); if (!g.length) continue;
  const c = g.reduce((s, p) => [s[0] + p[0] / g.length, s[1] + p[1] / g.length], [0, 0]);
  for (const [id, parts] of groups) {
    if (!parts.some((p) => pip(c, p.ring))) continue;
    const L = levels.get(id) || levels.set(id, { n: 0, set: new Set() }).get(id);
    L.n++;
    const kind = KIND[f.tags.indoor], pts = g.slice();
    if (kind && pts.length > 3) {
      if (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      if (pts.length >= 3 && area(pts) >= 1.2) {
        const flat = []; for (const q of pts) flat.push(+q[0].toFixed(1), +q[1].toFixed(1));
        const rec = [kind, f.tags.ref || '', f.tags.name || '', flat];
        const b = (rooms[id] ||= {});
        for (const lv of parseLevels(f.tags.level)) (b[lv] ||= []).push(rec);
      }
    }
    for (const v of String(f.tags.level || '').split(';')) if (/^-?\d+$/.test(v.trim())) L.set.add(+v);
    break;
  }
}
const out = [];
for (const [id, parts] of groups) {
  parts.sort((p, q) => q.a - p.a);
  const pts = parts.slice(0, 6).map((p) => inside(p.ring)).filter(Boolean).map(([x, z]) => unproject(x, z).map((v) => +v.toFixed(5)));
  const tags = parts[0].e.tags;
  const entry = { id, code: id.toUpperCase(), name: tud.get(id), address: tags['addr:street'] ? `${tags['addr:street']} ${tags['addr:housenumber'] || ''}`.trim() : '', points: pts };
  const L = levels.get(id);
  if (L && L.n >= 20 && L.set.size) {
    const lo = Math.min(...L.set), hi = Math.max(...L.set);
    entry.floors = []; for (let l = hi; l >= lo; l--) entry.floors.push({ id: l < 0 ? String(l) : String(l).padStart(2, '0'), label: 'Etage ' + l });
    entry.defaultFloor = entry.floors.some((f) => f.id === '00') ? '00' : entry.floors[0].id;
  }
  out.push(entry);
}
out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
// room outlines only for buildings that have a real floor list
const indoorOut = {};
for (const e of out) if (e.floors && rooms[e.id]) indoorOut[e.id] = rooms[e.id];
fs.writeFileSync(path.join(ROOT, 'data/indoor.json'), JSON.stringify({
  source: 'OpenStreetMap contributors (ODbL), indoor mapping. Rooms are community-mapped and may be incomplete.', levels: indoorOut,
}));
const nRooms = Object.values(indoorOut).reduce((q, b) => q + Object.values(b).reduce((r, a) => r + a.length, 0), 0);
console.log('indoor:', Object.keys(indoorOut).length, 'buildings,', nRooms, 'room/corridor/area outlines');
// Willers-Bau floors are confirmed against the navigator itself (Etage 3 .. -1)
fs.writeFileSync(path.join(ROOT, 'data/campus.json'), JSON.stringify({
  source: 'TU Dresden Campus Navigator', base: 'https://navigator.tu-dresden.de/',
  note: 'Building codes: OpenStreetMap cn_tud:token. Floor numbers: OSM indoor level tags. Floor plans and room data are not stored; the app embeds the official navigator live.',
  buildings: out,
}, null, 1));
console.log(out.length, 'buildings;', out.filter((b) => b.floors).length, 'with floor lists:', out.filter((b) => b.floors).map((b) => `${b.code}(${b.floors[b.floors.length - 1].id}..${b.floors[0].id})`).join(' '));
