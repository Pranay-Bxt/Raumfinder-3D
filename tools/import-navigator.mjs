// Imports room outlines for TU Dresden buildings from the Campus Navigator floor plans, one building at a time,
// and aligns them to the 3D map. Student project; data (c) TU Dresden Campus Navigator, credited in the output.
//   node tools/import-navigator.mjs apb            one building
//   node tools/import-navigator.mjs apb wil rec    several, in order
// Polite by design: one request at a time, 10.5 s apart (the site's Crawl-Delay is 10), results cached in raw/nav/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFloorPage } from './nav-parse.mjs';
import { footprintOf, alignToFootprint } from './nav-align.mjs';
import { floorGraph, relateAll } from './nav-floors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'raw/nav'), OUT = path.join(ROOT, 'data/rooms');
fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
const UA = 'tud-student-campus-3d/1.0 (student project; one request at a time, 10 s apart)';
const DELAY = 10500;
let lastReq = 0;

async function getPage(id, floor) {
  const f = path.join(CACHE, `${id}_${floor}.html`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  if (process.env.NAV_OFFLINE) return null; // re-run from the cache only
  const wait = lastReq + DELAY - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(`https://navigator.tu-dresden.de/etplan/${encodeURIComponent(id)}/${floor}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const html = await res.text();
  fs.writeFileSync(f, html);
  return html;
}

const KIND = { korridor: 'c', treppen: 's', aufzuege: 's', wc: 's' }; // everything else is a room
const toLevel = (floor) => parseInt(floor, 10);
const cen = (r) => { let x = 0, z = 0; for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; } return [x / (r.length / 2), z / (r.length / 2)]; };

/** similarity transform plan -> map from paired centroids, robust to bad pairs; flip = mirror the plan's y axis */
function fitOnce(P, flip) {
  const n = P.length, A = P.map((q) => [q.a[0], flip * q.a[1]]);
  const ca = [0, 1].map((k) => A.reduce((s, a) => s + a[k], 0) / n), cb = [0, 1].map((k) => P.reduce((s, q) => s + q.b[k], 0) / n);
  let sxx = 0, sxy = 0, saa = 0;
  P.forEach((q, i) => { const ax = A[i][0] - ca[0], ay = A[i][1] - ca[1], bx = q.b[0] - cb[0], by = q.b[1] - cb[1]; sxx += ax * bx + ay * by; sxy += ax * by - ay * bx; saa += ax * ax + ay * ay; });
  const s = Math.hypot(sxx, sxy) / saa, th = Math.atan2(sxy, sxx);
  return { s, th, flip, ca, cb, map: (x, y) => { const ax = x - ca[0], ay = flip * y - ca[1]; return [s * (Math.cos(th) * ax - Math.sin(th) * ay) + cb[0], s * (Math.sin(th) * ax + Math.cos(th) * ay) + cb[1]]; } };
}
function robustFit(pairs, flips = [1, -1]) {
  let best = null;
  for (const flip of flips) {
    let use = pairs, T;
    for (let it = 0; it < 7 && use.length >= 3; it++) {
      T = fitOnce(use, flip);
      const errs = pairs.map((q) => Math.hypot(...T.map(...q.a).map((v, i) => v - q.b[i]))), med = [...errs].sort((x, y) => x - y)[errs.length >> 1];
      use = pairs.filter((q, i) => errs[i] <= Math.max(2.5, 2.2 * med));
    }
    if (!T || use.length < 3) continue;
    const e = use.map((q) => Math.hypot(...T.map(...q.a).map((v, i) => v - q.b[i]))).sort((x, y) => x - y);
    const r = { T, inliers: use.length, pairs: pairs.length, median: e[e.length >> 1], p90: e[Math.floor(e.length * 0.9)] };
    if (!best || r.inliers - r.median * 3 > best.inliers - best.median * 3) best = r;
  }
  return best;
}

/** plan of floor A -> plan of floor B, from shared stairs / lifts / WCs (same name, same place on every floor) */
function planToPlan(pa, pb) {
  const bm = new Map(); for (const r of pb.rooms) if (r.ref && r.layer !== 'raeume' && r.layer !== 'hoersaele' && r.layer !== 'seminarraeume') (bm.get(r.ref) || bm.set(r.ref, []).get(r.ref)).push(r);
  const pairs = [];
  for (const r of pa.rooms) { const o = r.ref && bm.get(r.ref) && bm.get(r.ref).length === 1 ? bm.get(r.ref)[0] : null; if (o && r.layer !== 'raeume' && r.layer !== 'hoersaele' && r.layer !== 'seminarraeume') pairs.push({ a: cen(r.poly), b: cen(o.poly), ref: r.ref }); }
  return pairs.length >= 4 ? robustFit(pairs, [1]) : null;
}

/** 2D affine [a, b, c, d, e, f] of any point map: x' = a x + b y + c, z' = d x + e y + f */
const toAff = (map) => { const c = map(0, 0), x = map(1, 0), y = map(0, 1); return [x[0] - c[0], y[0] - c[0], c[0], x[1] - c[1], y[1] - c[1], c[1]].map((v) => +v.toFixed(6)); };
/**
 * Symmetric outline: the plan fits the building equally well in several orientations. Keep the plan coordinates,
 * a per-floor transform to one reference floor, and every orientation candidate (best overlap first); the viewer
 * shows the first and lets the user step through the others while comparing with the official plan.
 */
function writeUncertain(id, pages, allA, floors, graph) {
  // reference floor: the one most other floors can be related to (then the best outline match)
  const ranked = Object.entries(allA).map(([fl, A]) => ({ fl, A, rel: relateAll(pages, fl, graph) })).sort((a, b) => Object.keys(b.rel).length - Object.keys(a.rel).length || b.A.iou - a.A.iou);
  if (!ranked.length) return null;
  const { fl: rf, A: RA, rel } = ranked[0];
  const cands = [...RA.cands].sort((a, b) => b.iou - a.iou).map((c) => ({ iou: +c.iou.toFixed(3), A: toAff(RA.make(c.flip, RA.s0 * Math.exp(c.p.ls), c.p.th, c.p.tx, c.p.tz)) }));
  const base = {}, levels = {}, stats = { shapes: 0, rooms: 0 };
  for (const [fl, p] of Object.entries(pages)) {
    let B;
    if (fl === rf) B = [1, 0, 0, 0, 1, 0];
    else if (rel[fl]) { B = toAff(rel[fl].map); console.log(`  floor ${fl}: stacked on floor ${rf} via ${rel[fl].via.join(' > ')} (walls agree ${Math.round(rel[fl].near * 100)}%)`); }
    else { console.log(`  floor ${fl}: skipped - its walls cannot be matched to floor ${rf}`); continue; }
    const lv = toLevel(fl), arr = (levels[lv] ||= []);
    base[lv] = B;
    for (const r of p.rooms) {
      if (r.layer === 'gebaeude' || r.poly.length < 6) continue;
      arr.push([KIND[r.layer] || 'r', r.ref, '', r.poly.map((v) => +v.toFixed(1)), r.layer]);
      stats.shapes++; if ((KIND[r.layer] || 'r') === 'r') stats.rooms++;
    }
  }
  const out = { id, uncertain: true, source: '© TU Dresden Campus Navigator (floor plan geometry); orientation guessed from the building outline', floors, ref: rf, cands, base, levels, align: { method: 'footprint-uncertain', iou: cands[0].iou, margin: +(cands[0].iou - (cands[1] ? cands[1].iou : 0)).toFixed(3) } };
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(out));
  console.log(`  DONE ${id.toUpperCase()} (orientation is a guess: ${cands.length} candidates): ${stats.rooms} rooms + ${stats.shapes - stats.rooms} corridors/stairs/WCs on ${Object.keys(levels).length} floors`);
  return { id, aligned: true, uncertain: true, method: 'footprint-uncertain', floors: Object.keys(levels).map(Number).sort((a, b) => b - a), rooms: stats.rooms, medianErrorM: null };
}

async function importBuilding(id, indoorOsm) {
  console.log(`\n== ${id.toUpperCase()}`);
  // find the first floor page that has rooms, which also lists the building's floors
  let first = null, firstFloor = null;
  for (const cand of ['00', '01', '0', '-1', '02']) {
    const html = await getPage(id, cand); if (!html) continue;
    const p = parseFloorPage(html); if (p.rooms.length) { first = p; firstFloor = cand; break; }
  }
  if (!first) { console.log('  no floor plan data found'); return null; }
  const floors = [...new Set([firstFloor, ...first.floors])];
  console.log(`  ${first.title.trim()} - floors: ${floors.join(', ')}`);
  const pages = {};
  for (const fl of floors) { const html = await getPage(id, fl); if (html) { const p = parseFloorPage(html); p.canv = [+(html.match(/data_canv_width = (d+)/) || [])[1] || 0, +(html.match(/data_canv_height = (d+)/) || [])[1] || 0]; if (p.rooms.some((r) => r.layer !== 'gebaeude')) pages[fl] = p; } }
  const graph = floorGraph(pages); // how every floor plan relates to every other floor plan of this building
  // align each floor to the map using OSM rooms with the same room number
  const osm = (indoorOsm && indoorOsm.levels[id]) || {};
  const fits = {};
  for (const [fl, p] of Object.entries(pages)) {
    const lv = toLevel(fl), recs = osm[lv] || [], pairs = [];
    for (const r of p.rooms) {
      if (!r.ref || r.layer === 'korridor' || r.layer === 'gebaeude') continue;
      const o = recs.find((q) => q[0] === 'r' && q[1].toLowerCase() === r.ref.toLowerCase());
      if (o) pairs.push({ a: cen(r.poly), b: cen(o[3]), ref: r.ref });
    }
    const f = pairs.length >= 4 ? robustFit(pairs) : null;
    if (f && f.inliers >= 4) fits[fl] = f;
    console.log(`  floor ${fl}: ${p.rooms.length} shapes, ${pairs.length} rooms also mapped in OSM` + (f ? ` -> fit ${f.inliers} inliers, median error ${f.median.toFixed(2)} m, scale ${f.T.s.toFixed(4)}, rot ${(f.T.th * 180 / Math.PI).toFixed(1)}°${f.T.flip < 0 ? ' (mirrored)' : ''}` : ' -> no fit'));
  }
  // no OSM rooms to compare with: align each floor to the building outline instead (only when the orientation is unambiguous)
  let method = 'osm-rooms', footInfo = null, allA = {};
  if (!Object.values(fits).some((f) => f.inliers >= 8)) {
    method = 'footprint';
    const fp = footprintOf(id);
    if (!fp.outers.length) { console.log('  no building outline in the map data: cannot align. Skipped.'); return { id, aligned: false, reason: 'no building outline in the map' }; }
    let bestA = null;
    for (const [fl, p] of Object.entries(pages)) {
      const polys = p.rooms.filter((r) => r.layer !== 'gebaeude' && r.poly.length >= 6).map((r) => r.poly);
      if (polys.length < 3) continue;
      const A = alignToFootprint(polys, fp); if (!A) continue;
      if (p.rooms.some((r) => r.ref)) allA[fl] = A;
      const ok = A.iou >= 0.55 && A.margin >= 0.05;
      console.log(`  floor ${fl}: outline match IoU ${A.iou.toFixed(2)}, orientation margin ${A.margin.toFixed(2)} -> ${ok ? 'confident' : 'ambiguous'}`);
      if (ok) { fits[fl] = { T: { map: A.map, s: A.scale, th: (A.rotDeg * Math.PI) / 180, flip: A.flip }, inliers: 99, median: 1.2, p90: 2.4, iou: A.iou, margin: A.margin }; if (!bestA || A.margin > bestA.margin) bestA = A; }
    }
    if (!bestA) {
      console.log('  orientation cannot be determined from the building outline (symmetric shape): keeping all candidates');
      return writeUncertain(id, pages, allA, floors, graph) || { id, aligned: false, reason: 'orientation unclear from the outline' };
    }
    footInfo = { iou: +bestA.iou.toFixed(3), margin: +bestA.margin.toFixed(3) };
  }
  const good = Object.values(fits).sort((a, b) => b.inliers - a.inliers)[0];
  // floors without their own alignment: stack them on an aligned floor through the wall graph; failing that, fit them
  // onto the building outline turned like the aligned floor, then try stacking the rest on those, and so on
  const derived = {};
  const placed = () => [...Object.entries(fits).filter(([, f]) => f.inliers >= 8).map(([fl, f]) => [fl, f.T.map, f.inliers]), ...Object.entries(derived).map(([fl, d]) => [fl, d.map, 0])];
  const stackPass = () => {
    let added = 0;
    for (;;) {
      let best = null;
      for (const fl of Object.keys(pages)) {
        if ((fits[fl] && fits[fl].inliers >= 8) || derived[fl]) continue;
        for (const [rf, rmap, rq] of placed()) { const rel = relateAll(pages, rf, graph)[fl]; if (rel && (!best || rel.near > best.rel.near || (rel.near === best.rel.near && rq > best.rq))) best = { fl, rf, rmap, rel, rq }; }
      }
      if (!best) return added;
      const { fl, rf, rmap, rel } = best;
      derived[fl] = { map: (x, y) => rmap(...rel.map(x, y)), note: `stacked on floor ${rf} via ${rel.via.join(' > ')} (walls agree ${Math.round(rel.near * 100)}%)` };
      added++;
    }
  };
  const outlinePass = () => {
    let added = 0;
    const fp = footprintOf(id), angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    if (!fp.outers.length) return 0;
    for (const [fl, p] of Object.entries(pages)) {
      if ((fits[fl] && fits[fl].inliers >= 8) || derived[fl] || !p.rooms.some((r) => r.ref)) continue;
      const polys = p.rooms.filter((r) => r.layer !== 'gebaeude' && r.poly.length >= 6).map((r) => r.poly);
      const A = allA[fl] || (polys.length >= 3 ? (allA[fl] = alignToFootprint(polys, fp)) : null); if (!A) continue;
      const c = A.cands.filter((q) => q.flip === good.T.flip).sort((x, y) => angDiff(x.p.th, good.T.th) - angDiff(y.p.th, good.T.th))[0];
      if (c && angDiff(c.p.th, good.T.th) < 0.35 && c.iou >= 0.5) { derived[fl] = { map: A.make(c.flip, A.s0 * Math.exp(c.p.ls), c.p.th, c.p.tx, c.p.tz), note: `placed on the building outline on its own (overlap ${c.iou.toFixed(2)}), turned like the aligned floor` }; added++; }
    }
    return added;
  };
  if (good) { stackPass(); while (outlinePass()) stackPass(); }
  // check the method on floors that have their own fit: how far off would the derived alignment have been?
  if (good) for (const [fl, p] of Object.entries(pages)) {
    if (!(fits[fl] && fits[fl].inliers >= 8)) continue;
    const lv = toLevel(fl), recs = osm[lv] || [];
    for (const [rf, rfit] of Object.entries(fits)) {
      if (rf === fl || rfit.inliers < 8) continue;
      const rel = relateAll(pages, rf, graph)[fl]; if (!rel) continue;
      const errs = []; for (const r of p.rooms) { if (!r.ref || r.layer === 'korridor') continue; const o = recs.find((q) => q[0] === 'r' && q[1].toLowerCase() === r.ref.toLowerCase()); if (!o) continue; const m = rfit.T.map(...rel.map(...cen(r.poly))), c = cen(o[3]); errs.push(Math.hypot(m[0] - c[0], m[1] - c[1])); }
      errs.sort((a, b) => a - b); if (errs.length) console.log(`  check: floor ${fl} aligned through floor ${rf} instead -> median error ${errs[errs.length >> 1].toFixed(2)} m over ${errs.length} rooms`);
      break;
    }
  }
  if (!good) { console.log('  cannot align (no OSM rooms to compare). Skipped.'); return { id, aligned: false }; }
  const levels = {}, stats = { shapes: 0, rooms: 0 };
  for (const [fl, p] of Object.entries(pages)) {
    if (!(fits[fl] && fits[fl].inliers >= 8) && !derived[fl] && !p.rooms.some((r) => r.ref)) { console.log(`  floor ${fl}: skipped - the plan has no room numbers, so it cannot be aligned or labelled`); continue; }
    const own = !!(fits[fl] && fits[fl].inliers >= 8);
    if (!own && !derived[fl]) { console.log(`  floor ${fl}: skipped - its walls cannot be matched to an aligned floor`); continue; }
    const M = own ? fits[fl].T : derived[fl], T = { map: (x, y) => M.map(x, y) };
    const arr = (levels[toLevel(fl)] ||= []);
    for (const r of p.rooms) {
      if (r.layer === 'gebaeude' || r.poly.length < 6) continue;
      const ring = []; for (let i = 0; i < r.poly.length; i += 2) { const [x, z] = T.map(r.poly[i], r.poly[i + 1]); ring.push(+x.toFixed(1), +z.toFixed(1)); }
      arr.push([KIND[r.layer] || 'r', r.ref, '', ring, r.layer]);
      stats.shapes++; if ((KIND[r.layer] || 'r') === 'r') stats.rooms++;
    }
    if (!own) console.log(`  floor ${fl}: ` + derived[fl].note);
  }
  const out = { id, source: '© TU Dresden Campus Navigator (floor plan geometry); aligned to OpenStreetMap by the student project', floors, align: { method, ...(footInfo || {}), inliers: good.inliers, medianErrorM: +good.median.toFixed(2), p90ErrorM: +good.p90.toFixed(2), scale: +good.T.s.toFixed(5), rotDeg: +(good.T.th * 180 / Math.PI).toFixed(2) }, levels };
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(out));
  console.log(`  DONE ${id.toUpperCase()}: ${stats.rooms} rooms + ${stats.shapes - stats.rooms} corridors/stairs/WCs on ${Object.keys(levels).length} floors (alignment median error ${good.median.toFixed(2)} m)`);
  return { id, aligned: true, method, floors: Object.keys(levels).map(Number).sort((a, b) => b - a), rooms: stats.rooms, medianErrorM: +good.median.toFixed(2) };
}

// ---- main
const ids = process.argv.slice(2).map((s) => s.toLowerCase());
const indoorOsm = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/indoor.json'), 'utf8'));
const idxFile = path.join(OUT, 'index.json');
const index = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { source: '© TU Dresden Campus Navigator', buildings: {} };
for (const id of ids) {
  const r = await importBuilding(id, indoorOsm).catch((e) => { console.log('  failed:', e.message); return null; });
  if (r && r.aligned) {
    const data = JSON.parse(fs.readFileSync(path.join(OUT, `${id}.json`), 'utf8')), lv = {};
    for (const [l, recs] of Object.entries(data.levels)) lv[l] = [...new Set(recs.filter((q) => q[0] === 'r' && q[1]).map((q) => q[1]))];
    // rooms on floors whose plan could not be lined up: not drawn, but still searchable with their (certain) floor
    const unplaced = {};
    for (const f of fs.readdirSync(CACHE).filter((f) => f.startsWith(id + '_') && f.endsWith('.html'))) {
      const fl = f.slice(id.length + 1, -5); if (fl === '0') continue;
      const l = toLevel(fl); if (Number.isNaN(l) || data.levels[l]) continue;
      const refs = [...new Set(parseFloorPage(fs.readFileSync(path.join(CACHE, f), 'utf8')).rooms.filter((q) => q.ref && q.layer !== 'gebaeude' && !KIND[q.layer]).map((q) => q.ref))];
      if (refs.length) unplaced[l] = refs;
    }
    index.buildings[id] = { floors: r.floors, rooms: r.rooms, medianErrorM: r.medianErrorM, method: r.method, uncertain: !!r.uncertain, levels: lv, ...(Object.keys(unplaced).length ? { unplaced } : {}) };
    if (index.pending) delete index.pending[id];
    fs.writeFileSync(idxFile, JSON.stringify(index));
  } else if (r && r.reason) { (index.pending ||= {})[id] = r.reason; fs.writeFileSync(idxFile, JSON.stringify(index)); }
}
console.log('\nbuildings imported so far:', Object.keys(index.buildings).map((k) => k.toUpperCase()).join(', ') || '(none)');
if (index.pending && Object.keys(index.pending).length) console.log('could not place yet:', Object.entries(index.pending).map(([k, v]) => k.toUpperCase() + ' (' + v + ')').join(', '));
