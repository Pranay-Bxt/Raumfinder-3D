// Aligns a Campus Navigator floor plan (plan units) to the OpenStreetMap footprint of the same building, for
// buildings that have no OSM rooms to compare against: rotation from the dominant wall direction, scale from area,
// then a local search that maximises the overlap (IoU) of the plan's rooms with the building outline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../src/proj.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let osmCache = null;

/** footprint of a building by its navigator token: { outers: [flat], inners: [flat] } in map metres */
export function footprintOf(id) {
  osmCache ||= JSON.parse(fs.readFileSync(path.join(ROOT, fs.existsSync(path.join(ROOT, 'raw/tud_tokens_geom.json')) ? 'raw/tud_tokens_geom.json' : 'raw/v3_buildings.json'), 'utf8')).elements;
  const outers = [], inners = [], ring = (g) => { const f = []; for (const p of g.filter(Boolean)) { const [x, z] = project(p.lat, p.lon); f.push(x, z); } return f; };
  for (const e of osmCache) {
    const t = e.tags && e.tags['cn_tud:token']; if (!t || t.toLowerCase() !== id) continue;
    if (e.geometry) outers.push(ring(e.geometry));
    else for (const m of e.members || []) if (m.geometry && m.type === 'way') (m.role === 'inner' ? inners : outers).push(ring(m.geometry));
  }
  return { outers: outers.filter((r) => r.length >= 6), inners: inners.filter((r) => r.length >= 6) };
}

class Grid {
  constructor(x0, z0, W, H) { this.x0 = x0; this.z0 = z0; this.W = W; this.H = H; this.a = new Uint8Array(W * H); }
  fill(ring, v = 1) {
    let zmin = 1e9, zmax = -1e9; for (let i = 1; i < ring.length; i += 2) { zmin = Math.min(zmin, ring[i]); zmax = Math.max(zmax, ring[i]); }
    for (let row = Math.max(0, Math.floor(zmin - this.z0)); row <= Math.min(this.H - 1, Math.ceil(zmax - this.z0)); row++) {
      const zc = row + this.z0 + 0.5, xs = [];
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) { const az = ring[i + 1], bz = ring[j + 1]; if ((az > zc) !== (bz > zc)) xs.push(ring[i] + ((zc - az) * (ring[j] - ring[i])) / (bz - az)); }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let c = Math.max(0, Math.round(xs[k] - this.x0)); c < Math.min(this.W, Math.round(xs[k + 1] - this.x0)); c++) this.a[row * this.W + c] = v;
    }
  }
}
const edgeAngle = (rings, flip) => { let sx = 0, sy = 0; for (const r of rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const dx = r[i] - r[j], dz = flip * (r[i + 1] - r[j + 1]), l = Math.hypot(dx, dz), a = Math.atan2(dz, dx); sx += l * Math.cos(4 * a); sy += l * Math.sin(4 * a); } return Math.atan2(sy, sx) / 4; };
const polyArea = (r) => { let s = 0; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) s += r[j] * r[i + 1] - r[i] * r[j + 1]; return Math.abs(s / 2); };

/** plans: plan polygons (flat, plan units; rooms/corridors of one floor). Returns { map, iou, flip } or null */
export function alignToFootprint(plans, fp) {
  if (!plans.length || !fp.outers.length) return null;
  const all = fp.outers.flat(); let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < all.length; i += 2) { x0 = Math.min(x0, all[i]); x1 = Math.max(x1, all[i]); z0 = Math.min(z0, all[i + 1]); z1 = Math.max(z1, all[i + 1]); }
  const pad = 45, gx = Math.floor(x0 - pad), gz = Math.floor(z0 - pad), W = Math.ceil(x1 - x0 + 2 * pad), H = Math.ceil(z1 - z0 + 2 * pad);
  const F = new Grid(gx, gz, W, H); for (const r of fp.outers) F.fill(r, 1); for (const r of fp.inners) F.fill(r, 0);
  let fa = 0; for (const v of F.a) fa += v;
  const planA = plans.reduce((s, r) => s + polyArea(r), 0);
  const fc = [0, 0]; { let n = 0; for (let i = 0; i < F.a.length; i++) if (F.a[i]) { fc[0] += (i % W) + gx; fc[1] += Math.floor(i / W) + gz; n++; } fc[0] /= n; fc[1] /= n; }
  const pc = [0, 0]; { let n = 0; for (const r of plans) for (let i = 0; i < r.length; i += 2) { pc[0] += r[i]; pc[1] += r[i + 1]; n++; } pc[0] /= n; pc[1] /= n; }
  const G = new Grid(gx, gz, W, H);
  const make = (flip, s, th, tx, tz) => (x, y) => { const ax = s * (x - pc[0]), ay = s * (flip * y - flip * pc[1]); return [Math.cos(th) * ax - Math.sin(th) * ay + fc[0] + tx, Math.sin(th) * ax + Math.cos(th) * ay + fc[1] + tz]; };
  const iou = (m) => {
    G.a.fill(0);
    for (const r of plans) { const t = new Array(r.length); for (let i = 0; i < r.length; i += 2) { const [x, z] = m(r[i], r[i + 1]); t[i] = x; t[i + 1] = z; } G.fill(t, 1); }
    let inter = 0, uni = 0; for (let i = 0; i < G.a.length; i++) { const a = F.a[i], b = G.a[i]; if (a & b) inter++; if (a | b) uni++; }
    return inter / (uni || 1);
  };
  const s0 = Math.sqrt(fa / planA) * 0.96, thF = edgeAngle(fp.outers, 1);
  let best = null; const cands = [];
  for (const flip of [1, -1]) {
    const thP = edgeAngle(plans, flip);
    for (let k = 0; k < 4; k++) {
      let p = { ls: 0, th: thF - thP + (k * Math.PI) / 2, tx: 0, tz: 0 }, cur = iou(make(flip, s0, p.th, 0, 0));
      for (let step = 1; step >= 0.06; step /= 2) {
        let improved = true, guard = 0;
        while (improved && guard++ < 40) {
          improved = false;
          for (const [key, d] of [['ls', 0.05], ['th', 0.03], ['tx', 3], ['tz', 3]]) for (const sg of [-1, 1]) {
            const q = { ...p, [key]: p[key] + sg * d * step }, v = iou(make(flip, s0 * Math.exp(q.ls), q.th, q.tx, q.tz));
            if (v > cur + 1e-4) { cur = v; p = q; improved = true; }
          }
        }
      }
      cands.push({ flip, k, iou: cur, p });
      if (!best || cur > best.iou) best = { iou: cur, flip, p };
    }
  }
  const { flip, p } = best, s = s0 * Math.exp(p.ls), vs = cands.map((c) => c.iou).sort((a, b) => b - a), margin = vs[0] - (vs[1] || 0);
  return { map: make(flip, s, p.th, p.tx, p.tz), iou: best.iou, margin, flip, scale: s, rotDeg: (p.th * 180) / Math.PI, cands, make, s0, pc, fc };
}
