/**
 * Wavetables: a table is a waveform that changes shape along a "position"
 * from 0 to 1. Turning the position knob (or modulating it) morphs the sound,
 * which is the heart of a Serum-style synth.
 *
 * Each table is described as a function (a shape at a position) and turned into
 * the harmonics the browser's PeriodicWave wants. Those waves are cached, so a
 * note only ever pays for the first request of a given position.
 */

export interface WavetableDef {
  id: string;
  name: string;
  /** What the table does as the position goes from 0 to 1, in a few words. */
  hint: string;
}

/** Harmonic 1 is the fundamental; index 0 is unused (no DC). */
export interface Harmonics {
  real: Float32Array;
  imag: Float32Array;
}

export const HARMONICS = 64;
/** Positions are cached in this many steps. */
export const POSITION_STEPS = 128;

type Shape = (phase: number, position: number) => number;
type Additive = (position: number) => number[];

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);

const sine = (p: number) => Math.sin(TAU * p);
const saw = (p: number) => 2 * frac(p) - 1;
const square = (p: number) => (frac(p) < 0.5 ? 1 : -1);

/** A proper triangle: 0 at phase 0, rising to +1 at a quarter. */
const tri = (p: number) => {
  const x = frac(p);
  return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
};

/** Simple seeded random numbers, so a table sounds the same every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────────────────────────── the tables ───────────────────────────── */

interface Table extends WavetableDef {
  shape?: Shape;
  additive?: Additive;
}

const VOWELS: Array<[number, number]> = [
  [800, 1150], // ah
  [400, 2000], // eh
  [300, 2500], // ee
  [500, 900], // oh
  [350, 700] // oo
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const DRAWBARS_SOFT = [1, 0.35, 0.12, 0, 0.05, 0, 0.02, 0];
const DRAWBARS_FULL = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];

const TABLES: Table[] = [
  {
    id: "basic",
    name: "Basic Shapes",
    hint: "sine, triangle, saw, square",
    shape: (p, pos) => {
      const t = pos * 3;
      const i = Math.min(2, Math.floor(t));
      const f = t - i;
      const shapes = [sine, tri, saw, square];
      return lerp(shapes[i](p), shapes[i + 1](p), f);
    }
  },
  {
    id: "pwm",
    name: "Pulse Width",
    hint: "wide pulse to thin pulse",
    shape: (p, pos) => (frac(p) < lerp(0.5, 0.04, pos) ? 1 : -1)
  },
  {
    id: "sawsweep",
    name: "Saw Sweep",
    hint: "dark saw to bright saw",
    additive: (pos) => {
      const cutoff = lerp(1.5, 48, pos * pos);
      return Array.from({ length: HARMONICS }, (_, i) => {
        const n = i + 1;
        return (1 / n) / (1 + Math.pow(n / cutoff, 4));
      });
    }
  },
  {
    id: "sync",
    name: "Sync Saw",
    hint: "hard-sync sweep",
    shape: (p, pos) => saw(frac(p) * lerp(1, 6, pos))
  },
  {
    id: "bend",
    name: "Bent Saw",
    hint: "saw leaning harder and harder",
    shape: (p, pos) => 2 * Math.pow(frac(p), lerp(1, 4, pos)) - 1
  },
  {
    id: "fm",
    name: "FM Sweep",
    hint: "plain sine to metallic FM",
    shape: (p, pos) => Math.sin(TAU * p + lerp(0, 7, pos) * Math.sin(TAU * p))
  },
  {
    id: "fm2",
    name: "FM Octave",
    hint: "FM one octave up",
    shape: (p, pos) => Math.sin(TAU * p + lerp(0, 6, pos) * Math.sin(TAU * 2 * p))
  },
  {
    id: "vowel",
    name: "Vowels",
    hint: "ah, eh, ee, oh, oo",
    additive: (pos) => {
      const t = pos * (VOWELS.length - 1);
      const i = Math.min(VOWELS.length - 2, Math.floor(t));
      const f = t - i;
      const f1 = lerp(VOWELS[i][0], VOWELS[i + 1][0], f);
      const f2 = lerp(VOWELS[i][1], VOWELS[i + 1][1], f);
      const f0 = 110;
      return Array.from({ length: HARMONICS }, (_, k) => {
        const n = k + 1;
        const freq = n * f0;
        const peak =
          Math.exp(-Math.pow((freq - f1) / (f1 * 0.22), 2)) +
          0.7 * Math.exp(-Math.pow((freq - f2) / (f2 * 0.18), 2));
        return (peak + 0.02) / Math.pow(n, 0.55);
      });
    }
  },
  {
    id: "organ",
    name: "Organ",
    hint: "soft drawbars to full organ",
    additive: (pos) => {
      const ratios = [1, 2, 3, 4, 6, 8, 10, 12];
      const out = new Array(HARMONICS).fill(0);
      ratios.forEach((ratio, i) => {
        out[ratio - 1] = lerp(DRAWBARS_SOFT[i], DRAWBARS_FULL[i], pos);
      });
      return out;
    }
  },
  {
    id: "spectral",
    name: "Digital",
    hint: "a different bright digital tone at every step",
    additive: (pos) => {
      const frames = 7;
      const t = pos * (frames - 1);
      const i = Math.min(frames - 2, Math.floor(t));
      const f = t - i;
      const frame = (index: number) => {
        const random = seeded(1000 + index * 7919);
        return Array.from({ length: HARMONICS }, (_, k) => {
          const n = k + 1;
          const strength = random();
          return (strength > 0.45 ? strength : strength * 0.15) / Math.pow(n, 0.75);
        });
      };
      const a = frame(i);
      const b = frame(i + 1);
      return a.map((value, k) => lerp(value, b[k], f));
    }
  }
];

export const WAVETABLES: WavetableDef[] = TABLES.map(({ id, name, hint }) => ({ id, name, hint }));
export const DEFAULT_TABLE = "basic";

export function isWavetable(id: unknown): id is string {
  return typeof id === "string" && TABLES.some((table) => table.id === id);
}

function findTable(id: string): Table {
  return TABLES.find((table) => table.id === id) ?? TABLES[0];
}

/* ───────────────────────────── harmonics ───────────────────────────── */

/** Samples used to analyse a shape into harmonics. */
const ANALYSIS = 1024;

function analyse(shape: Shape, position: number): Harmonics {
  const real = new Float32Array(HARMONICS + 1);
  const imag = new Float32Array(HARMONICS + 1);
  const samples = new Float32Array(ANALYSIS);
  for (let k = 0; k < ANALYSIS; k++) samples[k] = shape(k / ANALYSIS, position);

  for (let n = 1; n <= HARMONICS; n++) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < ANALYSIS; k++) {
      const angle = (TAU * n * k) / ANALYSIS;
      a += samples[k] * Math.cos(angle);
      b += samples[k] * Math.sin(angle);
    }
    real[n] = (2 * a) / ANALYSIS;
    imag[n] = (2 * b) / ANALYSIS;
  }
  return { real, imag };
}

const harmonicsCache = new Map<string, Harmonics>();

/** The harmonics of a table at a position (0..1), cached in small steps. */
export function harmonicsAt(tableId: string, position: number): Harmonics {
  const step = Math.round(Math.min(1, Math.max(0, position)) * POSITION_STEPS) / POSITION_STEPS;
  const key = `${tableId}:${step.toFixed(4)}`;

  let cached = harmonicsCache.get(key);
  if (!cached) {
    const table = findTable(tableId);
    if (table.additive) {
      const amplitudes = table.additive(step);
      const real = new Float32Array(HARMONICS + 1);
      const imag = new Float32Array(HARMONICS + 1);
      for (let n = 1; n <= HARMONICS; n++) imag[n] = amplitudes[n - 1] ?? 0;
      cached = { real, imag };
    } else {
      cached = analyse(table.shape ?? sine, step);
    }
    harmonicsCache.set(key, cached);
  }
  return cached;
}

/* ───────────────────────────── Web Audio ───────────────────────────── */

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

/** The browser's wave for a table position, made once per audio context. */
export function getPeriodicWave(context: BaseAudioContext, tableId: string, position: number): PeriodicWave {
  let waves = waveCache.get(context);
  if (!waves) {
    waves = new Map();
    waveCache.set(context, waves);
  }

  const step = Math.round(Math.min(1, Math.max(0, position)) * POSITION_STEPS);
  const key = `${tableId}:${step}`;

  let wave = waves.get(key);
  if (!wave) {
    const { real, imag } = harmonicsAt(tableId, step / POSITION_STEPS);
    wave = context.createPeriodicWave(real, imag);
    waves.set(key, wave);
  }
  return wave;
}

/* ───────────────────────────── for drawing ───────────────────────────── */

/** One cycle of a table position, as `points` samples from -1 to 1 for the display. */
export function sampleWavetable(tableId: string, position: number, points = 96): number[] {
  const { real, imag } = harmonicsAt(tableId, position);
  const out: number[] = [];
  let peak = 0.0001;

  for (let k = 0; k < points; k++) {
    const phase = (TAU * k) / points;
    let sum = 0;
    for (let n = 1; n <= HARMONICS; n++) sum += real[n] * Math.cos(n * phase) + imag[n] * Math.sin(n * phase);
    out.push(sum);
    peak = Math.max(peak, Math.abs(sum));
  }
  return out.map((value) => value / peak);
}
