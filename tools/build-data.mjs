// Fetches OpenStreetMap data for central Dresden (Overpass API) and converts it
// into compact JSON files the viewer loads from /data.
//   node tools/build-data.mjs            (uses cached raw/*.json when present)
//   node tools/build-data.mjs --refresh  (re-download)
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import earcut from 'earcut';
import { project, unproject, ORIGIN } from '../src/proj.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw');
const OUT = path.join(ROOT, 'data');
const REFRESH = process.argv.includes('--refresh');

// Central Dresden plus every TU Dresden building in the city (south to Nickerner Weg, east to Dobritz).
const BBOX = { s: 50.988, w: 13.6955, n: 51.076, e: 13.820 };
const TAG = 'v4_';
// area rendered from Saxony's official LoD2 3D building models (real roof shapes and measured heights)
const LOD2_AREA = { lat: 51.0299, lon: 13.7491, radius: 1500 };
const B = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const queriesFor = (B) => ({
  buildings: `[out:json][timeout:180];(way["building"](${B});relation["building"](${B});way["building:part"](${B});relation["building:part"](${B}););out tags geom qt;`,
  roads: `[out:json][timeout:180];(way["highway"](${B});way["railway"~"^(rail|tram|light_rail)$"](${B}););out tags geom qt;`,
  land: `[out:json][timeout:180];(
    way["landuse"](${B});relation["landuse"](${B});
    way["natural"~"^(water|wood|scrub|heath|grassland|sand|beach)$"](${B});relation["natural"~"^(water|wood|scrub|heath|grassland|sand|beach)$"](${B});
    way["leisure"~"^(park|garden|pitch|playground|recreation_ground|track)$"](${B});relation["leisure"~"^(park|garden|pitch|playground|recreation_ground|track)$"](${B});
    way["waterway"~"^(riverbank|dock)$"](${B});relation["waterway"~"^(riverbank|dock)$"](${B});
    way["amenity"="parking"](${B});
    way["highway"="pedestrian"]["area"="yes"](${B});relation["highway"="pedestrian"](${B});
  );out tags geom qt;`,
  pois: `[out:json][timeout:120];(
    node["place"~"^(suburb|quarter|neighbourhood)$"](${B});
    nwr["tourism"~"^(attraction|museum|gallery|viewpoint)$"]["name"](${B});
    nwr["historic"]["name"](${B});
    nwr["amenity"~"^(place_of_worship|theatre|university|townhall|arts_centre)$"]["name"](${B});
    node["railway"~"^(station|halt|tram_stop)$"]["name"](${B});
    node["natural"="tree"](${B});
  );out tags center qt;`,
});

async function overpass(name, q) {
  const file = path.join(RAW, TAG + name + '.json');
  if (!REFRESH && existsSync(file)) return JSON.parse(await fs.readFile(file, 'utf8'));
  let lastErr;
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      console.log(`  fetching ${name} from ${new URL(url).host} ...`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'city-3d-map-builder/0.1' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const json = JSON.parse(text);
      if (!json.elements) throw new Error('no elements');
      await fs.writeFile(file, text);
      return json;
    } catch (e) {
      lastErr = e;
      console.log(`    failed (${e.message}), retrying`);
      await new Promise((r) => setTimeout(r, Math.min(60000, 5000 + attempt * 6000)));
    }
  }
  throw lastErr;
}

// the area is large: download each query in 2 x 2 tiles and merge (ways crossing a tile edge come back whole)
const TILES = [];
for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) TILES.push(`${BBOX.s + ((BBOX.n - BBOX.s) * j) / 2},${BBOX.w + ((BBOX.e - BBOX.w) * i) / 2},${BBOX.s + ((BBOX.n - BBOX.s) * (j + 1)) / 2},${BBOX.w + ((BBOX.e - BBOX.w) * (i + 1)) / 2}`);
async function overpassTiled(name, key) {
  const seen = new Set(), elements = [];
  for (let i = 0; i < TILES.length; i++) {
    const json = await overpass(`${name}_t${i}`, queriesFor(TILES[i])[key]);
    for (const e of json.elements) { const k = e.type + e.id; if (!seen.has(k)) { seen.add(k); elements.push(e); } }
  }
  return { elements };
}

// ---------- geometry helpers ----------
const r2 = (v) => Math.round(v * 100) / 100;
const P = (g) => { const [x, z] = project(g.lat, g.lon); return [r2(x), r2(z)]; };
function ringOf(geom) {
  const pts = geom.filter(Boolean).map(P);
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) pts.pop();
  }
  // drop consecutive duplicates
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}
function isClosed(geom) {
  const a = geom[0], b = geom[geom.length - 1];
  return geom.length > 3 && a && b && a.lat === b.lat && a.lon === b.lon;
}
function signedArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return s / 2;
}
const area = (r) => Math.abs(signedArea(r));
function centroid(r) {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}
function pip(pt, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
/** stitch relation member ways into closed rings */
function stitch(geoms) {
  const key = (g) => g.lat.toFixed(7) + ',' + g.lon.toFixed(7);
  const segs = geoms.filter((g) => g && g.length > 1).map((g) => g.slice());
  const rings = [];
  while (segs.length) {
    let cur = segs.pop();
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 5000) {
      const end = key(cur[cur.length - 1]);
      const i = segs.findIndex((s) => key(s[0]) === end || key(s[s.length - 1]) === end);
      if (i < 0) break;
      let s = segs.splice(i, 1)[0];
      if (key(s[0]) !== end) s = s.reverse();
      cur = cur.concat(s.slice(1));
    }
    if (cur.length > 3 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}
/** element -> [{outer, holes}] in projected metres */
function polygonsOf(el) {
  if (el.type === 'way') {
    if (!el.geometry || !isClosed(el.geometry)) return [];
    const outer = ringOf(el.geometry);
    return outer.length >= 3 ? [{ outer, holes: [] }] : [];
  }
  if (el.type === 'relation' && el.members) {
    const outers = stitch(el.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry)).map(ringOf).filter((r) => r.length >= 3);
    const inners = stitch(el.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => m.geometry)).map(ringOf).filter((r) => r.length >= 3);
    const polys = outers.map((outer) => ({ outer, holes: [] }));
    for (const h of inners) {
      const host = polys.find((p) => pip(h[0], p.outer));
      if (host) host.holes.push(h);
    }
    return polys;
  }
  return [];
}
const flat = (r) => { const o = []; for (const p of r) o.push(p[0], p[1]); return o; };

// ---------- colours ----------
const NAMED = { white: '#f2f0ea', black: '#2b2b2b', grey: '#9a9a9a', gray: '#9a9a9a', lightgrey: '#c9c9c7', lightgray: '#c9c9c7', darkgrey: '#5f6165', darkgray: '#5f6165', red: '#a8402f', brown: '#7a5137', yellow: '#e2c873', beige: '#dccfae', orange: '#cf8a4a', green: '#6f9a72', blue: '#6a8fb5', silver: '#b4b8bc', maroon: '#7a2f2a', tan: '#cdb38b', cream: '#eee4c8', pink: '#e2b8b0', sandstone: '#cdb892', gold: '#c9a23f', ivory: '#eee9d8', khaki: '#c8bb8a' };
function parseColor(v) {
  if (!v) return null;
  v = String(v).trim().toLowerCase().replace(/\s|_/g, '');
  if (NAMED[v]) v = NAMED[v];
  let m = v.match(/^#([0-9a-f]{6})$/);
  if (m) return parseInt(m[1], 16);
  m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return parseInt(m[1].split('').map((c) => c + c).join(''), 16);
  return null;
}
const hex = (s) => parseInt(s.slice(1), 16);
const WALLS = ['#e6dcc6', '#ddd3bd', '#efe7d6', '#d9cfb8', '#e9dfc4', '#d6d2c8', '#e2d6b6', '#cfc7b6', '#ead9b8', '#d8d8d2', '#e0cba6', '#c9c2b2'].map(hex);
const ROOF_PITCHED = ['#9a4a36', '#8a4332', '#a3553d', '#7d4a3c', '#93503f', '#6b4d44', '#5a5d63', '#845040'].map(hex);
const ROOF_FLAT = ['#9b9b99', '#8c8e90', '#a6a39c', '#7f8387', '#94918b'].map(hex);
const WALL_MAT = { sandstone: '#c4b08a', stone: '#bdb39d', brick: '#a0553a', glass: '#8fb0c0', concrete: '#b5b3ad', plaster: '#e2d8c2', wood: '#9a7650', metal: '#a2a7ab', steel: '#a2a7ab' };
const ROOF_MAT = { roof_tiles: '#9c4a35', tile: '#9c4a35', tiles: '#9c4a35', slate: '#4a4d55', copper: '#6fae9a', metal: '#8a9096', glass: '#9fc0cc', concrete: '#9a9a98', tar_paper: '#55565a', gravel: '#9a968c', stone: '#b8a988', sandstone: '#b8a988', grass: '#7c9a63' };

// ---------- aerial imagery (Saxony GeoSN DOP20, open data) ----------
const ORTHO = { NX: 5, NY: 5, TW: 2048, tiles: [] };
async function loadOrtho() {
  const dir = path.join(RAW, 'ortho');
  await fs.mkdir(dir, { recursive: true });
  const dLon = (BBOX.e - BBOX.w) / ORTHO.NX, dLat = (BBOX.n - BBOX.s) / ORTHO.NY;
  ORTHO.dLon = dLon; ORTHO.dLat = dLat;
  ORTHO.TH = Math.round((ORTHO.TW * dLat * 111230) / (dLon * 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)));
  for (let iy = 0; iy < ORTHO.NY; iy++)
    for (let ix = 0; ix < ORTHO.NX; ix++) {
      const file = path.join(dir, TAG + 't_' + ix + '_' + iy + '.jpg');
      if (REFRESH || !existsSync(file)) {
        const w = BBOX.w + ix * dLon, s0 = BBOX.s + iy * dLat;
        const url = 'https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=sn_dop_020&STYLES=&CRS=CRS:84&BBOX=' + [w, s0, w + dLon, s0 + dLat].join(',') + '&WIDTH=' + ORTHO.TW + '&HEIGHT=' + ORTHO.TH + '&FORMAT=image/jpeg';
        console.log('  aerial tile ' + ix + ',' + iy);
        const res = await fetch(url, { headers: { 'User-Agent': 'city-3d-map-builder/0.1' } });
        if (!res.ok || !(res.headers.get('content-type') || '').includes('jpeg')) throw new Error('aerial tile failed: HTTP ' + res.status);
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
        await new Promise((r) => setTimeout(r, 400));
      }
      const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      ORTHO.tiles[iy * ORTHO.NX + ix] = { data, w: info.width, h: info.height };
    }
  ORTHO.ok = true;
}
function orthoAt(lat, lon) {
  const fx = (lon - BBOX.w) / ORTHO.dLon, fy = (lat - BBOX.s) / ORTHO.dLat;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix >= ORTHO.NX || iy >= ORTHO.NY) return null;
  const t = ORTHO.tiles[iy * ORTHO.NX + ix];
  const px = Math.min(t.w - 1, Math.floor((fx - ix) * t.w)), py = Math.min(t.h - 1, Math.floor((1 - (fy - iy)) * t.h));
  const i = (py * t.w + px) * 3;
  return [t.data[i], t.data[i + 1], t.data[i + 2]];
}
/** representative roof colour of a footprint, from the aerial photo */
function roofColourFromPhoto(b) {
  const pts = [b.c];
  const step = Math.max(1, Math.floor(b.outer.length / 10));
  for (let i = 0; i < b.outer.length; i += step) {
    for (const k of [0.35, 0.65]) {
      const q = [b.c[0] + (b.outer[i][0] - b.c[0]) * k, b.c[1] + (b.outer[i][1] - b.c[1]) * k];
      if (pip(q, b.outer) && !b.holes.some((h) => pip(q, h))) pts.push(q);
    }
  }
  const cols = [];
  for (const q of pts) { const [lat, lon] = unproject(q[0], q[1]); const c = orthoAt(lat, lon); if (c) cols.push(c); }
  if (cols.length < 3) return null;
  cols.sort((a, b2) => (a[0] + a[1] + a[2]) - (b2[0] + b2[1] + b2[2]));
  const mid = cols.slice(Math.floor(cols.length * 0.3), Math.ceil(cols.length * 0.8));
  let r = 0, g = 0, bl = 0;
  for (const c of mid) { r += c[0]; g += c[1]; bl += c[2]; }
  r /= mid.length; g /= mid.length; bl /= mid.length;
  return photoColour(r, g, bl);
}
/** photo pixel average -> plausible roof colour: tame saturation, normalise brightness */
function photoColour(r, g, bl) {
  const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), avg = (r + g + bl) / 3;
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  if (sat > 0.42) { const f = 0.42 / sat; r = avg + (r - avg) * f; g = avg + (g - avg) * f; bl = avg + (bl - avg) * f; }
  // keep hue, normalise brightness (the photo has sunlit and shadowed sides)
  const l = (Math.max(r, g, bl) + Math.min(r, g, bl)) / 2;
  const k = Math.min(150, Math.max(70, l)) / Math.max(1, l);
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (cl(r) << 16) | (cl(g) << 8) | cl(bl);
}

// ---------- buildings ----------
const num = (v) => {
  if (v == null) return NaN;
  const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return NaN;
  let x = +m[0];
  if (/ft|'/.test(String(v))) x *= 0.3048;
  return x;
};
const SHAPES = { flat: 0, gabled: 1, hipped: 2, pyramidal: 3, dome: 4, onion: 5, skillion: 6, 'half-hipped': 2, mansard: 2, gambrel: 1, cone: 3, round: 1, saltbox: 1, 'side_hipped': 2 };
const SMALL = new Set(['garage', 'garages', 'shed', 'hut', 'carport', 'roof', 'kiosk', 'service', 'toilets', 'container', 'bicycle_shed', 'greenhouse', 'transformer_tower']);
const HOUSE = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'farm', 'cabin']);
const FLATTISH = new Set(['industrial', 'warehouse', 'retail', 'supermarket', 'office', 'commercial', 'parking', 'train_station', 'transportation', 'hangar', 'school', 'university', 'hospital', 'sports_hall', 'stadium', 'kindergarten', 'bridge']);
const SACRED = new Set(['church', 'cathedral', 'chapel', 'castle', 'palace', 'temple', 'synagogue', 'monastery']);

function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return n >>> 0; }

function makeBuilding(el, poly, isPart) {
  const t = el.tags || {};
  const kind = isPart ? (t['building:part'] !== 'yes' ? t['building:part'] : t.building || 'part') : t.building;
  const A = area(poly.outer);
  if (A < 2) return null;
  const hid = hash(el.id);
  let flags = isPart ? 4 : 0;

  let minH = num(t.min_height);
  if (isNaN(minH)) { const ml = num(t['building:min_level']); minH = isNaN(ml) ? 0 : ml * 3.1; }

  let shape = t['roof:shape'] ? (SHAPES[t['roof:shape']] ?? 0) : -1;
  let rh = num(t['roof:height']);
  if (isNaN(rh)) { const rl = num(t['roof:levels']); rh = !isNaN(rl) && rl > 0 ? rl * 2.8 : NaN; }
  if (t['roof:orientation'] === 'across') flags |= 8;

  let levels = num(t['building:levels']);
  let total = num(t.height) || num(t['building:height']);
  let wallH;

  // roof choice when untagged
  if (shape === -1) {
    if (!isPart && !poly.holes.length && !SMALL.has(kind) && !FLATTISH.has(kind)) {
      if (HOUSE.has(kind)) { shape = 1; flags |= 16; }
      else if (A > 40 && A < 1200) { shape = 2; flags |= 16; }
      else shape = 0;
    } else shape = 0;
  }
  if (poly.holes.length && (shape === 1 || shape === 2 || shape === 6 || shape >= 3)) shape = 0;
  if (shape === 0) rh = 0;
  else if (isNaN(rh)) rh = -1; // viewer derives from footprint width

  if (!isNaN(total) && total > 0) {
    flags |= 1;
    const r = rh < 0 ? Math.min(total * 0.3, 5) : rh;
    wallH = Math.max(total - r, minH + Math.min(1, total - minH));
    if (rh < 0) rh = r2(total - wallH);
    else if (wallH + rh > total + 0.01) rh = Math.max(0, r2(total - wallH));
  } else if (!isNaN(levels) && levels > 0) {
    flags |= 2;
    wallH = levels * 3.1 + (isPart ? 0 : 0.6);
  } else {
    let lv;
    if (SMALL.has(kind)) lv = 0.9;
    else if (HOUSE.has(kind)) lv = 2;
    else if (SACRED.has(kind)) lv = 5.5;
    else if (kind === 'apartments' || kind === 'residential' || kind === 'dormitory' || kind === 'hotel') lv = 5;
    else if (kind === 'industrial' || kind === 'warehouse') lv = 2.6;
    else if (kind === 'train_station') lv = 4;
    else if (FLATTISH.has(kind) || kind === 'civic' || kind === 'public' || kind === 'government') lv = 4;
    else lv = A < 30 ? 0.9 : A < 120 ? 2 : 4;
    wallH = lv * 3.1 + (isPart ? 0 : 0.4);
    levels = 0;
    if (minH > 0) wallH = minH + Math.max(3, wallH - minH);
  }
  if (wallH <= minH) wallH = minH + 0.5;

  const historic = t.historic || SACRED.has(kind) || t.heritage || t.tourism === 'attraction';
  const style = historic ? 2 : SMALL.has(kind) || kind === 'industrial' || kind === 'warehouse' || kind === 'parking' || kind === 'hangar' ? 3 : (t['building:material'] === 'glass' || ((kind === 'office' || kind === 'commercial' || kind === 'retail' || kind === 'supermarket') && shape === 0)) ? 1 : 0;
  const wcTag = parseColor(t['building:colour']) != null || !!WALL_MAT[t['building:material']];
  const rcTag = parseColor(t['roof:colour']) != null || !!ROOF_MAT[t['roof:material']];
  let wc = parseColor(t['building:colour']) ?? (WALL_MAT[t['building:material']] ? hex(WALL_MAT[t['building:material']]) : null);
  if (wc == null) wc = historic ? hex(['#c2b08c', '#b5a482', '#c9b995'][hid % 3]) : SMALL.has(kind) ? hex('#bdb8ad') : WALLS[hid % WALLS.length];
  let rc = parseColor(t['roof:colour']) ?? (ROOF_MAT[t['roof:material']] ? hex(ROOF_MAT[t['roof:material']]) : null);
  if (rc == null) {
    if (shape === 4 || shape === 5) rc = hex('#7fae9c');
    else if (shape === 0) rc = ROOF_FLAT[(hid >>> 4) % ROOF_FLAT.length];
    else rc = historic ? hex(['#8a4332', '#6fae9a', '#55585e'][(hid >>> 4) % 3]) : ROOF_PITCHED[(hid >>> 4) % ROOF_PITCHED.length];
  }

  return {
    id: el.id, rel: el.type === 'relation', name: t.name || 0, kind: kind || 'yes', A,
    wallH: r2(wallH), minH: r2(minH), rh: r2(rh), shape, flags, levels: isNaN(levels) ? 0 : Math.round(levels), wc, rc,
    outer: poly.outer, holes: poly.holes, c: centroid(poly.outer), style, wcTag, rcTag, generic: !t.building || t.building === 'yes', historic: !!historic,
  };
}

// ---------- official cadastre (GeoSN ALKIS, open data) ----------
// Adds buildings that exist in Saxony's official building register but are
// missing from OpenStreetMap (garages, sheds, back-yard and garden houses...).
const ALKIS_URL = 'https://geodienste.sachsen.de/aaa/public_alkis/vereinf/wfs';
const ALKIS_KIND = [
  [/Überdachung|Unterstand|Wartehalle|Carport/, 'roof'],
  [/Garage/, 'garage'],
  [/Gartenhaus|Laube|Schuppen|Gewächshaus|Hütte|Kiosk|Toilette|Trafo|Umform|Pumpstation|Stall|Scheune|Nebengebäude|Wochenendhaus/, 'shed'],
  [/Kirche|Kapelle|Gotteshaus|Synagoge|Moschee/, 'church'],
  [/Fabrik|Werkstatt|Lager|Industrie|Betriebsgebäude|Produktion|Speicher|Gewerbe|Kraftwerk|Heizwerk/, 'industrial'],
  [/Schule|Hochschule|Universität|Forschung/, 'school'],
  [/Büro|Verwaltung|Geschäft|Handel|Bank|Kaufhaus|Einkauf/, 'commercial'],
  [/Wohn/, 'residential'],
];
function alkisKind(f) { for (const [re, k] of ALKIS_KIND) if (re.test(f)) return k; return 'yes'; }

/** even-odd scanline fill of rings (projected metres) into a 1 m bitmap; returns covered / total px */
function makeRaster() {
  const W = ext.maxX - ext.minX + 200, H = ext.maxZ - ext.minZ + 200, ox = ext.minX - 100, oz = ext.minZ - 100;
  const bits = new Uint8Array(W * H);
  function scan(rings, fn) {
    let z0 = Infinity, z1 = -Infinity;
    for (const r of rings) for (const p of r) { z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    for (let row = Math.max(0, Math.floor(z0 - oz)); row <= Math.min(H - 1, Math.ceil(z1 - oz)); row++) {
      const zc = row + oz + 0.5, xs = [];
      for (const r of rings)
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const a = r[i], b = r[j];
          if ((a[1] > zc) !== (b[1] > zc)) xs.push(a[0] + ((zc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let col = Math.max(0, Math.round(xs[k] - ox)); col < Math.min(W, Math.round(xs[k + 1] - ox)); col++) fn(row * W + col);
    }
  }
  return {
    fill(rings) { scan(rings, (i) => { bits[i] = 1; }); },
    coverage(rings) { let t = 0, c = 0; scan(rings, (i) => { t++; c += bits[i]; }); return t ? c / t : 1; },
  };
}

function parseAlkis(xml) {
  const out = [];
  for (const m of xml.split('<wfs:member>').slice(1)) {
    const tag = (n) => { const r = m.match(new RegExp('<' + n + '>([^<]*)</' + n + '>')); return r ? r[1] : ''; };
    const polys = [];
    for (const pg of m.split('<gml:Polygon').slice(1)) {
      const ring = (s) => {
        const pl = s.match(/<gml:posList[^>]*>([^<]*)<\/gml:posList>/);
        if (!pl) return null;
        const v = pl[1].trim().split(/\s+/).map(Number), pts = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push(v.slice(i, i + 2));
        return pts;
      };
      const ext0 = pg.split('<gml:interior>')[0], outer = ring(ext0);
      if (!outer) continue;
      const holes = pg.split('<gml:interior>').slice(1).map(ring).filter(Boolean);
      polys.push({ outer, holes });
    }
    out.push({ oid: tag('oid'), funktion: tag('funktion'), name: tag('name'), floors: +tag('anzahlgs') || 0, rellage: tag('rellage'), addr: tag('lagebeztxt'), polys });
  }
  return out;
}

async function addCadastreBuildings(buildings) {
  const { toUTM33, fromUTM33 } = await import('./utm.mjs');
  const dir = path.join(RAW, 'alkis');
  await fs.mkdir(dir, { recursive: true });
  const a = toUTM33(BBOX.s, BBOX.w), b = toUTM33(BBOX.n, BBOX.e), c = toUTM33(BBOX.s, BBOX.e), d = toUTM33(BBOX.n, BBOX.w);
  const E0 = Math.floor(Math.min(a[0], d[0]) / 100) * 100, E1 = Math.ceil(Math.max(b[0], c[0]) / 100) * 100;
  const N0 = Math.floor(Math.min(a[1], c[1]) / 100) * 100, N1 = Math.ceil(Math.max(b[1], d[1]) / 100) * 100;
  const T = 600, feats = new Map();
  const tiles = [];
  for (let e = E0; e < E1; e += T) for (let nn = N0; nn < N1; nn += T) tiles.push([e, nn]);
  let fetched = 0;
  for (const [e, nn] of tiles) {
    const file = path.join(dir, `t_${e}_${nn}.xml`);
    if (REFRESH || !existsSync(file)) {
      const url = `${ALKIS_URL}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ave:GebaeudeBauwerk&COUNT=20000&BBOX=${e},${nn},${e + T},${nn + T},urn:ogc:def:crs:EPSG::25833`;
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'city-3d-map-builder/0.1' } });
          const text = await res.text();
          if (!res.ok || !text.includes('FeatureCollection')) throw new Error('HTTP ' + res.status);
          await fs.writeFile(file, text);
          ok = true;
        } catch (err) { await new Promise((r) => setTimeout(r, 2000 + attempt * 2000)); if (attempt === 3) throw err; }
      }
      fetched++;
      if (fetched % 10 === 0) console.log(`  cadastre tiles ${fetched} / ${tiles.length}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const f of parseAlkis(await fs.readFile(file, 'utf8'))) feats.set(f.oid, f); // tiles overlap at edges: dedupe by id
  }
  console.log(`  ${feats.size} buildings in the official cadastre`);

  // rasterise every OpenStreetMap building on the ground, then keep cadastre buildings that are mostly uncovered
  const ras = makeRaster();
  for (const bd of buildings) if (bd.minH < 2.6) ras.fill([bd.outer, ...bd.holes]);
  // tagged heights near each point, for estimating untagged neighbours
  const HC = 80, hgrid = new Map();
  for (const bd of buildings) if (bd.flags & 3 && !(bd.flags & 4)) {
    const k = Math.floor(bd.c[0] / HC) + ',' + Math.floor(bd.c[1] / HC);
    (hgrid.get(k) || hgrid.set(k, []).get(k)).push(bd.wallH);
  }
  const nearH = (p) => {
    const gx = Math.floor(p[0] / HC), gz = Math.floor(p[1] / HC), hs = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const h of hgrid.get(gx + i + ',' + (gz + j)) || []) hs.push(h);
    if (hs.length < 3) return null;
    hs.sort((x, y) => x - y);
    return hs[hs.length >> 1];
  };
  const toLocal = (pts) => {
    const r = pts.map(([E, N]) => { const [lat, lon] = fromUTM33(E, N); const [x, z] = project(lat, lon); return [r2(x), r2(z)]; });
    const q = r[0], l = r[r.length - 1];
    if (q[0] === l[0] && q[1] === l[1]) r.pop();
    return r.filter((p, i) => i === 0 || p[0] !== r[i - 1][0] || p[1] !== r[i - 1][1]);
  };
  let added = 0, idn = 0, withFloors = 0, skippedCovered = 0;
  const reasons = {};
  for (const f of feats.values()) {
    if (/unter/i.test(f.rellage)) continue; // underground
    for (const pg of f.polys) {
      const outer = toLocal(pg.outer), holes = pg.holes.map(toLocal).filter((h) => h.length >= 3);
      if (outer.length < 3 || area(outer) < 6) continue;
      if (!inExt(centroid(outer))) continue;
      ALKIS_INDEX.push({ outer, addr: f.addr, funktion: f.funktion, name: f.name, c: centroid(outer) });
      if (ras.coverage([outer, ...holes]) > 0.3) { skippedCovered++; continue; }
      const kind = alkisKind(f.funktion);
      const tags = { building: kind };
      if (f.floors > 0) tags['building:levels'] = String(f.floors);
      if (f.name) tags.name = f.name;
      const bd = makeBuilding({ id: -(++idn), type: 'way', tags }, { outer, holes }, false);
      if (!bd) continue;
      if (f.floors > 0) withFloors++;
      else if (kind === 'yes' || kind === 'residential' || kind === 'commercial') {
        // no storey count: use the typical height of mapped buildings around it
        const h = nearH(bd.c);
        if (h && bd.A > 60) bd.wallH = r2(Math.min(h, Math.max(4, Math.sqrt(bd.A) * 1.4)));
      }
      bd.flags |= 128;
      ras.fill([outer, ...holes]); // multi-polygon features must not double up
      buildings.push(bd);
      added++;
      reasons[kind] = (reasons[kind] || 0) + 1;
    }
  }
  console.log(`  added ${added} buildings from the cadastre (${withFloors} with official storey counts); ${skippedCovered} already in OpenStreetMap`);
  console.log('  added by use:', JSON.stringify(reasons));
  return added;
}

// ---------- official LoD2 3D building models (GeoSN, open data) ----------
const ALKIS_INDEX = [];
const LOD2_SHARE = 'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/AyJqXpJAZJXomCb/';
const ROOF_TYPE = { 1000: [0, 'flat'], 2100: [6, 'skillion'], 2200: [6, 'staggered skillion'], 3100: [1, 'gabled'], 3200: [2, 'hipped'], 3300: [2, 'half-hipped'], 3400: [2, 'mansard'], 3500: [3, 'pyramidal'], 3600: [3, 'conical'], 3700: [4, 'dome'], 3800: [1, 'sawtooth'], 3900: [1, 'arched'], 4000: [3, 'tower'], 5000: [1, 'mixed'], 9999: [1, 'other'] };

function triangulate3D(ring, holes) {
  // Newell normal -> project onto the dominant plane -> earcut
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const [u, v] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [0, 2] : [0, 1];
  const pts = [ring, ...holes], flat2 = [], hIdx = [], all = [];
  for (const r of pts) { if (all.length) hIdx.push(all.length); for (const p of r) { flat2.push(p[u], p[v]); all.push(p); } }
  return { verts: all, tris: earcut(flat2, hIdx.length ? hIdx : null), normal: [nx, ny, nz] };
}

async function addLod2Buildings(buildings) {
  const { toUTM33, fromUTM33 } = await import('./utm.mjs');
  const [cx, cz] = project(LOD2_AREA.lat, LOD2_AREA.lon), R = LOD2_AREA.radius;
  const [cE, cN] = toUTM33(LOD2_AREA.lat, LOD2_AREA.lon);
  const dir = path.join(RAW, 'lod2');
  await fs.mkdir(dir, { recursive: true });
  const tiles = new Set();
  for (const dx of [-R, 0, R]) for (const dz of [-R, 0, R]) tiles.add(Math.floor((cE + dx) / 2000) * 2 + '_' + Math.floor((cN + dz) / 2000) * 2);
  const files = [];
  for (const t of tiles) {
    const zip = path.join(dir, t + '.zip'), out = path.join(dir, t);
    if (!existsSync(zip)) {
      console.log('  downloading 3D tile ' + t);
      const res = await fetch(LOD2_SHARE + `lod2_33${t}_2_sn_citygml.zip`, { headers: { 'User-Agent': 'city-3d-map-builder/0.1' } });
      if (!res.ok) throw new Error('3D tile ' + t + ': HTTP ' + res.status);
      await fs.writeFile(zip, Buffer.from(await res.arrayBuffer()));
    }
    if (!existsSync(out)) {
      await fs.mkdir(out, { recursive: true });
      const { execFileSync } = await import('node:child_process');
      execFileSync('unzip', ['-o', '-q', zip, '-d', out]);
    }
    for (const f of await fs.readdir(out)) if (f.endsWith('.gml')) files.push(path.join(out, f));
  }

  // indexes: OpenStreetMap buildings (names, wall colours) and cadastre footprints (addresses)
  const G = 60, osmGrid = new Map(), alkGrid = new Map();
  const put = (m, p, v) => { const k = Math.floor(p[0] / G) + ',' + Math.floor(p[1] / G); (m.get(k) || m.set(k, []).get(k)).push(v); };
  const find = (m, p, test) => { const gx = Math.floor(p[0] / G), gz = Math.floor(p[1] / G); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const v of m.get(gx + i + ',' + (gz + j)) || []) if (test(v)) return v; return null; };
  for (const b of buildings) if (!(b.flags & 4)) put(osmGrid, b.c, b);
  for (const a of ALKIS_INDEX) put(alkGrid, a.c, a);

  const rows = [], chunks = [];
  const ras = makeRaster();
  let nBuild = 0, nTri = 0;
  const seenIds = new Set();
  for (const file of files) {
    const xml = await fs.readFile(file, 'utf8');
    for (const m of xml.split('<core:cityObjectMember>').slice(1)) {
      const gid = (m.match(/<bldg:Building gml:id="([^"]+)"/) || [])[1];
      if (!gid || seenIds.has(gid)) continue;
      seenIds.add(gid);
      const surf = [];
      for (const s of m.matchAll(/<bldg:(RoofSurface|WallSurface|GroundSurface)\b[\s\S]*?<\/bldg:\1>/g)) {
        for (const pg of s[0].split('<gml:Polygon').slice(1)) {
          const ringOf3 = (txt) => {
            const pl = txt.match(/<gml:posList[^>]*>([^<]*)<\/gml:posList>/);
            if (!pl) return null;
            const v = pl[1].trim().split(/\s+/).map(Number), r = [];
            for (let i = 0; i + 2 < v.length; i += 3) r.push([v[i], v[i + 1], v[i + 2]]);
            if (r.length > 1) { const a = r[0], b = r[r.length - 1]; if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) r.pop(); }
            return r.length >= 3 ? r : null;
          };
          const parts = pg.split('<gml:interior>');
          const outer = ringOf3(parts[0]);
          if (outer) surf.push({ type: s[1], outer, holes: parts.slice(1).map(ringOf3).filter(Boolean) });
        }
      }
      if (!surf.length) continue;
      const grounds = surf.filter((s) => s.type === 'GroundSurface');
      let gH = Infinity, sE = 0, sN = 0, k = 0;
      for (const s of grounds.length ? grounds : surf) for (const p of s.outer) { gH = Math.min(gH, p[2]); sE += p[0]; sN += p[1]; k++; }
      const [la, lo] = fromUTM33(sE / k, sN / k), [ox, oz] = project(la, lo);
      if (Math.hypot(ox - cx, oz - cz) > R || !inExt([ox, oz])) continue;
      // UTM + height -> local metres relative to the building's own ground (the world is flat)
      const L = (p) => { const [a, b] = fromUTM33(p[0], p[1]); const [x, z] = project(a, b); return [x, p[2] - gH, z]; };
      const footprint = grounds.length ? grounds.sort((a, b) => b.outer.length - a.outer.length)[0].outer.map((p) => { const q = L(p); return [r2(q[0]), r2(q[2])]; }) : null;

      const measured = +((m.match(/<bldg:measuredHeight[^>]*>([\d.]+)</) || [])[1] || 0);
      const rt = ROOF_TYPE[+((m.match(/<bldg:roofType>(\d+)</) || [])[1] || 9999)] || ROOF_TYPE[9999];
      const fp2 = footprint || [[ox, oz]];
      const osm = find(osmGrid, [ox, oz], (b) => pip([ox, oz], b.outer));
      const alk = find(alkGrid, [ox, oz], (a) => pip([ox, oz], a.outer));
      const kind = osm && osm.kind !== 'yes' ? osm.kind : alk ? alkisKind(alk.funktion) : 'yes';
      const hid = hash(nBuild * 7919 + 13);
      const style = osm ? osm.style : /industrial|garage|shed|roof/.test(kind) ? 3 : 0;
      const wc = osm ? osm.wc : /garage|shed|roof/.test(kind) ? hex('#bdb8ad') : WALLS[hid % WALLS.length];

      // geometry
      const verts = [], parts = [], idx = [];
      let maxY = 0, roofE = 0, roofN = 0, roofK = 0, flatArea = 0, slopeArea = 0;
      for (const s of surf) {
        if (s.type === 'GroundSurface') continue;
        const loc = s.outer.map(L), holes = s.holes.map((h) => h.map(L));
        const t = triangulate3D(loc, holes);
        const len = Math.hypot(...t.normal) || 1;
        const part = s.type === 'WallSurface' ? 0 : Math.abs(t.normal[1] / len) > 0.97 ? 2 : 1;
        if (part === 2) flatArea += len / 2; else if (part === 1) slopeArea += len / 2;
        const base = verts.length;
        for (const p of t.verts) { verts.push(p); parts.push(part); maxY = Math.max(maxY, p[1]); }
        for (const ti of t.tris) idx.push(base + ti);
        if (s.type === 'RoofSurface') for (const p of s.outer) { roofE += p[0]; roofN += p[1]; roofK++; }
      }
      if (!idx.length || verts.length > 65535) continue;
      // roof colour from the aerial photo, sampled on the real roof surfaces (not for tall, leaning buildings)
      let rc = null, photo = false;
      if (ORTHO.ok && maxY < 24) {
        const cols = [];
        for (const s of surf) if (s.type === 'RoofSurface') {
          let e = 0, n = 0; for (const p of s.outer) { e += p[0]; n += p[1]; }
          e /= s.outer.length; n /= s.outer.length;
          for (const p of s.outer) for (const f of [0.3, 0.6]) {
            const [a, b] = fromUTM33(e + (p[0] - e) * f, n + (p[1] - n) * f); const c = orthoAt(a, b); if (c) cols.push(c);
          }
        }
        if (cols.length >= 4) {
          cols.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
          const mid = cols.slice(Math.floor(cols.length * 0.3), Math.ceil(cols.length * 0.8));
          let r = 0, g = 0, bl = 0; for (const c of mid) { r += c[0]; g += c[1]; bl += c[2]; }
          rc = photoColour(r / mid.length, g / mid.length, bl / mid.length); photo = true;
        }
      }
      if (rc == null) rc = rt[0] === 0 || flatArea > slopeArea ? ROOF_FLAT[(hid >>> 4) % ROOF_FLAT.length] : ROOF_PITCHED[(hid >>> 4) % ROOF_PITCHED.length];

      // binary: origin, counts, int16 decimetre offsets, part per vertex, uint16 indices
      const buf = Buffer.alloc(8 + 4 + verts.length * 7 + idx.length * 2);
      let o = 0;
      buf.writeFloatLE(ox, o); o += 4; buf.writeFloatLE(oz, o); o += 4;
      buf.writeUInt16LE(verts.length, o); o += 2; buf.writeUInt16LE(idx.length / 3, o); o += 2;
      for (const p of verts) {
        buf.writeInt16LE(Math.round((p[0] - ox) * 10), o); buf.writeInt16LE(Math.round(p[1] * 10), o + 2); buf.writeInt16LE(Math.round((p[2] - oz) * 10), o + 4); o += 6;
      }
      for (const pt of parts) buf.writeUInt8(pt, o++);
      for (const i of idx) { buf.writeUInt16LE(i, o); o += 2; }
      chunks.push(buf);
      nTri += idx.length / 3;
      if (footprint) ras.fill([footprint]);
      rows.push([gid, (osm && osm.name) || (alk && alk.name) || 0, kind, r2(measured || maxY), rt[1], wc, rc, alk ? alk.addr : '', style, (photo ? 64 : 0) | 256, footprint ? flat(footprint) : []]);
      // a building made of parts lists one measured height per part: the real height is the top of the model
      rows[rows.length - 1][3] = r2(Math.max(measured, maxY));
      nBuild++;
    }
  }
  // drop OpenStreetMap / cadastre buildings now covered by an official 3D model
  const before = buildings.length;
  const kept = buildings.filter((b) => !(Math.hypot(b.c[0] - cx, b.c[1] - cz) < R + 80 && ras.coverage([b.outer, ...b.holes]) > 0.35));
  buildings.splice(0, buildings.length, ...kept);
  const head = Buffer.alloc(8); head.write('LOD2', 0); head.writeUInt32LE(rows.length, 4);
  await fs.writeFile(path.join(OUT, 'lod2.bin'), Buffer.concat([head, ...chunks]));
  await fs.writeFile(path.join(OUT, 'lod2.json'), JSON.stringify({ area: { x: r2(cx), z: r2(cz), r: R }, rows }));
  console.log(`  ${nBuild} official 3D buildings (${nTri} triangles) within ${R} m; replaced ${before - buildings.length} simpler buildings`);
  return nBuild;
}

// ---------- main ----------
await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(OUT, { recursive: true });

const corners = [project(BBOX.n, BBOX.w), project(BBOX.n, BBOX.e), project(BBOX.s, BBOX.w), project(BBOX.s, BBOX.e)];
const ext = {
  minX: Math.ceil(Math.max(corners[0][0], corners[2][0])), maxX: Math.floor(Math.min(corners[1][0], corners[3][0])),
  minZ: Math.ceil(Math.max(corners[0][1], corners[1][1])), maxZ: Math.floor(Math.min(corners[2][1], corners[3][1])),
};
const inExt = (p, m = 0) => p[0] >= ext.minX - m && p[0] <= ext.maxX + m && p[1] >= ext.minZ - m && p[1] <= ext.maxZ + m;
console.log('extent (m):', ext);

console.log('1/4 buildings');
const rawB = await overpassTiled('buildings', 'buildings');
const outlines = [], parts = [];
for (const el of rawB.elements) {
  const t = el.tags || {};
  const isPart = !!t['building:part'] && t['building:part'] !== 'no';
  if (!isPart && (!t.building || t.building === 'no')) continue;
  if (t.location === 'underground' || t.tunnel === 'yes') continue;
  for (const poly of polygonsOf(el)) {
    const b = makeBuilding(el, poly, isPart);
    if (!b || !inExt(b.c, 60)) continue;
    (isPart ? parts : outlines).push(b);
  }
}
// outlines replaced by their building:parts (Simple 3D Buildings rule)
const CELL = 60, grid = new Map();
for (const p of parts) {
  const k = Math.floor(p.c[0] / CELL) + ',' + Math.floor(p.c[1] / CELL);
  (grid.get(k) || grid.set(k, []).get(k)).push(p);
}
let dropped = 0;
const keptOutlines = outlines.filter((o) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of o.outer) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  let covered = 0;
  for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
    for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++)
      for (const p of grid.get(gx + ',' + gz) || []) if (pip(p.c, o.outer)) { p.parent = o; if (p.minH < 1) covered += p.A; }
  if (covered >= 0.55 * o.A) { dropped++; return false; }
  return true;
});
// parts inherit name / look from the building they belong to
for (const p of parts) {
  const o = p.parent;
  if (!o) continue;
  if (!p.name) p.name = o.name;
  if (!p.wcTag && (o.wcTag || o.historic)) p.wc = o.wc;
  if (p.generic || o.historic) p.style = o.style;
}
const buildings = keptOutlines.concat(parts);
// TU Dresden buildings mapped with a navigator code but not tagged as "building": add them so every listed building exists in 3D
try {
  const tok = JSON.parse(await fs.readFile(path.join(RAW, 'tud_tokens_geom.json'), 'utf8')).elements;
  const have = new Set(rawB.elements.map((e) => e.type + e.id));
  let addedTU = 0;
  for (const el of tok) {
    if (have.has(el.type + el.id)) continue;
    const t = { ...el.tags }; if (!t.building && !t['building:part']) t.building = 'university';
    const e2 = { ...el, tags: t };
    for (const poly of polygonsOf(e2)) { const b = makeBuilding(e2, poly, false); if (b && inExt(b.c, 60)) { buildings.push(b); addedTU++; } }
  }
  console.log(`  ${addedTU} TU Dresden buildings added that OpenStreetMap does not tag as buildings`);
} catch (e) { console.log('  (no TU building code file: ' + e.message + ')'); }
let cadastreAdded = 0;
try { cadastreAdded = await addCadastreBuildings(buildings); }
catch (e) { console.log('  official cadastre unavailable (' + e.message + ') - OpenStreetMap buildings only'); }
let photoRoofs = 0;
try {
  await loadOrtho();
  for (const b of buildings) {
    // tall buildings lean in the aerial photo, so their roof pixels are offset onto the ground beside them
    if (b.rcTag || b.wallH + Math.max(0, b.rh) > 24) continue;
    const c = roofColourFromPhoto(b);
    if (c != null) { b.rc = c; b.flags |= 64; photoRoofs++; }
  }
  console.log('  ' + photoRoofs + ' roof colours sampled from aerial imagery');
} catch (e) { console.log('  aerial imagery unavailable (' + e.message + ') - using palette colours'); }
let lod2Count = 0;
try { lod2Count = await addLod2Buildings(buildings); }
catch (e) { console.log('  official 3D models unavailable (' + e.message + ')'); await fs.rm(path.join(OUT, 'lod2.bin'), { force: true }); await fs.rm(path.join(OUT, 'lod2.json'), { force: true }); }
const tagged = buildings.filter((b) => b.flags & 3).length;
console.log(`  ${buildings.length} buildings (${parts.length} parts, ${dropped} outlines replaced), ${Math.round((100 * tagged) / buildings.length)}% with tagged height/levels`);
await fs.writeFile(path.join(OUT, 'buildings.json'), JSON.stringify(buildings.map((b) => [
  b.id, b.name, b.kind, b.wallH, b.minH, b.rh, b.shape, b.flags | (b.rel ? 32 : 0), b.levels, b.wc, b.rc, [flat(b.outer), ...b.holes.map(flat)], b.style,
])));

console.log('2/4 roads');
const rawR = await overpassTiled('roads', 'roads');
const HW = {
  motorway: 0, trunk: 0, motorway_link: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2, tertiary: 3, tertiary_link: 3,
  residential: 4, unclassified: 4, living_street: 4, road: 4, busway: 4, service: 5, pedestrian: 6, footway: 7, path: 7, cycleway: 7, steps: 7, track: 7, bridleway: 7,
};
const SURF = { sett: 1, cobblestone: 1, unhewn_cobblestone: 1, 'cobblestone:flattened': 1, paving_stones: 2, paved: 2, bricks: 2, 'concrete:plates': 2, unpaved: 3, gravel: 3, fine_gravel: 3, compacted: 3, ground: 3, dirt: 3, grass: 3, sand: 3, earth: 3, pebblestone: 3, wood: 2 };
const roads = [], streets = new Map(), roadNames = [], nameIdx = new Map();
for (const el of rawR.elements) {
  const t = el.tags || {};
  if (!el.geometry || el.type !== 'way') continue;
  if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') continue;
  if (t.area === 'yes') continue;
  let cls;
  if (t.railway) cls = t.railway === 'tram' ? 9 : 8;
  else cls = HW[t.highway];
  if (cls == null) continue;
  if (cls === 5 && t.service === 'parking_aisle') continue;
  const oneway = t.oneway === 'yes' || t.junction === 'roundabout' ? 1 : 0;
  let lanes = num(t.lanes);
  const lanesTagged = !isNaN(lanes) && lanes > 0;
  if (!lanesTagged) lanes = cls <= 3 ? (oneway ? (cls <= 1 ? 2 : 1) : 2) : 1;
  lanes = Math.min(8, Math.round(lanes));
  // real carriageway width: width tag > lane count > class default
  let w;
  const wt = num(t.width) || num(t['width:carriageway']);
  if (cls <= 7 && !isNaN(wt) && wt > 0.8 && wt < 40) w = wt;
  else if (cls <= 3) w = lanes * 3.25 + 0.6;
  else if (cls === 4) w = lanesTagged ? lanes * 3.0 + 0.5 : oneway ? 4.2 : 5.5;
  else if (cls === 5) w = 3.4;
  else if (cls === 6) w = 6;
  else if (cls === 7) w = t.highway === 'cycleway' ? 2.4 : t.highway === 'track' ? 3 : t.highway === 'steps' ? 2.2 : t.highway === 'path' ? 1.5 : 2;
  else w = cls === 8 ? 3.0 : 2.5;
  let surf = SURF[t.surface];
  if (surf == null) surf = cls === 6 ? 2 : cls === 7 ? (t.highway === 'path' || t.highway === 'track' ? 3 : 2) : 0;
  const sw = t.sidewalk || t['sidewalk:both'];
  const sidewalk = cls >= 1 && cls <= 4 && (sw ? /both|left|right|yes/.test(sw) : cls >= 2 && t.highway !== 'living_street' && !/link/.test(t.highway)) ? 1 : 0;
  const marks = cls <= 3 && lanes >= 2 ? lanes : lanesTagged && lanes >= 2 && cls === 4 ? lanes : 0;
  let ni = -1;
  if (t.name && cls <= 7) { ni = nameIdx.get(t.name); if (ni == null) { ni = roadNames.length; roadNames.push(t.name); nameIdx.set(t.name, ni); } }
  const pts = el.geometry.filter(Boolean).map(P);
  const bridge = t.bridge && t.bridge !== 'no' ? 1 : 0;
  let run = [];
  const flush = () => { if (run.length > 1) roads.push([cls, bridge, r2(w), flat(run), marks, surf, sidewalk, ni, oneway]); run = []; };
  for (let i = 0; i < pts.length; i++) {
    if (inExt(pts[i], 120)) run.push(pts[i]);
    else flush();
  }
  flush();
  if (t.name && cls <= 6) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const mid = pts[pts.length >> 1];
    const cur = streets.get(t.name);
    if (inExt(mid) && (!cur || cur.len < len)) streets.set(t.name, { len, mid });
  }
}
console.log(`  ${roads.length} road/rail segments`);
await fs.writeFile(path.join(OUT, 'roads.json'), JSON.stringify({ names: roadNames, ways: roads }));

console.log('3/4 land cover & water');
const rawL = await overpassTiled('land', 'land');
// kind index = paint order
const KINDS = ['residential', 'commercial', 'industrial', 'railway', 'construction', 'farmland', 'grass', 'parking', 'plaza', 'cemetery', 'allotments', 'park', 'scrub', 'forest', 'pitch', 'sand', 'playground', 'pond', 'river'];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));
function landKind(t, A) {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'dock' || t.landuse === 'basin' || t.landuse === 'reservoir') {
    if (t.water === 'fountain' || t.amenity === 'fountain') return K.pond;
    return t.water === 'river' || t.water === 'canal' || t.water === 'harbour' || t.waterway || /elbe/i.test(t.name || '') || A > 40000 ? K.river : K.pond;
  }
  if (t.highway === 'pedestrian') return K.plaza;
  if (t.amenity === 'parking') return t.parking === 'underground' || t.parking === 'multi-storey' ? null : K.parking;
  if (t.leisure === 'park' || t.leisure === 'garden') return K.park;
  if (t.leisure === 'pitch') return K.pitch;
  if (t.leisure === 'playground') return K.playground;
  if (t.leisure === 'recreation_ground') return K.grass;
  if (t.natural === 'wood') return K.forest;
  if (t.natural === 'scrub' || t.natural === 'heath') return K.scrub;
  if (t.natural === 'grassland') return K.grass;
  if (t.natural === 'sand' || t.natural === 'beach') return K.sand;
  switch (t.landuse) {
    case 'residential': return K.residential;
    case 'commercial': case 'retail': case 'education': case 'religious': case 'institutional': return K.commercial;
    case 'industrial': case 'depot': case 'garages': return K.industrial;
    case 'railway': return K.railway;
    case 'construction': case 'brownfield': case 'greenfield': return K.construction;
    case 'farmland': case 'farmyard': case 'orchard': case 'vineyard': return K.farmland;
    case 'grass': case 'meadow': case 'village_green': case 'recreation_ground': case 'flowerbed': case 'greenery': return K.grass;
    case 'cemetery': return K.cemetery;
    case 'allotments': return K.allotments;
    case 'forest': return K.forest;
  }
  return null;
}
const land = [];
for (const el of rawL.elements) {
  const t = el.tags || {};
  for (const poly of polygonsOf(el)) {
    const k = landKind(t, area(poly.outer));
    if (k == null) continue;
    land.push({ k, outer: poly.outer, holes: poly.holes });
  }
}
land.sort((a, b) => a.k - b.k);
console.log(`  ${land.length} polygons, ${land.filter((l) => l.k === K.river).length} river sections`);
await fs.writeFile(path.join(OUT, 'land.json'), JSON.stringify({ kinds: KINDS, polys: land.map((l) => [l.k, [flat(l.outer), ...l.holes.map(flat)]]) }));

console.log('4/4 places, landmarks, trees');
const rawP = await overpassTiled('pois', 'pois');
const labels = [], trees = [], seen = new Set(), stops = new Map();
for (const el of rawP.elements) {
  const t = el.tags || {};
  const g = el.type === 'node' ? el : el.center;
  if (!g) continue;
  const p = P(g);
  if (!inExt(p)) continue;
  if (t.natural === 'tree') { trees.push(p[0], p[1]); continue; }
  if (!t.name) continue;
  if (t.place) { labels.push({ n: t.name, k: 'district', x: p[0], z: p[1], p: t.place === 'suburb' ? 1 : t.place === 'quarter' ? 2 : 3 }); continue; }
  if (t.railway === 'tram_stop') {
    const s = stops.get(t.name) || { x: 0, z: 0, c: 0 };
    s.x += p[0]; s.z += p[1]; s.c++; stops.set(t.name, s);
    continue;
  }
  if (seen.has(t.name)) continue;
  seen.add(t.name);
  if (t.railway) { labels.push({ n: t.name, k: 'station', x: p[0], z: p[1], p: 1 }); continue; }
  if (t.historic === 'memorial' && !t.wikidata) continue;
  const famous = t.wikipedia || t.wikidata;
  labels.push({ n: t.name, k: 'poi', x: p[0], z: p[1], p: famous ? (t.tourism === 'attraction' || t.tourism === 'museum' || t.amenity === 'theatre' || t.building === 'cathedral' ? 1 : 2) : 4 });
}
for (const [n, s] of stops) labels.push({ n, k: 'stop', x: r2(s.x / s.c), z: r2(s.z / s.c), p: 5 });
for (const [n, s] of streets) labels.push({ n, k: 'street', x: s.mid[0], z: s.mid[1], p: 9 });

// scatter extra trees in wooded / park polygons (deterministic)
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const DENS = { [K.forest]: 1 / 70, [K.park]: 1 / 550, [K.cemetery]: 1 / 400, [K.scrub]: 1 / 220, [K.allotments]: 1 / 500 };
const water = land.filter((l) => l.k >= K.pond);
const scattered = [];
for (const l of land) {
  const d = DENS[l.k];
  if (!d) continue;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of l.outer) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  x0 = Math.max(x0, ext.minX); x1 = Math.min(x1, ext.maxX); z0 = Math.max(z0, ext.minZ); z1 = Math.min(z1, ext.maxZ);
  if (x1 <= x0 || z1 <= z0) continue;
  const tries = Math.min(40000, Math.round((x1 - x0) * (z1 - z0) * d));
  for (let i = 0; i < tries; i++) {
    const p = [x0 + rnd() * (x1 - x0), z0 + rnd() * (z1 - z0)];
    if (!pip(p, l.outer) || l.holes.some((h) => pip(p, h))) continue;
    if (water.some((w) => pip(p, w.outer))) continue;
    scattered.push(r2(p[0]), r2(p[1]));
  }
}
console.log(`  ${labels.length} labels, ${trees.length / 2} mapped trees, ${scattered.length / 2} scattered trees`);
await fs.writeFile(path.join(OUT, 'labels.json'), JSON.stringify(labels));
await fs.writeFile(path.join(OUT, 'trees.json'), JSON.stringify({ mapped: trees, scattered }));

// sports grounds: football pitches and running tracks, drawn in detail by the viewer
const pitches = [], tracks = [];
for (const el of rawL.elements) {
  const t = el.tags || {};
  if (t.leisure !== 'pitch' && t.leisure !== 'track') continue;
  const polys = polygonsOf(el);
  if (t.leisure === 'track' && !polys.length && el.bounds) {
    // sketched track with no usable outline: keep its extent so the viewer can place a standard oval
    const a = project(el.bounds.minlat, el.bounds.minlon), b = project(el.bounds.maxlat, el.bounds.maxlon);
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (inExt(c)) tracks.push({ name: t.name || '', bbox: [r2(Math.min(a[0], b[0])), r2(Math.min(a[1], b[1])), r2(Math.max(a[0], b[0])), r2(Math.max(a[1], b[1]))] });
  }
  for (const poly of polys) {
    if (!inExt(centroid(poly.outer))) continue;
    if (t.leisure === 'track') { if (area(poly.outer) > 800) tracks.push({ name: t.name || '', outer: flat(poly.outer), holes: poly.holes.map(flat) }); continue; }
    const sport = t.sport || '';
    if (!/soccer|football|multi/.test(sport) || area(poly.outer) < 300) continue;
    pitches.push({ id: el.type + '/' + el.id, name: t.name || '', sport, surface: t.surface || '', outer: flat(poly.outer) });
  }
}
console.log(`  ${pitches.length} football pitches, ${tracks.length} running tracks`);
await fs.writeFile(path.join(OUT, 'sports.json'), JSON.stringify({ pitches, tracks }));

let aerial = false;
if (ORTHO.ok) {
  console.log('  resampling aerial ground image');
  const W = ext.maxX - ext.minX, H = ext.maxZ - ext.minZ, tw = 4096, th = Math.round((tw * H) / W);
  const out = Buffer.alloc(tw * th * 3);
  for (let py = 0; py < th; py++)
    for (let px = 0; px < tw; px++) {
      const [lat, lon] = unproject(ext.minX + ((px + 0.5) / tw) * W, ext.minZ + ((py + 0.5) / th) * H);
      const c = orthoAt(lat, lon) || [120, 120, 110];
      const i = (py * tw + px) * 3;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
    }
  await sharp(out, { raw: { width: tw, height: th, channels: 3 } }).jpeg({ quality: 84 }).toFile(path.join(OUT, 'aerial.jpg'));
  aerial = true;
}
await fs.writeFile(path.join(OUT, 'meta.json'), JSON.stringify({
  name: 'Dresden', origin: ORIGIN, bbox: BBOX, ext,
  counts: { buildings: buildings.length, parts: parts.length, roads: roads.length, trees: trees.length / 2 + scattered.length / 2 },
  aerial, photoRoofs, cadastreAdded, lod2Count,
  heightTaggedPct: Math.round((100 * tagged) / buildings.length),
  built: new Date().toISOString().slice(0, 10),
  attribution: 'Map data (c) OpenStreetMap contributors, ODbL. Aerial imagery and building register: GeoSN, dl-de/by-2-0',
}, null, 1));
console.log('done ->', OUT);
