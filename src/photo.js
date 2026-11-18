// Camera: viewfinder with zoom (bicycle mode), shutter flash and sound, instant photo frame with caption,
// a gallery of your shots and download.
import * as AUDIO from './audio.js';

export class PhotoCam {
  /** render(): draws the 3D view into the canvas synchronously; caption(): text for the photo frame */
  constructor({ canvas, render, caption }) {
    this.canvas = canvas; this.render = render; this.caption = caption;
    this.on = false; this.fov = 62; this.shots = [];
    this.vf = document.createElement('div'); this.vf.id = 'vf';
    this.vf.innerHTML = `<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i><i class="g1"></i><i class="g2"></i><i class="g3"></i><i class="g4"></i><i class="focus"></i>
      <div class="vf-info"><b class="vf-mm">24 mm</b><span>wheel — zoom · <kbd>Enter</kbd> / click — shoot · <kbd>F</kbd> — close viewfinder</span></div>`;
    this.flash = document.createElement('div'); this.flash.id = 'flash';
    this.gal = document.createElement('div'); this.gal.id = 'gallery';
    this.box = document.createElement('div'); this.box.id = 'lightbox';
    this.box.innerHTML = `<div class="lb-card"><img alt="photo"><div class="lb-row"><a class="lb-dl" download="dresden.jpg">Save photo</a><button class="lb-del">Delete</button><button class="lb-x">Close</button></div></div>`;
    document.body.append(this.vf, this.flash, this.gal, this.box);
    this.box.querySelector('.lb-x').onclick = () => (this.box.style.display = 'none');
    this.box.onclick = (e) => { if (e.target === this.box) this.box.style.display = 'none'; };
    this.box.querySelector('.lb-del').onclick = () => { this.shots.splice(this.cur, 1); this.box.style.display = 'none'; this.draw(); };
    this.toast = document.createElement('div'); this.toast.id = 'phototoast'; document.body.appendChild(this.toast);
  }
  mm() { return Math.round(12 / Math.tan((this.fov * Math.PI) / 360)); }
  setOn(on) {
    this.on = on; this.vf.style.display = on ? 'block' : 'none';
    if (on) this.vf.querySelector('.vf-mm').textContent = this.mm() + ' mm';
    this.canvas.style.cursor = on ? 'crosshair' : '';
  }
  toggle() { this.setOn(!this.on); }
  zoom(dy) {
    this.fov = Math.max(12, Math.min(75, this.fov * (dy > 0 ? 1.1 : 0.9)));
    this.vf.querySelector('.vf-mm').textContent = this.mm() + ' mm';
  }
  /** take a picture of whatever is in the 3D view right now */
  capture() {
    AUDIO.initAudio(); AUDIO.shutter();
    this.render();
    const w = this.canvas.width, h = this.canvas.height;
    const pad = Math.round(w * 0.018), cap = Math.round(h * 0.11);
    const c = document.createElement('canvas'); c.width = w + pad * 2; c.height = h + pad + cap;
    const x = c.getContext('2d');
    x.fillStyle = '#f7f4ec'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(this.canvas, pad, pad, w, h);
    x.strokeStyle = 'rgba(0,0,0,.18)'; x.lineWidth = 2; x.strokeRect(pad, pad, w, h);
    const ca = this.caption();
    x.fillStyle = '#2b2b2b'; x.textBaseline = 'middle';
    x.font = `600 ${Math.round(cap * 0.34)}px Georgia, serif`; x.fillText(ca.title, pad, pad + h + cap * 0.38);
    x.fillStyle = '#7b7568'; x.font = `${Math.round(cap * 0.24)}px system-ui, sans-serif`; x.fillText(ca.sub, pad, pad + h + cap * 0.74);
    x.textAlign = 'right'; x.fillText('Raumfinder 3D', c.width - pad, pad + h + cap * 0.74);
    const url = c.toDataURL('image/jpeg', 0.9);
    this.shots.push({ url, title: ca.title });
    if (this.shots.length > 16) this.shots.shift();
    this.flash.style.transition = 'none'; this.flash.style.opacity = 0.85;
    requestAnimationFrame(() => { this.flash.style.transition = 'opacity .45s ease-out'; this.flash.style.opacity = 0; });
    this.draw();
    this.say(`Photo saved — ${this.shots.length} in the gallery`);
  }
  say(t) { this.toast.textContent = t; this.toast.style.opacity = 1; clearTimeout(this.tt); this.tt = setTimeout(() => (this.toast.style.opacity = 0), 2200); }
  draw() {
    this.gal.innerHTML = '';
    this.gal.style.display = this.shots.length ? 'flex' : 'none';
    this.shots.forEach((s, i) => {
      const im = document.createElement('img'); im.src = s.url; im.title = s.title; im.onclick = () => this.open(i);
      this.gal.appendChild(im);
    });
    this.gal.scrollLeft = this.gal.scrollWidth;
  }
  open(i) {
    this.cur = i;
    const s = this.shots[i];
    this.box.querySelector('img').src = s.url;
    const a = this.box.querySelector('.lb-dl'); a.href = s.url; a.download = `dresden-${Date.now()}.jpg`;
    this.box.style.display = 'flex';
  }
}
