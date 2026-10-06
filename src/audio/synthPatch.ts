import type { SynthPresetDef } from "../presets/presets";
import { DEFAULT_MOD, MAX_ROUTES, MOD_DESTS, MOD_SOURCES, type ModRoute, type SynthMod, type WavetableOsc } from "./modulation";
import { DEFAULT_TABLE, isWavetable } from "./wavetables";

/**
 * A synth sound a person built or changed themselves. It is a whole preset
 * (minus its id) stored in the channel, so a project keeps its sounds even on
 * a PC that has never seen them, and the studio's presets stay untouched.
 */
export type SynthPatch = Omit<SynthPresetDef, "id">;

export const WAVEFORMS = ["sine", "triangle", "sawtooth", "square"] as const;
export const FILTER_TYPES = ["lowpass", "highpass", "bandpass"] as const;

const MAX_PARTIALS = 8;

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function wave(value: unknown, fallback: OscillatorType): OscillatorType {
  return (WAVEFORMS as readonly unknown[]).includes(value) ? (value as OscillatorType) : fallback;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export const DEFAULT_WT_A: WavetableOsc = {
  table: DEFAULT_TABLE,
  pos: 0.67,
  level: 1,
  semitones: 0,
  fine: 0,
  unison: 1,
  detune: 12,
  width: 0.6
};

export const DEFAULT_WT_B: WavetableOsc = { ...DEFAULT_WT_A, pos: 0.33, level: 0 };

function wavetableOsc(raw: unknown, fallback: WavetableOsc): WavetableOsc {
  const source = object(raw) ?? {};
  return {
    table: isWavetable(source.table) ? source.table : fallback.table,
    pos: number(source.pos, fallback.pos, 0, 1),
    level: number(source.level, fallback.level, 0, 1),
    semitones: Math.round(number(source.semitones, fallback.semitones, -36, 36)),
    fine: number(source.fine, fallback.fine, -100, 100),
    unison: Math.round(number(source.unison, fallback.unison, 1, 9)) | 1,
    detune: number(source.detune, fallback.detune, 0, 60),
    width: number(source.width, fallback.width, 0, 1)
  };
}

function modulation(raw: unknown): SynthMod | undefined {
  const source = object(raw);
  if (!source) return undefined;

  const env = object(source.env2) ?? {};
  const lfo = (value: unknown, fallback: SynthMod["lfo1"]): SynthMod["lfo1"] => {
    const entry = object(value) ?? {};
    return { shape: wave(entry.shape, fallback.shape), rate: number(entry.rate, fallback.rate, 0.05, 20) };
  };

  const routes: ModRoute[] = [];
  if (Array.isArray(source.routes)) {
    for (const entry of source.routes) {
      if (routes.length >= MAX_ROUTES) break;
      const route = object(entry);
      if (!route) continue;
      if (!(MOD_SOURCES as readonly unknown[]).includes(route.source)) continue;
      if (!(MOD_DESTS as readonly unknown[]).includes(route.dest)) continue;
      routes.push({
        source: route.source as ModRoute["source"],
        dest: route.dest as ModRoute["dest"],
        amount: number(route.amount, 0, -1, 1)
      });
    }
  }

  return {
    env2: {
      attack: number(env.attack, DEFAULT_MOD.env2.attack, 0.001, 4),
      decay: number(env.decay, DEFAULT_MOD.env2.decay, 0.005, 4),
      sustain: number(env.sustain, DEFAULT_MOD.env2.sustain, 0, 1),
      release: number(env.release, DEFAULT_MOD.env2.release, 0.01, 6)
    },
    lfo1: lfo(source.lfo1, DEFAULT_MOD.lfo1),
    lfo2: lfo(source.lfo2, DEFAULT_MOD.lfo2),
    routes
  };
}

/**
 * Make anything a project file might hold into a patch that is safe to play:
 * every number is clamped, unknown names fall back, nothing can reach the audio
 * engine out of range. Returns undefined when there is no usable patch at all.
 */
export function sanitizeSynthPatch(raw: unknown): SynthPatch | undefined {
  const source = object(raw);
  if (!source) return undefined;

  const patch: SynthPatch = {
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 40) : "Custom sound",
    oscType: wave(source.oscType, "sawtooth"),
    detuneSpread: number(source.detuneSpread, 0, 0, 60),
    filterType: (FILTER_TYPES as readonly unknown[]).includes(source.filterType)
      ? (source.filterType as BiquadFilterType)
      : "lowpass",
    filterFreq: number(source.filterFreq, 4000, 40, 18000),
    filterEnvAmount: number(source.filterEnvAmount, 0, 0, 4),
    filterQ: number(source.filterQ, 0.7, 0.1, 20),
    attackTime: number(source.attackTime, 0.01, 0.001, 4),
    decayTime: number(source.decayTime, 0.3, 0.005, 4),
    sustainLevel: number(source.sustainLevel, 0.7, 0, 1),
    releaseTime: number(source.releaseTime, 0.3, 0.01, 6),
    gain: number(source.gain, 0.4, 0, 1)
  };

  if (source.unison !== undefined) patch.unison = Math.round(number(source.unison, 3, 3, 9)) | 1;
  if (source.stereoSpread !== undefined) patch.stereoSpread = number(source.stereoSpread, 0.5, 0, 1);
  if (source.noise !== undefined) patch.noise = number(source.noise, 0, 0, 1);
  if (source.filterKeytrack !== undefined) patch.filterKeytrack = number(source.filterKeytrack, 0, 0, 1);
  if (source.filterDecay !== undefined) patch.filterDecay = number(source.filterDecay, 0.3, 0.01, 4);

  const sub = object(source.sub);
  if (sub) patch.sub = { gain: number(sub.gain, 0.3, 0, 1), type: wave(sub.type, "sine") };

  const osc2 = object(source.osc2);
  if (osc2) {
    patch.osc2 = {
      type: wave(osc2.type, "square"),
      semitones: Math.round(number(osc2.semitones, 0, -24, 24)),
      detune: number(osc2.detune, 0, -100, 100),
      gain: number(osc2.gain, 0.5, 0, 1)
    };
  }

  const fm = object(source.fm);
  if (fm) {
    patch.fm = {
      ratio: number(fm.ratio, 1, 0.25, 16),
      index: number(fm.index, 1, 0, 12),
      decay: number(fm.decay, 0.5, 0.01, 4),
      sustain: number(fm.sustain, 0.15, 0, 1)
    };
  }

  const pitchEnv = object(source.pitchEnv);
  if (pitchEnv) {
    patch.pitchEnv = { semitones: number(pitchEnv.semitones, 0, -24, 24), time: number(pitchEnv.time, 0.05, 0.005, 2) };
  }

  const filterLfo = object(source.filterLfo);
  if (filterLfo) patch.filterLfo = { rate: number(filterLfo.rate, 2, 0.05, 20), depth: number(filterLfo.depth, 0, 0, 4800) };

  const tremolo = object(source.tremolo);
  if (tremolo) patch.tremolo = { rate: number(tremolo.rate, 5, 0.05, 20), depth: number(tremolo.depth, 0, 0, 1) };

  const vibrato = object(source.vibrato);
  if (vibrato) {
    patch.vibrato = {
      rate: number(vibrato.rate, 5.5, 0.5, 14),
      depth: number(vibrato.depth, 0, 0, 100),
      delay: number(vibrato.delay, 0.2, 0, 3)
    };
  }

  const attackNoise = object(source.attackNoise);
  if (attackNoise) {
    patch.attackNoise = {
      gain: number(attackNoise.gain, 0, 0, 1),
      decay: number(attackNoise.decay, 0.03, 0.005, 0.5),
      cutoff: number(attackNoise.cutoff, 3000, 200, 16000)
    };
  }

  if (Array.isArray(source.partials)) {
    const partials: NonNullable<SynthPatch["partials"]> = [];
    for (const entry of source.partials.slice(0, MAX_PARTIALS)) {
      const partial = object(entry);
      if (!partial) continue;
      partials.push({
        ratio: number(partial.ratio, 2, 0.25, 16),
        gain: number(partial.gain, 0.2, 0, 1),
        type: wave(partial.type, "sine")
      });
    }
    if (partials.length > 0) patch.partials = partials;
  }

  const wt = object(source.wt);
  if (wt) patch.wt = { a: wavetableOsc(wt.a, DEFAULT_WT_A), b: wavetableOsc(wt.b, DEFAULT_WT_B) };

  const mod = modulation(source.mod);
  if (mod) patch.mod = mod;

  return patch;
}

/** A starting point for a person's own sound: a copy of a preset, free to change. */
export function patchFromPreset(preset: SynthPresetDef): SynthPatch {
  const { id: _id, ...rest } = structuredClone(preset);
  void _id;
  return rest;
}

/** What the voice engine plays. */
export function patchToPreset(patch: SynthPatch): SynthPresetDef {
  return { id: "custom", ...patch };
}
