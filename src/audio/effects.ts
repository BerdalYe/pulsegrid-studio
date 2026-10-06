import type { EffectInstance } from "../types";
import { clamp } from "../lib/utils";
import { defaultEffectParams } from "./effectDefs";

/**
 * An effect is built once and then *updated* in place. Rebuilding the graph
 * on every knob turn is what caused dropouts before, so nothing here tears
 * down nodes just because a parameter changed.
 */
export interface EffectNode {
  input: AudioNode;
  output: AudioNode;
  update(params: Record<string, number>, time: number, smooth: boolean): void;
  dispose(): void;
}

const SMOOTHING = 0.015;

function setParam(param: AudioParam, value: number, time: number, smooth: boolean): void {
  if (!Number.isFinite(value)) return;
  if (smooth) {
    param.setTargetAtTime(value, time, SMOOTHING);
  } else {
    param.value = value;
  }
}

function readParams(
  effect: EffectInstance
): Record<string, number> {
  return { ...defaultEffectParams(effect.type), ...effect.params };
}

/* ─────────────────────────────── reverb ─────────────────────────────── */

/**
 * Synthetic stereo impulse response. Deterministic-ish noise with an
 * exponential envelope plus a few early reflections.
 */
function createImpulseResponse(
  context: BaseAudioContext,
  decay: number,
  preDelay: number
): AudioBuffer {
  const sampleRate = context.sampleRate;
  const decayTime = clamp(decay, 0.1, 8);
  const preDelayTime = clamp(preDelay, 0, 0.2);
  const preDelaySamples = Math.floor(preDelayTime * sampleRate);
  const length = Math.max(
    Math.floor(sampleRate * 0.1),
    Math.floor((preDelayTime + decayTime) * sampleRate)
  );

  const impulse = context.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  // A handful of early reflections give the tail some shape.
  const reflections = [0.011, 0.019, 0.031, 0.047, 0.067];

  for (let i = preDelaySamples; i < length; i++) {
    const t = (i - preDelaySamples) / sampleRate;
    const envelope = Math.exp((-4 * t) / decayTime);

    left[i] = (Math.random() * 2 - 1) * envelope;
    right[i] = (Math.random() * 2 - 1) * envelope;
  }

  for (const offset of reflections) {
    const index = preDelaySamples + Math.floor(offset * sampleRate);
    if (index < length) {
      left[index] += 0.35;
      right[Math.min(length - 1, index + 17)] += 0.32;
    }
  }

  return impulse;
}

/**
 * Impulses are expensive — an 8-second tail is ~700k `Math.random()` calls and
 * a few megabytes of buffer. Quantising to the knob's own step and keeping a
 * small cache means dragging the Decay knob back and forth reuses buffers
 * instead of rebuilding one per pointer event.
 */
const impulseCache = new Map<string, AudioBuffer>();
const MAX_CACHED_IMPULSES = 8;

function getImpulseResponse(
  context: BaseAudioContext,
  decay: number,
  preDelay: number
): AudioBuffer {
  const quantisedDecay = Math.round(decay * 10) / 10;
  const quantisedPreDelay = Math.round(preDelay * 200) / 200;
  const key = `${context.sampleRate}:${quantisedDecay}:${quantisedPreDelay}`;

  const cached = impulseCache.get(key);
  if (cached) return cached;

  const impulse = createImpulseResponse(context, quantisedDecay, quantisedPreDelay);
  impulseCache.set(key, impulse);

  if (impulseCache.size > MAX_CACHED_IMPULSES) {
    const oldest = impulseCache.keys().next().value;
    if (oldest !== undefined) impulseCache.delete(oldest);
  }

  return impulse;
}

function createReverb(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const convolver = context.createConvolver();

  let lastDecay = -1;
  let lastPreDelay = -1;

  input.connect(dry);
  dry.connect(output);
  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      const decay = clamp(next.decay ?? 1.8, 0.1, 8);
      const preDelay = clamp(next.preDelay ?? 0.01, 0, 0.15);
      const mix = clamp(next.mix ?? 0.25, 0, 1);

      // Only swap the impulse when the knob has actually moved a whole step —
      // reassigning `convolver.buffer` resets the tail, so doing it on every
      // pointer event both stutters the reverb and locks up the main thread.
      const steppedDecay = Math.round(decay * 10) / 10;
      const steppedPreDelay = Math.round(preDelay * 200) / 200;

      if (steppedDecay !== lastDecay || steppedPreDelay !== lastPreDelay) {
        convolver.buffer = getImpulseResponse(context, steppedDecay, steppedPreDelay);
        lastDecay = steppedDecay;
        lastPreDelay = steppedPreDelay;
      }

      // Equal-power crossfade keeps perceived level steady across the mix.
      setParam(dry.gain, Math.cos((mix * Math.PI) / 2), time, smooth);
      setParam(wet.gain, Math.sin((mix * Math.PI) / 2), time, smooth);
    },
    dispose() {
      input.disconnect();
      dry.disconnect();
      wet.disconnect();
      convolver.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ─────────────────────────────── delay ─────────────────────────────── */

function createDelay(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const feedback = context.createGain();
  const damping = context.createBiquadFilter();
  const delay = context.createDelay(2.5);

  damping.type = "lowpass";

  input.connect(dry);
  dry.connect(output);

  input.connect(delay);
  delay.connect(damping);
  damping.connect(feedback);
  feedback.connect(delay);
  damping.connect(wet);
  wet.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      const mix = clamp(next.mix ?? 0.3, 0, 1);
      setParam(delay.delayTime, clamp(next.time ?? 0.25, 0.01, 2), time, smooth);
      setParam(feedback.gain, clamp(next.feedback ?? 0.35, 0, 0.95), time, smooth);
      setParam(damping.frequency, clamp(next.cutoff ?? 4000, 300, 18000), time, smooth);
      setParam(dry.gain, Math.cos((mix * Math.PI) / 2), time, smooth);
      setParam(wet.gain, Math.sin((mix * Math.PI) / 2), time, smooth);
    },
    dispose() {
      input.disconnect();
      dry.disconnect();
      wet.disconnect();
      feedback.disconnect();
      damping.disconnect();
      delay.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ──────────────────────────────── eq ──────────────────────────────── */

function createEq(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = context.createGain();
  const output = context.createGain();

  const lowCut = context.createBiquadFilter();
  lowCut.type = "highpass";
  lowCut.Q.value = 0.707;

  const low = context.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 220;

  const mid = context.createBiquadFilter();
  mid.type = "peaking";
  mid.Q.value = 1.2;

  const high = context.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 4500;

  const highCut = context.createBiquadFilter();
  highCut.type = "lowpass";
  highCut.Q.value = 0.707;

  input.connect(lowCut);
  lowCut.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(highCut);
  highCut.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      setParam(low.gain, clamp(next.lowGain ?? 0, -18, 18), time, smooth);
      setParam(mid.gain, clamp(next.midGain ?? 0, -18, 18), time, smooth);
      setParam(mid.frequency, clamp(next.midFreq ?? 1200, 200, 6000), time, smooth);
      setParam(high.gain, clamp(next.highGain ?? 0, -18, 18), time, smooth);
      setParam(mid.Q, clamp(next.midQ ?? 1.2, 0.3, 8), time, smooth);
      setParam(lowCut.frequency, clamp(next.lowCut ?? 20, 20, 1000), time, smooth);
      // Never above Nyquist — a 20 kHz cut at a 32 kHz sample rate would alias.
      setParam(
        highCut.frequency,
        clamp(next.highCut ?? 20000, 2000, Math.min(20000, context.sampleRate / 2 - 100)),
        time,
        smooth
      );
    },
    dispose() {
      input.disconnect();
      lowCut.disconnect();
      highCut.disconnect();
      low.disconnect();
      mid.disconnect();
      high.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ──────────────────────────── compressor ──────────────────────────── */

function createCompressor(
  context: BaseAudioContext,
  params: Record<string, number>
): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const compressor = context.createDynamicsCompressor();

  input.connect(compressor);
  compressor.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      setParam(compressor.threshold, clamp(next.threshold ?? -18, -60, 0), time, smooth);
      setParam(compressor.ratio, clamp(next.ratio ?? 4, 1, 20), time, smooth);
      setParam(compressor.attack, clamp(next.attack ?? 0.01, 0.001, 0.2), time, smooth);
      setParam(compressor.release, clamp(next.release ?? 0.15, 0.01, 1), time, smooth);
      setParam(output.gain, Math.pow(10, clamp(next.gain ?? 2, 0, 18) / 20), time, smooth);
    },
    dispose() {
      input.disconnect();
      compressor.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ────────────────────────────── filter ────────────────────────────── */

const FILTER_MODES: BiquadFilterType[] = ["lowpass", "highpass", "bandpass"];

function createFilter(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const filter = context.createBiquadFilter();

  input.connect(filter);
  filter.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      filter.type = FILTER_MODES[clamp(Math.round(next.mode ?? 0), 0, 2)];
      setParam(filter.frequency, clamp(next.cutoff ?? 8000, 30, 18000), time, smooth);
      setParam(filter.Q, clamp(next.resonance ?? 1, 0.1, 20), time, smooth);
    },
    dispose() {
      input.disconnect();
      filter.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ──────────────────────────── distortion ──────────────────────────── */

const CURVE_SAMPLES = 2048;

function makeDistortionCurve(drive: number) {
  const curve = new Float32Array(CURVE_SAMPLES);
  const amount = clamp(drive, 1, 100);

  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const x = (i * 2) / CURVE_SAMPLES - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }

  return curve;
}

function createDistortion(
  context: BaseAudioContext,
  params: Record<string, number>
): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const shaper = context.createWaveShaper();
  const tone = context.createBiquadFilter();

  shaper.oversample = "2x";
  tone.type = "lowpass";

  let lastDrive = -1;

  input.connect(dry);
  dry.connect(output);
  input.connect(shaper);
  shaper.connect(tone);
  tone.connect(wet);
  wet.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      const drive = clamp(next.drive ?? 12, 1, 100);
      const mix = clamp(next.mix ?? 0.5, 0, 1);

      if (drive !== lastDrive) {
        shaper.curve = makeDistortionCurve(drive);
        lastDrive = drive;
      }

      setParam(tone.frequency, clamp(next.tone ?? 6000, 500, 16000), time, smooth);
      setParam(dry.gain, Math.cos((mix * Math.PI) / 2), time, smooth);
      // Drive raises perceived loudness, so trim the wet path as it climbs.
      // The curve is already peak-normalised, so this only has to compensate
      // for the density the shaper adds — `1/√drive` was −20 dB at the top of
      // the range, which made the effect vanish as you turned it up.
      const trim = 1 / (1 + Math.log10(drive));
      setParam(wet.gain, Math.sin((mix * Math.PI) / 2) * trim, time, smooth);
    },
    dispose() {
      input.disconnect();
      dry.disconnect();
      wet.disconnect();
      shaper.disconnect();
      tone.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ─────────────────────────── modulation helpers ─────────────────────────── */

/** A gain node that always carries two channels, so mono sources spread to both. */
function stereoGain(context: BaseAudioContext): GainNode {
  const gain = context.createGain();
  gain.channelCount = 2;
  gain.channelCountMode = "explicit";
  gain.channelInterpretation = "speakers";
  return gain;
}

interface Lfo {
  osc: OscillatorNode;
  stop(): void;
}

function createLfo(context: BaseAudioContext, type: OscillatorType = "sine"): Lfo {
  const osc = context.createOscillator();
  osc.type = type;
  osc.start();

  return {
    osc,
    stop() {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      osc.disconnect();
    }
  };
}

function setMix(dry: GainNode, wet: GainNode, mix: number, time: number, smooth: boolean): void {
  const amount = clamp(mix, 0, 1);
  setParam(dry.gain, Math.cos((amount * Math.PI) / 2), time, smooth);
  setParam(wet.gain, Math.sin((amount * Math.PI) / 2), time, smooth);
}

/* ───────────────────────── chorus and flanger ───────────────────────── */

/**
 * Two delay lines swept by one LFO in opposite phase, one per side. Chorus
 * and flanger are the same machine: the flanger's delay is shorter and part of
 * its output is fed back in.
 */
function createModulatedDelay(
  context: BaseAudioContext,
  params: Record<string, number>,
  flavour: "chorus" | "flanger"
): EffectNode {
  const input = stereoGain(context);
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const merger = context.createChannelMerger(2);
  const lfo = createLfo(context);

  const sides = [0, 1].map((side) => {
    const delay = context.createDelay(0.1);
    const depth = context.createGain();
    const feedback = context.createGain();
    feedback.gain.value = 0;

    input.connect(delay);
    delay.connect(merger, 0, side);
    delay.connect(feedback);
    feedback.connect(delay);
    lfo.osc.connect(depth);
    depth.connect(delay.delayTime);

    return { delay, depth, feedback, polarity: side === 0 ? 1 : -1 };
  });

  input.connect(dry);
  dry.connect(output);
  merger.connect(wet);
  wet.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      const flanger = flavour === "flanger";
      const base = flanger ? 0.0025 : clamp(next.delay ?? 0.018, 0.005, 0.04);
      // Keep the sweep from ever reaching zero delay, which would click.
      const reach = flanger ? 0.0022 : Math.min(base * 0.8, 0.007);
      const depth = clamp(next.depth ?? 0.5, 0, 1) * reach;

      setParam(lfo.osc.frequency, clamp(next.rate ?? 0.8, 0.02, 5), time, smooth);

      for (const side of sides) {
        setParam(side.delay.delayTime, base, time, smooth);
        setParam(side.depth.gain, depth * side.polarity, time, smooth);
        setParam(side.feedback.gain, flanger ? clamp(next.feedback ?? 0.5, 0, 0.9) : 0, time, smooth);
      }

      setMix(dry, wet, next.mix ?? 0.5, time, smooth);
    },
    dispose() {
      lfo.stop();
      for (const side of sides) {
        side.delay.disconnect();
        side.depth.disconnect();
        side.feedback.disconnect();
      }
      input.disconnect();
      dry.disconnect();
      wet.disconnect();
      merger.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ─────────────────────────────── phaser ─────────────────────────────── */

const PHASER_STAGES = 6;

function createPhaser(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const lfo = createLfo(context);
  // Swept in cents through `detune`, so the sweep is even across octaves.
  const depth = context.createGain();

  const stages = Array.from({ length: PHASER_STAGES }, () => {
    const filter = context.createBiquadFilter();
    filter.type = "allpass";
    depth.connect(filter.detune);
    return filter;
  });

  lfo.osc.connect(depth);

  input.connect(dry);
  dry.connect(output);

  input.connect(stages[0]);
  for (let i = 0; i < stages.length - 1; i++) stages[i].connect(stages[i + 1]);
  stages[stages.length - 1].connect(wet);
  wet.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      setParam(lfo.osc.frequency, clamp(next.rate ?? 0.4, 0.02, 5), time, smooth);
      // Up to two octaves either side of the centre.
      setParam(depth.gain, clamp(next.depth ?? 0.7, 0, 1) * 2400, time, smooth);

      for (const stage of stages) {
        setParam(stage.frequency, clamp(next.frequency ?? 900, 200, 4000), time, smooth);
        setParam(stage.Q, clamp(next.resonance ?? 1.2, 0.3, 5), time, smooth);
      }

      // The notches come from summing dry and phase-shifted signal equally, so
      // mix is linear here rather than equal-power.
      const mix = clamp(next.mix ?? 0.5, 0, 1);
      setParam(dry.gain, 1 - mix * 0.5, time, smooth);
      setParam(wet.gain, mix, time, smooth);
    },
    dispose() {
      lfo.stop();
      depth.disconnect();
      for (const stage of stages) stage.disconnect();
      input.disconnect();
      dry.disconnect();
      wet.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ───────────────────────── tremolo and auto-pan ───────────────────────── */

const TREMOLO_SHAPES: OscillatorType[] = ["sine", "triangle", "square"];

function createTremolo(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const amp = context.createGain();
  const lfo = createLfo(context);
  const depth = context.createGain();

  input.connect(amp);
  amp.connect(output);
  lfo.osc.connect(depth);
  depth.connect(amp.gain);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      const amount = clamp(next.depth ?? 0.5, 0, 1);
      lfo.osc.type = TREMOLO_SHAPES[clamp(Math.round(next.shape ?? 0), 0, 2)];
      setParam(lfo.osc.frequency, clamp(next.rate ?? 5, 0.1, 20), time, smooth);
      // Swing between 1 and 1 - depth, never below silence.
      setParam(amp.gain, 1 - amount / 2, time, smooth);
      setParam(depth.gain, amount / 2, time, smooth);
    },
    dispose() {
      lfo.stop();
      depth.disconnect();
      input.disconnect();
      amp.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

function createAutoPan(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = stereoGain(context);
  const output = context.createGain();
  const panner = context.createStereoPanner();
  const lfo = createLfo(context);
  const depth = context.createGain();

  panner.pan.value = 0;
  input.connect(panner);
  panner.connect(output);
  lfo.osc.connect(depth);
  depth.connect(panner.pan);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      setParam(lfo.osc.frequency, clamp(next.rate ?? 0.5, 0.05, 10), time, smooth);
      setParam(depth.gain, clamp(next.depth ?? 0.7, 0, 1), time, smooth);
    },
    dispose() {
      lfo.stop();
      depth.disconnect();
      input.disconnect();
      panner.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ───────────────────────────── stereo width ───────────────────────────── */

/**
 * Mid/side matrix: L' = M + w·S, R' = M − w·S. Width 0 folds to mono, 1 is
 * untouched, 2 doubles the side signal.
 */
function createStereoWidth(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = stereoGain(context);
  const output = context.createGain();
  const splitter = context.createChannelSplitter(2);
  const merger = context.createChannelMerger(2);

  const mid = context.createGain();
  const side = context.createGain();
  const width = context.createGain();
  const invert = context.createGain();
  invert.gain.value = -1;

  const leftToMid = context.createGain();
  const rightToMid = context.createGain();
  const leftToSide = context.createGain();
  const rightToSide = context.createGain();
  leftToMid.gain.value = 0.5;
  rightToMid.gain.value = 0.5;
  leftToSide.gain.value = 0.5;
  rightToSide.gain.value = -0.5;

  input.connect(splitter);
  splitter.connect(leftToMid, 0);
  splitter.connect(leftToSide, 0);
  splitter.connect(rightToMid, 1);
  splitter.connect(rightToSide, 1);
  leftToMid.connect(mid);
  rightToMid.connect(mid);
  leftToSide.connect(side);
  rightToSide.connect(side);
  side.connect(width);

  mid.connect(merger, 0, 0);
  mid.connect(merger, 0, 1);
  width.connect(merger, 0, 0);
  width.connect(invert);
  invert.connect(merger, 0, 1);
  merger.connect(output);

  const parts: AudioNode[] = [
    input, splitter, merger, mid, side, width, invert,
    leftToMid, rightToMid, leftToSide, rightToSide, output
  ];

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      setParam(width.gain, clamp(next.width ?? 1.4, 0, 2), time, smooth);
      setParam(output.gain, Math.pow(10, clamp(next.gain ?? 0, -12, 12) / 20), time, smooth);
    },
    dispose() {
      for (const part of parts) part.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ───────────────────────────── bitcrusher ───────────────────────────── */

const CRUSH_SAMPLES = 65536;

function makeCrushCurve(bits: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CRUSH_SAMPLES);
  const steps = Math.pow(2, clamp(Math.round(bits), 1, 16)) / 2;

  for (let i = 0; i < CRUSH_SAMPLES; i++) {
    const x = (i * 2) / (CRUSH_SAMPLES - 1) - 1;
    curve[i] = Math.round(x * steps) / steps;
  }

  return curve;
}

function createBitcrusher(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const drive = context.createGain();
  const shaper = context.createWaveShaper();
  shaper.oversample = "none";

  let lastBits = -1;

  input.connect(dry);
  dry.connect(output);
  input.connect(drive);
  drive.connect(shaper);
  shaper.connect(wet);
  wet.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      const bits = clamp(Math.round(next.bits ?? 6), 1, 16);
      if (bits !== lastBits) {
        shaper.curve = makeCrushCurve(bits);
        lastBits = bits;
      }

      setParam(drive.gain, Math.pow(10, clamp(next.drive ?? 0, 0, 24) / 20), time, smooth);
      setMix(dry, wet, next.mix ?? 0.6, time, smooth);
    },
    dispose() {
      input.disconnect();
      dry.disconnect();
      wet.disconnect();
      drive.disconnect();
      shaper.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ─────────────────────────────── limiter ─────────────────────────────── */

function makeLimitCurve(ceiling: number): Float32Array<ArrayBuffer> {
  const length = 4096;
  const curve = new Float32Array(length);
  const knee = ceiling * 0.9;
  const range = ceiling - knee;

  for (let i = 0; i < length; i++) {
    const x = (i / (length - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    const shaped = magnitude <= knee ? magnitude : knee + range * Math.tanh((magnitude - knee) / range);
    curve[i] = x < 0 ? -shaped : shaped;
  }

  return curve;
}

/**
 * Drive into a fast, hard-kneed compressor, then a shaper that makes the
 * ceiling a guarantee — the compressor alone lets the first milliseconds of a
 * transient through.
 */
function createLimiter(context: BaseAudioContext, params: Record<string, number>): EffectNode {
  const input = context.createGain();
  const output = context.createGain();
  const drive = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const ceilingShaper = context.createWaveShaper();

  compressor.knee.value = 0;
  compressor.ratio.value = 20;
  compressor.attack.value = 0.001;
  ceilingShaper.oversample = "none";

  let lastCeiling = Number.NaN;

  input.connect(drive);
  drive.connect(compressor);
  compressor.connect(ceilingShaper);
  ceilingShaper.connect(output);

  const node: EffectNode = {
    input,
    output,
    update(next, time, smooth) {
      const ceiling = Math.round(clamp(next.ceiling ?? -0.3, -12, 0) * 10) / 10;

      if (ceiling !== lastCeiling) {
        ceilingShaper.curve = makeLimitCurve(Math.pow(10, ceiling / 20));
        lastCeiling = ceiling;
      }

      setParam(drive.gain, Math.pow(10, clamp(next.gain ?? 3, 0, 24) / 20), time, smooth);
      setParam(compressor.threshold, ceiling - 1, time, smooth);
      setParam(compressor.release, clamp(next.release ?? 0.12, 0.01, 1), time, smooth);
    },
    dispose() {
      input.disconnect();
      drive.disconnect();
      compressor.disconnect();
      ceilingShaper.disconnect();
      output.disconnect();
    }
  };

  node.update(params, 0, false);
  return node;
}

/* ─────────────────────────────── chain ─────────────────────────────── */
function createEffectNode(
  context: BaseAudioContext,
  effect: EffectInstance
): EffectNode | null {
  const params = readParams(effect);

  switch (effect.type) {
    case "delay":
      return createDelay(context, params);
    case "reverb":
      return createReverb(context, params);
    case "eq":
      return createEq(context, params);
    case "compressor":
      return createCompressor(context, params);
    case "filter":
      return createFilter(context, params);
    case "distortion":
      return createDistortion(context, params);
    case "chorus":
      return createModulatedDelay(context, params, "chorus");
    case "flanger":
      return createModulatedDelay(context, params, "flanger");
    case "phaser":
      return createPhaser(context, params);
    case "tremolo":
      return createTremolo(context, params);
    case "autopan":
      return createAutoPan(context, params);
    case "stereo":
      return createStereoWidth(context, params);
    case "bitcrush":
      return createBitcrusher(context, params);
    case "limiter":
      return createLimiter(context, params);
    default:
      return null;
  }
}

/** Identity of the chain's *structure* — what forces a rebuild. */
function structureKey(effects: EffectInstance[]): string {
  return effects
    .filter((effect) => effect.enabled)
    .map((effect) => `${effect.id}:${effect.type}`)
    .join("|");
}

export interface EffectChain {
  input: AudioNode;
  output: AudioNode;
  /** True when the chain can absorb these effects without being rebuilt. */
  matches(effects: EffectInstance[]): boolean;
  /** Push parameter values into the live nodes. */
  update(effects: EffectInstance[], time: number, smooth: boolean): void;
  dispose(): void;
}

export function buildEffectChain(
  context: BaseAudioContext,
  effects: EffectInstance[]
): EffectChain {
  const input = context.createGain();
  const output = context.createGain();

  const active = effects.filter((effect) => effect.enabled);
  const nodes = new Map<string, EffectNode>();
  const ordered: EffectNode[] = [];

  for (const effect of active) {
    const node = createEffectNode(context, effect);
    if (!node) continue;
    nodes.set(effect.id, node);
    ordered.push(node);
  }

  if (ordered.length === 0) {
    input.connect(output);
  } else {
    input.connect(ordered[0].input);
    for (let i = 0; i < ordered.length - 1; i++) {
      ordered[i].output.connect(ordered[i + 1].input);
    }
    ordered[ordered.length - 1].output.connect(output);
  }

  const key = structureKey(effects);

  return {
    input,
    output,
    matches(next) {
      return structureKey(next) === key;
    },
    update(next, time, smooth) {
      for (const effect of next) {
        if (!effect.enabled) continue;
        const node = nodes.get(effect.id);
        if (node) node.update(readParams(effect), time, smooth);
      }
    },
    dispose() {
      for (const node of ordered) node.dispose();
      nodes.clear();
      ordered.length = 0;
      input.disconnect();
      output.disconnect();
    }
  };
}
