// Tiny WebAudio-synthesized blips. No audio files; everything is a few
// oscillator notes with a square/triangle wave for that 8-bit feel.

export type SfxName = 'drop' | 'vaulted' | 'scrapped' | 'approval' | 'kill' | 'click';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

// Browsers only allow audio after a user gesture; unlock on the first one.
if (typeof window !== 'undefined') {
  const unlock = () => {
    audio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

type Note = [freq: number, startMs: number, durMs: number, type?: OscillatorType, gain?: number, slideTo?: number];

const SOUNDS: Record<SfxName, Note[]> = {
  // thunk: a crate lands on the dock
  drop: [
    [220, 0, 70, 'square', 0.12, 110],
    [110, 60, 90, 'triangle', 0.18],
  ],
  // rising arpeggio: an idea made it into the vault
  vaulted: [
    [523, 0, 80, 'square', 0.08],
    [659, 80, 80, 'square', 0.08],
    [784, 160, 80, 'square', 0.08],
    [1047, 240, 180, 'square', 0.09],
  ],
  // falling buzz: scrapped
  scrapped: [
    [300, 0, 120, 'sawtooth', 0.06, 150],
    [150, 120, 160, 'sawtooth', 0.05, 80],
  ],
  // two-tone ding-ding: approval needed
  approval: [
    [880, 0, 110, 'triangle', 0.2],
    [1175, 140, 160, 'triangle', 0.2],
    [880, 360, 110, 'triangle', 0.14],
    [1175, 500, 200, 'triangle', 0.14],
  ],
  // alarm: kill switch
  kill: [
    [660, 0, 140, 'square', 0.12, 330],
    [660, 160, 140, 'square', 0.12, 330],
    [660, 320, 220, 'square', 0.12, 220],
  ],
  click: [[1200, 0, 25, 'square', 0.05]],
};

export function playSfx(name: SfxName) {
  const ac = audio();
  if (!ac || ac.state !== 'running') return;
  const t0 = ac.currentTime + 0.01;
  for (const [freq, start, dur, type = 'square', gain = 0.1, slideTo] of SOUNDS[name]) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    const s = t0 + start / 1000;
    const e = s + dur / 1000;
    osc.frequency.setValueAtTime(freq, s);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, e);
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(gain, s + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, e);
    osc.connect(g).connect(ac.destination);
    osc.start(s);
    osc.stop(e + 0.02);
  }
}
