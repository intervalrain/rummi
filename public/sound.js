// Synthesised sound effects (Web Audio, no audio files).
// The core is `clack`: a plastic tile landing on a table — a short noise
// transient, a few body resonances and a low thump.

const KEY = 'rummi.sound';
let ctx = null, out = null, noise = null;
let enabled = (() => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } })();

function ac() {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    out = ctx.createGain();
    out.gain.value = 0.8;
    out.connect(comp).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
const rnd = (a, b) => a + Math.random() * (b - a);

function dest(pan) {
  if (!pan || !ctx.createStereoPanner) return out;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  p.connect(out);
  return p;
}
function env(g, t, peak, attack, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
function tone(freq, t, { type = 'sine', vol = 0.3, attack = 0.005, decay = 0.25, pan = 0, glide = 0 } = {}) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(freq * glide, t + attack + decay);
  env(g, t, vol, attack, decay);
  o.connect(g).connect(dest(pan));
  o.start(t);
  o.stop(t + attack + decay + 0.02);
}
function burst(t, { freq = 2400, q = 1.2, vol = 0.8, decay = 0.045, type = 'bandpass', pan = 0 } = {}) {
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noise;
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  env(g, t, vol, 0.002, decay);
  s.connect(f).connect(g).connect(dest(pan));
  s.start(t, Math.random() * 0.8);
  s.stop(t + decay + 0.03);
}

/** One tile hitting the table. pitch > 1 = smaller/lighter, vol 0..1. */
function clack(t, { pitch = 1, vol = 1, pan = 0 } = {}) {
  const p = pitch * rnd(0.96, 1.04);
  burst(t, { freq: 2600 * p, q: 1.1, vol: 0.9 * vol, decay: 0.035, pan });
  for (const [f, v, d] of [[1180, 0.22, 0.07], [1930, 0.14, 0.055], [3150, 0.08, 0.04]]) {
    tone(f * p, t, { vol: v * vol, attack: 0.001, decay: d, pan });
  }
  tone(170 * p, t, { vol: 0.35 * vol, attack: 0.002, decay: 0.07, glide: 0.55, pan });
}
function slide(t, { vol = 0.5, dur = 0.16, pan = 0 } = {}) {
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noise;
  f.type = 'bandpass'; f.Q.value = 0.8;
  f.frequency.setValueAtTime(700, t);
  f.frequency.exponentialRampToValueAtTime(2600, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol * 0.35, t + dur * 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(dest(pan));
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.02);
}
function mallet(freq, t, vol = 0.28, pan = 0) {
  tone(freq, t, { type: 'sine', vol, attack: 0.004, decay: 0.5, pan });
  tone(freq * 4, t, { type: 'sine', vol: vol * 0.18, attack: 0.002, decay: 0.12, pan });
}

const play = fn => { const c = ac(); if (c) fn(c.currentTime + 0.01); };

export const sfx = {
  get enabled() { return enabled; },
  toggle() {
    enabled = !enabled;
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* private mode */ }
    if (enabled) sfx.pick(); else ctx?.suspend();
    return enabled;
  },
  unlock() { ac(); },
  pick: () => play(t => clack(t, { pitch: 1.35, vol: 0.4 })),
  place: () => play(t => { clack(t, { vol: 0.9 }); navigator.vibrate?.(8); }),
  undo: () => play(t => { slide(t, { vol: 0.35, dur: 0.1 }); clack(t + 0.09, { pitch: 1.2, vol: 0.45 }); }),
  draw: (vol = 1) => play(t => { slide(t, { vol: 0.7 * vol }); clack(t + 0.16, { pitch: 1.1, vol: 0.6 * vol }); }),
  /** Your own tiles landing when you finish a turn. */
  play: n => play(t => {
    const k = Math.min(6, Math.max(2, n));
    for (let i = 0; i < k; i++) clack(t + i * 0.055 + rnd(0, 0.015), { vol: 0.85, pan: rnd(-0.3, 0.3) });
    mallet(784, t + k * 0.055 + 0.04, 0.16);
    mallet(1175, t + k * 0.055 + 0.1, 0.12);
  }),
  opponent: n => play(t => {
    const k = Math.min(5, Math.max(1, n)), side = rnd(-0.5, 0.5);
    for (let i = 0; i < k; i++) clack(t + i * 0.07 + rnd(0, 0.02), { vol: 0.55, pitch: 0.95, pan: side });
  }),
  /** Dealing 14 tiles into your rack at game start. */
  deal: () => play(t => {
    slide(t, { vol: 0.6, dur: 0.3 });
    for (let i = 0; i < 14; i++) clack(t + 0.25 + i * 0.045 + rnd(0, 0.012), { pitch: rnd(1, 1.15), vol: 0.5, pan: -0.6 + i * 0.09 });
  }),
  turn: () => play(t => { mallet(659, t, 0.26); mallet(988, t + 0.12, 0.24); }),
  nope: () => play(t => {
    tone(196, t, { type: 'triangle', vol: 0.32, attack: 0.004, decay: 0.09, glide: 0.8 });
    tone(165, t + 0.11, { type: 'triangle', vol: 0.3, attack: 0.004, decay: 0.12, glide: 0.8 });
    navigator.vibrate?.([12, 40, 12]);
  }),
  magic: () => play(t => { [1047, 1319, 1568, 2093, 2637].forEach((f, i) => tone(f, t + i * 0.05, { vol: 0.12, attack: 0.003, decay: 0.3, pan: -0.6 + i * 0.3 })); }),
  pop: () => play(t => tone(720, t, { vol: 0.2, attack: 0.004, decay: 0.08, glide: 1.9 })),
  tick: last => play(t => { burst(t, { freq: last ? 3200 : 2200, q: 6, vol: last ? 0.5 : 0.3, decay: 0.025 }); }),
  win: () => play(t => {
    [523, 659, 784, 1047].forEach((f, i) => mallet(f, t + i * 0.11, 0.26));
    [1047, 1319, 1568].forEach(f => tone(f, t + 0.5, { type: 'triangle', vol: 0.1, attack: 0.02, decay: 1.2 }));
    for (let i = 0; i < 8; i++) clack(t + 0.55 + i * 0.05, { pitch: rnd(1, 1.3), vol: 0.35, pan: rnd(-0.8, 0.8) });
  }),
  lose: () => play(t => { [659, 587, 494].forEach((f, i) => mallet(f, t + i * 0.16, 0.2)); }),
};
