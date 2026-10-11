import { uid } from "../lib/utils";

export interface RegisteredSample {
  id: string;
  name: string;
  buffer: AudioBuffer;
  duration: number;
  /**
   * Original encoded bytes, kept so the sample can be saved with the project.
   * Built-in generated samples have none — they're recreated on startup.
   */
  source?: Blob;
  builtIn: boolean;
}

const sampleCache = new Map<string, RegisteredSample>();
const peakCache = new Map<string, Float32Array>();
const reverseCache = new Map<string, AudioBuffer>();

const listeners = new Set<() => void>();
let version = 0;

export function subscribeSamples(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot value for `useSyncExternalStore`. */
export function getSamplesVersion(): number {
  return version;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function registerSample(
  id: string,
  buffer: AudioBuffer,
  name: string,
  options: { source?: Blob; builtIn?: boolean } = {}
): RegisteredSample {
  const record: RegisteredSample = {
    id,
    name,
    buffer,
    duration: buffer.duration,
    source: options.source,
    builtIn: options.builtIn ?? false
  };

  sampleCache.set(id, record);
  peakCache.delete(id);
  reverseCache.delete(id);
  notify();

  return record;
}

export function getSample(id: string | undefined): RegisteredSample | undefined {
  return id ? sampleCache.get(id) : undefined;
}

export function hasSample(id: string): boolean {
  return sampleCache.has(id);
}

export function getAllSamples(): RegisteredSample[] {
  return Array.from(sampleCache.values());
}

export function removeSample(id: string): void {
  if (!sampleCache.delete(id)) return;
  peakCache.delete(id);
  reverseCache.delete(id);
  notify();
}

/**
 * Reversed copy of a sample, built once and cached. Doing this per trigger
 * meant allocating megabytes inside the scheduling callback.
 */
export function getReversedBuffer(
  context: BaseAudioContext,
  sample: RegisteredSample
): AudioBuffer {
  const cached = reverseCache.get(sample.id);
  if (cached && cached.sampleRate === sample.buffer.sampleRate) return cached;

  const source = sample.buffer;
  const reversed = context.createBuffer(
    source.numberOfChannels,
    source.length,
    source.sampleRate
  );

  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    const from = source.getChannelData(channel);
    const to = reversed.getChannelData(channel);
    const last = from.length - 1;
    for (let i = 0; i <= last; i++) to[i] = from[last - i];
  }

  reverseCache.set(sample.id, reversed);
  return reversed;
}

/** Normalised peak envelope, cached per sample. */
export function getWaveformPeaks(sampleId: string, numPeaks = 160): Float32Array {
  const cached = peakCache.get(sampleId);
  if (cached && cached.length === numPeaks) return cached;

  const sample = sampleCache.get(sampleId);
  if (!sample) return new Float32Array(numPeaks);

  const peaks = computePeaks(sample.buffer, numPeaks);
  peakCache.set(sampleId, peaks);
  return peaks;
}

export function computePeaks(buffer: AudioBuffer, numPeaks: number): Float32Array {
  const peaks = new Float32Array(numPeaks);
  const length = buffer.length;
  if (length === 0) return peaks;

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < numPeaks; i++) {
    const start = Math.floor((i * length) / numPeaks);
    const end = Math.max(start + 1, Math.floor(((i + 1) * length) / numPeaks));
    let max = 0;

    for (const data of channels) {
      for (let j = start; j < end; j++) {
        const abs = Math.abs(data[j]);
        if (abs > max) max = abs;
      }
    }

    peaks[i] = Math.min(1, max);
  }

  return peaks;
}

export async function loadSampleFromFile(
  file: File | Blob,
  name: string,
  context: BaseAudioContext,
  id = uid()
): Promise<RegisteredSample> {
  const bytes = await file.arrayBuffer();
  // decodeAudioData detaches its input, so hand it a copy and keep the original.
  const decoded = await context.decodeAudioData(bytes.slice(0));
  return registerSample(id, decoded, name, { source: file });
}

/* ───────────────────────── built-in sample content ───────────────────────── */

interface BuiltInDef {
  id: string;
  name: string;
  seconds: number;
  /** One stereo frame at a time, for sounds with no memory from one sample to the next. */
  render?: (t: number, progress: number) => [number, number];
  /** The whole sound at once, for sounds that are filtered (a filter remembers its last output). */
  fill?: (left: Float32Array, right: Float32Array, sampleRate: number) => void;
}

/* ── the tools the transition effects are made with ── */

/** A one-pole low-pass, moved along by a cutoff that changes over time. */
function lowPassStep(state: { y: number }, input: number, cutoff: number, sampleRate: number): number {
  const a = 1 - Math.exp((-2 * Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate);
  state.y += a * (input - state.y);
  return state.y;
}

/** Noise through a band that sweeps from one cutoff to another, with a loudness shape: risers, downlifters, sweeps. */
function sweptNoise(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  cutoff: (progress: number) => number,
  level: (progress: number) => number
): void {
  const lowL = { y: 0 };
  const lowR = { y: 0 };
  const bodyL = { y: 0 };
  const bodyR = { y: 0 };
  for (let i = 0; i < left.length; i++) {
    const progress = i / left.length;
    const top = cutoff(progress);
    // A band: the low-passed noise, less a low-passed copy two octaves down, so it hisses rather than rumbles.
    const nl = Math.random() * 2 - 1;
    const nr = Math.random() * 2 - 1;
    const bandL = lowPassStep(lowL, nl, top, sampleRate) - lowPassStep(bodyL, nl, top / 4, sampleRate);
    const bandR = lowPassStep(lowR, nr, top * 1.03, sampleRate) - lowPassStep(bodyR, nr, top / 4, sampleRate);
    const gain = level(progress) * 1.6;
    left[i] = Math.tanh(bandL * gain);
    right[i] = Math.tanh(bandR * gain);
  }
}

/** A short fade at the very end, so a sound never stops with a click. */
function fadeTail(left: Float32Array, right: Float32Array, sampleRate: number, seconds = 0.03): void {
  const frames = Math.min(left.length, Math.floor(sampleRate * seconds));
  for (let i = 0; i < frames; i++) {
    const gain = i / frames;
    left[left.length - 1 - i] *= gain;
    right[right.length - 1 - i] *= gain;
  }
}

const builtIns: BuiltInDef[] = [
  {
    id: "sample-kick-acoustic",
    name: "Punchy 909 Kick",
    seconds: 0.45,
    render: (t) => {
      const freq = 160 * Math.exp(-28 * t) + 42;
      const amp = Math.exp(-9 * t);
      const click = t < 0.0018 ? (Math.random() * 2 - 1) * (1 - t / 0.0018) * 0.6 : 0;
      const value = (Math.sin(2 * Math.PI * freq * t) * amp + click) * 0.9;
      return [value, value];
    }
  },
  {
    id: "sample-snare-crisp",
    name: "Crisp Studio Snare",
    seconds: 0.35,
    render: (t) => {
      const env = Math.exp(-12 * t);
      const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-22 * t) * 0.4;
      return [
        tone + (Math.random() * 2 - 1) * env * 0.65,
        tone + (Math.random() * 2 - 1) * env * 0.65
      ];
    }
  },
  {
    id: "sample-hat-closed",
    name: "Tight Closed Hat",
    seconds: 0.12,
    render: (t) => {
      const env = Math.exp(-60 * t);
      const noise = (Math.random() * 2 - 1) * env * 0.5;
      return [noise, noise * 0.94];
    }
  },
  {
    id: "sample-sub-808",
    name: "Heavy 808 Bass",
    seconds: 1.5,
    render: (t) => {
      const freq = 65 * Math.exp(-6 * t) + 38;
      const env = Math.exp(-2.2 * t);
      const value = Math.tanh(Math.sin(2 * Math.PI * freq * t) * 1.4) * env * 0.85;
      return [value, value];
    }
  },
  {
    id: "sample-sweep-riser",
    name: "Atmospheric Riser",
    seconds: 2.2,
    render: (t, progress) => {
      const freq1 = 260 + progress * 600;
      const freq2 = 520 + progress * 800;
      const env = Math.sin(Math.PI * progress);
      return [
        (Math.sin(2 * Math.PI * freq1 * t) + Math.sin(2 * Math.PI * freq2 * t) * 0.5) * env * 0.4,
        (Math.sin(2 * Math.PI * freq1 * 1.01 * t) +
          Math.sin(2 * Math.PI * freq2 * 0.99 * t) * 0.5) *
          env *
          0.4
      ];
    }
  }
];

// ── transition effects for builds and drops ──
builtIns.push(
  {
    id: "sample-fx-noise-riser",
    name: "Noise Riser",
    seconds: 4,
    fill: (left, right, rate) => {
      // White noise opening up from a dull hiss to a bright one, getting louder all the way.
      sweptNoise(left, right, rate, (p) => 300 * Math.pow(40, p), (p) => 0.08 + 0.85 * Math.pow(p, 1.6));
      fadeTail(left, right, rate, 0.01);
    }
  },
  {
    id: "sample-fx-downlifter",
    name: "Downlifter",
    seconds: 3,
    fill: (left, right, rate) => {
      // The other way: bright to dull, loud to quiet, with a falling tone underneath.
      sweptNoise(left, right, rate, (p) => 12000 * Math.pow(1 / 60, p), (p) => 0.9 * Math.pow(1 - p, 1.4));
      let phase = 0;
      for (let i = 0; i < left.length; i++) {
        const p = i / left.length;
        phase += (2 * Math.PI * (700 * Math.pow(1 / 12, p))) / rate;
        const tone = Math.sin(phase) * 0.22 * Math.pow(1 - p, 2);
        left[i] = left[i] * 0.78 + tone;
        right[i] = right[i] * 0.78 + tone;
      }
      fadeTail(left, right, rate);
    }
  },
  {
    id: "sample-fx-impact",
    name: "Impact",
    seconds: 2.6,
    fill: (left, right, rate) => {
      // A boom for the first beat of a drop: a falling sub, a burst of noise, and a long dark tail.
      const tailL = { y: 0 };
      const tailR = { y: 0 };
      let phase = 0;
      for (let i = 0; i < left.length; i++) {
        const t = i / rate;
        phase += (2 * Math.PI * (38 + 70 * Math.exp(-t * 9))) / rate;
        const sub = Math.sin(phase) * Math.exp(-t * 1.6) * 0.9;
        const burst = Math.exp(-t * 18);
        const noiseL = lowPassStep(tailL, Math.random() * 2 - 1, 900 * Math.exp(-t * 1.2) + 120, rate);
        const noiseR = lowPassStep(tailR, Math.random() * 2 - 1, 950 * Math.exp(-t * 1.2) + 120, rate);
        const body = (0.5 * burst + 0.35 * Math.exp(-t * 2.2)) * 2.2;
        left[i] = Math.tanh(sub + noiseL * body);
        right[i] = Math.tanh(sub + noiseR * body);
      }
      fadeTail(left, right, rate);
    }
  },
  {
    id: "sample-fx-sub-drop",
    name: "Sub Drop",
    seconds: 2.2,
    render: (t, progress) => {
      // A sine falling from 110 Hz to 30 Hz: felt as much as heard.
      const phase = 2 * Math.PI * (30 * t + (80 / 2.4) * (1 - Math.exp(-2.4 * t)));
      const value = Math.tanh(Math.sin(phase) * 1.3) * Math.min(1, t / 0.005) * Math.pow(1 - progress, 1.2) * 0.85;
      return [value, value];
    }
  },
  {
    id: "sample-fx-reverse-crash",
    name: "Reverse Crash",
    seconds: 2.5,
    fill: (left, right, rate) => {
      // A crash cymbal backwards: a bright wash swelling up and stopping dead, for the bar before a drop.
      const highL = { y: 0 };
      const highR = { y: 0 };
      for (let i = 0; i < left.length; i++) {
        const p = i / left.length;
        const nl = Math.random() * 2 - 1;
        const nr = Math.random() * 2 - 1;
        // Highs only: the noise less its own low-passed copy.
        const hl = nl - lowPassStep(highL, nl, 4500, rate);
        const hr = nr - lowPassStep(highR, nr, 4500, rate);
        const swell = Math.pow(p, 3.2) * 0.8;
        left[i] = hl * swell;
        right[i] = hr * swell;
      }
      fadeTail(left, right, rate, 0.006);
    }
  },
  {
    id: "sample-fx-noise-sweep",
    name: "White Noise Sweep",
    seconds: 4,
    fill: (left, right, rate) => {
      // Up and back down again: a transition you can drop across a bar line.
      sweptNoise(left, right, rate, (p) => 250 * Math.pow(36, Math.sin(Math.PI * p)), (p) => 0.1 + 0.75 * Math.sin(Math.PI * p));
      fadeTail(left, right, rate);
    }
  }
);

export const builtInSampleIds = builtIns.map((def) => def.id);

export function initDefaultSamples(context: BaseAudioContext): void {
  for (const def of builtIns) {
    const existing = sampleCache.get(def.id);
    if (existing && existing.buffer.sampleRate === context.sampleRate) continue;

    const sampleRate = context.sampleRate;
    const length = Math.floor(sampleRate * def.seconds);
    const buffer = context.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    if (def.fill) {
      def.fill(left, right, sampleRate);
    } else if (def.render) {
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const [l, r] = def.render(t, t / def.seconds);
        left[i] = l;
        right[i] = r;
      }
    }

    registerSample(def.id, buffer, def.name, { builtIn: true });
  }
}
