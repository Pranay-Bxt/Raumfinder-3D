// Sky, sun, lighting, fog, weather and seasons. The sun follows the real solar
// position for Dresden at the chosen date and time (Europe/Berlin).
import * as THREE from 'three';

const rad = Math.PI / 180;
export function sunPosition(ms, lat, lon) {
  const d = ms / 864e5 - 0.5 + 2440588 - 2451545, e = rad * 23.4397, lw = -lon * rad, phi = lat * rad;
  const Mn = rad * (357.5291 + 0.98560028 * d);
  const Cc = rad * (1.9148 * Math.sin(Mn) + 0.02 * Math.sin(2 * Mn) + 0.0003 * Math.sin(3 * Mn));
  const L = Mn + Cc + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const Hh = rad * (280.16 + 360.9856235 * d) - lw - ra;
  return {
    azimuth: Math.atan2(Math.sin(Hh), Math.cos(Hh) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)), // from south, westward
    altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(Hh)),
  };
}

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
function berlinParts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = +p.value;
  return o;
}
export function nowBerlin() {
  const p = berlinParts(Date.now());
  return { y: p.year, m: p.month, d: p.day, min: p.hour * 60 + p.minute };
}
export function berlinToUtc(t) {
  const guess = Date.UTC(t.y, t.m - 1, t.d, 0, t.min);
  const p = berlinParts(guess);
  const off = (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess) / 60000;
  return guess - off * 60000;
}

const KF = [
  { a: -18, zen: '#04060d', hor: '#0a0f1f', sun: '#000000', si: 0, hemi: 0.16, hs: '#3f4f80', fog: '#080c18' },
  { a: -6, zen: '#111a38', hor: '#3d3550', sun: '#000000', si: 0, hemi: 0.3, hs: '#5a6494', fog: '#2a2a40' },
  { a: 0, zen: '#2c4a7c', hor: '#e8905c', sun: '#ff7b3d', si: 0.9, hemi: 0.5, hs: '#8f97bb', fog: '#c98d6f' },
  { a: 6, zen: '#3f6fb5', hor: '#f2c592', sun: '#ffc58a', si: 2.3, hemi: 0.75, hs: '#b9c7e0', fog: '#e3c3a2' },
  { a: 20, zen: '#3b7bd3', hor: '#c3dbef', sun: '#fff1dc', si: 3.0, hemi: 0.95, hs: '#cfe0f5', fog: '#c9dcec' },
  { a: 65, zen: '#2f6fcc', hor: '#b9d6f0', sun: '#fffaf0', si: 3.3, hemi: 1.05, hs: '#d4e4f7', fog: '#c4d9ec' },
].map((k) => ({ ...k, zen: new THREE.Color(k.zen), hor: new THREE.Color(k.hor), sun: new THREE.Color(k.sun), hs: new THREE.Color(k.hs), fog: new THREE.Color(k.fog) }));

const WEATHER = {
  clear: { fog: 0.00005, over: 0, rain: 0, cloud: 0.44 },
  haze: { fog: 0.0002, over: 0.25, rain: 0, cloud: 0.56 },
  fog: { fog: 0.0011, over: 0.75, rain: 0, cloud: 0.95 },
  rain: { fog: 0.00036, over: 0.9, rain: 1, cloud: 1.0 },
};
// falling particles per season: [count, fall m/s, sway, size m, colour A, colour B]
const FLAKES = {
  spring: [500, 1.0, 1.6, 0.16, '#ffd9e6', '#ffffff'],
  summer: [0, 0, 0, 0, '#fff', '#fff'],
  autumn: [900, 1.7, 1.8, 0.24, '#d9822b', '#e2b23a'],
  winter: [0, 3.2, 0.9, 0.11, '#ffffff', '#eef4ff'],
};

export class Environment {
  constructor(scene, camera, world, meta) {
    this.scene = scene; this.camera = camera; this.world = world; this.meta = meta;
    this.weather = 'clear'; this.season = 'autumn'; this.alt = 0; this.nightF = 0; this.shadows = true; this.ms = Date.now();

    this.sun = new THREE.DirectionalLight('#fff', 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0003; this.sun.shadow.normalBias = 0.5;
    this.moon = new THREE.DirectionalLight('#8ea2d8', 0);
    this.moon.position.set(0.4, 0.7, -0.5);
    this.hemi = new THREE.HemisphereLight('#cfe0f5', '#8a8576', 1);
    scene.add(this.sun, this.sun.target, this.moon, this.hemi);
    scene.fog = new THREE.FogExp2('#c9dcec', 0.00005);

    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uNight: { value: 0 }, uOver: { value: 0 }, uCloud: { value: 0.44 }, uTime: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uZen,uHor,uSunCol,uSunDir; uniform float uNight,uOver,uCloud,uTime; varying vec3 vDir;
        float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
        float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir); float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(uHor, uZen, pow(h, 0.45));
          if (d.y < 0.0) col = mix(uHor, uHor * 0.7, clamp(-d.y * 5.0, 0.0, 1.0));
          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunCol * (pow(sd, 1200.0) * 8.0 + pow(sd, 30.0) * 0.3 + pow(sd, 4.0) * 0.1) * (1.0 - uOver);
          vec3 g = floor(d * 240.0);
          float s = fract(sin(dot(g, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          col += vec3(step(0.9988, s)) * uNight * (1.0 - uOver) * smoothstep(0.02, 0.25, d.y);
          if (d.y > 0.015) {
            vec2 cp = d.xz / (d.y + 0.14) * 1.25 + vec2(uTime * 0.006, uTime * 0.002);
            float f = fbm(cp);
            float c = smoothstep(1.0 - uCloud, 1.0 - uCloud + 0.32, f + 0.08) * smoothstep(0.015, 0.14, d.y);
            float lum = dot(uHor, vec3(0.3, 0.55, 0.15));
            vec3 lit = mix(vec3(lum) * 1.25 + uSunCol * 0.22 * (1.0 - uOver), uHor, 0.25);
            vec3 shade = vec3(lum) * mix(0.75, 0.5, uOver);
            col = mix(col, mix(lit, shade, smoothstep(0.45, 0.95, f)), c * 0.9);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), this.skyMat);
    this.sky.renderOrder = -10; this.sky.frustumCulled = false;
    scene.add(this.sky);

    // rain streaks
    const N = 5000, rp = new Float32Array(N * 6), re = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random() * 300, y = Math.random() * 200, z = Math.random() * 300;
      rp.set([x, y, z, x, y, z], i * 6); re[i * 2 + 1] = 1;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rg.setAttribute('aEnd', new THREE.BufferAttribute(re, 1));
    this.rainMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAlpha: { value: 0.3 } },
      vertexShader: `uniform float uTime; uniform vec3 uCam; attribute float aEnd;
        void main(){ vec3 p = position; p.y -= uTime * 95.0; p.x += uTime * 9.0;
          p = mod(p - uCam, vec3(300.0, 200.0, 300.0)) - vec3(150.0, 100.0, 150.0) + uCam;
          p.y -= aEnd * 4.5; p.x += aEnd * 0.45;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`,
      fragmentShader: 'uniform float uAlpha; void main(){ gl_FragColor = vec4(0.82, 0.87, 0.95, uAlpha); }',
    });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false; this.rain.visible = false; this.rain.renderOrder = 20;
    scene.add(this.rain);

    // seasonal flakes: snow, leaves, blossom
    const F = 7000, fp = new Float32Array(F * 3), fr = new Float32Array(F);
    for (let i = 0; i < F; i++) { fp[i * 3] = Math.random() * 160; fp[i * 3 + 1] = Math.random() * 90; fp[i * 3 + 2] = Math.random() * 160; fr[i] = Math.random(); }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
    fg.setAttribute('aR', new THREE.BufferAttribute(fr, 1));
    this.flakeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uFall: { value: 2 }, uSway: { value: 1 }, uSize: { value: 0.1 }, uScale: { value: 800 }, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uDim: { value: 1 } },
      vertexShader: `uniform float uTime, uFall, uSway, uSize, uScale; uniform vec3 uCam, uA, uB; attribute float aR; varying vec3 vC;
        void main(){ vec3 p = position; p.y -= uTime * uFall * (0.7 + 0.6 * aR);
          p.x += sin(uTime * (0.6 + aR) + aR * 40.0) * uSway + uTime * 1.2; p.z += cos(uTime * (0.5 + aR) + aR * 17.0) * uSway;
          p = mod(p - uCam, vec3(160.0, 90.0, 160.0)) - vec3(80.0, 45.0, 80.0) + uCam;
          vec4 mv = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(uSize * (0.6 + 0.8 * aR) * uScale / -mv.z, 1.0, 18.0); vC = mix(uA, uB, fract(aR * 7.0)); }`,
      fragmentShader: `uniform float uDim; varying vec3 vC; void main(){ vec2 q = gl_PointCoord - 0.5; float a = 1.0 - smoothstep(0.3, 0.5, length(q)); if (a < 0.02) discard; gl_FragColor = vec4(vC * uDim, a * 0.9); }`,
    });
    this.flakes = new THREE.Points(fg, this.flakeMat);
    this.flakes.frustumCulled = false; this.flakes.renderOrder = 21;
    scene.add(this.flakes);
  }

  setWeather(w) { this.weather = w; this.apply(); }
  setTime(ms) { this.ms = ms; this.apply(); }
  setSeason(s) { this.season = s; this.world.setSeason(s); this.apply(); }

  apply() {
    const { lat, lon } = this.meta.origin;
    const sp = sunPosition(this.ms, lat, lon);
    const alt = sp.altitude / rad;
    this.alt = alt;
    let i = 0;
    while (i < KF.length - 2 && alt > KF[i + 1].a) i++;
    const A = KF[i], B = KF[i + 1], t = Math.min(1, Math.max(0, (alt - A.a) / (B.a - A.a)));
    const W = WEATHER[this.weather], winter = this.season === 'winter';
    const zen = A.zen.clone().lerp(B.zen, t), hor = A.hor.clone().lerp(B.hor, t), sun = A.sun.clone().lerp(B.sun, t), fog = A.fog.clone().lerp(B.fog, t), hs = A.hs.clone().lerp(B.hs, t);
    let si = A.si + (B.si - A.si) * t;
    const hemi = A.hemi + (B.hemi - A.hemi) * t;
    const grey = (c) => { const l = 0.3 * c.r + 0.55 * c.g + 0.15 * c.b; return new THREE.Color(l * 0.95, l, l * 1.06); };
    zen.lerp(grey(hor).multiplyScalar(0.85), W.over); hor.lerp(grey(hor), W.over); fog.lerp(grey(fog), W.over);
    si *= 1 - 0.8 * W.over;
    if (this.season === 'autumn') sun.lerp(new THREE.Color('#ffb070'), 0.12);

    const dir = new THREE.Vector3(-Math.sin(sp.azimuth) * Math.cos(sp.altitude), Math.sin(sp.altitude), Math.cos(sp.azimuth) * Math.cos(sp.altitude));
    this.sunDir = dir;
    this.nightF = 1 - Math.min(1, Math.max(0, (alt + 6) / 9));
    this.sun.color.copy(sun); this.sun.intensity = si;
    this.sun.castShadow = this.shadows && si > 0.15;
    this.moon.intensity = (winter ? 0.5 : 0.35) * this.nightF * (1 - 0.6 * W.over);
    this.hemi.color.copy(hs); this.hemi.intensity = hemi * (1 + 0.25 * W.over);
    this.hemi.groundColor.set(winter ? '#b9bfc6' : '#8a8576').multiplyScalar(0.4 + 0.6 * (1 - this.nightF));
    this.scene.fog.color.copy(fog); this.scene.fog.density = W.fog;
    const u = this.skyMat.uniforms;
    u.uZen.value.copy(zen); u.uHor.value.copy(hor); u.uSunCol.value.copy(sun); u.uSunDir.value.copy(dir); u.uNight.value = this.nightF; u.uOver.value = W.over; u.uCloud.value = W.cloud;
    const wu = this.world.waterMat.uniforms;
    wu.uSunDir.value.copy(dir); wu.uSunCol.value.copy(sun).multiplyScalar(si > 0.05 ? (1 - W.over) : 0); wu.uSky.value.copy(zen); wu.uHorizon.value.copy(hor);
    wu.uDeep.value.set(winter ? '#33474b' : '#2c4a44').multiplyScalar(0.08 + 0.92 * Math.min(1, hemi));
    const U = this.world.U;
    U.uNight.value = this.nightF;
    U.uSkyCol.value.copy(zen).lerp(hor, 0.5).multiplyScalar(1.2);
    const snowing = winter && W.rain > 0;
    U.uWet.value = W.rain > 0 && !winter ? 1 : 0;
    this.rain.visible = W.rain > 0 && !winter;
    this.rainMat.uniforms.uAlpha.value = 0.12 + 0.2 * (1 - this.nightF);
    // seasonal particles
    const f = FLAKES[this.season], fu = this.flakeMat.uniforms;
    let count = f[0];
    if (winter) count = snowing ? 7000 : this.weather === 'clear' ? 0 : 2200;
    this.flakes.visible = count > 0;
    this.flakes.geometry.setDrawRange(0, count);
    fu.uFall.value = f[1]; fu.uSway.value = f[2]; fu.uSize.value = f[3]; fu.uA.value.set(f[4]); fu.uB.value.set(f[5]);
    fu.uDim.value = 0.25 + 0.75 * Math.min(1, hemi);
  }

  /** call every frame: focus = point the shadow box should surround */
  update(time, focus, range, viewH) {
    this.sky.position.copy(this.camera.position);
    this.skyMat.uniforms.uTime.value = time;
    this.world.waterMat.uniforms.uTime.value = time;
    this.rainMat.uniforms.uTime.value = time;
    this.rainMat.uniforms.uCam.value.copy(this.camera.position);
    this.flakeMat.uniforms.uTime.value = time;
    this.flakeMat.uniforms.uCam.value.copy(this.camera.position);
    this.flakeMat.uniforms.uScale.value = viewH || 800;
    if (this.sun.castShadow) {
      const R = Math.min(2400, Math.max(120, range));
      const cam = this.sun.shadow.camera;
      if (Math.abs(cam.right - R) > R * 0.08) { cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R; cam.near = 100; cam.far = 9000; cam.updateProjectionMatrix(); }
      const step = ((2 * cam.right) / 4096) * 4;
      const fx = Math.round(focus.x / step) * step, fz = Math.round(focus.z / step) * step;
      this.sun.target.position.set(fx, 0, fz);
      this.sun.position.set(fx, 0, fz).addScaledVector(this.sunDir, 4000);
    }
  }
}
