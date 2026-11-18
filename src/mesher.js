// Turns OSM building footprints into one merged 3D mesh: walls + real roof shapes
// (flat, gabled, hipped, skillion, pyramidal, dome, onion) following the
// OSM "Simple 3D Buildings" tagging.
import earcut from 'earcut';

export const LIN = new Uint8Array(256);
for (let i = 0; i < 256; i++) LIN[i] = Math.round(255 * Math.pow(i / 255, 2.2));

const PROFILES = {
  3: [[1, 0], [0, 1]],
  4: [[1, 0], [0.95, 0.31], [0.81, 0.59], [0.59, 0.81], [0.31, 0.95], [0, 1]],
  5: [[1, 0], [1.2, 0.16], [1.26, 0.32], [1.08, 0.5], [0.66, 0.66], [0.3, 0.8], [0.1, 0.91], [0, 1]],
};

function obb(r) {
  const n = r.length / 2;
  let best = null;
  const step = Math.max(1, Math.floor(n / 48));
  for (let i = 0; i < n; i += step) {
    const j = (i + 1) % n;
    let dx = r[j * 2] - r[i * 2], dz = r[j * 2 + 1] - r[i * 2 + 1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    dx /= len; dz /= len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const a = r[k * 2] * dx + r[k * 2 + 1] * dz, b = -r[k * 2] * dz + r[k * 2 + 1] * dx;
      if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    const ar = (a1 - a0) * (b1 - b0);
    if (!best || ar < best.ar) best = { ar, dx, dz, a0, a1, b0, b1 };
  }
  if (!best) return null;
  const ca = (best.a0 + best.a1) / 2, cb = (best.b0 + best.b1) / 2;
  const o = { cx: ca * best.dx - cb * best.dz, cz: ca * best.dz + cb * best.dx, ux: best.dx, uz: best.dz, L: best.a1 - best.a0, W: best.b1 - best.b0 };
  if (o.W > o.L) { [o.L, o.W] = [o.W, o.L]; [o.ux, o.uz] = [-o.uz, o.ux]; }
  return o;
}

function clip(poly, a, b, c) {
  const out = [], n = poly.length;
  for (let i = 0; i < n; i++) {
    const P = poly[i], Q = poly[(i + 1) % n];
    const dp = a * P[0] + b * P[1] + c, dq = a * Q[0] + b * Q[1] + c;
    if (dp >= 0) out.push(P);
    if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]); }
  }
  return out;
}

/** list: rows from data/buildings.json */
export function meshBuildings(list) {
  const pos = [], col = [], idx = [], ab = [];
  let seed = 0, style = 0;
  const triStart = new Uint32Array(list.length + 1);
  const totalH = new Float32Array(list.length);
  let nv = 0;
  const V = (x, y, z, c, k = 1, part = 0) => {
    pos.push(x, y, z);
    ab.push(seed, part, style, 0);
    col.push(LIN[((c >> 16) & 255) * k | 0], LIN[((c >> 8) & 255) * k | 0], LIN[(c & 255) * k | 0]);
    return nv++;
  };

  for (let bi = 0; bi < list.length; bi++) {
    const b = list[bi];
    triStart[bi] = idx.length / 3;
    seed = (Math.imul(b[0], 2654435761) >>> 24) & 255; style = b[12] || 0;
    const wallH = b[3], minH = b[4], flags = b[7], wc = b[9], rc = b[10], rings = b[11];
    let rh = b[5], shape = b[6];
    const outer = rings[0], n = outer.length / 2;
    const y0 = minH > 0 ? minH : -1.5, y1 = wallH;

    let box = null, hf = null;
    if (shape === 1 || shape === 2 || shape === 6) {
      box = obb(outer);
      if (!box || box.W < 1.5) shape = 0;
      else {
        if (flags & 8) { [box.L, box.W] = [box.W, box.L]; [box.ux, box.uz] = [-box.uz, box.ux]; }
        if (rh < 0) rh = Math.min(5.5, Math.max(1.2, Math.min(box.W, box.L) * 0.36));
        const hw = box.W / 2, hl = box.L / 2;
        if (shape === 1) hf = (u, v) => rh * Math.max(0, 1 - Math.abs(v) / hw);
        else if (shape === 2) hf = (u, v) => rh * Math.max(0, Math.min(1 - Math.abs(v) / hw, (hl - Math.abs(u)) / hw));
        else hf = (u, v) => rh * Math.min(1, Math.max(0, (v + hw) / box.W));
      }
    }
    let cx = 0, cz = 0, rad = 0;
    if (shape >= 3 && shape <= 5) {
      for (let i = 0; i < n; i++) { cx += outer[i * 2]; cz += outer[i * 2 + 1]; }
      cx /= n; cz /= n;
      for (let i = 0; i < n; i++) rad += Math.hypot(outer[i * 2] - cx, outer[i * 2 + 1] - cz);
      rad /= n;
      if (rh < 0) rh = shape === 3 ? rad * 0.7 : shape === 4 ? rad : rad * 1.7;
    }
    if (shape === 0 || rh < 0) rh = 0;
    totalH[bi] = y1 + rh;
    const uv = box ? (x, z) => [(x - box.cx) * box.ux + (z - box.cz) * box.uz, -(x - box.cx) * box.uz + (z - box.cz) * box.ux] : null;
    const top = hf ? (x, z) => { const q = uv(x, z); return y1 + hf(q[0], q[1]); } : () => y1;

    // ---- walls
    const quad = (ax, az, bx, bz) => {
      const ta = top(ax, az), tb = top(bx, bz);
      const i0 = V(ax, y0, az, wc, 0.78), i1 = V(bx, y0, bz, wc, 0.78), i2 = V(bx, tb, bz, wc), i3 = V(ax, ta, az, wc);
      idx.push(i0, i1, i2, i0, i2, i3);
    };
    for (const r of rings) {
      const m = r.length / 2;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const ax = r[i * 2], az = r[i * 2 + 1], bx = r[j * 2], bz = r[j * 2 + 1];
        if (hf && shape !== 6) {
          const va = uv(ax, az)[1], vb = uv(bx, bz)[1];
          if (va * vb < -1e-4) {
            const t = va / (va - vb), mx = ax + t * (bx - ax), mz = az + t * (bz - az);
            quad(ax, az, mx, mz); quad(mx, mz, bx, bz);
            continue;
          }
        }
        quad(ax, az, bx, bz);
      }
    }

    // ---- roof
    if (hf) {
      const P = [];
      for (let i = 0; i < n; i++) P.push(uv(outer[i * 2], outer[i * 2 + 1]));
      const k = box.L / 2 - box.W / 2;
      const regions = shape === 1 ? [[[0, 1, 0]], [[0, -1, 0]]]
        : shape === 2 ? [[[0, 1, 0], [-1, 1, k], [1, 1, k]], [[0, -1, 0], [-1, -1, k], [1, -1, k]], [[1, -1, -k], [1, 1, -k]], [[-1, -1, -k], [-1, 1, -k]]]
          : [[]];
      for (const reg of regions) {
        let poly = P;
        for (const h of reg) { poly = clip(poly, h[0], h[1], h[2]); if (poly.length < 3) break; }
        if (poly.length < 3) continue;
        const fl = [];
        for (const q of poly) fl.push(q[0], q[1]);
        const tri = earcut(fl);
        const base = nv;
        for (const q of poly) V(box.cx + q[0] * box.ux - q[1] * box.uz, y1 + hf(q[0], q[1]), box.cz + q[0] * box.uz + q[1] * box.ux, rc, 1, 1);
        for (const t of tri) idx.push(base + t);
      }
    } else if (shape >= 3 && rh > 0 && rings.length === 1) {
      const prof = PROFILES[shape];
      let prev = -1;
      for (let p = 0; p < prof.length; p++) {
        const [s, f] = prof[p], y = y1 + rh * f;
        if (s === 0) {
          const apex = V(cx, y, cz, rc, 1, 1);
          for (let i = 0; i < n; i++) idx.push(prev + i, prev + ((i + 1) % n), apex);
          break;
        }
        const base = nv;
        for (let i = 0; i < n; i++) V(cx + (outer[i * 2] - cx) * s, y, cz + (outer[i * 2 + 1] - cz) * s, rc, 0.86 + 0.14 * f, 1);
        if (prev >= 0) for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(prev + i, prev + j, base + j, prev + i, base + j, base + i); }
        prev = base;
      }
    } else {
      const fl = [], holes = [];
      for (const r of rings) { if (fl.length) holes.push(fl.length / 2); for (const v of r) fl.push(v); }
      const tri = earcut(fl, holes);
      const base = nv;
      for (let i = 0; i < fl.length; i += 2) V(fl[i], y1, fl[i + 1], rc, 1, 2);
      for (const t of tri) idx.push(base + t);
    }
  }
  triStart[list.length] = idx.length / 3;
  return { positions: new Float32Array(pos), colors: new Uint8Array(col), index: new Uint32Array(idx), triStart, totalH, ab: new Uint8Array(ab) };
}

/** Official LoD2 models (data/lod2.bin + rows from data/lod2.json) -> one merged mesh, same layout as meshBuildings */
export function meshLod2(rows, view, offsets, list) {
  let nv = 0, nt = 0;
  for (const i of list) { nv += view.getUint16(offsets[i] + 8, true); nt += view.getUint16(offsets[i] + 10, true); }
  const positions = new Float32Array(nv * 3), colors = new Uint8Array(nv * 3), ab = new Uint8Array(nv * 4), index = new Uint32Array(nt * 3);
  const triStart = new Uint32Array(list.length + 1), totalH = new Float32Array(list.length);
  let v = 0, t = 0;
  list.forEach((bi, j) => {
    const row = rows[bi], wc = row[5], rc = row[6], style = row[8] || 0;
    const seed = (Math.imul(bi + 1, 2654435761) >>> 24) & 255;
    let o = offsets[bi];
    const ox = view.getFloat32(o, true), oz = view.getFloat32(o + 4, true), n = view.getUint16(o + 8, true), m = view.getUint16(o + 10, true);
    o += 12;
    const partsAt = o + n * 6, idxAt = partsAt + n;
    triStart[j] = t;
    let maxY = 0;
    for (let k = 0; k < n; k++) {
      const x = ox + view.getInt16(o + k * 6, true) / 10, y = view.getInt16(o + k * 6 + 2, true) / 10, z = oz + view.getInt16(o + k * 6 + 4, true) / 10;
      const part = view.getUint8(partsAt + k), c = part ? rc : wc, sh = part ? 1 : y < 0.6 ? 0.78 : 1;
      const p = (v + k) * 3;
      positions[p] = x; positions[p + 1] = y < 0.05 ? -1.5 : y; positions[p + 2] = z;
      colors[p] = LIN[((c >> 16) & 255) * sh | 0]; colors[p + 1] = LIN[((c >> 8) & 255) * sh | 0]; colors[p + 2] = LIN[(c & 255) * sh | 0];
      ab.set([seed, part, style, 0], (v + k) * 4);
      maxY = Math.max(maxY, y);
    }
    for (let k = 0; k < m * 3; k++) index[t * 3 + k] = v + view.getUint16(idxAt + k * 2, true);
    totalH[j] = row[3] || maxY;
    v += n; t += m;
  });
  triStart[list.length] = t;
  return { positions, colors, index, triStart, totalH, ab };
}

/** byte offset of every building record in data/lod2.bin */
export function lod2Offsets(view) {
  const n = view.getUint32(4, true), offs = new Uint32Array(n);
  let o = 8;
  for (let i = 0; i < n; i++) {
    offs[i] = o;
    const nv = view.getUint16(o + 8, true), nt = view.getUint16(o + 10, true);
    o += 12 + nv * 7 + nt * 6;
  }
  return offs;
}
