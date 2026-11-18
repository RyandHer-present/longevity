// Subtle UI sounds, synthesized (no audio files): soft wooden ticks, a paper rustle for page turns,
// a low chime for finished chapters. All very quiet and short.
import { useStore } from "./store";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let lastHover = 0;

function ac(): AudioContext | null {
  if (!useStore.getState().settings?.sounds) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const b = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", when = 0, glide = 0) {
  const c = ac();
  if (!c || !master) return;
  const t = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(freq * glide, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, gain: number, filterFreq: number, q = 0.8, when = 0, sweepTo = 0) {
  const c = ac();
  if (!c || !master) return;
  const t = c.currentTime + when;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur + 0.05);
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.setValueAtTime(filterFreq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);
}

export const sfx = {
  click() {
    tone(1250, 0.045, 0.18, "triangle", 0, 0.55);
    noise(0.03, 0.08, 3200, 1.5);
  },
  hover() {
    const now = performance.now();
    if (now - lastHover < 70) return;
    lastHover = now;
    tone(2100, 0.025, 0.035, "sine");
  },
  nav() {
    tone(660, 0.07, 0.12, "sine", 0, 1.25);
    tone(990, 0.09, 0.06, "sine", 0.03);
  },
  open() {
    tone(392, 0.16, 0.09, "sine", 0, 1.5);
    tone(587, 0.2, 0.05, "sine", 0.05);
  },
  close() {
    tone(587, 0.12, 0.07, "sine", 0, 0.66);
  },
  page() {
    noise(0.32, 0.22, 1800, 0.6, 0, 600);
    noise(0.12, 0.08, 5200, 1.2, 0.18);
  },
  chime() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 1.4, 0.05, "sine", i * 0.11));
  },
  shutter() {
    noise(0.05, 0.25, 2600, 2);
    noise(0.07, 0.18, 1400, 2, 0.09);
  },
  toggle(on: boolean) {
    tone(on ? 880 : 520, 0.06, 0.1, "triangle", 0, on ? 1.3 : 0.75);
  },
  /** card tilt-in / flip */
  flip() {
    noise(0.09, 0.16, 2400, 0.9, 0, 5200);
    tone(1500, 0.05, 0.04, "triangle", 0.02, 1.4);
  },
  /** the pack shaking in your hands */
  rumble() {
    for (let i = 0; i < 6; i++) noise(0.07, 0.1 + i * 0.02, 420 + i * 60, 1.4, i * 0.08);
    tone(70, 0.5, 0.06, "sine", 0, 1.6);
  },
  /** foil tearing open */
  tear() {
    noise(0.28, 0.3, 3800, 0.5, 0, 900);
    noise(0.18, 0.18, 7000, 1, 0.08, 2600);
    tone(220, 0.5, 0.05, "sine", 0.1, 3);
  },
  /** a card turning over; brighter and richer the rarer it is (0..4) */
  reveal(rank: number) {
    const base = [523.25, 587.33, 659.25, 783.99, 880][Math.max(0, Math.min(4, rank))];
    tone(base, 0.35 + rank * 0.12, 0.06, "sine", 0);
    tone(base * 1.5, 0.4 + rank * 0.15, 0.04, "sine", 0.06);
    if (rank >= 2) tone(base * 2, 0.6 + rank * 0.2, 0.035, "triangle", 0.12);
    if (rank >= 3) [1, 1.25, 1.5, 2].forEach((m, i) => tone(base * 2 * m, 0.9, 0.025, "sine", 0.2 + i * 0.07));
    if (rank >= 4) {
      noise(1.2, 0.07, 6000, 0.4, 0.1, 9000);
      [1, 1.26, 1.5, 1.68, 2].forEach((m, i) => tone(base * m, 1.8, 0.04, "sine", 0.35 + i * 0.09));
    }
  },
  /** soft glittery shimmer for hovering a rare card */
  sparkle() {
    const now = performance.now();
    if (now - lastHover < 160) return;
    lastHover = now;
    [2637, 3136, 3520].forEach((f, i) => tone(f, 0.12, 0.012, "sine", i * 0.04));
  },
};
