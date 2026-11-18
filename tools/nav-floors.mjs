// Relating one Campus Navigator floor plan to another floor of the same building.
// Every floor page is drawn in its own plan coordinates (centred on the drawing, scaled to the page canvas), so to
// stack the floors we need the scale + offset between two plans. Floors share their outer and most inner walls, so:
//   1. starting guesses from things at the same spot on every floor: stairs/lifts with the same name (TR1, Aufzug1),
//      rooms whose numbers differ only in the floor digit (A.004 under A.104), the canvas size, the plan extents
//   2. refine each guess by sliding/scaling floor A's walls onto floor B's walls (chamfer distance, robust to
//      floors that are only partly the same, e.g. a smaller top floor)
//   3. keep the best one if the walls really agree; floors are never rotated or mirrored against each other.
const cen = (r) => { let x = 0, z = 0; for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; } return [x / (r.length / 2), z / (r.length / 2)]; };
const ROOMISH = new Set(['raeume', 'hoersaele', 'seminarraeume', 'pc_pools', 'labore', 'ruheraeume', 'bibliotheken']);
const shapes = (p) => p.rooms.filter((r) => r.layer !== 'gebaeude' && r.poly.length >= 6);
const bboxOf = (p) => { const a = [1e9, 1e9, -1e9, -1e9]; for (const r of shapes(p)) for (let i = 0; i < r.poly.length; i += 2) { a[0] = Math.min(a[0], r.poly[i]); a[1] = Math.min(a[1], r.poly[i + 1]); a[2] = Math.max(a[2], r.poly[i]); a[3] = Math.max(a[3], r.poly[i + 1]); } return a; };
/** room number without its floor digit: "A.104" -> "A.#04", "2031" -> "#031"; null when it has no such digits */
const floorFree = (ref) => { const m = ref.match(/^(\D*)(\d)(\d{2,})(\D*)$/); return m ? m[1] + '#' + m[3] + m[4] : null; };

/** least-squares scale + offset (no rotation) mapping a -> b */
function fitST(P) {
  const n = P.length, ca = [0, 1].map((k) => P.reduce((s, q) => s + q.a[k], 0) / n), cb = [0, 1].map((k) => P.reduce((s, q) => s + q.b[k], 0) / n);
  let num = 0, den = 0; for (const q of P) { const ax = q.a[0] - ca[0], ay = q.a[1] - ca[1]; num += ax * (q.b[0] - cb[0]) + ay * (q.b[1] - cb[1]); den += ax * ax + ay * ay; }
  const s = n >= 2 && den > 0 ? num / den : 1;
  return { s, tx: cb[0] - s * ca[0], tz: cb[1] - s * ca[1] };
}
function robustST(pairs, tol) {
  let use = pairs, T = null;
  for (let it = 0; it < 8 && use.length >= 2; it++) {
    T = fitST(use);
    const err = pairs.map((q) => Math.hypot(T.s * q.a[0] + T.tx - q.b[0], T.s * q.a[1] + T.tz - q.b[1])), med = [...err].sort((x, y) => x - y)[err.length >> 1];
    const next = pairs.filter((q, i) => err[i] <= Math.max(tol, 2 * med));
    if (next.length === use.length) break;
    use = next;
  }
  return T && use.length >= 2 && T.s > 0 ? T : null;
}

/** distance (in cells) from every cell to the nearest wall of plan B */
function wallField(p, cell) {
  const b = bboxOf(p), padX = (b[2] - b[0]) * 0.3 + 20 * cell, padZ = (b[3] - b[1]) * 0.3 + 20 * cell;
  const x0 = b[0] - padX, z0 = b[1] - padZ, W = Math.ceil((b[2] - b[0] + 2 * padX) / cell), H = Math.ceil((b[3] - b[1] + 2 * padZ) / cell);
  const D = new Float32Array(W * H).fill(1e6);
  for (const r of shapes(p)) for (let i = 0, j = r.poly.length - 2; i < r.poly.length; j = i, i += 2) {
    const ax = r.poly[j], az = r.poly[j + 1], bx = r.poly[i], bz = r.poly[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (cell * 0.5)));
    for (let k = 0; k <= n; k++) { const c = Math.floor((ax + ((bx - ax) * k) / n - x0) / cell), rr = Math.floor((az + ((bz - az) * k) / n - z0) / cell); if (c >= 0 && c < W && rr >= 0 && rr < H) D[rr * W + c] = 0; }
  }
  // two-pass chamfer distance (1, sqrt 2)
  const S = Math.SQRT2;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const i = r * W + c; let v = D[i]; if (c > 0) v = Math.min(v, D[i - 1] + 1); if (r > 0) { v = Math.min(v, D[i - W] + 1); if (c > 0) v = Math.min(v, D[i - W - 1] + S); if (c < W - 1) v = Math.min(v, D[i - W + 1] + S); } D[i] = v; }
  for (let r = H - 1; r >= 0; r--) for (let c = W - 1; c >= 0; c--) { const i = r * W + c; let v = D[i]; if (c < W - 1) v = Math.min(v, D[i + 1] + 1); if (r < H - 1) { v = Math.min(v, D[i + W] + 1); if (c < W - 1) v = Math.min(v, D[i + W + 1] + S); if (c > 0) v = Math.min(v, D[i + W - 1] + S); } D[i] = v; }
  return { at: (x, z) => { const c = Math.floor((x - x0) / cell), r = Math.floor((z - z0) / cell); return c >= 0 && c < W && r >= 0 && r < H ? D[r * W + c] : 1e6; } };
}
/** points along the walls of plan A, about one per cell */
function wallSamples(p, step) {
  const pts = [];
  for (const r of shapes(p)) for (let i = 0, j = r.poly.length - 2; i < r.poly.length; j = i, i += 2) {
    const ax = r.poly[j], az = r.poly[j + 1], bx = r.poly[i], bz = r.poly[i + 1], n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) pts.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
  }
  if (pts.length > 2 * 6000) { const out = [], every = Math.ceil(pts.length / 2 / 6000); for (let i = 0; i < pts.length; i += 2 * every) out.push(pts[i], pts[i + 1]); return out; }
  return pts;
}

/**
 * Transform from plan `pa` (floor A) into the plan coordinates of `pb` (floor B), or null when the walls don't agree.
 * Returns { T: { s, th: 0, map }, near, meanDist, how, inliers, median } — distances in B's plan units.
 */
export function relateFloors(pa, pb) {
  const bB = bboxOf(pb), bA = bboxOf(pa), ext = Math.max(bB[2] - bB[0], bB[3] - bB[1]);
  if (!(ext > 0) || !(bA[2] > bA[0])) return null;
  const cell = ext / 400, cap = 6; // ~0.15-0.25 m per cell
  const F = wallField(pb, cell), P = wallSamples(pa, (Math.max(bA[2] - bA[0], bA[3] - bA[1]) / 400));
  const score = (T) => { let s = 0, near = 0; const m = P.length / 2; for (let i = 0; i < P.length; i += 2) { const d = F.at(T.s * P[i] + T.tx, T.s * P[i + 1] + T.tz); s += Math.min(d, cap); if (d <= 1.5) near++; } return { mean: s / m, near: near / m }; };
  // starting guesses
  const starts = [];
  const uniq = (p, keyOf) => { const m = new Map(); for (const r of p.rooms) { if (!r.ref || r.layer === 'gebaeude' || r.layer === 'korridor') continue; const k = keyOf(r); if (k == null) continue; m.set(k, m.has(k) ? null : r); } return m; };
  const kA = uniq(pa, (r) => (ROOMISH.has(r.layer) ? null : r.layer + ':' + r.ref)), kB = uniq(pb, (r) => (ROOMISH.has(r.layer) ? null : r.layer + ':' + r.ref));
  const fixed = []; for (const [k, r] of kA) { const o = kB.get(k); if (r && o) fixed.push({ a: cen(r.poly), b: cen(o.poly), ref: k }); }
  const rA = uniq(pa, (r) => floorFree(r.ref)), rB = uniq(pb, (r) => floorFree(r.ref));
  const stacked = []; for (const [k, r] of rA) { const o = rB.get(k); if (r && o) stacked.push({ a: cen(r.poly), b: cen(o.poly), ref: k }); }
  if (fixed.length >= 2) { const T = robustST(fixed, cell * 4); if (T) starts.push({ ...T, how: 'stairs/lifts' }); }
  if (fixed.length + stacked.length >= 3) { const T = robustST([...fixed, ...stacked], cell * 8); if (T) starts.push({ ...T, how: 'stacked rooms' }); }
  const cA = [(bA[0] + bA[2]) / 2, (bA[1] + bA[3]) / 2], cB = [(bB[0] + bB[2]) / 2, (bB[1] + bB[3]) / 2];
  for (const s of [(bB[2] - bB[0]) / (bA[2] - bA[0]), (bB[3] - bB[1]) / (bA[3] - bA[1]), (pa.canv && pb.canv ? pb.canv[0] / pa.canv[0] : 0) || 1, 1]) {
    if (!(s > 0.25 && s < 4)) continue;
    starts.push({ s, tx: cB[0] - s * cA[0], tz: cB[1] - s * cA[1], how: 'plan extent' });
    starts.push({ s, tx: bB[0] - s * bA[0], tz: bB[1] - s * bA[1], how: 'plan extent' }); // left/top edges together (partial floors)
    starts.push({ s, tx: bB[2] - s * bA[2], tz: bB[3] - s * bA[3], how: 'plan extent' }); // right/bottom edges together
  }
  // refine each guess: pattern search over log-scale and offset
  let best = null;
  for (const st of starts) {
    let T = { s: st.s, tx: st.tx, tz: st.tz }, cur = score(T);
    for (let step = 8; step >= 0.25; step /= 2) {
      let improved = true, guard = 0;
      while (improved && guard++ < 30) {
        improved = false;
        for (const [k, d] of [['tx', step * cell], ['tz', step * cell], ['ls', step * 0.004]]) for (const sg of [-1, 1]) {
          let Q;
          if (k === 'ls') { const f = Math.exp(sg * d), cx = cB[0], cz = cB[1]; Q = { s: T.s * f, tx: cx + (T.tx - cx) * f, tz: cz + (T.tz - cz) * f }; } // scale about B's centre
          else Q = { ...T, [k]: T[k] + sg * d };
          if (!(Q.s > 0.4 && Q.s < 2.5)) continue;
          const v = score(Q);
          if (v.mean < cur.mean - 1e-4) { T = Q; cur = v; improved = true; }
        }
      }
    }
    if (!best || cur.mean < best.cur.mean) best = { T, cur, how: st.how };
  }
  if (!best || !(best.T.s > 0.4 && best.T.s < 2.5)) return null;
  // landmark check under the final transform
  const tol = cell * 6, agree = fixed.filter((q) => Math.hypot(best.T.s * q.a[0] + best.T.tx - q.b[0], best.T.s * q.a[1] + best.T.tz - q.b[1]) < tol).length;
  // small floors (a stair tower, a roof room) fit almost anywhere: ask more of them, and believe named stairs/lifts
  const small = shapes(pa).length < 8;
  const landmarks = agree >= 3 && agree >= 0.4 * fixed.length; // several named stairs/lifts land on their twins
  const ok = (landmarks && best.cur.near >= 0.45 && best.cur.mean <= 3) || best.cur.near >= (small ? 0.8 : 0.55) && best.cur.mean <= 2.2 && (fixed.length === 0 ? !small : agree >= Math.min(2, fixed.length) || (!small && best.cur.near >= 0.75));
  if (!ok) { if (process.env.NAV_DEBUG) console.log("    reject", JSON.stringify({ near: best.cur.near.toFixed(2), mean: best.cur.mean.toFixed(2), agree, fixed: fixed.length, s: best.T.s.toFixed(3), how: best.how, samples: P.length / 2 })); return null; }
  const { s, tx, tz } = best.T;
  return { T: { s, th: 0, tx, tz, map: (x, y) => [s * x + tx, s * y + tz] }, near: +best.cur.near.toFixed(2), meanDist: +(best.cur.mean * cell).toFixed(1), how: `walls match (${Math.round(best.cur.near * 100)}% on the other floor's walls, start: ${best.how}, ${agree}/${fixed.length} stairs/lifts agree)`, inliers: Math.round(best.cur.near * 100), median: best.cur.mean * cell };
}

/**
 * Relate every floor to the reference floor, going through the most similar floors (e.g. 05 -> 04 -> 03 -> ref),
 * because neighbouring floors share far more walls than the top floor and the ground floor.
 * pages: { floorId: plan }. Returns { floorId: { map, s, tx, tz, near, via: [floorIds] } } (the ref floor maps to itself).
 */
/** every pairwise floor relation of one building (A>B keys), computed once */
export function floorGraph(pages) {
  const ids = Object.keys(pages), rel = {};
  for (const a of ids) for (const b of ids) if (a !== b) {
    let r = relateFloors(pages[a], pages[b]);
    // no wall match, but both pages have exactly the same canvas: the Navigator then draws them in the same plan
    // coordinates (true for 65 of 68 floor pairs that could be checked), so keep that as a weak link
    const ca = pages[a].canv, cb = pages[b].canv;
    if (!r && ca && cb && ca[0] && ca[0] === cb[0] && ca[1] === cb[1]) r = { T: { s: 1, th: 0, tx: 0, tz: 0, map: (x, y) => [x, y] }, near: 0.5, how: 'same page canvas' };
    if (r) rel[a + '>' + b] = r;
  }
  return rel;
}
export function relateAll(pages, ref, rel = floorGraph(pages)) {
  const ids = Object.keys(pages);
  const out = { [ref]: { s: 1, tx: 0, tz: 0, near: 1, via: [ref] } };
  // Prim-style widest path: always attach the floor whose best link (into an attached floor) is strongest
  for (;;) {
    let best = null;
    for (const a of ids) {
      if (out[a]) continue;
      for (const b of Object.keys(out)) { const r = rel[a + '>' + b]; if (!r) continue; const q = Math.min(r.near, out[b].near); if (!best || q > best.q) best = { a, b, r, q }; }
    }
    if (!best) break;
    const B = out[best.b], R = best.r.T; // compose: A -> B (R), then B -> ref (B)
    out[best.a] = { s: B.s * R.s, tx: B.s * R.tx + B.tx, tz: B.s * R.tz + B.tz, near: best.q, via: [best.a, ...B.via] };
  }
  for (const v of Object.values(out)) { const { s, tx, tz } = v; v.map = (x, y) => [s * x + tx, s * y + tz]; }
  return out;
}
