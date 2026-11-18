/**
 * Synthesised key sounds (Web Audio, no files). Silent without an `AudioContext` (jsdom), until the first user
 * gesture (browsers refuse audio before one), and while muted. Mute is kept in localStorage.
 */
const KEY = "beambox.muted";
export const HOLD_MS = 1200;

let ctx: AudioContext | null = null;
let gestured = false;
let muted = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

if (typeof window !== "undefined") {
  const unlock = () => {
    gestured = true;
  };
  window.addEventListener("pointerdown", unlock, { once: true, capture: true });
  window.addEventListener("keydown", unlock, { once: true, capture: true });
}

function audio(): AudioContext | null {
  if (muted || !gestured || typeof AudioContext === "undefined") return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

type Opts = { type?: OscillatorType; gain?: number; slide?: number; at?: number };
function tone(freq: number, dur: number, o: Opts = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + (o.at ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t);
  if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t + dur);
  // Low gain: sounds are on by default.
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime((o.gain ?? 0.1) * 0.6, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function noise(dur: number, o: { gain?: number; freq?: number; at?: number } = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + (o.at ?? 0);
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buffer = c.createBuffer(1, len, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const source = c.createBufferSource();
  source.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = o.freq ?? 2000;
  const g = c.createGain();
  g.gain.value = (o.gain ?? 0.2) * 0.6;
  source.connect(filter).connect(g).connect(c.destination);
  source.start(t);
}

export const sound = {
  muted: () => muted,
  setMuted(on: boolean) {
    muted = on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {}
  },
  press: () => {
    noise(0.02, { gain: 0.35, freq: 3500 });
    tone(160, 0.035, { type: "square", gain: 0.02 });
  },
  clunk: () => {
    noise(0.06, { gain: 0.5, freq: 800 });
    tone(110, 0.12, { gain: 0.25, slide: 55 });
  },
  ready: () => {
    tone(523, 0.12, { type: "triangle", gain: 0.07 });
    tone(784, 0.2, { type: "triangle", gain: 0.07, at: 0.08 });
  },
  needsYou: () => {
    tone(740, 0.13, { type: "triangle", gain: 0.1 });
    tone(740, 0.13, { type: "triangle", gain: 0.1, at: 0.18 });
  },
  sleep: () => tone(520, 0.45, { gain: 0.08, slide: 180 }),
  wake: () => tone(240, 0.35, { gain: 0.08, slide: 640 }),
  shutter: () => {
    noise(0.03, { gain: 0.45, freq: 5200 });
    noise(0.06, { gain: 0.3, freq: 2600, at: 0.07 });
  },
  trash: () => {
    noise(0.3, { gain: 0.4, freq: 500 });
    tone(220, 0.35, { type: "sawtooth", gain: 0.025, slide: 50 });
  },
  /** A tone rising over a full hold; call the result to stop it. */
  hold(): () => void {
    const c = audio();
    if (!c) return () => {};
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(180, c.currentTime);
    osc.frequency.linearRampToValueAtTime(720, c.currentTime + HOLD_MS / 1000);
    g.gain.value = 0.03;
    osc.connect(g).connect(c.destination);
    osc.start();
    return () => {
      g.gain.setTargetAtTime(0.0001, c.currentTime, 0.02);
      osc.stop(c.currentTime + 0.12);
    };
  },
};
