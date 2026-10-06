/**
 * The shapes a Serum-style sound is made of: wavetable oscillators and a small
 * modulation system where sources (an envelope, two LFOs, velocity, the key)
 * are routed to destinations (cutoff, wavetable position, pitch, …).
 */

export interface WavetableOsc {
  /** Id from `WAVETABLES`. */
  table: string;
  /** Where in the table, 0..1. */
  pos: number;
  /** 0..1 */
  level: number;
  /** Whole semitones from the note, -36..36. */
  semitones: number;
  /** Cents, -100..100. */
  fine: number;
  /** Voices, odd 1..9. */
  unison: number;
  /** Cents the outer voices are spread by, 0..60. */
  detune: number;
  /** Stereo spread of the voices, 0..1. */
  width: number;
}

export const MOD_SOURCES = ["env2", "lfo1", "lfo2", "velocity", "key"] as const;
export type ModSource = (typeof MOD_SOURCES)[number];

export const MOD_DESTS = ["cutoff", "resonance", "pitch", "posA", "posB", "levelA", "levelB", "volume"] as const;
export type ModDest = (typeof MOD_DESTS)[number];

export const MOD_SOURCE_NAMES: Record<ModSource, string> = {
  env2: "Env 2",
  lfo1: "LFO 1",
  lfo2: "LFO 2",
  velocity: "Velocity",
  key: "Key"
};

export const MOD_DEST_NAMES: Record<ModDest, string> = {
  cutoff: "Cutoff",
  resonance: "Resonance",
  pitch: "Pitch",
  posA: "A position",
  posB: "B position",
  levelA: "A level",
  levelB: "B level",
  volume: "Volume"
};

export interface ModRoute {
  source: ModSource;
  dest: ModDest;
  /** -1..1: how far the source pushes the destination. */
  amount: number;
}

export interface LfoDef {
  shape: OscillatorType;
  /** Hz */
  rate: number;
}

export interface EnvelopeDef {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export interface SynthMod {
  env2: EnvelopeDef;
  lfo1: LfoDef;
  lfo2: LfoDef;
  routes: ModRoute[];
}

export const MAX_ROUTES = 8;

/** What an amount of 1 means for each destination, in that destination's own units. */
export const DEST_SCALE: Record<ModDest, number> = {
  cutoff: 4800, // cents: four octaves
  resonance: 12,
  pitch: 1200, // cents: an octave
  posA: 1,
  posB: 1,
  levelA: 1,
  levelB: 1,
  volume: 1
};

export const DEFAULT_MOD: SynthMod = {
  env2: { attack: 0.01, decay: 0.4, sustain: 0.3, release: 0.3 },
  lfo1: { shape: "sine", rate: 2 },
  lfo2: { shape: "triangle", rate: 0.5 },
  routes: []
};

/** The range each source swings through, before it is scaled by a route's amount. */
export const SOURCE_RANGE: Record<ModSource, [number, number]> = {
  env2: [0, 1],
  lfo1: [-1, 1],
  lfo2: [-1, 1],
  velocity: [0, 1],
  key: [-1, 1]
};

/** The lowest and highest total push the routes to a destination can add together. */
export function routeRange(routes: readonly ModRoute[], dest: ModDest): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const route of routes) {
    if (route.dest !== dest) continue;
    const [low, high] = SOURCE_RANGE[route.source];
    const a = route.amount * low;
    const b = route.amount * high;
    min += Math.min(a, b);
    max += Math.max(a, b);
  }
  return { min, max };
}

/** A short description for a hint/tooltip, e.g. "LFO 1 → Cutoff". */
export function describeRoute(route: ModRoute): string {
  return `${MOD_SOURCE_NAMES[route.source]} → ${MOD_DEST_NAMES[route.dest]}`;
}

/** Total push on a destination, to draw next to its knob. */
export function amountFor(routes: readonly ModRoute[], dest: ModDest): number {
  return routes.filter((route) => route.dest === dest).reduce((sum, route) => sum + route.amount, 0);
}
