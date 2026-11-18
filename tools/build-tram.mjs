// Builds data/tram.json: the real DVB tram line 11 (OpenStreetMap route relation) as one ordered
// track polyline in map metres, plus every stop with its distance along the track.
//   node tools/build-tram.mjs            (uses cached raw/tram11_*.json when present)
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../src/proj.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw'), OUT = path.join(ROOT, 'data');
const REL = 2817120; // Tram 11: Zschertnitz => Bühlau
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

async function overpass(file, q) {
  const f = path.join(RAW, file);
  if (existsSync(f)) return JSON.parse(await fs.readFile(f, 'utf8'));
  for (let a = 0; a < 8; a++) {
    try {
      const res = await fetch(ENDPOINTS[a % 3], { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'city-3d-map-builder/0.1' }, body: 'data=' + encodeURIComponent(q) });
      const text = await res.text();
      const json = JSON.parse(text);
      await fs.writeFile(f, text);
      return json;
    } catch (e) { await new Promise((r) => setTimeout(r, 3000 + a * 2000)); }
  }
  throw new Error('overpass unavailable');
}

const rel = (await overpass('tram11_rel.json', `[out:json][timeout:90];relation(${REL});out geom;`)).elements[0];
const stopIds = rel.members.filter((m) => m.type === 'node' && /stop/.test(m.role)).map((m) => m.ref);
const names = (await overpass('tram11_names.json', `[out:json][timeout:60];node(id:${stopIds.join(',')});out tags;`)).elements;
const nameOf = Object.fromEntries(names.map((e) => [e.id, (e.tags || {}).name || '']));

// ---- ordered track polyline from the way members
const P = (g) => project(g.lat, g.lon);
let line = [];
let gaps = 0;
for (const m of rel.members) {
  if (m.type !== 'way' || m.role !== '' || !m.geometry) continue;
  let pts = m.geometry.filter(Boolean).map(P);
  if (pts.length < 2) continue;
  if (line.length) {
    const end = line[line.length - 1];
    const dS = Math.hypot(pts[0][0] - end[0], pts[0][1] - end[1]), dE = Math.hypot(pts[pts.length - 1][0] - end[0], pts[pts.length - 1][1] - end[1]);
    if (dE < dS) pts = pts.reverse();
    if (Math.min(dS, dE) > 8) gaps++;
    if (Math.min(dS, dE) < 0.5) pts = pts.slice(1);
  }
  line.push(...pts);
}
// drop consecutive duplicates and tiny zig-zags
line = line.filter((p, i) => i === 0 || Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) > 0.2);
const cum = [0];
for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));

function along(x, z) {
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const ax = line[i][0], az = line[i][1], dx = line[i + 1][0] - ax, dz = line[i + 1][1] - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { d, s: cum[i] + Math.sqrt(l2) * t };
  }
  return best;
}

// ---- stops in travel order; the two platforms of one stop (same name, consecutive) become one stop
const stops = [];
for (const m of rel.members) {
  if (m.type !== 'node' || !/stop/.test(m.role)) continue;
  const name = nameOf[m.ref] || '?', [x, z] = project(m.lat, m.lon), a = along(x, z);
  const last = stops[stops.length - 1];
  if (last && last.name === name && Math.abs(last.s - a.s) < 220) { last.s = (last.s + a.s) / 2; continue; }
  stops.push({ name, s: a.s, off: a.d, x, z });
}
stops.sort((p, q) => p.s - q.s);

// ---- keep what is inside the map (+ margin)
const meta = JSON.parse(await fs.readFile(path.join(OUT, 'meta.json'), 'utf8'));
const { minX, maxX, minZ, maxZ } = meta.ext, inside = (p, m = 0) => p[0] > minX + m && p[0] < maxX - m && p[1] > minZ + m && p[1] < maxZ - m;
let i0 = 0, i1 = line.length - 1;
while (i0 < line.length && !inside(line[i0], 20)) i0++;
while (i1 > i0 && !inside(line[i1], 20)) i1--;
const sA = cum[i0], sB = cum[i1];
const poly = [], flat = [];
for (let i = i0; i <= i1; i++) flat.push(Math.round(line[i][0] * 100) / 100, Math.round(line[i][1] * 100) / 100);
const kept = stops.filter((s) => s.s >= sA + 30 && s.s <= sB - 30).map((s) => ({ name: s.name, s: Math.round((s.s - sA) * 10) / 10, x: Math.round(s.x * 10) / 10, z: Math.round(s.z * 10) / 10 }));

await fs.writeFile(path.join(OUT, 'tram.json'), JSON.stringify({ line: '11', operator: 'DVB', relation: REL, length: Math.round(sB - sA), pts: flat, stops: kept }));
console.log(`line 11: ${Math.round(sB - sA)} m of track in the map, ${line.length} points, ${gaps} gaps > 8 m, ${kept.length} stops`);
for (const s of kept) console.log(String(Math.round(s.s)).padStart(6), s.name);
