// Builds the static world: carved ground + baked land-cover texture, water,
// detailed roads / rails / bridges, trees and buildings with procedural facades.
import * as THREE from 'three';
import earcut from 'earcut';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { meshBuildings, meshLod2, lod2Offsets } from './mesher.js';

export const WATER_Y = -7;
const POND_Y = -0.7;

const LAND_COL = {
  residential: '#d9d3c5', commercial: '#d7d0c7', industrial: '#cfcbc5', railway: '#bcb7af', construction: '#cbc1aa', farmland: '#d3d5a6',
  grass: '#b4cd90', parking: '#c8c6c1', plaza: '#e2dac8', cemetery: '#a8c398', allotments: '#b6ca99', park: '#a2c786', scrub: '#98b880',
  forest: '#7cab70', pitch: '#8cc387', sand: '#e3d6ae', playground: '#d8d2aa', pond: '#566b66', river: '#4d5b52',
};
const GREEN = new Set(['farmland', 'grass', 'cemetery', 'allotments', 'park', 'scrub', 'forest', 'pitch', 'playground']);
const WATERK = new Set(['pond', 'river']);
function seasonColour(kind, hexc, season) {
  const c = new THREE.Color(hexc), h = {};
  c.getHSL(h);
  if (WATERK.has(kind)) return '#' + c.getHexString();
  if (GREEN.has(kind)) {
    if (season === 'spring') c.setHSL(h.h + 0.01, Math.min(1, h.s * 1.25), h.l * 1.04);
    else if (season === 'autumn') c.setHSL(kind === 'forest' ? 0.1 : h.h - 0.07, h.s * (kind === 'forest' ? 0.75 : 0.7), h.l * (kind === 'forest' ? 0.86 : 0.97));
    else if (season === 'winter') c.lerp(new THREE.Color('#eef2f6'), 0.84);
  } else if (season === 'winter') c.lerp(new THREE.Color('#eef2f6'), kind === 'plaza' || kind === 'parking' ? 0.45 : 0.6);
  return '#' + c.getHexString();
}

const NOISE = `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
`;

function tracePoly(ctx, rings, sx, sz, ox, oz) {
  ctx.beginPath();
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      const x = (r[i] - ox) * sx, y = (r[i + 1] - oz) * sz;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

export function buildWorld(data, renderer) {
  const { meta, land, trees, buildings } = data;
  const roads = data.roads.ways, roadNames = data.roads.names;
  const { minX, maxX, minZ, maxZ } = meta.ext;
  const W = maxX - minX, H = maxZ - minZ;
  const group = new THREE.Group();
  const riverK = land.kinds.indexOf('river'), pondK = land.kinds.indexOf('pond');
  const U = { uNight: { value: 0 }, uSnow: { value: 0 }, uWet: { value: 0 }, uSkyCol: { value: new THREE.Color('#9db7d8') } };

  // ---------- masks (2 m / px) ----------
  // water: R = river, G = pond (blurred -> smooth banks);  solid: R = buildings, G = bridge decks
  const MS = Math.max(2, Math.ceil(Math.sqrt((W * H) / 1e7))), mw = Math.ceil(W / MS), mh = Math.ceil(H / MS);
  const mkCanvas = () => { const c = document.createElement('canvas'); c.width = mw; c.height = mh; return c; };
  const raw = mkCanvas(), rc = raw.getContext('2d');
  rc.fillStyle = '#000'; rc.fillRect(0, 0, mw, mh);
  rc.globalCompositeOperation = 'lighter';
  for (const [k, rings] of land.polys) {
    if (k !== riverK && k !== pondK) continue;
    rc.fillStyle = k === riverK ? '#ff0000' : '#00ff00';
    tracePoly(rc, rings, 1 / MS, 1 / MS, minX, minZ);
    rc.fill('evenodd');
  }
  const blurred = mkCanvas(), bc = blurred.getContext('2d', { willReadFrequently: true });
  bc.filter = 'blur(5px)';
  bc.drawImage(raw, 0, 0);
  const wdRaw = bc.getImageData(0, 0, mw, mh).data;
  const wm = new Uint8Array(mw * mh * 2);
  for (let i = 0, j = 0; i < wdRaw.length; i += 4) { wm[j++] = wdRaw[i]; wm[j++] = wdRaw[i + 1]; }
  const sample = (x, z, ch) => {
    const fx = (x - minX) / MS - 0.5, fz = (z - minZ) / MS - 0.5;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    if (x0 < 0 || z0 < 0 || x0 >= mw - 1 || z0 >= mh - 1) return 0;
    const tx = fx - x0, tz = fz - z0, i = (z0 * mw + x0) * 2 + ch;
    return ((wm[i] * (1 - tx) + wm[i + 2] * tx) * (1 - tz) + (wm[i + mw * 2] * (1 - tx) + wm[i + mw * 2 + 2] * tx) * tz) / 255;
  };
  const riverAt = (x, z) => sample(x, z, 0);
  const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const groundY = (x, z) => -(10.5 * ss(0.15, 0.8, sample(x, z, 0)) + 1.8 * ss(0.2, 0.8, sample(x, z, 1)));

  const solid = mkCanvas(), sc = solid.getContext('2d', { willReadFrequently: true });
  sc.fillStyle = '#000'; sc.fillRect(0, 0, mw, mh);
  sc.globalCompositeOperation = 'lighter';
  sc.fillStyle = '#ff0000';
  for (const b of buildings) {
    if (b[4] > 2.6) continue; // raised parts (passages) do not block
    tracePoly(sc, [b[11][0]], 1 / MS, 1 / MS, minX, minZ);
    sc.fill();
  }
  const lod = data.lod2;
  const lodView = lod ? new DataView(lod.bin) : null, lodOffs = lod ? lod2Offsets(lodView) : null;
  if (lod) for (const row of lod.rows) { if (row[10].length >= 6) { tracePoly(sc, [row[10]], 1 / MS, 1 / MS, minX, minZ); sc.fill(); } }
  sc.strokeStyle = '#00ff00'; sc.lineCap = 'round'; sc.lineJoin = 'round';
  for (const r of roads) {
    if (!r[1]) continue;
    const p = r[3];
    sc.lineWidth = (r[2] + 3) / MS;
    sc.beginPath();
    for (let i = 0; i < p.length; i += 2) { const x = (p[i] - minX) / MS, y = (p[i + 1] - minZ) / MS; if (i) sc.lineTo(x, y); else sc.moveTo(x, y); }
    sc.stroke();
  }
  const sdRaw = sc.getImageData(0, 0, mw, mh).data;
  const sm = new Uint8Array(mw * mh * 2);
  for (let i = 0, j = 0; i < sdRaw.length; i += 4) { sm[j++] = sdRaw[i]; sm[j++] = sdRaw[i + 1]; }
  const smAt = (x, z, ch) => {
    const px = Math.floor((x - minX) / MS), pz = Math.floor((z - minZ) / MS);
    if (px < 0 || pz < 0 || px >= mw || pz >= mh) return 0;
    return sm[(pz * mw + px) * 2 + ch];
  };
  const solidAt = (x, z) => smAt(x, z, 0) > 170;
  const bridgeAt = (x, z) => smAt(x, z, 1) > 90;

  // ---------- ground ----------
  const CELL = W * H > 6e7 ? 10 : 7, gsx = Math.round(W / CELL), gsz = Math.round(H / CELL);
  const gg = new THREE.PlaneGeometry(W, H, gsx, gsz);
  gg.rotateX(-Math.PI / 2);
  gg.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const gp = gg.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, groundY(gp.getX(i), gp.getZ(i)));
  gg.computeVertexNormals();

  const tw = Math.min(4096, renderer.capabilities.maxTextureSize), th = Math.round((tw * H) / W);
  const tex = document.createElement('canvas'); tex.width = tw; tex.height = th;
  const tc = tex.getContext('2d');
  const map = new THREE.CanvasTexture(tex);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  function bakeGround(season) {
    tc.fillStyle = season === 'winter' ? '#e6e8ea' : '#d6d1c5'; tc.fillRect(0, 0, tw, th);
    for (const [k, rings] of land.polys) {
      const kind = land.kinds[k];
      tracePoly(tc, rings, tw / W, th / H, minX, minZ);
      tc.fillStyle = seasonColour(kind, LAND_COL[kind], season);
      tc.fill('evenodd');
      if (k === riverK) { tc.strokeStyle = season === 'winter' ? '#d8dcdd' : '#9d9a84'; tc.lineWidth = 6; tc.stroke(); }
    }
    map.needsUpdate = true;
  }
  const groundMat = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
  const aerialF = { value: 0 };
  groundMat.onBeforeCompile = (sh) => {
    sh.uniforms.uAerial = aerialF;
    sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec3 vWPos;\nuniform float uAerial;\n' + NOISE + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      { float d = length(vWPos - cameraPosition);
        float n = vn(vWPos.xz * 1.3) * 0.5 + vn(vWPos.xz * 0.11) * 0.5;
        diffuseColor.rgb *= 1.0 + (n - 0.5) * 0.22 * (1.0 - uAerial) * (1.0 - smoothstep(400.0, 2500.0, d) * 0.6); }`);
  };
  const ground = new THREE.Mesh(gg, groundMat);
  ground.receiveShadow = true;
  group.add(ground);
  let aerialTex = null;
  function setAerial(on) {
    aerialF.value = on ? 1 : 0;
    if (!on) { groundMat.map = map; return; }
    if (aerialTex) { groundMat.map = aerialTex; return; }
    new THREE.TextureLoader().load('./data/aerial.jpg', (t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = map.anisotropy; aerialTex = t;
      if (aerialF.value) groundMat.map = t;
    });
  }

  // surroundings: flat apron with a hole for the map + closing walls
  const S = 40000;
  const shape = new THREE.Shape([new THREE.Vector2(-S, -S), new THREE.Vector2(S, -S), new THREE.Vector2(S, S), new THREE.Vector2(-S, S)]);
  shape.holes.push(new THREE.Path([new THREE.Vector2(minX, minZ), new THREE.Vector2(minX, maxZ), new THREE.Vector2(maxX, maxZ), new THREE.Vector2(maxX, minZ)]));
  // countryside helpers: smooth value noise, distance outside the map rectangle
  const hash2 = (x, z) => { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); };
  const vnoise = (x, z) => { const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz), a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; };
  const fbm = (x, z) => 0.5 * vnoise(x, z) + 0.3 * vnoise(x * 2.03 + 5.1, z * 2.03 - 3.7) + 0.2 * vnoise(x * 4.1 - 9.2, z * 4.1 + 1.3);
  const outside = (x, z) => Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
  const sstep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  // fields: a patchwork texture (redrawn per season) tiled over the flat land outside the map
  const fieldCv = document.createElement('canvas'); fieldCv.width = fieldCv.height = 512;
  const apronTex = new THREE.CanvasTexture(fieldCv);
  apronTex.wrapS = apronTex.wrapT = THREE.RepeatWrapping; apronTex.repeat.set(1 / 2600, 1 / 2600); apronTex.colorSpace = THREE.SRGBColorSpace; apronTex.anisotropy = 8;
  const FIELDS = {
    spring: ['#8fae5f', '#a4bf6a', '#7c9c52', '#c9c27a', '#b59a6e', '#9bb865', '#e4d65a'],
    summer: ['#9aa955', '#c8b768', '#d8c47a', '#7f9a4c', '#b39b62', '#a7b35d', '#cdb15c'],
    autumn: ['#8c7a52', '#a58e5c', '#6f7a46', '#b49a63', '#7d6a48', '#94884f', '#a07b4a'],
    winter: ['#e9ecef', '#dfe3e6', '#f2f4f5', '#d6dadc', '#e4e6e3', '#cfd4d6', '#eef0f0'],
  };
  function paintFields(season) {
    const c = fieldCv.getContext('2d'), pal = FIELDS[season] || FIELDS.summer;
    let sd = 23; const r = () => ((sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0) / 4294967296);
    c.fillStyle = season === 'winter' ? '#b9c0bd' : '#5d7240'; c.fillRect(0, 0, 512, 512); // hedgerows between fields
    const split = (x, y, w, h, depth) => {
      if (depth >= 5 || (w * h < 7000 && r() < 0.7)) {
        c.fillStyle = pal[Math.floor(r() * pal.length)]; c.fillRect(x + 1.5, y + 1.5, w - 3, h - 3);
        if (r() < 0.55) { c.globalAlpha = 0.07; c.fillStyle = '#000'; if (w > h) for (let k = 3; k < h - 3; k += 4) c.fillRect(x + 2, y + k, w - 4, 1); else for (let k = 3; k < w - 3; k += 4) c.fillRect(x + k, y + 2, 1, h - 4); c.globalAlpha = 1; }
        return;
      }
      const t = 0.3 + r() * 0.4;
      if (w > h) { split(x, y, w * t, h, depth + 1); split(x + w * t, y, w * (1 - t), h, depth + 1); } else { split(x, y, w, h * t, depth + 1); split(x, y + h * t, w, h * (1 - t), depth + 1); }
    };
    split(0, 0, 512, 512, 0);
    apronTex.needsUpdate = true;
  }
  paintFields('autumn');
  const apronMat = new THREE.MeshStandardMaterial({ map: apronTex, roughness: 1, side: THREE.DoubleSide });
  const apron = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2), apronMat);
  apron.position.y = -0.02;
  group.add(apron);
  const wallMat = new THREE.MeshBasicMaterial({ color: '#39443f', side: THREE.DoubleSide });
  for (const [ax, az, bx, bz] of [[minX, minZ, maxX, minZ], [maxX, minZ, maxX, maxZ], [maxX, maxZ, minX, maxZ], [minX, maxZ, minX, minZ]]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([ax, 0, az, bx, 0, bz, bx, -14, bz, ax, -14, az], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    group.add(new THREE.Mesh(g, wallMat));
  }

  // hills on the horizon: a ring of low-poly countryside rising away from the map (fades into the haze)
  const hcx = (minX + maxX) / 2, hcz = (minZ + maxZ) / 2, R0 = Math.hypot(W, H) / 2 + 200, R1 = 38000, NA = 360, NR = 30;
  const hpos = [], hidx = [], hinfo = [];
  for (let k = 0; k <= NR; k++) {
    const rr = R0 + (R1 - R0) * Math.pow(k / NR, 1.7);
    for (let a = 0; a < NA; a++) {
      const ang = (a / NA) * Math.PI * 2, x = hcx + Math.cos(ang) * rr, z = hcz + Math.sin(ang) * rr;
      const n = fbm(x / 3200, z / 3200), big = fbm(x / 9000 + 7.3, z / 9000 - 2.1);
      const rise = sstep(R0, R0 + 4500, rr);
      const hgt = rise * (25 + 260 * n * n + 340 * big * big * sstep(9000, 20000, rr));
      hpos.push(x, -0.6 + hgt, z);
      hinfo.push(fbm(x / 1400 + 3.3, z / 1400 + 8.8), hgt);
    }
  }
  for (let k = 0; k < NR; k++) for (let a = 0; a < NA; a++) { const i0 = k * NA + a, i1 = k * NA + ((a + 1) % NA), j0 = i0 + NA, j1 = i1 + NA; hidx.push(i0, j0, i1, i1, j0, j1); }
  const hillGeo = new THREE.BufferGeometry();
  hillGeo.setAttribute('position', new THREE.Float32BufferAttribute(hpos, 3));
  hillGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(hpos.length), 3));
  hillGeo.setIndex(hidx); hillGeo.computeVertexNormals();
  const hills = new THREE.Mesh(hillGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  hills.receiveShadow = false; hills.castShadow = false;
  group.add(hills);
  const hc = new THREE.Color();
  function paintHills(season) {
    const col = hillGeo.attributes.color;
    for (let i = 0; i < col.count; i++) {
      const woods = hinfo[i * 2] > 0.52, hgt = hinfo[i * 2 + 1], j = hash2(i, 3) * 0.04;
      if (season === 'winter') hc.setHSL(0.58, 0.06, woods ? 0.42 + j : 0.86 + j - Math.min(0.1, hgt / 4000));
      else if (woods) hc.setHSL(season === 'autumn' ? 0.08 + j : 0.27 + j, season === 'autumn' ? 0.42 : 0.35, season === 'autumn' ? 0.26 : 0.2);
      else hc.setHSL(season === 'autumn' ? 0.12 + j : season === 'spring' ? 0.24 + j : 0.19 + j, 0.38, season === 'autumn' ? 0.42 : 0.4);
      col.setXYZ(i, hc.r, hc.g, hc.b);
    }
    col.needsUpdate = true;
  }
  paintHills('autumn');

  // ---------- water ----------
  const wpos = [], widx = [];
  for (const [k, rings] of land.polys) {
    if (k !== riverK && k !== pondK) continue;
    const fl = [], holes = [];
    for (const r of rings) { if (fl.length) holes.push(fl.length / 2); for (const v of r) fl.push(v); }
    const base = wpos.length / 3, y = k === riverK ? WATER_Y : POND_Y;
    for (let i = 0; i < fl.length; i += 2) wpos.push(fl[i], y, fl[i + 1]);
    for (const t of earcut(fl, holes)) widx.push(base + t);
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
  wg.setIndex(widx);
  const waterMat = new THREE.ShaderMaterial({
    fog: true,
    side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
      uSky: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uDeep: { value: new THREE.Color('#2c4a44') },
    }]),
    vertexShader: `varying vec3 vW;
      #include <fog_pars_vertex>
      void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
      }`,
    fragmentShader: `uniform float uTime; uniform vec3 uSunDir, uSunCol, uSky, uHorizon, uDeep; varying vec3 vW;
      #include <fog_pars_fragment>
      ${NOISE}
      float wh(vec2 p, float t){ return vn(p * 0.22 + vec2(t * 0.35, t * 0.2)) + 0.5 * vn(p * 0.55 - vec2(t * 0.5, -t * 0.3)) + 0.25 * vn(p * 1.3 + t * 0.7); }
      void main(){
        vec2 p = vW.xz; float t = uTime;
        float d = length(cameraPosition - vW);
        float amp = 1.0 / (1.0 + d * 0.01);
        float e = 0.35, h0 = wh(p, t);
        vec3 n = normalize(vec3((h0 - wh(p + vec2(e, 0.0), t)) * 0.55 * amp, 1.0, (h0 - wh(p + vec2(0.0, e), t)) * 0.55 * amp));
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(dot(V, n), 0.0), 4.0);
        vec3 R = reflect(-V, n);
        vec3 skyRef = mix(uHorizon, uSky, clamp(R.y * 1.6, 0.0, 1.0));
        vec3 col = mix(uDeep, skyRef, 0.2 + 0.72 * fres);
        col += uSunCol * pow(max(dot(R, uSunDir), 0.0), 180.0) * 2.2;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const water = new THREE.Mesh(wg, waterMat);
  group.add(water);

  // ---------- roads, rails, sidewalks, bridges ----------
  function offsets(p, half) {
    const n = p.length / 2, L = new Float32Array(n * 2), R = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      let ix = 0, iz = 0, ox = 0, oz = 0;
      if (i > 0) { ix = p[i * 2] - p[i * 2 - 2]; iz = p[i * 2 + 1] - p[i * 2 - 1]; const l = Math.hypot(ix, iz) || 1; ix /= l; iz /= l; }
      if (i < n - 1) { ox = p[i * 2 + 2] - p[i * 2]; oz = p[i * 2 + 3] - p[i * 2 + 1]; const l = Math.hypot(ox, oz) || 1; ox /= l; oz /= l; }
      if (i === 0) { ix = ox; iz = oz; } if (i === n - 1) { ox = ix; oz = iz; }
      let tx = ix + ox, tz = iz + oz, tl = Math.hypot(tx, tz);
      if (tl < 1e-3) { tx = ix; tz = iz; tl = 1; }
      tx /= tl; tz /= tl;
      const s = half / Math.max(0.5, tx * ix + tz * iz);
      L[i * 2] = p[i * 2] - tz * s; L[i * 2 + 1] = p[i * 2 + 1] + tx * s;
      R[i * 2] = p[i * 2] + tz * s; R[i * 2 + 1] = p[i * 2 + 1] - tx * s;
    }
    return [L, R];
  }
  const mk = () => ({ pos: [], col: [], uv: [], inf: [], len: [], idx: [] });
  const layers = { sidewalk: mk(), paths: mk(), minor: mk(), major: mk(), rail: mk() };
  const bridge = { pos: [], idx: [] };
  const C = (h) => new THREE.Color(h);
  const ASPH = [C('#303236'), C('#33353a'), C('#37393d'), C('#3b3d41'), C('#424448'), C('#505255')];
  const COL = { sett: C('#665f57'), settPed: C('#8d8578'), gravel: C('#b09d78'), paving: C('#b3aa98'), ped: C('#bdb4a1'), ballast: C('#5d554e'), tram: C('#2b2d31'), walk: C('#96938b') };
  const RY = { sidewalk: 0.1, paths: 0.12, minor: 0.14, major: 0.16, rail: 0.18 };
  function ribbon(g, pts, half, y, c, mkv, surf, typ) {
    const [L, R] = offsets(pts, half), n = pts.length / 2, base = g.pos.length / 3;
    let total = 0;
    const cum = [0];
    for (let i = 1; i < n; i++) { total += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]); cum.push(total); }
    for (let i = 0; i < n; i++) {
      g.pos.push(L[i * 2], y, L[i * 2 + 1], R[i * 2], y, R[i * 2 + 1]);
      g.col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      g.uv.push(-half, cum[i], half, cum[i]);
      g.inf.push(half, mkv, surf, typ, half, mkv, surf, typ);
      g.len.push(total, total);
      if (i < n - 1) { const a = base + i * 2; g.idx.push(a, a + 3, a + 1, a, a + 2, a + 3); }
    }
    return cum;
  }
  // spatial index of roads (bicycle HUD / spawn)
  const RG = 40, roadGrid = new Map();
  const addRoadPoint = (x, z, ni, dx, dz, cls) => { const k = Math.floor(x / RG) + ',' + Math.floor(z / RG); (roadGrid.get(k) || roadGrid.set(k, []).get(k)).push([x, z, ni, dx, dz, cls]); };
  const SG = 40, segGrid = new Map();
  const addSeg = (ax, az, bx, bz, half, paved) => {
    const r = half + 2.4, x0 = Math.floor((Math.min(ax, bx) - r) / SG), x1 = Math.floor((Math.max(ax, bx) + r) / SG), z0 = Math.floor((Math.min(az, bz) - r) / SG), z1 = Math.floor((Math.max(az, bz) + r) / SG);
    const seg = [ax, az, bx, bz, half, paved];
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) { const k = gx + ',' + gz; (segGrid.get(k) || segGrid.set(k, []).get(k)).push(seg); }
  };
  /** how far (x, z) is inside the nearest road/track ribbon (> 0 = on it); 'paved' extends to the sidewalks */
  function roadInside(x, z, withSidewalk = false) {
    let best = -1e9;
    for (const s of segGrid.get(Math.floor(x / SG) + ',' + Math.floor(z / SG)) || []) {
      const dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / l2));
      const d = Math.hypot(x - s[0] - dx * t, z - s[1] - dz * t), inside = (withSidewalk ? s[5] : s[4]) - d;
      if (inside > best) best = inside;
    }
    return best;
  }
  const piers = [];
  const rails = { pos: [], idx: [] }, posts = [];
  for (const [cls, isBridge, w, pts, marks, surf, sw, ni, oneway] of roads) {
    const name = cls === 7 ? 'paths' : cls >= 8 ? 'rail' : cls <= 3 ? 'major' : 'minor';
    const typ = cls === 9 ? 2 : cls === 8 ? 3 : cls >= 6 ? 1 : 0;
    const c = cls === 8 ? COL.ballast : cls === 9 ? COL.tram : surf === 1 ? (cls >= 6 ? COL.settPed : COL.sett) : surf === 3 ? COL.gravel : surf === 2 && cls >= 6 ? (cls === 6 ? COL.ped : COL.paving) : ASPH[Math.min(cls, 5)];
    const cum = ribbon(layers[name], pts, w / 2, RY[name], c, marks + (oneway ? 0.5 : 0), surf, typ);
    if (sw && !isBridge) ribbon(layers.sidewalk, pts, w / 2 + 2.2, RY.sidewalk, COL.walk, w / 2, 2, 4);
    const n = pts.length / 2;
    for (let i = 0; i < n - 1; i++) addSeg(pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3], w / 2, w / 2 + (sw && !isBridge ? 2.4 : 0.3));
    if (cls <= 7) for (let i = 0; i < n - 1; i++) {
      const dx = pts[i * 2 + 2] - pts[i * 2], dz = pts[i * 2 + 3] - pts[i * 2 + 1], l = Math.hypot(dx, dz) || 1, st = Math.max(1, Math.ceil(l / 15));
      for (let k = 0; k < st; k++) addRoadPoint(pts[i * 2] + (dx * k) / st, pts[i * 2 + 1] + (dz * k) / st, ni, dx / l, dz / l, cls);
    }
    if (isBridge && cls !== 5) {
      const [BL, BR] = offsets(pts, w / 2 + 0.9), b0 = bridge.pos.length / 3, yt = 0.05, yb = -1.4;
      // railings: a top rail and a middle rail (thin vertical strips) plus posts every ~2.4 m, just inside the deck edge.
      // Only on the outer edge of the whole bridge: where another deck (tram tracks, sidewalk...) continues, skip it.
      const [IL, IR] = offsets(pts, w / 2 + 0.75);
      for (const E of [IL, IR]) {
        const outer = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const ox = E[i * 2] - pts[i * 2], oz = E[i * 2 + 1] - pts[i * 2 + 1], ol = Math.hypot(ox, oz) || 1;
          outer[i] = bridgeAt(E[i * 2] + (ox / ol) * 2.6, E[i * 2 + 1] + (oz / ol) * 2.6) ? 0 : 1;
        }
        for (const [y0, y1] of [[1.0, 1.12], [0.5, 0.56]]) {
          const r0 = rails.pos.length / 3;
          for (let i = 0; i < n; i++) rails.pos.push(E[i * 2], y0, E[i * 2 + 1], E[i * 2], y1, E[i * 2 + 1]);
          for (let i = 0; i < n - 1; i++) if (outer[i] && outer[i + 1]) { const q = r0 + i * 2; rails.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
        }
        let carry = 0;
        for (let i = 0; i < n - 1; i++) {
          const ax = E[i * 2], az = E[i * 2 + 1], dx = E[i * 2 + 2] - ax, dz = E[i * 2 + 3] - az, l = Math.hypot(dx, dz);
          if (outer[i] && outer[i + 1]) for (let t = carry; t < l; t += 2.4) posts.push(ax + (dx * t) / l, az + (dz * t) / l, Math.atan2(dx, dz));
          carry = (((carry - l) % 2.4) + 2.4) % 2.4;
        }
        if (outer[n - 1]) posts.push(E[(n - 1) * 2], E[(n - 1) * 2 + 1], 0);
      }
      for (let i = 0; i < n; i++) {
        bridge.pos.push(BL[i * 2], yt, BL[i * 2 + 1], BR[i * 2], yt, BR[i * 2 + 1], BL[i * 2], yb, BL[i * 2 + 1], BR[i * 2], yb, BR[i * 2 + 1]);
        if (i < n - 1) {
          const a = b0 + i * 4, b = a + 4;
          bridge.idx.push(a, a + 1, b + 1, a, b + 1, b, a, b, b + 2, a, b + 2, a + 2, a + 1, a + 3, b + 3, a + 1, b + 3, b + 1, a + 2, b + 2, b + 3, a + 2, b + 3, a + 3);
        }
      }
      if ((cls <= 3 || cls === 8) && w >= 5.5) { // piers in the river
        let next = 22;
        for (let i = 0; i < n - 1; i++) {
          const dx = pts[i * 2 + 2] - pts[i * 2], dz = pts[i * 2 + 3] - pts[i * 2 + 1], l = Math.hypot(dx, dz) || 1;
          while (next <= cum[i + 1]) {
            const t = (next - cum[i]) / l, x = pts[i * 2] + dx * t, z = pts[i * 2 + 1] + dz * t;
            if (riverAt(x, z) > 0.55) piers.push([x, z, Math.atan2(dx, dz), w + 2.4]);
            next += 44;
          }
        }
      }
    }
  }
  const roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  roadMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'varying vec3 vWPos; varying vec2 vRUV; varying vec4 vI; varying float vLen;\nattribute vec2 aRUV; attribute vec4 aI; attribute float aLen;\n'
      + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vRUV = aRUV; vI = aI; vLen = aLen;');
    sh.fragmentShader = 'varying vec3 vWPos; varying vec2 vRUV; varying vec4 vI; varying float vLen;\nuniform float uNight, uSnow, uWet;\n' + NOISE
      + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        float hw = vI.x, mk = vI.y, surf = vI.z, typ = vI.w, ac = vRUV.x, al = vRUV.y;
        float d = length(vWPos - cameraPosition);
        float fd = 1.0 - smoothstep(200.0, 950.0, d), fn = 1.0 - smoothstep(25.0, 150.0, d);
        float aa = max(fwidth(ac), 0.02);
        vec3 base = diffuseColor.rgb;
        float n = vn(vWPos.xz * 2.3) * 0.6 + vn(vWPos.xz * 0.19) * 0.4;
        base *= 0.88 + 0.24 * n * (0.35 + 0.65 * fd);
        if (surf > 0.5 && surf < 1.5) {
          vec2 c = vWPos.xz / 0.2; c.x += step(1.0, mod(floor(c.y), 2.0)) * 0.5; vec2 f = fract(c);
          float j = smoothstep(0.0, 0.16, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
          base *= mix(1.0, (0.62 + 0.38 * j) * (0.86 + 0.28 * h21(floor(c))), fn);
        } else if (surf > 1.5 && surf < 2.5) {
          vec2 f = fract(vWPos.xz / 0.6);
          base *= mix(1.0, 0.82 + 0.18 * smoothstep(0.0, 0.05, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y))), fn);
        }
        float glow = 0.05;
        if (typ < 0.5) {
          glow = 0.2;
          if (mk >= 2.0) {
            glow = 0.5;
            float lanes = floor(mk), oneway = step(0.25, fract(mk));
            float lw = 2.0 * hw / lanes, k = (ac + hw) / lw, r = floor(k + 0.5), dl = abs(k - r) * lw;
            float inner = step(0.5, r) * step(r, lanes - 0.5);
            float isC = (1.0 - oneway) * step(abs(r - lanes * 0.5), 0.25) * step(3.5, lanes);
            float dash = step(fract(al / 9.0), 0.34);
            float ends = smoothstep(5.0, 12.0, al) * smoothstep(5.0, 12.0, vLen - al);
            float line = (1.0 - smoothstep(0.09, 0.09 + aa, dl)) * inner * mix(dash, 1.0, isC);
            float edge = (1.0 - smoothstep(0.06, 0.06 + aa, abs(hw - 0.3 - abs(ac)))) * step(3.5, lanes) * 0.8;
            base = mix(base, vec3(0.92), max(line, edge) * ends * fd * (1.0 - uSnow * 0.8));
          }
        } else if (typ > 1.5 && typ < 2.5) {
          float rail = 1.0 - smoothstep(0.04, 0.04 + aa, abs(abs(ac) - 0.7175));
          base = mix(base, vec3(0.5, 0.52, 0.56), rail * fd); glow = 0.08;
        } else if (typ > 2.5 && typ < 3.5) {
          float sl = step(fract(al / 0.62), 0.42) * step(abs(ac), 1.25);
          base = mix(base, vec3(0.16, 0.13, 0.11), sl * fn);
          float rail = 1.0 - smoothstep(0.045, 0.045 + aa, abs(abs(ac) - 0.7175));
          base = mix(base, vec3(0.42, 0.4, 0.4), rail * fd); glow = 0.04;
        } else if (typ > 3.5) {
          float kerb = 1.0 - smoothstep(0.02, 0.14 + aa, abs(abs(ac) - mk - 0.1));
          vec2 f = fract(vec2(ac, al) / 0.5);
          base *= mix(1.0, 0.86 + 0.14 * smoothstep(0.0, 0.06, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y))), fn);
          base = mix(base, vec3(0.55, 0.56, 0.58), kerb * fd); glow = 0.12;
        }
        float tracks = typ < 0.5 ? 0.3 + 0.45 * smoothstep(0.25, 1.0, abs(ac) / hw) : 0.85;
        base = mix(base, vec3(0.86, 0.89, 0.93), uSnow * tracks * (0.7 + 0.3 * n));
        base *= 1.0 - 0.3 * uWet;
        roughnessFactor = mix(roughnessFactor, 0.22, uWet);
        diffuseColor.rgb = base;
        float pd = (fract(al / 34.0) - 0.5) * 34.0 / 7.5;
        float pool = exp(-pd * pd);
        totalEmissiveRadiance += vec3(1.0, 0.6, 0.28) * glow * uNight * (0.35 + 1.5 * pool);
      }`);
  };
  const roadMeshes = {};
  let order = 1;
  for (const [name, g] of Object.entries(layers)) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
    geo.setAttribute('aRUV', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setAttribute('aI', new THREE.Float32BufferAttribute(g.inf, 4));
    geo.setAttribute('aLen', new THREE.Float32BufferAttribute(g.len, 1));
    geo.setIndex(g.idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, roadMat);
    m.renderOrder = order++;
    m.receiveShadow = true;
    roadMeshes[name] = m;
    group.add(m);
  }
  const bgeo = new THREE.BufferGeometry();
  bgeo.setAttribute('position', new THREE.Float32BufferAttribute(bridge.pos, 3));
  bgeo.setIndex(bridge.idx);
  const stone = new THREE.MeshStandardMaterial({ color: '#a8997c', roughness: 0.9, flatShading: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const bridges = new THREE.Mesh(bgeo, stone);
  bridges.castShadow = true;
  group.add(bridges);
  const ironMat = new THREE.MeshStandardMaterial({ color: '#2c3133', roughness: 0.55, metalness: 0.6, side: THREE.DoubleSide });
  if (rails.idx.length) {
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(rails.pos, 3)); rg.setIndex(rails.idx); rg.computeVertexNormals();
    const rm = new THREE.Mesh(rg, ironMat); rm.castShadow = true; bridges.add(rm);
  }
  if (posts.length) {
    const np = posts.length / 3, pg = new THREE.BoxGeometry(0.07, 1.12, 0.07).translate(0, 0.56, 0), pim = new THREE.InstancedMesh(pg, ironMat, np);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    for (let i = 0; i < np; i++) pim.setMatrixAt(i, M.compose(v.set(posts[i * 3], 0.05, posts[i * 3 + 1]), q.setFromAxisAngle(up, posts[i * 3 + 2]), one));
    pim.castShadow = true; pim.computeBoundingSphere(); bridges.add(pim);
  }
  if (piers.length) {
    const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 11, 3.2).translate(0, -6.9, 0), stone, piers.length);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    piers.forEach((p, i) => pm.setMatrixAt(i, M.compose(new THREE.Vector3(p[0], 0, p[1]), q.setFromAxisAngle(up, p[2] + Math.PI / 2), new THREE.Vector3(p[3], 1, 1))));
    pm.castShadow = true;
    bridges.add(pm);
  }

  // ---------- trees (chunked for culling) ----------
  const crown = new THREE.IcosahedronGeometry(1, 1).scale(1, 1.25, 1).translate(0, 2.05, 0);
  const trunk = new THREE.CylinderGeometry(0.1, 0.17, 1.3, 5, 1, true).translate(0, 0.65, 0);
  const paint = (g, r, gr, b) => { const a = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = r; a[i + 1] = gr; a[i + 2] = b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; };
  const treeGeo = mergeGeometries([paint(crown, 1, 1, 1), paint(trunk, 0.3, 0.21, 0.14)]);
  const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  const all = trees.mapped.concat(trees.scattered), nT = all.length / 2;
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const TC = 520, treeCells = new Map();
  for (let i = 0; i < nT; i++) {
    const x = all[i * 2], z = all[i * 2 + 1];
    const r = [rnd(), rnd(), rnd(), rnd(), rnd()];
    if (sample(x, z, 0) > 0.3 || sample(x, z, 1) > 0.3 || solidAt(x, z) || roadInside(x, z) > -0.6) continue;
    const k = Math.floor(x / TC) + ',' + Math.floor(z / TC);
    (treeCells.get(k) || treeCells.set(k, []).get(k)).push([x, z, r]);
  }
  {
    const BAND = 1100; let sd = 99, placed = 0;
    const r2 = () => ((sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 900000 && placed < 32000; i++) {
      const x = minX - BAND + r2() * (W + 2 * BAND), z = minZ - BAND + r2() * (H + 2 * BAND), d = outside(x, z);
      if (d < 30 || d > BAND) continue;
      const woods = fbm(x / 650, z / 650), p = woods > 0.6 ? 1 : woods > 0.56 ? 0.35 : 0.004; // woods, their edges, a few lone trees
      if (r2() > p * (1 - (d / BAND) * 0.3)) continue;
      // keep the river corridor open where the Elbe leaves the map
      if (riverAt(Math.min(maxX - 3, Math.max(minX + 3, x)), Math.min(maxZ - 3, Math.max(minZ + 3, z))) > 0.1) continue;
      if (roadInside(x, z) > -1) continue;
      const k = Math.floor(x / TC) + ',' + Math.floor(z / TC);
      (treeCells.get(k) || treeCells.set(k, []).get(k)).push([x, z, [r2(), r2(), r2(), r2(), woods > 0.6 ? r2() * 0.3 : r2()]]);
      placed++;
    }
  }
  const treeGroup = new THREE.Group();
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), tcol = new THREE.Color();
  for (const list of treeCells.values()) {
    const im = new THREE.InstancedMesh(treeGeo, treeMat, list.length);
    list.forEach(([x, z, r], i) => {
      const s = 2.6 + r[0] * 2.8;
      im.setMatrixAt(i, M4.compose(new THREE.Vector3(x, 0, z), Q.setFromAxisAngle(UP, r[1] * 6.28), new THREE.Vector3(s, s * (0.85 + r[2] * 0.4), s)));
      im.setColorAt(i, tcol.set('#3c6b34'));
    });
    im.userData.list = list;
    im.castShadow = true; im.renderOrder = 6;
    im.computeBoundingSphere();
    treeGroup.add(im);
  }
  group.add(treeGroup);
  function treeColour(r, season) {
    const [a, b, c, , conifer] = r;
    if (conifer < 0.1) return tcol.setHSL(0.31, 0.35, season === 'winter' ? 0.3 : 0.17 + c * 0.05);
    if (season === 'spring') return a < 0.13 ? tcol.setHSL(0.93, 0.55, 0.8) : a < 0.2 ? tcol.setHSL(0.15, 0.2, 0.88) : tcol.setHSL(0.22 + b * 0.07, 0.5, 0.33 + c * 0.1);
    if (season === 'autumn') return a < 0.3 ? tcol.setHSL(0.125 + b * 0.02, 0.78, 0.47) : a < 0.58 ? tcol.setHSL(0.07 + b * 0.025, 0.8, 0.42) : a < 0.76 ? tcol.setHSL(0.015 + b * 0.02, 0.68, 0.34) : a < 0.88 ? tcol.setHSL(0.08, 0.42, 0.27) : tcol.setHSL(0.21, 0.4, 0.3);
    if (season === 'winter') return a < 0.55 ? tcol.setHSL(0.6, 0.08, 0.7 + b * 0.14) : tcol.setHSL(0.07, 0.14, 0.32 + b * 0.1);
    return tcol.setHSL(0.24 + a * 0.09, 0.32 + b * 0.2, 0.2 + c * 0.12);
  }

  // ---------- buildings (chunked) ----------
  const BC = 650, bCells = new Map();
  buildings.forEach((b, i) => {
    const o = b[11][0], k = Math.floor(o[0] / BC) + ',' + Math.floor(o[1] / BC);
    (bCells.get(k) || bCells.set(k, []).get(k)).push(i);
  });
  const bmat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  bmat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'varying vec3 vWPos; varying vec4 vB;\nattribute vec4 aB;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vB = aB;');
    sh.fragmentShader = 'varying vec3 vWPos; varying vec4 vB;\nuniform float uNight, uSnow; uniform vec3 uSkyCol;\n' + NOISE + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        vec3 wn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
        float up = abs(wn.y);
        float seed = vB.x, part = floor(vB.y * 255.0 + 0.5), style = floor(vB.z * 255.0 + 0.5);
        float d = length(vWPos - cameraPosition);
        float fade = 1.0 - smoothstep(320.0, 1300.0, d), fn = 1.0 - smoothstep(40.0, 240.0, d);
        vec3 base = diffuseColor.rgb;
        float glass = 0.0;
        if (part < 0.5) {
          vec2 td = normalize(vec2(-wn.z, wn.x) + 1e-5);
          float along = dot(vWPos.xz, td), y = vWPos.y;
          float wallF = step(0.35, y) * (1.0 - smoothstep(0.25, 0.5, up));
          float bay = style == 1.0 ? 1.5 : style == 2.0 ? 4.4 : mix(2.4, 3.3, fract(seed * 7.31));
          float fl = style == 1.0 ? 3.5 : style == 2.0 ? 6.6 : 3.1;
          vec2 g = vec2(along / bay, y / fl), cell = floor(g), f = fract(g);
          float rnd = h21(cell + seed * 91.0);
          float win = 0.0, frame = 0.0;
          if (style == 1.0) {
            win = step(0.05, f.x) * step(f.x, 0.95) * step(0.1, f.y) * step(f.y, 0.92);
          } else if (style == 2.0) {
            float body = step(0.34, f.x) * step(f.x, 0.66) * step(0.16, f.y) * step(f.y, 0.7);
            float arch = step(length((f - vec2(0.5, 0.7)) * vec2(bay, fl)), 0.16 * bay);
            win = max(body, arch) * step(0.25, rnd);
            vec2 bl = fract(vec2(along / 1.3 + step(1.0, mod(floor(y / 0.6), 2.0)) * 0.5, y / 0.6));
            base *= 1.0 - 0.12 * fn * (1.0 - smoothstep(0.0, 0.06, min(bl.x, bl.y)));
          } else if (style == 3.0) {
            win = step(0.3, f.x) * step(f.x, 0.7) * step(0.5, f.y) * step(f.y, 0.78) * step(0.55, rnd);
          } else {
            float gf = step(cell.y, 0.5);
            vec2 lo = mix(vec2(0.27, 0.26), vec2(0.14, 0.06), gf), hi = mix(vec2(0.73, 0.8), vec2(0.86, 0.8), gf);
            win = step(lo.x, f.x) * step(f.x, hi.x) * step(lo.y, f.y) * step(f.y, hi.y) * mix(1.0, step(0.3, rnd), gf);
            float outer = step(lo.x - 0.04, f.x) * step(f.x, hi.x + 0.04) * step(lo.y - 0.035, f.y) * step(f.y, hi.y + 0.045);
            frame = (outer - win) * (1.0 - gf);
            base *= 1.0 - 0.08 * fn * step(f.y, 0.035) * step(0.5, fract(seed * 3.7));
            base *= mix(1.0, 0.8, step(y, 0.9) * fn);
          }
          win *= wallF; frame *= wallF;
          base *= 0.93 + 0.14 * vn(vec2(along * 0.8, y * 0.8) + seed * 50.0) * fade;
          base = mix(base, base * 1.2 + 0.04, frame * fade);
          vec3 glassCol = mix(vec3(0.06, 0.08, 0.11), uSkyCol * 0.32, 0.6);
          float mull = style == 1.0 ? 0.0 : (1.0 - smoothstep(0.0, 0.03, abs(f.x - 0.5))) * fn;
          base = mix(base, glassCol, win * fade * (1.0 - 0.6 * mull));
          base *= 1.0 - 0.1 * (1.0 - fade) * wallF * (style == 1.0 ? 2.5 : 1.0);
          glass = win * fade;
          float on = step(rnd, style == 1.0 ? 0.22 : style == 2.0 ? 0.3 : 0.45);
          vec3 lc = mix(vec3(1.0, 0.72, 0.4), vec3(0.85, 0.9, 1.0), clamp(step(0.8, fract(rnd * 17.0)) + (style == 1.0 ? 0.6 : 0.0), 0.0, 1.0));
          totalEmissiveRadiance += lc * uNight * wallF * (win * on * fade * 1.7 + (1.0 - fade) * 0.1);
        } else if (part < 1.5) {
          base *= 1.0 - fn * 0.24 * step(fract(vWPos.y / 0.33), 0.22);
          base *= 0.88 + 0.24 * vn(vWPos.xz * 0.9 + seed * 20.0) * fade;
        } else {
          base *= 0.9 + 0.2 * vn(vWPos.xz * 0.6 + seed * 20.0) * fade;
          vec2 q = fract(vWPos.xz / 5.0 + seed); base *= 1.0 - 0.06 * fn * step(min(q.x, q.y), 0.03);
        }
        float snow = uSnow * smoothstep(0.25, 0.6, up) * (0.8 + 0.2 * vn(vWPos.xz * 0.4));
        base = mix(base, vec3(0.9, 0.93, 0.97), snow);
        diffuseColor.rgb = base;
        roughnessFactor = mix(roughnessFactor, 0.12, glass);
        vec3 Vd = normalize(cameraPosition - vWPos);
        totalEmissiveRadiance += uSkyCol * glass * pow(1.0 - abs(dot(Vd, wn)), 3.0) * 0.5 * (1.0 - uNight);
      }`);
  };
  const bGroup = new THREE.Group();
  // coarse height grid (for the aircraft's obstacle clearance)
  const HG = 24, hgw = Math.ceil(W / HG), hgh = Math.ceil(H / HG), hgrid = new Float32Array(hgw * hgh);
  for (const idxs of bCells.values()) {
    const bm = meshBuildings(idxs.map((i) => buildings[i]));
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(bm.positions, 3));
    bg.setAttribute('color', new THREE.BufferAttribute(bm.colors, 3, true));
    bg.setAttribute('aB', new THREE.BufferAttribute(bm.ab, 4, true));
    bg.setIndex(new THREE.BufferAttribute(bm.index, 1));
    bg.computeBoundingSphere(); bg.computeBoundingBox();
    const mesh = new THREE.Mesh(bg, bmat);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 6;
    mesh.userData = { idxs, triStart: bm.triStart, totalH: bm.totalH };
    bGroup.add(mesh);
    idxs.forEach((bi, j) => {
      const o = buildings[bi][11][0], h = bm.totalH[j];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
      for (let gx = Math.max(0, Math.floor((x0 - minX) / HG)); gx <= Math.min(hgw - 1, Math.floor((x1 - minX) / HG)); gx++)
        for (let gz = Math.max(0, Math.floor((z0 - minZ) / HG)); gz <= Math.min(hgh - 1, Math.floor((z1 - minZ) / HG)); gz++)
          if (h > hgrid[gz * hgw + gx]) hgrid[gz * hgw + gx] = h;
    });
  }
  if (lod) {
    const cells = new Map();
    lod.rows.forEach((row, i) => { const o = lodOffs[i], k = Math.floor(lodView.getFloat32(o, true) / BC) + ',' + Math.floor(lodView.getFloat32(o + 4, true) / BC); (cells.get(k) || cells.set(k, []).get(k)).push(i); });
    for (const idxs of cells.values()) {
      const bm = meshLod2(lod.rows, lodView, lodOffs, idxs);
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(bm.positions, 3));
      bg.setAttribute('color', new THREE.BufferAttribute(bm.colors, 3, true));
      bg.setAttribute('aB', new THREE.BufferAttribute(bm.ab, 4, true));
      bg.setIndex(new THREE.BufferAttribute(bm.index, 1));
      bg.computeBoundingSphere();
      const mesh = new THREE.Mesh(bg, bmat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 6;
      mesh.userData = { src: 'lod2', idxs, triStart: bm.triStart, totalH: bm.totalH };
      bGroup.add(mesh);
      // obstacle heights for the aircraft
      const pos = bm.positions;
      idxs.forEach((bi, j) => {
        const t0 = bm.triStart[j], t1 = bm.triStart[j + 1];
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let t = t0 * 3; t < t1 * 3; t++) { const v = bm.index[t] * 3; x0 = Math.min(x0, pos[v]); x1 = Math.max(x1, pos[v]); z0 = Math.min(z0, pos[v + 2]); z1 = Math.max(z1, pos[v + 2]); }
        const h = bm.totalH[j];
        for (let gx = Math.max(0, Math.floor((x0 - minX) / HG)); gx <= Math.min(hgw - 1, Math.floor((x1 - minX) / HG)); gx++)
          for (let gz = Math.max(0, Math.floor((z0 - minZ) / HG)); gz <= Math.min(hgh - 1, Math.floor((z1 - minZ) / HG)); gz++)
            if (h > hgrid[gz * hgw + gx]) hgrid[gz * hgw + gx] = h;
      });
    }
  }
  group.add(bGroup);
  const heightAt = (x, z) => {
    const gx = Math.floor((x - minX) / HG), gz = Math.floor((z - minZ) / HG);
    let m = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const X = gx + a, Z = gz + b;
      if (X >= 0 && Z >= 0 && X < hgw && Z < hgh) m = Math.max(m, hgrid[Z * hgw + X]);
    }
    return m;
  };

  function nearestRoad(x, z, maxCls = 7) {
    const gx = Math.floor(x / RG), gz = Math.floor(z / RG);
    let best = null, bd = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++)
      for (const p of roadGrid.get(gx + a + ',' + (gz + b)) || []) {
        if (p[5] > maxCls) continue;
        const d = Math.hypot(p[0] - x, p[1] - z);
        if (d < bd) { bd = d; best = p; }
      }
    return best && { x: best[0], z: best[1], name: best[2] >= 0 ? roadNames[best[2]] : null, dx: best[3], dz: best[4], d: bd };
  }

  function setSeason(s) {
    bakeGround(s);
    paintFields(s); paintHills(s);
    for (const im of treeGroup.children) {
      im.userData.list.forEach(([, , r], i) => im.setColorAt(i, treeColour(r, s)));
      im.instanceColor.needsUpdate = true;
    }
    U.uSnow.value = s === 'winter' ? 1 : 0;
  }

  return {
    group, ground, water, waterMat, roadMeshes, bridges, treeGroup, bGroup, U, ext: meta.ext,
    riverAt, groundY, solidAt, bridgeAt, heightAt, nearestRoad, setSeason, setAerial, roadInside,
    /** height of the walkable surface: roads and sidewalks sit a little above the ground */
    surfaceAt: (x, z) => (bridgeAt(x, z) ? 0.25 : roadInside(x, z, true) > 0 ? 0.2 : groundY(x, z) + 0.03),
    isWater: (x, z) => x > minX + 20 && x < maxX - 20 && z > minZ + 20 && z < maxZ - 20 && riverAt(x, z) > 0.8,
  };
}
