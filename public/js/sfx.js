// Tiny WebAudio synth for game sounds. No assets needed.

let ctx = null;
let master = null;
let muted = localStorage.getItem('mh_muted') === '1';

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = !!m;
  localStorage.setItem('mh_muted', muted ? '1' : '0');
  if (master) master.gain.value = muted ? 0 : 0.16;
}

function ensure() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.16;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Call once on first user gesture.
export function unlock() {
  try { ensure(); } catch {}
}

function tone({ freq = 440, dur = 0.12, type = 'square', vol = 1, slide = 0, delay = 0 }) {
  try {
    const c = ensure();
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch {}
}

function noise({ dur = 0.2, vol = 0.8, delay = 0 }) {
  try {
    const c = ensure();
    const t0 = c.currentTime + delay;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = vol;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    src.connect(filter).connect(g).connect(master);
    src.start(t0);
  } catch {}
}

export const sfx = {
  select: () => tone({ freq: 660, dur: 0.06, type: 'square', vol: 0.5 }),
  move: () => {
    tone({ freq: 330, dur: 0.05, vol: 0.5 });
    tone({ freq: 392, dur: 0.05, delay: 0.05, vol: 0.5 });
    tone({ freq: 494, dur: 0.06, delay: 0.1, vol: 0.5 });
  },
  attack: () => {
    noise({ dur: 0.25, vol: 0.9 });
    tone({ freq: 120, dur: 0.22, type: 'sawtooth', slide: -80, vol: 0.8 });
  },
  destroy: () => {
    noise({ dur: 0.45, vol: 1 });
    tone({ freq: 90, dur: 0.4, type: 'sawtooth', slide: -60, vol: 0.9 });
  },
  capture: () => {
    tone({ freq: 523, dur: 0.09 });
    tone({ freq: 659, dur: 0.09, delay: 0.09 });
    tone({ freq: 784, dur: 0.14, delay: 0.18 });
  },
  build: () => {
    tone({ freq: 392, dur: 0.07, type: 'triangle' });
    tone({ freq: 523, dur: 0.1, delay: 0.08, type: 'triangle' });
  },
  turn: () => {
    tone({ freq: 440, dur: 0.09, type: 'triangle' });
    tone({ freq: 554, dur: 0.09, delay: 0.1, type: 'triangle' });
    tone({ freq: 659, dur: 0.16, delay: 0.2, type: 'triangle' });
  },
  error: () => tone({ freq: 180, dur: 0.14, type: 'sawtooth', vol: 0.45 }),
  chat: () => tone({ freq: 880, dur: 0.05, type: 'sine', vol: 0.4 }),
  win: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.16, delay: i * 0.13, type: 'triangle' }));
  },
  lose: () => {
    [392, 330, 262, 196].forEach((f, i) => tone({ freq: f, dur: 0.2, delay: i * 0.15, type: 'sawtooth', vol: 0.5 }));
  },
};
