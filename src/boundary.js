// The edge of the map: a see-through "digital" wall (a glowing grid with a scan band and flickering cells) all
// around the modelled area. You can look over and through it at the countryside outside, but not go past it.
// It lights up near the camera and pulses when you bump into it.
import * as THREE from 'three';

export const WALL_HEIGHT = 650; // above the ultralight's ceiling (480 m)

export function makeBoundary(ext, color = '#FFD400') {
  const { minX, maxX, minZ, maxZ } = ext;
  const pos = [], along = [], idx = [];
  let run = 0;
  for (const [ax, az, bx, bz] of [[minX, minZ, maxX, minZ], [maxX, minZ, maxX, maxZ], [maxX, maxZ, minX, maxZ], [minX, maxZ, minX, minZ]]) {
    const L = Math.hypot(bx - ax, bz - az), n = pos.length / 3;
    pos.push(ax, -2, az, bx, -2, bz, bx, WALL_HEIGHT, bz, ax, WALL_HEIGHT, az);
    along.push(run, run + L, run + L, run);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    run += L;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(idx);
  const U = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color(color) }, uH: { value: WALL_HEIGHT }, uPulse: { value: 0 }, uHit: { value: new THREE.Vector3(0, -1e5, 0) } };
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    vertexShader: /* glsl */ `
      attribute float aAlong; varying float vAlong; varying vec3 vW;
      void main() { vAlong = aAlong; vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uH, uPulse; uniform vec3 uCam, uColor, uHit; varying float vAlong; varying vec3 vW;
      float grid(float c, float size, float w) { float t = c / size; float f = abs(fract(t - 0.5) - 0.5) / (fwidth(t) * w); return 1.0 - min(f, 1.0); }
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        float h = vW.y, d = distance(vW.xz, uCam.xz);
        float near = 1.0 - smoothstep(40.0, 900.0, d);
        float fine = max(grid(vAlong, 16.0, 1.2), grid(h, 16.0, 1.2)) * (1.0 - smoothstep(300.0, 1600.0, d));
        float major = max(grid(vAlong, 128.0, 1.6), grid(h, 128.0, 1.6));
        float top = 1.0 - smoothstep(uH * 0.25, uH, h);
        // scan band sweeping upwards
        float s = fract(h / uH - uTime * 0.07), band = smoothstep(0.92, 1.0, s) * (1.0 - smoothstep(0.995, 1.0, s));
        // pixel cells that flicker on and off
        vec2 cell = floor(vec2(vAlong, h) / 16.0); float r = hash(cell);
        float flick = step(0.93, fract(r * 7.0 + floor(uTime * (0.6 + r * 1.6)) * 0.37)) * step(0.6, r);
        // bump ripple around the spot that was hit
        float hd = distance(vW, uHit), ring = uPulse * smoothstep(40.0, 0.0, abs(hd - (1.0 - uPulse) * 260.0)) ;
        float a = 0.045 + near * 0.07
          + fine * (0.08 + near * 0.32)
          + major * (0.17 + near * 0.25)
          + band * (0.18 + near * 0.2)
          + flick * 0.16 * (0.3 + near)
          + ring * 0.8;
        a *= top;
        a += (1.0 - smoothstep(0.0, 10.0, h)) * (0.35 + near * 0.4); // glowing foot along the ground
        a += uPulse * 0.12 * near;
        vec3 col = mix(uColor, vec3(1.0, 0.98, 0.85), clamp(fine * near * 0.6 + ring, 0.0, 1.0));
        gl_FragColor = vec4(col, clamp(a, 0.0, 0.92));
      }`,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.renderOrder = 9; mesh.frustumCulled = false; mesh.name = 'boundary';
  return {
    mesh,
    /** call every frame */
    update(time, dt, cam) { U.uTime.value = time; U.uCam.value.copy(cam); U.uPulse.value = Math.max(0, U.uPulse.value - dt * 1.4); },
    /** something touched the wall at (x, y, z): ripple + glow */
    hit(x, y, z) { if (U.uPulse.value < 0.35) { U.uHit.value.set(x, y, z); U.uPulse.value = 1; } },
  };
}

/** clamp a point into the map, `margin` metres inside the wall; returns true when it had to be moved */
export function keepInside(p, ext, margin) {
  const x = Math.min(ext.maxX - margin, Math.max(ext.minX + margin, p.x)), z = Math.min(ext.maxZ - margin, Math.max(ext.minZ + margin, p.z));
  const moved = x !== p.x || z !== p.z;
  p.x = x; p.z = z;
  return moved;
}
