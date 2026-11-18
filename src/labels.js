// HTML place labels projected over the 3D view, with priority-based decluttering.
import * as THREE from 'three';

const RANGE = { district: [500, 20000], station: [0, 5000], stop: [0, 750], campus: [0, 1100] };
const POI_RANGE = { 1: 4500, 2: 1300, 4: 480 };

export class Labels {
  constructor(container, list, camera, onPick) {
    this.camera = camera; this.container = container; this.enabled = true; this.frame = 0;
    this.items = list.filter((l) => l.k !== 'street').map((l) => {
      const el = document.createElement('div');
      el.className = 'lbl lbl-' + l.k + (l.k === 'poi' ? ' p' + l.p : '');
      el.textContent = l.n;
      el.style.display = 'none';
      el.addEventListener('click', () => onPick(l));
      container.appendChild(el);
      return { ...l, el, w: l.n.length * (l.k === 'district' ? 8.5 : 6.4) + 22, on: false, y: l.k === 'poi' ? 28 : l.k === 'district' ? 40 : l.k === 'campus' ? 34 : 6 };
    });
    this.items.sort((a, b) => a.p - b.p);
    this.v = new THREE.Vector3();
  }
  setEnabled(on) { this.enabled = on; this.container.style.display = on ? '' : 'none'; }
  update() {
    if (!this.enabled || this.frame++ % 2) return;
    const W = this.container.clientWidth, H = this.container.clientHeight, cam = this.camera.position, placed = [];
    for (const it of this.items) {
      let show = false, sx = 0, sy = 0;
      const d = Math.hypot(it.x - cam.x, it.y - cam.y, it.z - cam.z);
      const [lo, hi] = it.k === 'poi' ? [0, POI_RANGE[it.p] || 900] : RANGE[it.k];
      if (d >= lo && d <= hi && !(this.near && (it.k === 'district' || d > 240))) {
        this.v.set(it.x, it.y, it.z).project(this.camera);
        if (this.v.z < 1 && Math.abs(this.v.x) < 1.02 && Math.abs(this.v.y) < 1.02) {
          sx = (this.v.x * 0.5 + 0.5) * W; sy = (-this.v.y * 0.5 + 0.5) * H;
          show = !placed.some((p) => Math.abs(p[0] - sx) < (p[2] + it.w) / 2 + 14 && Math.abs(p[1] - sy) < 28);
          if (show) placed.push([sx, sy, it.w]);
        }
      }
      if (show) {
        it.el.style.transform = `translate(-50%,-50%) translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px)`;
        if (!it.on) { it.el.style.display = ''; it.on = true; }
      } else if (it.on) { it.el.style.display = 'none'; it.on = false; }
    }
  }
}
