import { wavetablePresets } from "./wavetablePresets";
import type { SynthMod, WavetableOsc } from "../audio/modulation";
import {
  SCHEMA_VERSION,
  type Channel,
  type ChannelType,
  type EffectType,
  type NoteData,
  type Pattern,
  type PlaylistClip,
  type PlaylistMarker,
  type PlaylistTrack,
  type ProjectData,
  type StepCell
} from "../types";

import {
  DEFAULT_TRACK_HEIGHT,
  STEPS_PER_BAR,
  channelColors,
  makeSteps,
  trackColorAt,
  uid
} from "../lib/utils";
import { createDefaultMixer } from "../state/initialState";

/* ──────────────────────────────── synths ──────────────────────────────── */

export interface SynthPresetDef {
  id: string;
  name: string;
  oscType: OscillatorType;
  /** Second detuned oscillator for width; 0 disables it. */
  detuneSpread: number;
  filterType: BiquadFilterType;
  filterFreq: number;
  filterEnvAmount: number;
  filterQ: number;
  attackTime: number;
  decayTime: number;
  sustainLevel: number;
  releaseTime: number;
  gain: number;

  /**
   * Extra oscillators at harmonic ratios of the fundamental. A single
   * oscillator can only sound like a synth; the overtone structure is what
   * makes a piano read as a piano and an organ as an organ.
   */
  partials?: Array<{ ratio: number; gain: number; type?: OscillatorType }>;

  /** Short filtered noise burst at note-on: hammer, pick or breath. */
  attackNoise?: { gain: number; decay: number; cutoff: number };

  /** Delayed pitch vibrato, in cents, for held strings and winds. */
  vibrato?: { rate: number; depth: number; delay: number };

  /** Unison voice count (odd, 3 or more) when `detuneSpread` is on. */
  unison?: number;
  /** How far the unison voices are spread across the stereo field, 0..1. */
  stereoSpread?: number;
  /** Oscillator one octave below the note. */
  sub?: { gain: number; type?: OscillatorType };
  /**
   * FM: a sine modulator at `ratio` × the note, deviating the carrier by
   * `index` × the note's frequency, decaying to `sustain` × that over `decay`.
   */
  fm?: { ratio: number; index: number; decay: number; sustain?: number };
  /** Start `semitones` off pitch and settle onto the note over about `time` seconds. */
  pitchEnv?: { semitones: number; time: number };
  /** Filter sweep LFO; `depth` is in cents. */
  filterLfo?: { rate: number; depth: number };
  /** Amplitude LFO; `depth` 0..1. */
  tremolo?: { rate: number; depth: number };

  /** A second oscillator with its own waveform: `semitones` from the note, `detune` in cents, `gain` 0..1. */
  osc2?: { type: OscillatorType; semitones: number; detune: number; gain: number };
  /** A constant hiss under the note, 0..1: breath, air, a noisier pad. */
  noise?: number;
  /** How closely the filter follows the note's pitch, 0..1, so high notes aren't duller than low ones. */
  filterKeytrack?: number;
  /** How long the filter takes to close after the note starts, when it should differ from `decayTime`. */
  filterDecay?: number;

  /**
   * Wavetable oscillators A and B. When set they replace `oscType`'s oscillator
   * and `osc2`; everything after them (sub, filter, envelope, effects) is shared.
   */
  wt?: { a: WavetableOsc; b: WavetableOsc };
  /** A second envelope, two LFOs, and where they are routed. */
  mod?: SynthMod;
}

const classicSynthPresets: SynthPresetDef[] = [
  {
    id: "grand-piano",
    name: "Grand Piano",
    oscType: "triangle",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 4200,
    filterEnvAmount: 0.55,
    filterQ: 0.7,
    attackTime: 0.002,
    decayTime: 1.7,
    sustainLevel: 0.1,
    releaseTime: 0.34,
    gain: 0.5,
    // A real string is slightly inharmonic — the stretched fourth partial is
    // most of why a piano sounds like one rather than like a bell.
    partials: [
      { ratio: 2, gain: 0.34, type: "sine" },
      { ratio: 3, gain: 0.15, type: "sine" },
      { ratio: 4.08, gain: 0.07, type: "sine" },
      { ratio: 5.2, gain: 0.03, type: "sine" }
    ],
    attackNoise: { gain: 0.32, decay: 0.03, cutoff: 3600 }
  },
  {
    id: "electric-piano",
    name: "Electric Piano",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 3000,
    filterEnvAmount: 0.5,
    filterQ: 0.6,
    attackTime: 0.003,
    decayTime: 1.2,
    sustainLevel: 0.2,
    releaseTime: 0.4,
    gain: 0.5,
    // The 6th partial is the tine ring that gives a Rhodes its bite.
    partials: [
      { ratio: 2, gain: 0.46, type: "sine" },
      { ratio: 6, gain: 0.11, type: "sine" }
    ],
    attackNoise: { gain: 0.16, decay: 0.02, cutoff: 5200 }
  },
  {
    id: "drawbar-organ",
    name: "Drawbar Organ",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 7200,
    filterEnvAmount: 0,
    filterQ: 0.7,
    attackTime: 0.008,
    decayTime: 0.02,
    sustainLevel: 1,
    releaseTime: 0.1,
    gain: 0.32,
    // Drawbars: a stack of sines at fixed ratios, flat while the key is held.
    partials: [
      { ratio: 2, gain: 0.7, type: "sine" },
      { ratio: 3, gain: 0.45, type: "sine" },
      { ratio: 4, gain: 0.3, type: "sine" },
      { ratio: 6, gain: 0.17, type: "sine" },
      { ratio: 8, gain: 0.11, type: "sine" }
    ]
  },
  {
    id: "string-ensemble",
    name: "String Ensemble",
    oscType: "sawtooth",
    detuneSpread: 9,
    filterType: "lowpass",
    filterFreq: 2600,
    filterEnvAmount: 0.35,
    filterQ: 0.8,
    attackTime: 0.28,
    decayTime: 0.4,
    sustainLevel: 0.85,
    releaseTime: 0.5,
    gain: 0.32,
    vibrato: { rate: 5.2, depth: 7, delay: 0.35 }
  },
  {
    id: "brass-section",
    name: "Brass Section",
    oscType: "sawtooth",
    detuneSpread: 5,
    filterType: "lowpass",
    filterFreq: 1500,
    filterEnvAmount: 1.5,
    filterQ: 1.2,
    attackTime: 0.07,
    decayTime: 0.26,
    sustainLevel: 0.7,
    releaseTime: 0.22,
    gain: 0.34
  },
  {
    id: "nylon-guitar",
    name: "Nylon Guitar",
    oscType: "triangle",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 3200,
    filterEnvAmount: 0.8,
    filterQ: 0.8,
    attackTime: 0.004,
    decayTime: 0.95,
    sustainLevel: 0.05,
    releaseTime: 0.3,
    gain: 0.48,
    partials: [
      { ratio: 2, gain: 0.28, type: "sine" },
      { ratio: 3, gain: 0.11, type: "sine" }
    ],
    attackNoise: { gain: 0.3, decay: 0.02, cutoff: 2600 }
  },
  {
    id: "marimba",
    name: "Marimba",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 5000,
    filterEnvAmount: 0.3,
    filterQ: 0.7,
    attackTime: 0.001,
    decayTime: 0.45,
    sustainLevel: 0.02,
    releaseTime: 0.2,
    gain: 0.5,
    // A tuned bar rings at roughly the 4th and 10th mode, not the harmonics.
    partials: [
      { ratio: 3.95, gain: 0.33, type: "sine" },
      { ratio: 9.2, gain: 0.09, type: "sine" }
    ],
    attackNoise: { gain: 0.2, decay: 0.012, cutoff: 6000 }
  },
  {
    id: "music-box",
    name: "Music Box",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 6500,
    filterEnvAmount: 0.2,
    filterQ: 0.7,
    attackTime: 0.001,
    decayTime: 1.1,
    sustainLevel: 0.02,
    releaseTime: 0.5,
    gain: 0.42,
    partials: [
      { ratio: 3.01, gain: 0.26, type: "sine" },
      { ratio: 5.4, gain: 0.11, type: "sine" }
    ],
    attackNoise: { gain: 0.14, decay: 0.01, cutoff: 7000 }
  },
  {
    id: "flute",
    name: "Flute",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 3800,
    filterEnvAmount: 0.2,
    filterQ: 0.7,
    attackTime: 0.09,
    decayTime: 0.2,
    sustainLevel: 0.9,
    releaseTime: 0.18,
    gain: 0.34,
    partials: [
      { ratio: 2, gain: 0.11, type: "sine" },
      { ratio: 3, gain: 0.04, type: "sine" }
    ],
    // Breath noise, longer and softer than a hammer.
    attackNoise: { gain: 0.17, decay: 0.09, cutoff: 2200 },
    vibrato: { rate: 5.6, depth: 9, delay: 0.25 }
  },
  {
    id: "choir-aah",
    name: "Choir Aah",
    oscType: "sawtooth",
    detuneSpread: 12,
    // A bandpass around 950 Hz stands in for the "aah" formant.
    filterType: "bandpass",
    filterFreq: 950,
    filterEnvAmount: 0.6,
    filterQ: 2.2,
    attackTime: 0.18,
    decayTime: 0.4,
    sustainLevel: 0.85,
    releaseTime: 0.45,
    gain: 0.62,
    partials: [{ ratio: 2, gain: 0.2, type: "sine" }],
    vibrato: { rate: 4.8, depth: 8, delay: 0.4 }
  },

  {
    id: "808-sub",
    name: "808 Sub Bass",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 450,
    filterEnvAmount: 0.4,
    filterQ: 1,
    attackTime: 0.005,
    decayTime: 0.5,
    sustainLevel: 0.7,
    releaseTime: 0.35,
    gain: 0.7
  },
  {
    id: "cyber-saw",
    name: "Cyber Saw Lead",
    oscType: "sawtooth",
    detuneSpread: 14,
    filterType: "lowpass",
    filterFreq: 3200,
    filterEnvAmount: 0.8,
    filterQ: 8,
    attackTime: 0.004,
    decayTime: 0.22,
    sustainLevel: 0.55,
    releaseTime: 0.1,
    gain: 0.38
  },
  {
    id: "hyper-pluck",
    name: "Hyper Pluck",
    oscType: "triangle",
    detuneSpread: 6,
    filterType: "lowpass",
    filterFreq: 4800,
    filterEnvAmount: 0.9,
    filterQ: 4,
    attackTime: 0.001,
    decayTime: 0.09,
    sustainLevel: 0.15,
    releaseTime: 0.06,
    gain: 0.42
  },
  {
    id: "warm-pad",
    name: "Warm Poly Pad",
    oscType: "sawtooth",
    detuneSpread: 20,
    filterType: "lowpass",
    filterFreq: 1800,
    filterEnvAmount: 0.35,
    filterQ: 2,
    attackTime: 0.12,
    decayTime: 0.8,
    sustainLevel: 0.75,
    releaseTime: 0.9,
    gain: 0.28
  },
  {
    id: "chiptune-sq",
    name: "Chiptune Square",
    oscType: "square",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 6000,
    filterEnvAmount: 0.2,
    filterQ: 1,
    attackTime: 0.002,
    decayTime: 0.12,
    sustainLevel: 0.6,
    releaseTime: 0.05,
    gain: 0.32
  },
  {
    id: "reese-bass",
    name: "Reese Bass",
    oscType: "sawtooth",
    detuneSpread: 26,
    filterType: "lowpass",
    filterFreq: 900,
    filterEnvAmount: 0.5,
    filterQ: 6,
    attackTime: 0.01,
    decayTime: 0.4,
    sustainLevel: 0.8,
    releaseTime: 0.2,
    gain: 0.45,
    // Bass stays near the centre; a wide low end falls apart in mono.
    stereoSpread: 0.15
  },
  {
    id: "glass-bell",
    name: "Glass Bell",
    oscType: "sine",
    detuneSpread: 0,
    // Was a bandpass fixed at 2600 Hz, which removed almost the entire note
    // anywhere below the top octave — a pure sine has no energy up there.
    filterType: "lowpass",
    filterFreq: 7000,
    filterEnvAmount: 0.3,
    filterQ: 0.7,
    attackTime: 0.002,
    decayTime: 1.4,
    sustainLevel: 0.03,
    releaseTime: 0.8,
    gain: 0.44,
    // Bells ring at inharmonic modes; that clash is the whole character.
    partials: [
      { ratio: 2.76, gain: 0.4, type: "sine" },
      { ratio: 5.4, gain: 0.19, type: "sine" },
      { ratio: 8.9, gain: 0.09, type: "sine" }
    ],
    attackNoise: { gain: 0.12, decay: 0.01, cutoff: 8000 }
  },

  /* ── keys ── */
  {
    id: "fm-epiano",
    name: "FM E-Piano",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 7000,
    filterEnvAmount: 0.1,
    filterQ: 0.7,
    attackTime: 0.002,
    decayTime: 2,
    sustainLevel: 0.12,
    releaseTime: 0.5,
    gain: 0.46,
    // The classic tine: a 1:1 modulator whose bite fades within the note.
    fm: { ratio: 1, index: 2.6, decay: 0.9, sustain: 0.12 },
    partials: [{ ratio: 14, gain: 0.02, type: "sine" }],
    tremolo: { rate: 4.2, depth: 0.12 }
  },
  {
    id: "harpsichord",
    name: "Harpsichord",
    oscType: "sawtooth",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 3600,
    filterEnvAmount: 0.7,
    filterQ: 1,
    attackTime: 0.001,
    decayTime: 1.3,
    sustainLevel: 0.04,
    releaseTime: 0.25,
    gain: 0.3,
    // A second set of strings an octave up, like the 4-foot register.
    partials: [{ ratio: 2, gain: 0.3, type: "sawtooth" }],
    attackNoise: { gain: 0.25, decay: 0.01, cutoff: 6000 }
  },
  {
    id: "clavinet",
    name: "Clavinet",
    oscType: "sawtooth",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 1800,
    filterEnvAmount: 1.4,
    filterQ: 3,
    attackTime: 0.001,
    decayTime: 0.6,
    sustainLevel: 0.25,
    releaseTime: 0.07,
    gain: 0.34,
    attackNoise: { gain: 0.15, decay: 0.008, cutoff: 5000 }
  },
  {
    id: "pipe-organ",
    name: "Pipe Organ",
    oscType: "sawtooth",
    detuneSpread: 4,
    stereoSpread: 0.6,
    filterType: "lowpass",
    filterFreq: 2600,
    filterEnvAmount: 0,
    filterQ: 0.7,
    attackTime: 0.06,
    decayTime: 0.1,
    sustainLevel: 1,
    releaseTime: 0.35,
    gain: 0.3,
    partials: [
      { ratio: 2, gain: 0.4, type: "sine" },
      { ratio: 4, gain: 0.2, type: "sine" }
    ],
    sub: { gain: 0.3 }
  },
  {
    id: "accordion",
    name: "Accordion",
    oscType: "sawtooth",
    detuneSpread: 9,
    stereoSpread: 0.3,
    filterType: "lowpass",
    filterFreq: 2200,
    filterEnvAmount: 0.2,
    filterQ: 1,
    attackTime: 0.04,
    decayTime: 0.2,
    sustainLevel: 0.9,
    releaseTime: 0.12,
    gain: 0.34,
    tremolo: { rate: 5.5, depth: 0.1 }
  },

  /* ── strings ── */
  {
    id: "solo-violin",
    name: "Solo Violin",
    oscType: "sawtooth",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 3000,
    filterEnvAmount: 0.3,
    filterQ: 1.6,
    attackTime: 0.09,
    decayTime: 0.3,
    sustainLevel: 0.9,
    releaseTime: 0.25,
    gain: 0.32,
    vibrato: { rate: 5.8, depth: 14, delay: 0.22 },
    // Bow noise at the start of each stroke.
    attackNoise: { gain: 0.07, decay: 0.07, cutoff: 4000 }
  },
  {
    id: "cello",
    name: "Cello",
    oscType: "sawtooth",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 1500,
    filterEnvAmount: 0.3,
    filterQ: 1.4,
    attackTime: 0.12,
    decayTime: 0.4,
    sustainLevel: 0.9,
    releaseTime: 0.35,
    gain: 0.38,
    vibrato: { rate: 5, depth: 12, delay: 0.3 },
    attackNoise: { gain: 0.06, decay: 0.08, cutoff: 2500 }
  },
  {
    id: "pizzicato",
    name: "Pizzicato Strings",
    oscType: "triangle",
    detuneSpread: 5,
    stereoSpread: 0.5,
    filterType: "lowpass",
    filterFreq: 2600,
    filterEnvAmount: 0.9,
    filterQ: 0.8,
    attackTime: 0.002,
    decayTime: 0.35,
    sustainLevel: 0.01,
    releaseTime: 0.12,
    gain: 0.5,
    partials: [
      { ratio: 2, gain: 0.3, type: "sine" },
      { ratio: 3, gain: 0.1, type: "sine" }
    ],
    attackNoise: { gain: 0.15, decay: 0.01, cutoff: 3500 }
  },
  {
    id: "harp",
    name: "Harp",
    oscType: "triangle",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 3600,
    filterEnvAmount: 0.4,
    filterQ: 0.7,
    attackTime: 0.002,
    decayTime: 1.8,
    sustainLevel: 0.02,
    releaseTime: 0.9,
    gain: 0.48,
    partials: [
      { ratio: 2, gain: 0.22, type: "sine" },
      { ratio: 3, gain: 0.08, type: "sine" }
    ],
    attackNoise: { gain: 0.12, decay: 0.008, cutoff: 5000 }
  },
  {
    id: "steel-guitar",
    name: "Steel Guitar",
    oscType: "triangle",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 4200,
    filterEnvAmount: 1,
    filterQ: 0.9,
    attackTime: 0.002,
    decayTime: 1.3,
    sustainLevel: 0.03,
    releaseTime: 0.35,
    gain: 0.42,
    partials: [
      { ratio: 2, gain: 0.4, type: "sine" },
      { ratio: 3, gain: 0.25, type: "sine" },
      { ratio: 4, gain: 0.12, type: "sine" },
      { ratio: 5, gain: 0.06, type: "sine" }
    ],
    attackNoise: { gain: 0.35, decay: 0.015, cutoff: 6000 }
  },

  /* ── winds ── */
  {
    id: "trumpet",
    name: "Trumpet",
    oscType: "sawtooth",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 1700,
    filterEnvAmount: 1.8,
    filterQ: 1,
    attackTime: 0.03,
    decayTime: 0.2,
    sustainLevel: 0.8,
    releaseTime: 0.12,
    gain: 0.34,
    vibrato: { rate: 5.5, depth: 10, delay: 0.35 },
    pitchEnv: { semitones: -0.7, time: 0.05 }
  },
  {
    id: "saxophone",
    name: "Saxophone",
    oscType: "square",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 2100,
    filterEnvAmount: 0.9,
    filterQ: 2,
    attackTime: 0.04,
    decayTime: 0.3,
    sustainLevel: 0.85,
    releaseTime: 0.15,
    gain: 0.26,
    vibrato: { rate: 5, depth: 12, delay: 0.4 },
    attackNoise: { gain: 0.12, decay: 0.08, cutoff: 3000 },
    pitchEnv: { semitones: -0.5, time: 0.06 }
  },
  {
    id: "clarinet",
    name: "Clarinet",
    // A square wave is odd harmonics only — which is what a clarinet is.
    oscType: "square",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 2500,
    filterEnvAmount: 0.2,
    filterQ: 0.8,
    attackTime: 0.05,
    decayTime: 0.2,
    sustainLevel: 0.9,
    releaseTime: 0.12,
    gain: 0.26,
    vibrato: { rate: 4.8, depth: 5, delay: 0.5 },
    attackNoise: { gain: 0.08, decay: 0.06, cutoff: 2500 }
  },
  {
    id: "pan-flute",
    name: "Pan Flute",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 3000,
    filterEnvAmount: 0.2,
    filterQ: 0.7,
    attackTime: 0.06,
    decayTime: 0.3,
    sustainLevel: 0.85,
    releaseTime: 0.2,
    gain: 0.38,
    partials: [{ ratio: 2, gain: 0.08, type: "sine" }],
    attackNoise: { gain: 0.35, decay: 0.12, cutoff: 1800 },
    vibrato: { rate: 5, depth: 6, delay: 0.3 },
    pitchEnv: { semitones: -0.3, time: 0.08 }
  },

  /* ── mallets and plucks ── */
  {
    id: "vibraphone",
    name: "Vibraphone",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 6000,
    filterEnvAmount: 0.2,
    filterQ: 0.7,
    attackTime: 0.001,
    decayTime: 2.4,
    sustainLevel: 0.05,
    releaseTime: 1,
    gain: 0.46,
    partials: [
      { ratio: 4, gain: 0.22, type: "sine" },
      { ratio: 10, gain: 0.04, type: "sine" }
    ],
    attackNoise: { gain: 0.1, decay: 0.006, cutoff: 6000 },
    // The motor-driven fans that give the instrument its name.
    tremolo: { rate: 5.5, depth: 0.35 }
  },
  {
    id: "celesta",
    name: "Celesta",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 8000,
    filterEnvAmount: 0.2,
    filterQ: 0.7,
    attackTime: 0.001,
    decayTime: 1,
    sustainLevel: 0.02,
    releaseTime: 0.6,
    gain: 0.42,
    partials: [
      { ratio: 4, gain: 0.18, type: "sine" },
      { ratio: 8.1, gain: 0.05, type: "sine" }
    ],
    attackNoise: { gain: 0.1, decay: 0.005, cutoff: 8000 }
  },
  {
    id: "kalimba",
    name: "Kalimba",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 5000,
    filterEnvAmount: 0.3,
    filterQ: 0.7,
    attackTime: 0.001,
    decayTime: 0.9,
    sustainLevel: 0.01,
    releaseTime: 0.4,
    gain: 0.5,
    partials: [{ ratio: 6.1, gain: 0.14, type: "sine" }],
    attackNoise: { gain: 0.22, decay: 0.006, cutoff: 3000 }
  },
  {
    id: "steel-drum",
    name: "Steel Drum",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 5000,
    filterEnvAmount: 0.3,
    filterQ: 0.7,
    attackTime: 0.002,
    decayTime: 0.8,
    sustainLevel: 0.05,
    releaseTime: 0.3,
    gain: 0.42,
    partials: [{ ratio: 3, gain: 0.12, type: "sine" }],
    fm: { ratio: 2, index: 1.5, decay: 0.25, sustain: 0.2 }
  },

  /* ── bass ── */
  {
    id: "808-boom",
    name: "808 Boom",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 700,
    filterEnvAmount: 0.3,
    filterQ: 0.8,
    attackTime: 0.002,
    decayTime: 1.4,
    sustainLevel: 0.45,
    releaseTime: 0.4,
    gain: 0.72,
    // A little second harmonic so it still reads on laptop speakers.
    partials: [{ ratio: 2, gain: 0.14, type: "sine" }],
    pitchEnv: { semitones: 7, time: 0.07 }
  },
  {
    id: "acid-bass",
    name: "Acid Bass",
    oscType: "sawtooth",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 450,
    filterEnvAmount: 3.5,
    filterQ: 14,
    attackTime: 0.002,
    decayTime: 0.18,
    sustainLevel: 0.4,
    releaseTime: 0.06,
    gain: 0.36
  },
  {
    id: "fm-bass",
    name: "FM Bass",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 2400,
    filterEnvAmount: 0.3,
    filterQ: 0.8,
    attackTime: 0.002,
    decayTime: 0.5,
    sustainLevel: 0.6,
    releaseTime: 0.1,
    gain: 0.52,
    fm: { ratio: 1, index: 4, decay: 0.25, sustain: 0.15 }
  },
  {
    id: "wobble-bass",
    name: "Wobble Bass",
    oscType: "sawtooth",
    detuneSpread: 8,
    stereoSpread: 0.2,
    filterType: "lowpass",
    filterFreq: 550,
    filterEnvAmount: 0.3,
    filterQ: 7,
    attackTime: 0.005,
    decayTime: 0.3,
    sustainLevel: 0.9,
    releaseTime: 0.1,
    gain: 0.4,
    sub: { gain: 0.5 },
    filterLfo: { rate: 4, depth: 2400 }
  },
  {
    id: "analog-bass",
    name: "Analog Bass",
    oscType: "sawtooth",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 650,
    filterEnvAmount: 2,
    filterQ: 3,
    attackTime: 0.003,
    decayTime: 0.3,
    sustainLevel: 0.5,
    releaseTime: 0.08,
    gain: 0.4,
    sub: { gain: 0.45, type: "square" }
  },
  {
    id: "upright-bass",
    name: "Upright Bass",
    oscType: "sine",
    detuneSpread: 0,
    filterType: "lowpass",
    filterFreq: 900,
    filterEnvAmount: 1,
    filterQ: 0.8,
    attackTime: 0.006,
    decayTime: 0.7,
    sustainLevel: 0.25,
    releaseTime: 0.15,
    gain: 0.62,
    partials: [
      { ratio: 2, gain: 0.35, type: "sine" },
      { ratio: 3, gain: 0.12, type: "sine" }
    ],
    attackNoise: { gain: 0.25, decay: 0.02, cutoff: 1500 }
  },

  /* ── leads and plucks ── */
  {
    id: "supersaw",
    name: "Supersaw",
    oscType: "sawtooth",
    detuneSpread: 22,
    unison: 7,
    stereoSpread: 0.9,
    filterType: "lowpass",
    filterFreq: 6000,
    filterEnvAmount: 0.3,
    filterQ: 0.8,
    attackTime: 0.005,
    decayTime: 0.4,
    sustainLevel: 0.8,
    releaseTime: 0.25,
    gain: 0.42
  },
  {
    id: "square-lead",
    name: "Square Lead",
    oscType: "square",
    detuneSpread: 6,
    stereoSpread: 0.4,
    filterType: "lowpass",
    filterFreq: 3500,
    filterEnvAmount: 0.6,
    filterQ: 2,
    attackTime: 0.003,
    decayTime: 0.2,
    sustainLevel: 0.7,
    releaseTime: 0.1,
    gain: 0.28,
    vibrato: { rate: 5.5, depth: 10, delay: 0.3 }
  },
  {
    id: "future-pluck",
    name: "Future Pluck",
    oscType: "sawtooth",
    detuneSpread: 12,
    unison: 5,
    stereoSpread: 0.8,
    filterType: "lowpass",
    filterFreq: 2800,
    filterEnvAmount: 1.5,
    filterQ: 2,
    attackTime: 0.002,
    decayTime: 0.25,
    sustainLevel: 0.1,
    releaseTime: 0.2,
    gain: 0.36
  },
  {
    id: "synth-brass",
    name: "Synth Brass",
    oscType: "sawtooth",
    detuneSpread: 10,
    stereoSpread: 0.6,
    filterType: "lowpass",
    filterFreq: 1200,
    filterEnvAmount: 2.2,
    filterQ: 1.5,
    attackTime: 0.015,
    decayTime: 0.25,
    sustainLevel: 0.55,
    releaseTime: 0.12,
    gain: 0.34
  },

  /* ── pads ── */
  {
    id: "bright-pad",
    name: "Bright Pad",
    oscType: "sawtooth",
    detuneSpread: 18,
    unison: 5,
    stereoSpread: 1,
    filterType: "lowpass",
    filterFreq: 4200,
    filterEnvAmount: 0.2,
    filterQ: 1,
    attackTime: 0.5,
    decayTime: 1,
    sustainLevel: 0.8,
    releaseTime: 1.4,
    gain: 0.28,
    vibrato: { rate: 4.5, depth: 4, delay: 0.6 }
  },
  {
    id: "dark-pad",
    name: "Dark Evolving Pad",
    oscType: "sawtooth",
    detuneSpread: 14,
    unison: 5,
    stereoSpread: 0.9,
    filterType: "lowpass",
    filterFreq: 800,
    filterEnvAmount: 0.2,
    filterQ: 3,
    attackTime: 0.8,
    decayTime: 1,
    sustainLevel: 0.9,
    releaseTime: 1.8,
    gain: 0.32,
    filterLfo: { rate: 0.15, depth: 1200 }
  }
];
/**
 * Instrument categories, in the order the pickers show them.
 */
/** Every synth sound: the classic ones first, then the wavetable ones. */
export const synthPresets: SynthPresetDef[] = [...classicSynthPresets, ...wavetablePresets];

export const INSTRUMENT_GROUPS = [
  "Plugins",
  "Recorded instruments",
  "Drums",
  "Keys",
  "Strings",
  "Winds & Voice",
  "Mallets",
  "Bass",
  "Leads & Plucks",
  "Pads",
  "Wavetable sounds",
  "Other"
] as const;

export type InstrumentGroup = (typeof INSTRUMENT_GROUPS)[number];

export interface InstrumentMenuEntry {
  label: string;
  type: ChannelType;
  /** Synth preset to start the channel on; omitted for drums and the sampler. */
  preset?: string;
  group: InstrumentGroup;
  /** A synth with its own editor: adding it opens that editor straight away. */
  plugin?: boolean;
  /** Plays a recorded instrument from the built-in SoundFont instead of the synth. */
  soundfont?: { bank: number; program: number };
  /** Sends its notes out of a MIDI port, to another program, instead of making sound here. */
  midiOut?: boolean;
}

/** A recorded instrument: General MIDI program numbers (0 is the first, the piano), or bank 128 for a drum kit. */
const recorded = (label: string, program: number, bank = 0): InstrumentMenuEntry => ({
  label: `${label} (recorded)`,
  type: "synth",
  group: "Recorded instruments",
  soundfont: { bank, program }
});

const synth = (label: string, preset: string, group: InstrumentGroup): InstrumentMenuEntry => ({
  label,
  type: "synth",
  preset,
  group
});

/**
 * Everything you can add as a channel, mirroring FL's channel-creation menu.
 * Shared by the ADD menu and the channel rack, so the two can never drift.
 */
export const INSTRUMENT_MENU: InstrumentMenuEntry[] = [
  { label: "Wavetable Synth", type: "synth", preset: "wt-init", group: "Plugins", plugin: true },
  // Opens a panel with every instrument in the SoundFont, and lets you add your own SoundFont files.
  { label: "SoundFont Instrument", type: "synth", group: "Plugins", plugin: true, soundfont: { bank: 0, program: 0 } },
  // For instruments that live in another program (the Akai Studio Instrument Collection, a hardware synth).
  { label: "MIDI Out (external instrument)", type: "synth", group: "Plugins", plugin: true, midiOut: true },

  recorded("Grand Piano", 0),
  recorded("Bright Piano", 1),
  recorded("Electric Piano", 4),
  recorded("Harpsichord", 6),
  recorded("Vibraphone", 11),
  recorded("Marimba", 12),
  recorded("Church Organ", 19),
  recorded("Accordion", 21),
  recorded("Nylon Guitar", 24),
  recorded("Steel Guitar", 25),
  recorded("Clean Electric Guitar", 27),
  recorded("Overdriven Guitar", 29),
  recorded("Fingered Bass", 33),
  recorded("Slap Bass", 36),
  recorded("Violin", 40),
  recorded("Cello", 42),
  recorded("String Ensemble", 48),
  recorded("Harp", 46),
  recorded("Choir Aahs", 52),
  recorded("Trumpet", 56),
  recorded("Trombone", 57),
  recorded("French Horn", 60),
  recorded("Brass Section", 61),
  recorded("Alto Sax", 65),
  recorded("Clarinet", 71),
  recorded("Flute", 73),
  recorded("Square Lead", 80),
  recorded("Saw Lead", 81),
  recorded("Warm Pad", 89),
  recorded("Sitar", 104),
  recorded("Steel Drums", 114),
  recorded("Drum Kit", 0, 128),
  recorded("Room Drum Kit", 8, 128),
  recorded("Power Drum Kit", 16, 128),
  recorded("Electronic Drum Kit", 24, 128),

  { label: "Kick", type: "kick", group: "Drums" },
  { label: "Snare", type: "snare", group: "Drums" },
  { label: "Clap", type: "clap", group: "Drums" },
  { label: "Hi-hat", type: "hat", group: "Drums" },
  { label: "Shaker", type: "shaker", group: "Drums" },
  { label: "Rimshot", type: "rim", group: "Drums" },
  { label: "Tom", type: "tom", group: "Drums" },
  { label: "Crash Cymbal", type: "cymbal", group: "Drums" },
  { label: "Cowbell", type: "cowbell", group: "Drums" },

  synth("Grand Piano", "grand-piano", "Keys"),
  synth("Electric Piano", "electric-piano", "Keys"),
  synth("FM E-Piano", "fm-epiano", "Keys"),
  synth("Drawbar Organ", "drawbar-organ", "Keys"),
  synth("Pipe Organ", "pipe-organ", "Keys"),
  synth("Harpsichord", "harpsichord", "Keys"),
  synth("Clavinet", "clavinet", "Keys"),
  synth("Accordion", "accordion", "Keys"),

  synth("String Ensemble", "string-ensemble", "Strings"),
  synth("Solo Violin", "solo-violin", "Strings"),
  synth("Cello", "cello", "Strings"),
  synth("Pizzicato Strings", "pizzicato", "Strings"),
  synth("Harp", "harp", "Strings"),
  synth("Nylon Guitar", "nylon-guitar", "Strings"),
  synth("Steel Guitar", "steel-guitar", "Strings"),

  synth("Brass Section", "brass-section", "Winds & Voice"),
  synth("Trumpet", "trumpet", "Winds & Voice"),
  synth("Saxophone", "saxophone", "Winds & Voice"),
  synth("Clarinet", "clarinet", "Winds & Voice"),
  synth("Flute", "flute", "Winds & Voice"),
  synth("Pan Flute", "pan-flute", "Winds & Voice"),
  synth("Choir Aah", "choir-aah", "Winds & Voice"),

  synth("Marimba", "marimba", "Mallets"),
  synth("Vibraphone", "vibraphone", "Mallets"),
  synth("Celesta", "celesta", "Mallets"),
  synth("Music Box", "music-box", "Mallets"),
  synth("Glass Bell", "glass-bell", "Mallets"),
  synth("Kalimba", "kalimba", "Mallets"),
  synth("Steel Drum", "steel-drum", "Mallets"),

  synth("808 Sub Bass", "808-sub", "Bass"),
  synth("808 Boom", "808-boom", "Bass"),
  synth("Reese Bass", "reese-bass", "Bass"),
  synth("Acid Bass", "acid-bass", "Bass"),
  synth("FM Bass", "fm-bass", "Bass"),
  synth("Wobble Bass", "wobble-bass", "Bass"),
  synth("Analog Bass", "analog-bass", "Bass"),
  synth("Upright Bass", "upright-bass", "Bass"),

  synth("Supersaw", "supersaw", "Leads & Plucks"),
  synth("Cyber Saw Lead", "cyber-saw", "Leads & Plucks"),
  synth("Square Lead", "square-lead", "Leads & Plucks"),
  synth("Chiptune Square", "chiptune-sq", "Leads & Plucks"),
  synth("Synth Brass", "synth-brass", "Leads & Plucks"),
  synth("Hyper Pluck", "hyper-pluck", "Leads & Plucks"),
  synth("Future Pluck", "future-pluck", "Leads & Plucks"),

  synth("Warm Pad", "warm-pad", "Pads"),
  synth("Bright Pad", "bright-pad", "Pads"),
  synth("Dark Evolving Pad", "dark-pad", "Pads"),

  synth("WT Init", "wt-init", "Wavetable sounds"),
  synth("WT Supersaw", "wt-supersaw", "Wavetable sounds"),
  synth("WT Reese Growl", "wt-reese", "Wavetable sounds"),
  synth("WT Wobble Bass", "wt-wobble", "Wavetable sounds"),
  synth("WT Vowel Lead", "wt-vowel-lead", "Wavetable sounds"),
  synth("WT FM Pluck", "wt-fm-pluck", "Wavetable sounds"),
  synth("WT Glass Pad", "wt-glass-pad", "Wavetable sounds"),
  synth("WT PWM Strings", "wt-pwm-strings", "Wavetable sounds"),
  synth("WT Sync Lead", "wt-sync-lead", "Wavetable sounds"),
  synth("WT Digital Bell", "wt-digital-bell", "Wavetable sounds"),
  synth("WT Organ Morph", "wt-organ-morph", "Wavetable sounds"),
  synth("WT Analog Brass", "wt-analog-brass", "Wavetable sounds"),
  synth("WT Bright Pluck", "wt-bright-pluck", "Wavetable sounds"),

  { label: "Sampler", type: "sample", group: "Other" }
];
/**
 * The instruments to offer. Where the built-in recorded set doesn't exist (the web studio),
 * its entries are left out rather than adding silent channels.
 */
export function availableInstruments(builtinAvailable: boolean | null): InstrumentMenuEntry[] {
  if (builtinAvailable !== false) return INSTRUMENT_MENU;
  return INSTRUMENT_MENU.filter((entry) => entry.group !== "Recorded instruments");
}

const synthPresetsById = new Map(synthPresets.map((preset) => [preset.id, preset]));

export function getSynthPreset(id: string | undefined): SynthPresetDef | undefined {
  return id ? synthPresetsById.get(id) : undefined;
}

export const defaultSynthPreset: SynthPresetDef = synthPresets[1];

/* ──────────────────────────────── effects ──────────────────────────────── */

export interface EffectPresetDef {
  id: string;
  name: string;
  type: EffectType;
  params: Record<string, number>;
}

export const effectPresets: EffectPresetDef[] = [
  {
    id: "tape-echo",
    name: "Tape Echo",
    type: "delay",
    params: { time: 0.375, feedback: 0.42, mix: 0.35, cutoff: 3200 }
  },
  {
    id: "slap-back",
    name: "Slapback",
    type: "delay",
    params: { time: 0.09, feedback: 0.15, mix: 0.22, cutoff: 6000 }
  },
  {
    id: "stadium-reverb",
    name: "Stadium Reverb",
    type: "reverb",
    params: { decay: 4, preDelay: 0.04, mix: 0.5 }
  },
  {
    id: "room-reverb",
    name: "Tight Room",
    type: "reverb",
    params: { decay: 0.8, preDelay: 0.005, mix: 0.22 }
  },
  {
    id: "warm-punch-eq",
    name: "Warm Punch EQ",
    type: "eq",
    params: { lowGain: 3, midGain: -1, midFreq: 800, highGain: 2 }
  },
  {
    id: "vocal-air",
    name: "Vocal Air",
    type: "eq",
    params: { lowGain: -3, midGain: 2, midFreq: 3200, highGain: 5 }
  },
  {
    id: "drum-bus",
    name: "Snappy Drum Bus",
    type: "compressor",
    params: { threshold: -18, ratio: 6, attack: 0.005, release: 0.12, gain: 4 }
  },
  {
    id: "glue",
    name: "Mix Glue",
    type: "compressor",
    params: { threshold: -12, ratio: 2, attack: 0.03, release: 0.3, gain: 1.5 }
  },
  {
    id: "telephone",
    name: "Telephone",
    type: "filter",
    params: { mode: 2, cutoff: 1400, resonance: 6 }
  },
  {
    id: "warm-drive",
    name: "Warm Drive",
    type: "distortion",
    params: { drive: 8, tone: 7000, mix: 0.35 }
  },
  {
    id: "crush",
    name: "Hard Crush",
    type: "distortion",
    params: { drive: 45, tone: 4200, mix: 0.7 }
  },
  {
    id: "plate-reverb",
    name: "Bright Plate",
    type: "reverb",
    params: { decay: 2.2, preDelay: 0.02, mix: 0.3 }
  },
  {
    id: "dub-delay",
    name: "Dub Delay",
    type: "delay",
    params: { time: 0.5, feedback: 0.62, mix: 0.4, cutoff: 1800 }
  },
  {
    id: "clean-lowcut",
    name: "Clean Low Cut",
    type: "eq",
    params: { lowCut: 120, lowGain: 0, midGain: 0, midFreq: 1200, midQ: 1.2, highGain: 0, highCut: 20000 }
  },
  {
    id: "lush-chorus",
    name: "Lush Chorus",
    type: "chorus",
    params: { rate: 0.6, depth: 0.7, delay: 0.02, mix: 0.5 }
  },
  {
    id: "jet-flanger",
    name: "Jet Flanger",
    type: "flanger",
    params: { rate: 0.15, depth: 0.9, feedback: 0.75, mix: 0.5 }
  },
  {
    id: "slow-phaser",
    name: "Slow Phaser",
    type: "phaser",
    params: { rate: 0.2, depth: 0.8, frequency: 700, resonance: 1.5, mix: 0.6 }
  },
  {
    id: "vintage-tremolo",
    name: "Vintage Tremolo",
    type: "tremolo",
    params: { rate: 6, depth: 0.6, shape: 0 }
  },
  {
    id: "stutter-gate",
    name: "Stutter Gate",
    type: "tremolo",
    params: { rate: 8, depth: 1, shape: 2 }
  },
  {
    id: "wide-pan",
    name: "Wide Auto-Pan",
    type: "autopan",
    params: { rate: 0.25, depth: 0.9 }
  },
  {
    id: "super-wide",
    name: "Super Wide",
    type: "stereo",
    params: { width: 1.8, gain: 0 }
  },
  {
    id: "mono-bass",
    name: "Mono Maker",
    type: "stereo",
    params: { width: 0, gain: 0 }
  },
  {
    id: "8-bit",
    name: "8-bit Crush",
    type: "bitcrush",
    params: { bits: 8, drive: 3, mix: 0.8 }
  },
  {
    id: "master-maximizer",
    name: "Master Maximizer",
    type: "limiter",
    params: { gain: 4, ceiling: -0.3, release: 0.1 }
  }
];

const effectPresetsById = new Map(effectPresets.map((preset) => [preset.id, preset]));

export function getEffectPreset(id: string): EffectPresetDef | undefined {
  return effectPresetsById.get(id);
}

/* ─────────────────────────── demo project helpers ─────────────────────────── */

interface DemoChannelSpec {
  key: string;
  name: string;
  type: Channel["type"];
  volume: number;
  pan?: number;
  color?: string;
  synthPreset?: string;
  sampleId?: string;
}

interface SectionSpec {
  name: string;
  bars: number;
  drums: Record<string, number[]>;
  /** Velocity overrides per channel key. */
  drumVelocity?: Record<string, number>;
  notes: Record<string, NoteData[]>;
}

function buildDemo(options: {
  projectName: string;
  bpm: number;
  swing: number;
  masterVolume: number;
  channels: DemoChannelSpec[];
  sections: SectionSpec[];
  arrangement: string[];
  masterEffects?: Array<{ presetId: string }>;
  trackEffects?: Record<string, string[]>;
}): ProjectData {
  const channels: Channel[] = options.channels.map((spec, index) => ({
    id: uid(),
    name: spec.name,
    type: spec.type,
    color: spec.color ?? channelColors[spec.type],
    mute: false,
    solo: false,
    volume: spec.volume,
    pan: spec.pan ?? 0,
    mixerTrackId: index + 1,
    sampleId: spec.sampleId,
    pitchOffset: 0,
    trimStart: 0,
    trimEnd: 1,
    reverse: false,
    loop: false,
    synthPreset: spec.synthPreset
  }));

  const idByKey = new Map(options.channels.map((spec, index) => [spec.key, channels[index].id]));

  const drumKeys = options.channels.filter((spec) => spec.type !== "synth").map((s) => s.key);
  const melodyKeys = options.channels.filter((spec) => spec.type === "synth").map((s) => s.key);

  const patterns: Record<string, Pattern> = {};
  const patternOrder: string[] = [];

  /** One "Drums" and one "Melody" pattern per section, FL-style. */
  const sectionPatterns = new Map<string, { drums: string; melody: string }>();

  for (const section of options.sections) {
    const length = section.bars * STEPS_PER_BAR;

    const makePattern = (suffix: string, keys: string[]): string => {
      const id = uid();
      const pattern: Pattern = {
        id,
        name: `${section.name} ${suffix}`,
        length,
        channels: {}
      };

      for (const channel of channels) {
        pattern.channels[channel.id] = {
          steps: Array<StepCell>(length).fill(null),
          notes: []
        };
      }

      for (const key of keys) {
        const channelId = idByKey.get(key);
        if (!channelId) continue;

        const steps = section.drums[key];
        if (steps) {
          pattern.channels[channelId].steps = makeSteps(
            length,
            steps,
            section.drumVelocity?.[key] ?? 0.9
          );
        }

        const notes = section.notes[key];
        if (notes) {
          pattern.channels[channelId].notes = notes.map((note) => ({ ...note, id: uid() }));
        }
      }

      patterns[id] = pattern;
      patternOrder.push(id);
      return id;
    };

    sectionPatterns.set(section.name, {
      drums: makePattern("Drums", drumKeys),
      melody: makePattern("Melody", melodyKeys)
    });
  }

  const tracks: PlaylistTrack[] = ["Drums", "Melody", "Extra 1", "Extra 2"].map((name, index) => ({
    id: uid(),
    name,
    mute: false,
    solo: false,
    height: DEFAULT_TRACK_HEIGHT,
    color: trackColorAt(index)
  }));

  const clips: PlaylistClip[] = [];
  // One marker per section, so the demo arrangements are navigable rather than
  // an undifferentiated wall of clips.
  const markers: PlaylistMarker[] = [];
  let cursor = 0;

  for (const sectionName of options.arrangement) {
    const section = options.sections.find((entry) => entry.name === sectionName);
    const ids = sectionPatterns.get(sectionName);
    if (!section || !ids) continue;

    const length = section.bars * STEPS_PER_BAR;

    if (!markers.some((marker) => marker.step === cursor)) {
      markers.push({ id: uid(), name: section.name, step: cursor });
    }

    clips.push({
      id: uid(),
      type: "pattern",
      patternId: ids.drums,
      trackIndex: 0,
      startStep: cursor,
      lengthSteps: length
    });

    clips.push({
      id: uid(),
      type: "pattern",
      patternId: ids.melody,
      trackIndex: 1,
      startStep: cursor,
      lengthSteps: length
    });

    cursor += length;
  }

  const mixer = createDefaultMixer();

  if (options.trackEffects) {
    for (const [key, presetIds] of Object.entries(options.trackEffects)) {
      const channelIndex = options.channels.findIndex((spec) => spec.key === key);
      if (channelIndex < 0) continue;

      const track = mixer.tracks[channelIndex];
      if (!track) continue;

      for (const presetId of presetIds) {
        const preset = getEffectPreset(presetId);
        if (!preset) continue;
        track.effects.push({
          id: uid(),
          type: preset.type,
          name: preset.name,
          enabled: true,
          params: { ...preset.params }
        });
      }
    }
  }

  for (const entry of options.masterEffects ?? []) {
    const preset = getEffectPreset(entry.presetId);
    if (!preset) continue;
    mixer.masterEffects.push({
      id: uid(),
      type: preset.type,
      name: preset.name,
      enabled: true,
      params: { ...preset.params }
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    projectName: options.projectName,
    bpm: options.bpm,
    swing: options.swing,
    masterVolume: options.masterVolume,
    songBars: Math.max(1, Math.ceil(cursor / STEPS_PER_BAR)),
    loopStart: null,
    loopEnd: null,
    channels,
    patterns,
    patternOrder,
    playlist: { tracks, clips, markers },
    mixer
  };
}

const note = (pitch: number, start: number, length: number, velocity = 100): NoteData => ({
  id: uid(),
  pitch,
  start,
  length,
  velocity
});

/* ─────────────────────────────── demo songs ─────────────────────────────── */

export function createSynthwaveDemoProject(): ProjectData {
  return buildDemo({
    projectName: "Neon Drive",
    bpm: 118,
    swing: 0,
    masterVolume: 0.88,
    channels: [
      { key: "kick", name: "909 Kick", type: "kick", volume: 0.92 },
      { key: "clap", name: "Clap", type: "snare", volume: 0.78, pan: 0.05 },
      { key: "hat", name: "Hi-Hat", type: "hat", volume: 0.48, pan: 0.2 },
      { key: "bass", name: "Reese Bass", type: "synth", volume: 0.6, synthPreset: "reese-bass" },
      { key: "lead", name: "Synth Lead", type: "synth", volume: 0.62, pan: -0.1, synthPreset: "cyber-saw" }
    ],
    trackEffects: {
      lead: ["tape-echo", "stadium-reverb"],
      clap: ["room-reverb"]
    },
    masterEffects: [{ presetId: "glue" }],
    sections: [
      {
        name: "Intro",
        bars: 1,
        drums: { kick: [0, 8], hat: [2, 6, 10, 14] },
        drumVelocity: { hat: 0.5 },
        notes: {
          bass: [note(33, 0, 8, 90), note(36, 8, 8, 90)],
          lead: [note(57, 0, 4, 88), note(60, 8, 4, 92)]
        }
      },
      {
        name: "Verse",
        bars: 1,
        drums: { kick: [0, 4, 8, 12], clap: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
        drumVelocity: { hat: 0.55 },
        notes: {
          bass: [note(33, 0, 2, 105), note(33, 2, 2, 90), note(40, 4, 2, 100), note(38, 8, 2, 102), note(36, 12, 4, 98)],
          lead: [note(57, 0, 2, 108), note(60, 2, 2, 104), note(64, 4, 2, 100), note(60, 6, 2, 96), note(57, 8, 2, 106), note(55, 10, 2, 98), note(57, 12, 4, 104)]
        }
      },
      {
        name: "Chorus",
        bars: 1,
        drums: { kick: [0, 4, 8, 12], clap: [4, 12], hat: [0, 2, 3, 4, 6, 8, 10, 11, 12, 14] },
        drumVelocity: { hat: 0.62 },
        notes: {
          bass: [note(33, 0, 2, 112), note(40, 4, 2, 106), note(45, 8, 2, 108), note(40, 12, 4, 104)],
          lead: [note(69, 0, 2, 118), note(72, 2, 2, 112), note(76, 4, 2, 110), note(72, 6, 2, 106), note(69, 8, 2, 116), note(76, 10, 2, 112), note(72, 12, 4, 114)]
        }
      },
      {
        name: "Break",
        bars: 1,
        drums: { kick: [0], hat: [4, 12] },
        drumVelocity: { hat: 0.4 },
        notes: {
          bass: [note(33, 0, 16, 70)],
          lead: [note(64, 0, 8, 78), note(67, 8, 8, 82)]
        }
      }
    ],
    arrangement: ["Intro", "Verse", "Verse", "Chorus", "Chorus", "Break", "Chorus", "Intro"]
  });
}

export function createLoFiDemoProject(): ProjectData {
  return buildDemo({
    projectName: "Midnight Lo-Fi",
    bpm: 84,
    swing: 0.34,
    masterVolume: 0.82,
    channels: [
      { key: "kick", name: "Lo-Fi Kick", type: "kick", volume: 0.85, color: "#e86b6b" },
      { key: "snare", name: "Dusty Snare", type: "snare", volume: 0.66, color: "#d4a556" },
      { key: "hat", name: "Vinyl Hat", type: "hat", volume: 0.34, pan: 0.15, color: "#6bc4e8" },
      { key: "bass", name: "Upright Bass", type: "synth", volume: 0.5, synthPreset: "808-sub" },
      { key: "keys", name: "Rhodes Keys", type: "synth", volume: 0.46, pan: -0.12, color: "#b8e86b", synthPreset: "warm-pad" }
    ],
    trackEffects: {
      keys: ["room-reverb", "warm-punch-eq"],
      snare: ["room-reverb"],
      hat: ["telephone"]
    },
    masterEffects: [{ presetId: "warm-drive" }, { presetId: "glue" }],
    sections: [
      {
        name: "Intro",
        bars: 1,
        drums: { kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14] },
        drumVelocity: { hat: 0.45, snare: 0.6 },
        notes: {
          bass: [note(36, 0, 8, 75), note(43, 8, 8, 68)],
          keys: [note(60, 0, 8, 62), note(64, 0, 8, 58), note(67, 8, 8, 60)]
        }
      },
      {
        name: "Verse",
        bars: 1,
        drums: { kick: [0, 7, 8, 14], snare: [4, 12], hat: [2, 5, 6, 10, 13, 14] },
        drumVelocity: { hat: 0.42, snare: 0.65 },
        notes: {
          bass: [note(36, 0, 4, 85), note(40, 4, 4, 80), note(38, 8, 4, 88), note(36, 12, 4, 78)],
          keys: [note(60, 0, 4, 68), note(63, 0, 4, 62), note(67, 0, 4, 58), note(62, 4, 4, 66), note(65, 4, 4, 60), note(60, 8, 4, 70), note(64, 8, 4, 63), note(59, 12, 4, 64)]
        }
      },
      {
        name: "Hook",
        bars: 1,
        drums: { kick: [0, 3, 7, 8, 11, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
        drumVelocity: { hat: 0.5, snare: 0.72 },
        notes: {
          bass: [note(36, 0, 4, 92), note(41, 4, 4, 86), note(43, 8, 4, 90), note(38, 12, 4, 84)],
          keys: [note(72, 0, 4, 82), note(76, 4, 4, 86), note(71, 8, 4, 80), note(67, 12, 4, 76)]
        }
      },
      {
        name: "Breakdown",
        bars: 1,
        drums: { kick: [0, 8], hat: [4, 12] },
        drumVelocity: { hat: 0.35 },
        notes: {
          keys: [note(60, 0, 8, 55), note(65, 8, 8, 58)]
        }
      }
    ],
    arrangement: ["Intro", "Verse", "Verse", "Hook", "Verse", "Breakdown", "Hook", "Hook", "Intro"]
  });
}

export function createHouseDemoProject(): ProjectData {
  return buildDemo({
    projectName: "Basement House",
    bpm: 126,
    swing: 0.12,
    masterVolume: 0.86,
    channels: [
      { key: "kick", name: "Four-Floor Kick", type: "kick", volume: 0.95 },
      { key: "clap", name: "Clap", type: "snare", volume: 0.7 },
      { key: "hat", name: "Open Hat", type: "hat", volume: 0.42, pan: -0.15 },
      { key: "bass", name: "Sub Bass", type: "synth", volume: 0.58, synthPreset: "808-sub" },
      { key: "stab", name: "Organ Stab", type: "synth", volume: 0.5, pan: 0.12, synthPreset: "hyper-pluck" }
    ],
    trackEffects: {
      stab: ["slap-back", "stadium-reverb"],
      clap: ["room-reverb"]
    },
    masterEffects: [{ presetId: "glue" }],
    sections: [
      {
        name: "Intro",
        bars: 1,
        drums: { kick: [0, 4, 8, 12], hat: [2, 6, 10, 14] },
        drumVelocity: { hat: 0.5 },
        notes: { bass: [note(29, 0, 16, 80)] }
      },
      {
        name: "Groove",
        bars: 1,
        drums: { kick: [0, 4, 8, 12], clap: [4, 12], hat: [2, 6, 10, 14] },
        drumVelocity: { hat: 0.58 },
        notes: {
          bass: [note(29, 0, 3, 100), note(29, 4, 3, 92), note(36, 8, 3, 98), note(34, 12, 3, 94)],
          stab: [note(60, 2, 1, 96), note(63, 2, 1, 92), note(67, 2, 1, 88), note(60, 10, 1, 96), note(63, 10, 1, 92), note(67, 10, 1, 88)]
        }
      },
      {
        name: "Lift",
        bars: 1,
        drums: { kick: [0, 4, 8, 12], clap: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
        drumVelocity: { hat: 0.66 },
        notes: {
          bass: [note(29, 0, 2, 104), note(36, 4, 2, 100), note(41, 8, 2, 102), note(36, 12, 4, 98)],
          stab: [note(72, 0, 2, 100), note(75, 4, 2, 98), note(79, 8, 2, 102), note(75, 12, 4, 96)]
        }
      },
      {
        name: "Filter",
        bars: 1,
        drums: { kick: [0, 8], hat: [4, 12] },
        drumVelocity: { hat: 0.4 },
        notes: { stab: [note(60, 0, 8, 70), note(67, 8, 8, 74)] }
      }
    ],
    arrangement: ["Intro", "Groove", "Groove", "Lift", "Filter", "Groove", "Lift", "Lift"]
  });
}

export const presetProjects: Array<{
  id: string;
  name: string;
  description: string;
  create: () => ProjectData;
}> = [
  {
    id: "synthwave-demo",
    name: "Neon Drive",
    description: "Synthwave · 118 BPM",
    create: createSynthwaveDemoProject
  },
  {
    id: "lofi-demo",
    name: "Midnight Lo-Fi",
    description: "Lo-fi hip hop · 84 BPM",
    create: createLoFiDemoProject
  },
  {
    id: "house-demo",
    name: "Basement House",
    description: "House · 126 BPM",
    create: createHouseDemoProject
  }
];
