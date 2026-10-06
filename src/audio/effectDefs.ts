import type { EffectType } from "../types";

export interface EffectParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** Discrete choices, for switch-style params like filter mode. */
  options?: string[];
  /** How many decimals to show in the readout. */
  precision?: number;
}

export interface EffectTypeDef {
  type: EffectType;
  name: string;
  description: string;
  params: EffectParamDef[];
}

export const effectTypeDefs: EffectTypeDef[] = [
  {
    type: "eq",
    name: "EQ",
    description: "Low and high cut, shelving and peaking bands.",
    params: [
      { key: "lowCut", label: "Low cut", min: 20, max: 1000, step: 5, unit: "Hz" },
      { key: "lowGain", label: "Low", min: -18, max: 18, step: 0.5, unit: "dB", precision: 1 },
      { key: "midGain", label: "Mid", min: -18, max: 18, step: 0.5, unit: "dB", precision: 1 },
      { key: "midFreq", label: "Mid freq", min: 200, max: 6000, step: 10, unit: "Hz" },
      { key: "midQ", label: "Mid Q", min: 0.3, max: 8, step: 0.1, precision: 1 },
      { key: "highGain", label: "High", min: -18, max: 18, step: 0.5, unit: "dB", precision: 1 },
      { key: "highCut", label: "High cut", min: 2000, max: 20000, step: 100, unit: "Hz" }
    ]
  },
  {
    type: "filter",
    name: "Filter",
    description: "Resonant multi-mode filter.",
    params: [
      { key: "mode", label: "Mode", min: 0, max: 2, step: 1, options: ["Low pass", "High pass", "Band pass"] },
      { key: "cutoff", label: "Cutoff", min: 30, max: 18000, step: 10, unit: "Hz" },
      { key: "resonance", label: "Res", min: 0.1, max: 20, step: 0.1, precision: 1 }
    ]
  },
  {
    type: "distortion",
    name: "Distortion",
    description: "Waveshaper drive with a tone control.",
    params: [
      { key: "drive", label: "Drive", min: 1, max: 100, step: 1 },
      { key: "tone", label: "Tone", min: 500, max: 16000, step: 50, unit: "Hz" },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, precision: 2 }
    ]
  },
  {
    type: "compressor",
    name: "Compressor",
    description: "Dynamics control with makeup gain.",
    params: [
      { key: "threshold", label: "Thresh", min: -60, max: 0, step: 1, unit: "dB" },
      { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.5, precision: 1 },
      { key: "attack", label: "Attack", min: 0.001, max: 0.2, step: 0.001, unit: "s", precision: 3 },
      { key: "release", label: "Release", min: 0.01, max: 1, step: 0.01, unit: "s", precision: 2 },
      { key: "gain", label: "Makeup", min: 0, max: 18, step: 0.5, unit: "dB", precision: 1 }
    ]
  },
  {
    type: "delay",
    name: "Delay",
    description: "Filtered feedback delay.",
    params: [
      { key: "time", label: "Time", min: 0.01, max: 2, step: 0.005, unit: "s", precision: 3 },
      { key: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01, precision: 2 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, precision: 2 },
      { key: "cutoff", label: "Damp", min: 300, max: 18000, step: 50, unit: "Hz" }
    ]
  },
  {
    type: "reverb",
    name: "Reverb",
    description: "Convolution reverb with a synthetic tail.",
    params: [
      { key: "decay", label: "Decay", min: 0.1, max: 8, step: 0.1, unit: "s", precision: 1 },
      { key: "preDelay", label: "Pre-delay", min: 0, max: 0.15, step: 0.005, unit: "s", precision: 3 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, precision: 2 }
    ]
  },
  {
    type: "chorus",
    name: "Chorus",
    description: "Stereo chorus: two modulated delays in opposite phase.",
    params: [
      { key: "rate", label: "Rate", min: 0.05, max: 5, step: 0.05, unit: "Hz", precision: 2 },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, precision: 2 },
      { key: "delay", label: "Delay", min: 0.005, max: 0.04, step: 0.001, unit: "s", precision: 3 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, precision: 2 }
    ]
  },
  {
    type: "flanger",
    name: "Flanger",
    description: "Short swept delay with feedback, for the jet-plane sweep.",
    params: [
      { key: "rate", label: "Rate", min: 0.02, max: 5, step: 0.01, unit: "Hz", precision: 2 },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, precision: 2 },
      { key: "feedback", label: "Feedback", min: 0, max: 0.9, step: 0.01, precision: 2 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, precision: 2 }
    ]
  },
  {
    type: "phaser",
    name: "Phaser",
    description: "Six swept all-pass stages.",
    params: [
      { key: "rate", label: "Rate", min: 0.02, max: 5, step: 0.01, unit: "Hz", precision: 2 },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, precision: 2 },
      { key: "frequency", label: "Centre", min: 200, max: 4000, step: 10, unit: "Hz" },
      { key: "resonance", label: "Res", min: 0.3, max: 5, step: 0.1, precision: 1 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, precision: 2 }
    ]
  },
  {
    type: "tremolo",
    name: "Tremolo",
    description: "Volume modulation.",
    params: [
      { key: "rate", label: "Rate", min: 0.1, max: 20, step: 0.1, unit: "Hz", precision: 1 },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, precision: 2 },
      { key: "shape", label: "Shape", min: 0, max: 2, step: 1, options: ["Sine", "Triangle", "Square"] }
    ]
  },
  {
    type: "autopan",
    name: "Auto Pan",
    description: "Sweeps the signal between left and right.",
    params: [
      { key: "rate", label: "Rate", min: 0.05, max: 10, step: 0.05, unit: "Hz", precision: 2 },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01, precision: 2 }
    ]
  },
  {
    type: "stereo",
    name: "Stereo Width",
    description: "Mid/side width: 0 is mono, 1 unchanged, 2 extra wide.",
    params: [
      { key: "width", label: "Width", min: 0, max: 2, step: 0.01, precision: 2 },
      { key: "gain", label: "Gain", min: -12, max: 12, step: 0.5, unit: "dB", precision: 1 }
    ]
  },
  {
    type: "bitcrush",
    name: "Bitcrusher",
    description: "Lo-fi bit-depth reduction.",
    params: [
      { key: "bits", label: "Bits", min: 1, max: 16, step: 1 },
      { key: "drive", label: "Drive", min: 0, max: 24, step: 0.5, unit: "dB", precision: 1 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01, precision: 2 }
    ]
  },
  {
    type: "limiter",
    name: "Limiter",
    description: "Brick-wall loudness maximiser for the master bus.",
    params: [
      { key: "gain", label: "Gain", min: 0, max: 24, step: 0.5, unit: "dB", precision: 1 },
      { key: "ceiling", label: "Ceiling", min: -12, max: 0, step: 0.1, unit: "dB", precision: 1 },
      { key: "release", label: "Release", min: 0.01, max: 1, step: 0.01, unit: "s", precision: 2 }
    ]
  }
];

const defsByType = new Map<EffectType, EffectTypeDef>(
  effectTypeDefs.map((def) => [def.type, def])
);

export function getEffectDef(type: EffectType): EffectTypeDef | undefined {
  return defsByType.get(type);
}

export function isEffectType(value: unknown): value is EffectType {
  return typeof value === "string" && defsByType.has(value as EffectType);
}

export const effectTypeNames = Object.fromEntries(
  effectTypeDefs.map((def) => [def.type, def.name])
) as Record<EffectType, string>;

export function defaultEffectParams(type: EffectType): Record<string, number> {
  const preferred: Partial<Record<EffectType, Record<string, number>>> = {
    delay: { time: 0.25, feedback: 0.35, mix: 0.3, cutoff: 4000 },
    reverb: { decay: 1.8, preDelay: 0.01, mix: 0.25 },
    eq: { lowCut: 20, lowGain: 0, midGain: 0, midFreq: 1200, midQ: 1.2, highGain: 0, highCut: 20000 },
    compressor: { threshold: -18, ratio: 4, attack: 0.01, release: 0.15, gain: 2 },
    filter: { mode: 0, cutoff: 8000, resonance: 1 },
    distortion: { drive: 12, tone: 6000, mix: 0.5 },
    chorus: { rate: 0.8, depth: 0.5, delay: 0.018, mix: 0.45 },
    flanger: { rate: 0.25, depth: 0.7, feedback: 0.5, mix: 0.5 },
    phaser: { rate: 0.4, depth: 0.7, frequency: 900, resonance: 1.2, mix: 0.5 },
    tremolo: { rate: 5, depth: 0.5, shape: 0 },
    autopan: { rate: 0.5, depth: 0.7 },
    stereo: { width: 1.4, gain: 0 },
    bitcrush: { bits: 6, drive: 0, mix: 0.6 },
    limiter: { gain: 3, ceiling: -0.3, release: 0.12 }
  };

  const def = defsByType.get(type);
  if (!def) return {};

  const chosen = preferred[type] ?? {};

  return Object.fromEntries(
    def.params.map((param) => [param.key, chosen[param.key] ?? param.min])
  );
}

export function formatParamValue(def: EffectParamDef, value: number): string {
  if (def.options) return def.options[Math.round(value)] ?? String(value);
  const text = value.toFixed(def.precision ?? 0);
  return def.unit ? `${text} ${def.unit}` : text;
}
