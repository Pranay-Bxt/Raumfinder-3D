// Floor boxes: the selected TU building is drawn as a stack of floors with the chosen floor highlighted
// (an x-ray slab around the building) and a floor-number ruler at one corner, so students see at a glance
// which floor their class is on. Pure geometry from the building footprint and height; no interior data.
import * as THREE from 'three';
const fitFont = (x, text, maxW, size, min = 18) => { let s = size; do { x.font = s + 'px VT323, ui-monospace, monospace'; } while (x.measureText(text).width > maxW && (s -= 2) > min); };

function pill(text, on) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 96;
  const x = c.getContext('2d');
  x.fillStyle = on ? '#FFD400' : 'rgba(17,15,7,0.85)';
  x.beginPath(); x.roundRect(6, 6, 244, 84, 42); x.fill();
  x.lineWidth = 6; x.strokeStyle = on ? '#fff' : 'rgba(255,255,255,.55)'; x.stroke();
  x.fillStyle = on ? '#111' : '#FFD400'; fitFont(x, text, 214, 76); x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 128, 52);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class FloorStack {
  constructor(scene) { this.group = new THREE.Group(); this.group.visible = false; scene.add(this.group); }
  clear() {
    this.group.visible = false;
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry && o.geometry.dispose(); const m = o.material; if (m) { m.map && m.map.dispose(); m.dispose(); } }
  }
  /** rings: flat [x,z,...] footprints; height: building height (m); levels: integer floor numbers, e.g. [-1,0,1,2]; selected: level number */
  show(rings, height, levels, selected, slab = true) {
    this.clear();
    if (!rings.length || !levels.length) return;
    const above = Math.max(1, levels.filter((l) => l >= 0).length);
    const fh = Math.min(4.6, Math.max(2.8, height / above));
    // outlines of every floor
    const lineMat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthTest: false });
    for (const l of levels) {
      for (const r of rings) {
        const pts = []; for (let i = 0; i < r.length; i += 2) pts.push(new THREE.Vector3(r[i], l * fh + 0.05, r[i + 1]));
        const ln = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat); ln.renderOrder = 11; this.group.add(ln);
      }
    }
    // the chosen floor as a translucent slab
    if (slab && selected != null && levels.includes(selected)) {
      const mat = new THREE.MeshBasicMaterial({ color: '#ffb21e', transparent: true, opacity: 0.42, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      for (const r of rings) {
        const s = new THREE.Shape(); for (let i = 0; i < r.length; i += 2) { if (i) s.lineTo(r[i], -r[i + 1]); else s.moveTo(r[i], -r[i + 1]); }
        const g = new THREE.ExtrudeGeometry(s, { depth: fh * 0.94, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, selected * fh + 0.03, 0);
        const m = new THREE.Mesh(g, mat); m.renderOrder = 12; this.group.add(m);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: '#fff3c4', depthTest: false })); e.renderOrder = 13; this.group.add(e);
      }
    }
    // floor-number ruler at the footprint corner nearest the map origin's south-west
    const big = rings.reduce((a, b) => (b.length > a.length ? b : a));
    let cx = 0, cz = 0; for (let i = 0; i < big.length; i += 2) { cx += big[i]; cz += big[i + 1]; } cx /= big.length / 2; cz /= big.length / 2;
    let best = [big[0], big[1]], bd = -1; // farthest vertex towards the south-west keeps the ruler off the camera's usual view of the roofs
    for (let i = 0; i < big.length; i += 2) { const d = (big[i] - cx) * -0.7 + (big[i + 1] - cz) * 0.7; if (d > bd) { bd = d; best = [big[i], big[i + 1]]; } }
    const size = Math.max(7, fh * 1.7);
    for (const l of levels) {
      const on = l === selected, sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: pill(on ? 'Etage ' + l : String(l), on), transparent: true, depthTest: false }));
      sp.scale.set(on ? size * 1.9 : size * 0.8, (on ? size * 1.9 : size * 0.8) * 0.375, 1);
      sp.position.set(best[0] + (on ? -3 : 0), l * fh + fh / 2, best[1] + (on ? 3 : 0)); sp.renderOrder = 14; this.group.add(sp);
    }
    this.group.visible = true;
    return { floorHeight: fh };
  }
}
