import { clamp } from "../lib/utils";
import { DEST_SCALE, routeRange, type ModDest, type SynthMod, type WavetableOsc } from "./modulation";
import { getPeriodicWave } from "./wavetables";

/**
 * The parts of a Serum-style voice: wavetable oscillators that can morph
 * between two positions, and the routing that lets an envelope, LFOs, the
 * velocity or the key move the knobs while a note plays.
 */

/** What stops, and what gets disconnected once the note is over. */
export interface VoiceParts {
  sources: Array<OscillatorNode | AudioBufferSourceNode | ConstantSourceNode>;
  nodes: AudioNode[];
}

export interface WavetableStack {
  oscillators: OscillatorNode[];
  /** The level knob's parameter, for modulation. */
  level: AudioParam;
  /** Gains that follow the modulation, for the upper and the lower table position. */
  morphHigh: AudioParam[];
  morphLow: AudioParam[];
  /** How wide the modulation reaches, in table-position units (0 when the position isn't modulated). */
  range: number;
}

/** Which destinations a patch actually modulates, so the oscillators can be built to suit. */
export function reachOf(mod: SynthMod | undefined, dest: ModDest): { min: number; max: number } {
  return mod ? routeRange(mod.routes, dest) : { min: 0, max: 0 };
}

/**
 * One wavetable oscillator with its unison voices. When its position is
 * modulated, each voice is two oscillators, at the lowest and highest position
 * the modulation can reach, blended by the modulation itself.
 */
export function buildWavetableStack(
  context: BaseAudioContext,
  osc: WavetableOsc,
  frequency: number,
  time: number,
  destination: AudioNode,
  parts: VoiceParts,
  reach: { min: number; max: number }
): WavetableStack {
  const canPan = typeof context.createStereoPanner === "function";

  const stack = context.createGain();
  const level = context.createGain();
  level.gain.value = clamp(osc.level, 0, 1);
  stack.connect(level);
  level.connect(destination);
  parts.nodes.push(stack, level);

  const voices = osc.unison > 1 && osc.detune > 0 ? Math.max(3, Math.round(osc.unison)) | 1 : 1;
  stack.gain.value = voices > 1 ? 0.66 / Math.sqrt(voices) : 1;

  const pitched = frequency * Math.pow(2, osc.semitones / 12);
  const low = clamp(osc.pos + reach.min, 0, 1);
  const high = clamp(osc.pos + reach.max, 0, 1);
  const range = reach.max - reach.min;
  const morphing = range > 1e-4 && Math.abs(high - low) > 1e-4;

  // Where the blend rests with nothing moving: 0 is all lower position, 1 all upper.
  const rest = morphing ? clamp(-reach.min / range, 0, 1) : 0;

  const oscillators: OscillatorNode[] = [];
  const morphHigh: AudioParam[] = [];
  const morphLow: AudioParam[] = [];

  const makeOscillator = (position: number, detune: number): OscillatorNode => {
    const oscillator = context.createOscillator();
    oscillator.setPeriodicWave(getPeriodicWave(context, osc.table, position));
    oscillator.frequency.setValueAtTime(pitched, time);
    oscillator.detune.value = detune;
    oscillators.push(oscillator);
    parts.sources.push(oscillator);
    return oscillator;
  };

  for (let i = 0; i < voices; i++) {
    const place = voices === 1 ? 0 : (i / (voices - 1)) * 2 - 1;
    const detune = osc.fine + place * osc.detune;

    let voiceOutput: AudioNode;
    if (morphing) {
      const bus = context.createGain();
      const lowGain = context.createGain();
      const highGain = context.createGain();
      lowGain.gain.value = 1 - rest;
      highGain.gain.value = rest;

      makeOscillator(low, detune).connect(lowGain);
      makeOscillator(high, detune).connect(highGain);
      lowGain.connect(bus);
      highGain.connect(bus);
      parts.nodes.push(bus, lowGain, highGain);
      morphLow.push(lowGain.gain);
      morphHigh.push(highGain.gain);
      voiceOutput = bus;
    } else {
      voiceOutput = makeOscillator(clamp(osc.pos, 0, 1), detune);
    }

    if (voices > 1 && canPan && osc.width > 0) {
      const panner = context.createStereoPanner();
      panner.pan.value = clamp(place * osc.width, -1, 1);
      voiceOutput.connect(panner);
      panner.connect(stack);
      parts.nodes.push(panner);
    } else {
      voiceOutput.connect(stack);
    }
  }

  return { oscillators, level: level.gain, morphHigh, morphLow, range: morphing ? range : 0 };
}

/* ─────────────────────────────── modulation ─────────────────────────────── */

export interface ModTargets {
  filterDetune: AudioParam;
  filterQ: AudioParam;
  oscillatorDetunes: AudioParam[];
  stackA: WavetableStack | null;
  stackB: WavetableStack | null;
  /** The voice's final gain, for the Volume destination. */
  volume: AudioParam | null;
}

export interface Modulation {
  /** Begin the modulation envelope's release at `at`. */
  release(at: number): void;
}

/** Cancel automation from `when`, keeping the value reached by then. */
function holdFrom(param: AudioParam, when: number): void {
  const holder = param as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
  if (typeof holder.cancelAndHoldAtTime === "function") {
    try {
      holder.cancelAndHoldAtTime(when);
      return;
    } catch {
      /* fall through to the portable path */
    }
  }
  param.cancelScheduledValues(when + 1e-5);
}

export function connectModulation(
  context: BaseAudioContext,
  mod: SynthMod,
  time: number,
  velocity: number,
  pitch: number,
  targets: ModTargets,
  parts: VoiceParts
): Modulation {
  const env = mod.env2;
  const sustain = clamp(env.sustain, 0, 1);
  const attackEnd = time + Math.max(0.001, env.attack);
  const decayEnd = attackEnd + Math.max(0.005, env.decay);

  const origins = new Map<string, AudioNode>();
  let envelopeParam: AudioParam | null = null;

  // Only the sources a route actually uses are built.
  for (const source of new Set(mod.routes.map((route) => route.source))) {
    if (source === "lfo1" || source === "lfo2") {
      const def = source === "lfo1" ? mod.lfo1 : mod.lfo2;
      const lfo = context.createOscillator();
      lfo.type = def.shape;
      lfo.frequency.value = clamp(def.rate, 0.05, 20);
      lfo.start(time);
      parts.sources.push(lfo);
      origins.set(source, lfo);
      continue;
    }

    const constant = context.createConstantSource();
    parts.sources.push(constant);
    origins.set(source, constant);

    if (source === "env2") {
      constant.offset.setValueAtTime(0, time);
      constant.offset.linearRampToValueAtTime(1, attackEnd);
      constant.offset.linearRampToValueAtTime(sustain, decayEnd);
      envelopeParam = constant.offset;
    } else if (source === "velocity") {
      constant.offset.value = clamp(velocity, 0, 1);
    } else {
      constant.offset.value = clamp((pitch - 60) / 36, -1, 1);
    }
    constant.start(time);
  }

  const route = (origin: AudioNode, param: AudioParam, scale: number) => {
    const gain = context.createGain();
    gain.gain.value = scale;
    origin.connect(gain);
    gain.connect(param);
    parts.nodes.push(gain);
  };

  /** A position route: pushes the upper oscillators up and the lower ones down by the same amount. */
  const morph = (stack: WavetableStack | null, amount: number, origin: AudioNode) => {
    if (!stack || stack.range <= 1e-4) return;
    const share = amount / stack.range;
    for (const param of stack.morphHigh) route(origin, param, share);
    for (const param of stack.morphLow) route(origin, param, -share);
  };

  for (const entry of mod.routes) {
    const origin = origins.get(entry.source);
    const amount = clamp(entry.amount, -1, 1);
    if (!origin || amount === 0) continue;

    switch (entry.dest) {
      case "cutoff":
        route(origin, targets.filterDetune, amount * DEST_SCALE.cutoff);
        break;
      case "resonance":
        route(origin, targets.filterQ, amount * DEST_SCALE.resonance);
        break;
      case "pitch":
        for (const detune of targets.oscillatorDetunes) route(origin, detune, amount * DEST_SCALE.pitch);
        break;
      case "levelA":
        if (targets.stackA) route(origin, targets.stackA.level, amount);
        break;
      case "levelB":
        if (targets.stackB) route(origin, targets.stackB.level, amount);
        break;
      case "volume":
        if (targets.volume) route(origin, targets.volume, amount);
        break;
      case "posA":
        morph(targets.stackA, amount, origin);
        break;
      case "posB":
        morph(targets.stackB, amount, origin);
        break;
    }
  }

  return {
    release(at: number) {
      if (!envelopeParam) return;

      // Where the envelope is at `at`, from the stages scheduled above.
      let value: number;
      if (at <= attackEnd) value = clamp((at - time) / Math.max(0.001, env.attack), 0, 1);
      else if (at >= decayEnd) value = sustain;
      else value = 1 + (sustain - 1) * ((at - attackEnd) / (decayEnd - attackEnd));

      holdFrom(envelopeParam, at);
      envelopeParam.setValueAtTime(value, at);
      envelopeParam.linearRampToValueAtTime(0, at + Math.max(0.01, env.release));
    }
  };
}
