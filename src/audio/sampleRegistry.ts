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
  render: (t: number, progress: number) => [number, number];
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

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const [l, r] = def.render(t, t / def.seconds);
      left[i] = l;
      right[i] = r;
    }

    registerSample(def.id, buffer, def.name, { builtIn: true });
  }
}
