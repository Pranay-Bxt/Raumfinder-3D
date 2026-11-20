// Tiny WebAudio helper: tram motor hum, bell, door chime and camera shutter. Starts on the first user input.
let ctx = null, master = null, eng = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
  } catch { ctx = null; }
}
export function beep(freq, dur = 0.12, type = 'sine', vol = 0.22, delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
}
export const bell = () => { beep(1760, 0.45, 'sine', 0.3); beep(1760, 0.45, 'sine', 0.3, 0.22); beep(2640, 0.3, 'sine', 0.08); };
export const doorChime = (open) => { for (let i = 0; i < 3; i++) beep(open ? 880 : 660, 0.09, 'square', 0.07, i * 0.14); };
export const warn = () => { beep(520, 0.12, 'square', 0.08); beep(520, 0.12, 'square', 0.08, 0.18); };
export function shutter() {
  if (!ctx) return;
  const len = Math.floor(ctx.sampleRate * 0.12), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.18)) * (i % 400 < 200 ? 1 : 0.4);
  const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = buf; g.gain.value = 0.35; s.connect(g); g.connect(master); s.start();
  beep(1400, 0.05, 'square', 0.05, 0.07);
}
/** crash: a low thump plus a crackling noise burst */
export function boom() {
  if (!ctx) return;
  const len = Math.floor(ctx.sampleRate * 1.6), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.22)) * (0.6 + 0.4 * Math.sin(i * 0.002));
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = 'lowpass'; f.frequency.value = 900; g.gain.value = 0.9; s.buffer = buf; s.connect(f); f.connect(g); g.connect(master); s.start();
  beep(55, 0.9, 'sine', 0.5); beep(38, 1.2, 'triangle', 0.4, 0.05);
}
/** tape rewind: a fast rising warble */
export function rewind() {
  if (!ctx) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sawtooth'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(1400, t + 1.6);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + 1.8);
}
/** motor hum: speed in m/s, power 0..1 */
export function engine(on, speed = 0, power = 0) {
  if (!ctx) return;
  if (!eng) {
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o1.type = 'sawtooth'; o2.type = 'triangle'; f.type = 'lowpass'; f.frequency.value = 500; g.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(master); o1.start(); o2.start();
    eng = { o1, o2, f, g };
  }
  const t = ctx.currentTime;
  eng.o1.frequency.setTargetAtTime(38 + speed * 7.5, t, 0.1);
  eng.o2.frequency.setTargetAtTime(76 + speed * 15, t, 0.1);
  eng.f.frequency.setTargetAtTime(260 + speed * 55 + power * 300, t, 0.1);
  eng.g.gain.setTargetAtTime(on ? Math.min(0.07, 0.008 + speed * 0.004 + power * 0.022) : 0, t, 0.15);
}
