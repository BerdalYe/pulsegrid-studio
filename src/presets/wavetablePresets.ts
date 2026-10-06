import type { SynthMod, WavetableOsc } from "../audio/modulation";
import type { SynthPresetDef } from "./presets";

/**
 * Starting points for the wavetable synth: each is a whole sound (two
 * wavetable oscillators, filter, envelopes, and modulation routes) that opens in
 * the sound editor to be changed.
 */

const osc = (changes: Partial<WavetableOsc> = {}): WavetableOsc => ({
  table: "basic",
  pos: 0.67,
  level: 1,
  semitones: 0,
  fine: 0,
  unison: 1,
  detune: 12,
  width: 0.7,
  ...changes
});

/** An oscillator that is switched off until a sound wants it. */
const off = (changes: Partial<WavetableOsc> = {}): WavetableOsc => osc({ level: 0, ...changes });

const mod = (routes: SynthMod["routes"], changes: Partial<SynthMod> = {}): SynthMod => ({
  env2: { attack: 0.005, decay: 0.45, sustain: 0.25, release: 0.4 },
  lfo1: { shape: "sine", rate: 2 },
  lfo2: { shape: "triangle", rate: 0.4 },
  routes,
  ...changes
});

const base = {
  oscType: "sawtooth" as OscillatorType,
  detuneSpread: 0,
  filterType: "lowpass" as BiquadFilterType,
  filterFreq: 9000,
  filterEnvAmount: 0,
  filterQ: 0.8,
  attackTime: 0.008,
  decayTime: 0.3,
  sustainLevel: 0.85,
  releaseTime: 0.35,
  gain: 0.42
};

export const wavetablePresets: SynthPresetDef[] = [
  {
    ...base,
    id: "wt-init",
    name: "WT Init",
    wt: { a: osc(), b: off() }
  },
  {
    ...base,
    id: "wt-supersaw",
    name: "WT Supersaw",
    gain: 0.34,
    filterFreq: 11000,
    attackTime: 0.012,
    releaseTime: 0.5,
    wt: {
      a: osc({ unison: 7, detune: 24, width: 1 }),
      b: osc({ level: 0.5, semitones: -12, unison: 5, detune: 14, width: 0.9 })
    }
  },
  {
    ...base,
    id: "wt-reese",
    name: "WT Reese Growl",
    gain: 0.4,
    filterFreq: 900,
    filterQ: 5,
    sustainLevel: 0.9,
    sub: { gain: 0.45, type: "sine" },
    wt: {
      a: osc({ table: "bend", pos: 0.3, unison: 3, detune: 16, width: 0.6 }),
      b: osc({ table: "bend", pos: 0.45, level: 0.85, fine: 9, unison: 3, detune: 12, width: 0.6 })
    },
    mod: mod(
      [
        { source: "lfo1", dest: "posA", amount: 0.35 },
        { source: "lfo2", dest: "cutoff", amount: 0.3 }
      ],
      { lfo1: { shape: "sine", rate: 0.35 }, lfo2: { shape: "triangle", rate: 3 } }
    )
  },
  {
    ...base,
    id: "wt-wobble",
    name: "WT Wobble Bass",
    gain: 0.28,
    filterFreq: 420,
    filterQ: 9,
    sub: { gain: 0.5, type: "sine" },
    wt: {
      a: osc({ table: "sawsweep", pos: 0.5, unison: 3, detune: 10 }),
      b: osc({ table: "pwm", pos: 0.1, level: 0.5, semitones: -12 })
    },
    mod: mod(
      [
        { source: "lfo1", dest: "cutoff", amount: 0.7 },
        { source: "env2", dest: "posA", amount: 0.3 }
      ],
      { lfo1: { shape: "sine", rate: 2.5 }, env2: { attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.2 } }
    )
  },
  {
    ...base,
    id: "wt-vowel-lead",
    name: "WT Vowel Lead",
    gain: 0.38,
    filterFreq: 10000,
    vibrato: { rate: 5.2, depth: 9, delay: 0.3 },
    wt: {
      a: osc({ table: "vowel", pos: 0.1, unison: 3, detune: 8 }),
      b: off({ table: "vowel", pos: 0.6 })
    },
    mod: mod([{ source: "lfo1", dest: "posA", amount: 0.55 }], { lfo1: { shape: "sine", rate: 0.6 } })
  },
  {
    ...base,
    id: "wt-fm-pluck",
    name: "WT FM Pluck",
    gain: 0.42,
    attackTime: 0.002,
    decayTime: 0.35,
    sustainLevel: 0.0001,
    releaseTime: 0.2,
    wt: { a: osc({ table: "fm", pos: 0.15 }), b: off() },
    mod: mod(
      [
        { source: "env2", dest: "posA", amount: 0.6 },
        { source: "env2", dest: "cutoff", amount: 0.4 }
      ],
      { env2: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.2 } }
    )
  },
  {
    ...base,
    id: "wt-glass-pad",
    name: "WT Glass Pad",
    gain: 0.34,
    filterFreq: 7000,
    attackTime: 1.2,
    decayTime: 1,
    sustainLevel: 0.9,
    releaseTime: 2.2,
    wt: {
      a: osc({ table: "sawsweep", pos: 0.3, unison: 5, detune: 16, width: 1 }),
      b: osc({ table: "spectral", pos: 0.4, level: 0.4, semitones: 12, unison: 3, detune: 10, width: 1 })
    },
    mod: mod(
      [
        { source: "lfo2", dest: "posA", amount: 0.3 },
        { source: "lfo1", dest: "posB", amount: 0.5 }
      ],
      { lfo1: { shape: "sine", rate: 0.17 }, lfo2: { shape: "triangle", rate: 0.23 } }
    )
  },
  {
    ...base,
    id: "wt-pwm-strings",
    name: "WT PWM Strings",
    gain: 0.34,
    filterFreq: 6000,
    attackTime: 0.45,
    sustainLevel: 0.9,
    releaseTime: 0.9,
    vibrato: { rate: 5, depth: 6, delay: 0.5 },
    wt: { a: osc({ table: "pwm", pos: 0.3, unison: 5, detune: 11, width: 1 }), b: off() },
    mod: mod([{ source: "lfo1", dest: "posA", amount: 0.35 }], { lfo1: { shape: "sine", rate: 0.7 } })
  },
  {
    ...base,
    id: "wt-sync-lead",
    name: "WT Sync Lead",
    gain: 0.38,
    filterFreq: 10000,
    vibrato: { rate: 5.4, depth: 8, delay: 0.25 },
    wt: { a: osc({ table: "sync", pos: 0.25, unison: 3, detune: 7 }), b: off() },
    mod: mod([{ source: "env2", dest: "posA", amount: 0.5 }], {
      env2: { attack: 0.01, decay: 0.7, sustain: 0.35, release: 0.3 }
    })
  },
  {
    ...base,
    id: "wt-digital-bell",
    name: "WT Digital Bell",
    gain: 0.4,
    attackTime: 0.002,
    decayTime: 1.8,
    sustainLevel: 0.0001,
    releaseTime: 1.6,
    wt: { a: osc({ table: "fm2", pos: 0.15 }), b: off({ table: "fm", pos: 0.5, semitones: 12 }) },
    mod: mod(
      [
        { source: "env2", dest: "posA", amount: 0.6 },
        { source: "env2", dest: "levelB", amount: 0.3 }
      ],
      { env2: { attack: 0.001, decay: 1.4, sustain: 0, release: 1 } }
    )
  },
  {
    ...base,
    id: "wt-organ-morph",
    name: "WT Organ Morph",
    gain: 0.38,
    filterFreq: 9000,
    attackTime: 0.01,
    releaseTime: 0.12,
    tremolo: { rate: 5.8, depth: 0.14 },
    wt: { a: osc({ table: "organ", pos: 0.4 }), b: off({ table: "organ", pos: 1, semitones: 12 }) },
    mod: mod([{ source: "lfo2", dest: "posA", amount: 0.35 }], { lfo2: { shape: "triangle", rate: 0.3 } })
  },
  {
    ...base,
    id: "wt-analog-brass",
    name: "WT Analog Brass",
    gain: 0.38,
    filterFreq: 1400,
    filterQ: 1.4,
    attackTime: 0.06,
    sustainLevel: 0.85,
    releaseTime: 0.25,
    wt: { a: osc({ table: "sawsweep", pos: 0.6, unison: 3, detune: 9 }), b: off() },
    mod: mod([{ source: "env2", dest: "cutoff", amount: 0.55 }], {
      env2: { attack: 0.09, decay: 0.45, sustain: 0.5, release: 0.25 }
    })
  },
  {
    ...base,
    id: "wt-bright-pluck",
    name: "WT Bright Pluck",
    gain: 0.4,
    attackTime: 0.002,
    decayTime: 0.4,
    sustainLevel: 0.0001,
    releaseTime: 0.25,
    wt: { a: osc({ table: "sawsweep", pos: 0.15, unison: 3, detune: 8 }), b: off() },
    mod: mod([{ source: "env2", dest: "posA", amount: 0.75 }], {
      env2: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.2 }
    })
  }
];
