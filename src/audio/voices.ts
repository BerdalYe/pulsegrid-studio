import type { Channel } from "../types";
import { clamp, isSampleChannel, midiToFreq } from "../lib/utils";
import { getReversedBuffer, getSample } from "./sampleRegistry";
import { patchToPreset } from "./synthPatch";
import { buildWavetableStack, connectModulation, reachOf, type Modulation, type WavetableStack } from "./wtVoice";
import { defaultSynthPreset, getSynthPreset, type SynthPresetDef } from "../presets/presets";

export interface Voice {
  /** Begin the release stage at `time`. Safe to call more than once. */
  release(time: number): void;
  /** Hard stop with a short fade, for panic / transport stop. */
  kill(time: number): void;
  /** Pitch bend, in cents, for a held note (MIDI pitch wheel / joystick). */
  bend?(cents: number, time: number): void;
  /** Modulation wheel, 0..1: adds vibrato to a held note. */
  modulate?(amount: number, time: number): void;
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function getNoiseBuffer(context: BaseAudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(context);

  if (!buffer || buffer.sampleRate !== context.sampleRate) {
    const length = Math.floor(context.sampleRate);
    buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(context, buffer);
  }

  return buffer;
}

function disconnectAll(nodes: AudioNode[]): void {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Clear automation from `when` onwards without destroying the ramp that lands
 * exactly on it. `cancelScheduledValues` drops every event at a time >= its
 * argument, so calling it with an envelope stage boundary deletes that stage.
 */
function cancelFrom(param: AudioParam, when: number): void {
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

/* ───────────────────────────── metronome ───────────────────────────── */

/**
 * A metronome tick. Deliberately not a `Voice`: it is fire-and-forget, never
 * sequenced, and never tracked — so Stop and panic have nothing to clean up.
 */
export function scheduleMetronomeClick(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  accent: boolean
): void {
  const osc = context.createOscillator();
  const gain = context.createGain();

  osc.type = "triangle";
  osc.frequency.setValueAtTime(accent ? 1800 : 1200, time);

  const level = accent ? 0.5 : 0.28;
  const decay = accent ? 0.055 : 0.04;

  // A couple of milliseconds of attack keeps it a click rather than a pop.
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(level, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + decay);

  osc.connect(gain);
  gain.connect(destination);

  osc.start(time);
  osc.stop(time + decay + 0.02);
  osc.onended = () => disconnectAll([osc, gain]);
}

/* ─────────────────────────────── drums ─────────────────────────────── */

function createKick(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number
): Voice {
  const osc = context.createOscillator();
  const gain = context.createGain();
  const click = context.createBufferSource();
  const clickFilter = context.createBiquadFilter();
  const clickGain = context.createGain();

  const base = 160 * Math.pow(2, tune / 12);

  osc.type = "sine";
  osc.frequency.setValueAtTime(base, time);
  osc.frequency.exponentialRampToValueAtTime(base * 0.28, time + 0.12);

  gain.gain.setValueAtTime(velocity, time);
  gain.gain.exponentialRampToValueAtTime(0.0008, time + 0.34);

  click.buffer = getNoiseBuffer(context);
  clickFilter.type = "bandpass";
  clickFilter.frequency.value = 2200;
  clickGain.gain.setValueAtTime(velocity * 0.25, time);
  clickGain.gain.exponentialRampToValueAtTime(0.0008, time + 0.02);

  osc.connect(gain);
  gain.connect(destination);
  click.connect(clickFilter);
  clickFilter.connect(clickGain);
  clickGain.connect(destination);

  osc.start(time);
  osc.stop(time + 0.4);
  click.start(time);
  click.stop(time + 0.03);

  osc.onended = () => disconnectAll([osc, gain, click, clickFilter, clickGain]);

  return {
    release: () => undefined,
    kill: (at) => stopSources(at, [osc, click], [gain, clickGain])
  };
}

function createSnare(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number
): Voice {
  const noise = context.createBufferSource();
  const noiseFilter = context.createBiquadFilter();
  const noiseGain = context.createGain();

  noise.buffer = getNoiseBuffer(context);
  noiseFilter.type = "highpass";
  noiseFilter.frequency.value = 1800;
  noiseGain.gain.setValueAtTime(0.4 * velocity, time);
  noiseGain.gain.exponentialRampToValueAtTime(0.0008, time + 0.2);

  const body = context.createOscillator();
  const bodyGain = context.createGain();
  const base = 185 * Math.pow(2, tune / 12);

  body.type = "triangle";
  body.frequency.setValueAtTime(base, time);
  body.frequency.exponentialRampToValueAtTime(base * 0.6, time + 0.08);
  bodyGain.gain.setValueAtTime(0.3 * velocity, time);
  bodyGain.gain.exponentialRampToValueAtTime(0.0008, time + 0.1);

  // A second head mode, a little over an octave up: the "crack".
  const ring = context.createOscillator();
  ring.type = "sine";
  ring.frequency.setValueAtTime(base * 1.78, time);
  const ringLevel = context.createGain();
  ringLevel.gain.value = 0.45;
  ring.connect(ringLevel);
  ringLevel.connect(bodyGain);
  ring.start(time);
  ring.stop(time + 0.14);

  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(destination);
  body.connect(bodyGain);
  bodyGain.connect(destination);

  noise.start(time);
  noise.stop(time + 0.24);
  body.start(time);
  body.stop(time + 0.14);

  noise.onended = () => disconnectAll([noise, noiseFilter, noiseGain, body, ring, ringLevel, bodyGain]);

  return {
    release: () => undefined,
    kill: (at) => stopSources(at, [noise, body, ring], [noiseGain, bodyGain])
  };
}

/**
 * The TR-808's metal: six square waves at fixed, inharmonic frequencies.
 * Through a high-pass it is a hi-hat, through a band-pass a cymbal or a bell —
 * much more convincing than filtered noise on its own.
 */
const METAL_RATIOS = [205.3, 304.4, 369.6, 522.7, 540, 800];

function createMetal(
  context: BaseAudioContext,
  time: number,
  stopAt: number,
  tune: number,
  ratios: number[] = METAL_RATIOS
): { output: GainNode; sources: OscillatorNode[]; parts: AudioNode[] } {
  const output = context.createGain();
  output.gain.value = 1 / ratios.length;

  const scale = Math.pow(2, tune / 12);
  const sources = ratios.map((hz) => {
    const osc = context.createOscillator();
    osc.type = "square";
    osc.frequency.value = hz * scale;
    osc.connect(output);
    osc.start(time);
    osc.stop(stopAt);
    return osc;
  });

  return { output, sources, parts: [output] };
}

function noiseSource(context: BaseAudioContext, time: number, stopAt: number): AudioBufferSourceNode {
  const noise = context.createBufferSource();
  noise.buffer = getNoiseBuffer(context);
  // A random start point, so rapid hits don't all share one noise texture.
  noise.start(time, Math.random() * 0.5);
  noise.stop(stopAt);
  return noise;
}

/** Wire the finished nodes together and hand back a one-shot Voice. */
function oneShot(
  sources: Array<OscillatorNode | AudioBufferSourceNode | ConstantSourceNode>,
  gains: GainNode[],
  parts: AudioNode[]
): Voice {
  sources[0].onended = () => disconnectAll([...sources, ...gains, ...parts]);

  return {
    release: () => undefined,
    kill: (at) => stopSources(at, sources, gains)
  };
}

function createHat(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number,
  open: boolean
): Voice {
  const decay = open ? 0.34 : 0.055;
  const end = time + decay + 0.03;

  const metal = createMetal(context, time, end, tune);
  const noise = noiseSource(context, time, end);
  const noiseLevel = context.createGain();
  noiseLevel.gain.value = 0.35;

  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 10000;
  band.Q.value = 0.8;

  const high = context.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 7000 * Math.pow(2, tune / 24);

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(1.5 * velocity, time + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0008, time + decay);

  metal.output.connect(band);
  noise.connect(noiseLevel);
  noiseLevel.connect(band);
  band.connect(high);
  high.connect(gain);
  gain.connect(destination);

  return oneShot([...metal.sources, noise], [gain], [...metal.parts, noiseLevel, band, high]);
}

function createCymbal(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number
): Voice {
  const decay = 1.9;
  const end = time + decay + 0.05;

  const metal = createMetal(context, time, end, tune);
  const noise = noiseSource(context, time, end);
  const noiseLevel = context.createGain();
  noiseLevel.gain.value = 0.6;

  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 7500;
  band.Q.value = 0.5;

  const high = context.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 4000;

  // Fast initial drop, then the long wash.
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(0.5 * velocity, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.2 * velocity, time + 0.12);
  gain.gain.exponentialRampToValueAtTime(0.0008, time + decay);

  metal.output.connect(band);
  noise.connect(noiseLevel);
  noiseLevel.connect(band);
  band.connect(high);
  high.connect(gain);
  gain.connect(destination);

  return oneShot([...metal.sources, noise], [gain], [...metal.parts, noiseLevel, band, high]);
}

function createCowbell(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number
): Voice {
  const end = time + 0.5;
  const metal = createMetal(context, time, end, tune, [540, 800]);

  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 2640 * Math.pow(2, tune / 12);
  band.Q.value = 1.2;

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(1.1 * velocity, time + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.25 * velocity, time + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0008, time + 0.45);

  metal.output.connect(band);
  band.connect(gain);
  gain.connect(destination);

  return oneShot(metal.sources, [gain], [...metal.parts, band]);
}

function createClap(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number
): Voice {
  const end = time + 0.4;
  const noise = noiseSource(context, time, end);

  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1150 * Math.pow(2, tune / 12);
  band.Q.value = 1.1;

  const high = context.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 600;

  // Three quick hand slaps, then the room.
  const gain = context.createGain();
  const peak = 1.3 * velocity;
  gain.gain.setValueAtTime(0.0001, time);
  for (const offset of [0, 0.011, 0.022]) {
    gain.gain.setValueAtTime(peak, time + offset);
    gain.gain.exponentialRampToValueAtTime(0.08 * velocity, time + offset + 0.009);
  }
  gain.gain.setValueAtTime(peak * 0.8, time + 0.031);
  gain.gain.exponentialRampToValueAtTime(0.0008, time + 0.3);

  noise.connect(band);
  band.connect(high);
  high.connect(gain);
  gain.connect(destination);

  return oneShot([noise], [gain], [band, high]);
}

function createTom(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number
): Voice {
  // Middle C plays a mid tom; the piano roll tunes it from floor to high tom.
  const base = 130 * Math.pow(2, tune / 12);
  const end = time + 0.6;

  const osc = context.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(base * 1.6, time);
  osc.frequency.exponentialRampToValueAtTime(base, time + 0.08);
  osc.frequency.exponentialRampToValueAtTime(base * 0.85, time + 0.5);
  osc.start(time);
  osc.stop(end);

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(0.9 * velocity, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0008, time + 0.5);

  const noise = noiseSource(context, time, time + 0.05);
  const hit = context.createBiquadFilter();
  hit.type = "bandpass";
  hit.frequency.value = base * 8;
  const hitGain = context.createGain();
  hitGain.gain.setValueAtTime(0.25 * velocity, time);
  hitGain.gain.exponentialRampToValueAtTime(0.0008, time + 0.03);

  osc.connect(gain);
  gain.connect(destination);
  noise.connect(hit);
  hit.connect(hitGain);
  hitGain.connect(destination);

  return oneShot([osc, noise], [gain, hitGain], [hit]);
}

function createRim(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number
): Voice {
  const scale = Math.pow(2, tune / 12);
  const end = time + 0.08;

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(0.58 * velocity, time + 0.0008);
  gain.gain.exponentialRampToValueAtTime(0.0008, time + 0.05);

  const sources = [1720, 480].map((hz, index) => {
    const osc = context.createOscillator();
    osc.type = index === 0 ? "triangle" : "sine";
    osc.frequency.value = hz * scale;
    osc.connect(gain);
    osc.start(time);
    osc.stop(end);
    return osc;
  });

  const high = context.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 400;
  gain.connect(high);
  high.connect(destination);

  return oneShot(sources, [gain], [high]);
}

function createShaker(
  context: BaseAudioContext,
  destination: AudioNode,
  time: number,
  velocity: number,
  tune: number,
  long: boolean
): Voice {
  const length = long ? 0.18 : 0.09;
  const end = time + length + 0.03;
  const noise = noiseSource(context, time, end);

  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 7000 * Math.pow(2, tune / 12);
  band.Q.value = 1.4;

  // A shaker swells in rather than striking.
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(0.6 * velocity, time + length * 0.35);
  gain.gain.exponentialRampToValueAtTime(0.0008, time + length);

  noise.connect(band);
  band.connect(gain);
  gain.connect(destination);

  return oneShot([noise], [gain], [band]);
}
/* ─────────────────────────────── sample ─────────────────────────────── */

function createSampleVoice(
  context: BaseAudioContext,
  channel: Channel,
  destination: AudioNode,
  time: number,
  velocity: number,
  pitchOffsetSemitones: number,
  /** Gate length in seconds, or null to hold until released. */
  duration: number | null
): Voice | null {
  const sample = getSample(channel.sampleId);
  if (!sample) return null;

  const buffer = channel.reverse ? getReversedBuffer(context, sample) : sample.buffer;

  const source = context.createBufferSource();
  source.buffer = buffer;

  const detune = ((channel.pitchOffset ?? 0) + pitchOffsetSemitones) * 100;
  if (source.detune) source.detune.value = clamp(detune, -4800, 4800);

  const trimStart = clamp(channel.trimStart ?? 0, 0, 0.99) * buffer.duration;
  const trimEnd = clamp(channel.trimEnd ?? 1, 0.01, 1) * buffer.duration;
  const trimDuration = Math.max(0.01, trimEnd - trimStart);

  const gain = context.createGain();
  gain.gain.value = velocity;

  source.connect(gain);
  gain.connect(destination);

  if (channel.loop) {
    source.loop = true;
    source.loopStart = trimStart;
    source.loopEnd = trimStart + trimDuration;
    source.start(time, trimStart);

    // A looping source runs until something stops it. Honour the step gate, or
    // the sequencer would stack a new never-ending copy on every trigger.
    if (duration !== null) source.stop(time + Math.max(0.02, duration));
  } else {
    source.start(time, trimStart, trimDuration);
  }

  source.onended = () => disconnectAll([source, gain]);

  let released = false;

  return {
    release(at) {
      if (released) return;
      released = true;
      const stopAt = Math.max(at, time);
      gain.gain.cancelScheduledValues(stopAt);
      gain.gain.setValueAtTime(gain.gain.value, stopAt);
      gain.gain.linearRampToValueAtTime(0.0001, stopAt + 0.02);
      try {
        source.stop(stopAt + 0.03);
      } catch {
        /* already stopped */
      }
    },
    kill(at) {
      released = true;
      stopSources(at, [source], [gain]);
    }
  };
}

/* ─────────────────────────────── synth ─────────────────────────────── */

function createSynthVoice(
  context: BaseAudioContext,
  preset: SynthPresetDef,
  destination: AudioNode,
  time: number,
  pitch: number,
  velocity: number,
  /** Sustain length in seconds, or null to hold until released. */
  duration: number | null
): Voice {
  const frequency = midiToFreq(pitch);
  const nyquist = context.sampleRate / 2;

  /** Everything that has to be stopped: oscillators, the LFO, the noise burst. */
  const sources: Array<OscillatorNode | AudioBufferSourceNode | ConstantSourceNode> = [];
  /** Everything that has to be disconnected once the voice is done. */
  const parts: AudioNode[] = [];

  /** Everything that follows the note's pitch: the main voices, partials, sub. */
  const oscillators: OscillatorNode[] = [];
  /** The main voices only — what FM modulates. */
  const carriers: OscillatorNode[] = [];
  const mixGain = context.createGain();
  parts.push(mixGain);

  const canPan = typeof context.createStereoPanner === "function";

  const makeOsc = (detuneCents: number, pan: number) => {
    const osc = context.createOscillator();
    osc.type = preset.oscType;
    osc.frequency.setValueAtTime(frequency, time);
    osc.detune.value = detuneCents;

    // Unison voices spread across the stereo field: most of what makes a
    // supersaw or a pad sound wide rather than just thick.
    if (pan !== 0 && canPan) {
      const panner = context.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      osc.connect(panner);
      panner.connect(mixGain);
      parts.push(panner);
    } else {
      osc.connect(mixGain);
    }

    oscillators.push(osc);
    carriers.push(osc);
    sources.push(osc);
    return osc;
  };

  // Wavetable oscillators A and B, when the sound has them.
  let stackA: WavetableStack | null = null;
  let stackB: WavetableStack | null = null;

  if (preset.wt) {
    const voiceParts = { sources, nodes: parts };
    const routes = preset.mod?.routes ?? [];

    stackA = buildWavetableStack(context, preset.wt.a, frequency, time, mixGain, voiceParts, reachOf(preset.mod, "posA"));
    for (const osc of stackA.oscillators) {
      oscillators.push(osc);
      carriers.push(osc);
    }

    // B costs nothing until it has a level, or something that raises it.
    if (preset.wt.b.level > 0 || routes.some((route) => route.dest === "levelB")) {
      stackB = buildWavetableStack(context, preset.wt.b, frequency, time, mixGain, voiceParts, reachOf(preset.mod, "posB"));
      for (const osc of stackB.oscillators) oscillators.push(osc);
    }
  } else {
    // Unison: an odd number of voices, detuned symmetrically around the centre.
    const unison =
      preset.detuneSpread > 0 ? Math.max(3, Math.round(preset.unison ?? 3)) | 1 : 1;
    const stereoSpread = clamp(preset.stereoSpread ?? (unison > 1 ? 0.5 : 0), 0, 1);

    for (let i = 0; i < unison; i++) {
      const position = unison === 1 ? 0 : (i / (unison - 1)) * 2 - 1;
      makeOsc(position * preset.detuneSpread, position * stereoSpread);
    }

    // Equal-power-ish: three voices land on the level the old fixed trio had.
    mixGain.gain.value = unison > 1 ? 0.66 / Math.sqrt(unison) : 1;
  }

  // A second oscillator with a waveform of its own: saw + square, sine + saw, a fifth up.
  if (!preset.wt && preset.osc2 && preset.osc2.gain > 0) {
    const osc2 = context.createOscillator();
    osc2.type = preset.osc2.type;
    osc2.frequency.setValueAtTime(frequency * Math.pow(2, preset.osc2.semitones / 12), time);
    osc2.detune.value = preset.osc2.detune;

    const level = context.createGain();
    level.gain.value = clamp(preset.osc2.gain, 0, 1);
    osc2.connect(level);
    level.connect(mixGain);

    oscillators.push(osc2);
    sources.push(osc2);
    parts.push(level);
  }

  // Sub oscillator an octave down, for weight under basses and leads.
  if (preset.sub && preset.sub.gain > 0) {
    const sub = context.createOscillator();
    sub.type = preset.sub.type ?? "sine";
    sub.frequency.setValueAtTime(frequency / 2, time);

    const level = context.createGain();
    level.gain.value = preset.sub.gain;
    sub.connect(level);
    level.connect(mixGain);

    oscillators.push(sub);
    sources.push(sub);
    parts.push(level);
  }

  // FM: a sine modulator swings the carriers' frequency. Its depth decays, so
  // the attack is bright and metallic and the tail mellows — an FM e-piano,
  // a bell, a bass with bite.
  if (preset.fm && preset.fm.index > 0) {
    const modulator = context.createOscillator();
    modulator.type = "sine";
    modulator.frequency.setValueAtTime(frequency * preset.fm.ratio, time);

    const depth = context.createGain();
    const peakDeviation = Math.max(0.0001, frequency * preset.fm.index);
    const restDeviation = Math.max(0.0001, peakDeviation * (preset.fm.sustain ?? 0.15));
    depth.gain.setValueAtTime(peakDeviation, time);
    depth.gain.exponentialRampToValueAtTime(restDeviation, time + Math.max(0.01, preset.fm.decay));

    modulator.connect(depth);
    for (const carrier of carriers) depth.connect(carrier.frequency);

    oscillators.push(modulator);
    sources.push(modulator);
    parts.push(depth);
  }

  // Harmonic partials. A single oscillator can only ever sound like a synth —
  // the overtone structure is what makes a piano a piano and an organ an organ.
  for (const partial of preset.partials ?? []) {
    const partialFrequency = frequency * partial.ratio;
    // Above Nyquist a partial folds back down as an audible mistuned tone.
    if (partialFrequency >= nyquist - 200) continue;

    const osc = context.createOscillator();
    osc.type = partial.type ?? "sine";
    osc.frequency.setValueAtTime(partialFrequency, time);

    const level = context.createGain();
    level.gain.value = partial.gain;

    osc.connect(level);
    level.connect(mixGain);

    oscillators.push(osc);
    sources.push(osc);
    parts.push(level);
  }

  const filter = context.createBiquadFilter();
  filter.type = preset.filterType;
  filter.Q.value = preset.filterQ;
  parts.push(filter);

  // Keyboard tracking: with it on, the filter rises and falls with the note.
  const keytrack = Math.pow(frequency / 261.63, clamp(preset.filterKeytrack ?? 0, 0, 1));

  // Harder notes open the filter further, as a struck or plucked string does.
  const brightness = 0.7 + 0.3 * velocity;
  const openFreq = clamp(
    preset.filterFreq * keytrack * (1 + preset.filterEnvAmount * 3) * brightness,
    40,
    nyquist - 1000
  );
  const restFreq = clamp(preset.filterFreq * keytrack, 40, nyquist - 1000);

  filter.frequency.setValueAtTime(openFreq, time);
  filter.frequency.exponentialRampToValueAtTime(
    restFreq,
    time + Math.max(0.01, preset.filterDecay ?? preset.decayTime)
  );

  const amp = context.createGain();
  parts.push(amp);

  const peak = Math.max(0.0002, velocity * preset.gain);
  const sustain = Math.max(0.0002, peak * preset.sustainLevel);

  const attackEnd = time + Math.max(0.001, preset.attackTime);
  const decayEnd = attackEnd + Math.max(0.005, preset.decayTime);

  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.linearRampToValueAtTime(peak, attackEnd);
  amp.gain.exponentialRampToValueAtTime(sustain, decayEnd);

  // Tremolo sits after the envelope so the two never write to the same param.
  let output: AudioNode = amp;
  if (preset.tremolo) {
    const trem = context.createGain();
    const depth = clamp(preset.tremolo.depth, 0, 1);
    trem.gain.value = 1 - depth / 2;

    const lfo = context.createOscillator();
    lfo.frequency.value = preset.tremolo.rate;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = depth / 2;

    lfo.connect(lfoDepth);
    lfoDepth.connect(trem.gain);
    amp.connect(trem);
    lfo.start(time);

    output = trem;
    sources.push(lfo);
    parts.push(trem, lfoDepth);
  }

  // Modulation aimed at the volume goes through a gain of its own, after the envelope.
  let volumeParam: AudioParam | null = null;
  if (preset.mod?.routes.some((route) => route.dest === "volume")) {
    const modVolume = context.createGain();
    modVolume.gain.value = 1;
    output.connect(modVolume);
    output = modVolume;
    parts.push(modVolume);
    volumeParam = modVolume.gain;
  }

  // Filter LFO, in cents on the filter's detune: wobble basses, moving pads.
  if (preset.filterLfo) {
    const lfo = context.createOscillator();
    lfo.frequency.value = preset.filterLfo.rate;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = preset.filterLfo.depth;
    lfo.connect(lfoDepth);
    lfoDepth.connect(filter.detune);
    lfo.start(time);

    sources.push(lfo);
    parts.push(lfoDepth);
  }

  mixGain.connect(filter);
  filter.connect(amp);
  output.connect(destination);

  // The modulation routes: an envelope, two LFOs, velocity and key, aimed at the knobs.
  let modulation: Modulation | null = null;
  if (preset.mod && preset.mod.routes.length > 0) {
    modulation = connectModulation(
      context,
      preset.mod,
      time,
      velocity,
      pitch,
      {
        filterDetune: filter.detune,
        filterQ: filter.Q,
        oscillatorDetunes: oscillators.map((osc) => osc.detune),
        stackA,
        stackB,
        volume: volumeParam
      },
      { sources, nodes: parts }
    );
  }

  // Pitch envelope: the note starts off pitch and settles — the thump of an
  // 808, the scoop of a horn.
  if (preset.pitchEnv) {
    const cents = preset.pitchEnv.semitones * 100;
    const settle = Math.max(0.005, preset.pitchEnv.time) / 4;
    for (const osc of oscillators) {
      const rest = osc.detune.value;
      osc.detune.setValueAtTime(rest + cents, time);
      osc.detune.setTargetAtTime(rest, time, settle);
    }
  }

  for (const osc of oscillators) osc.start(time);

  // A constant hiss that goes through the filter and envelope with everything else.
  if (preset.noise && preset.noise > 0) {
    const hiss = context.createBufferSource();
    hiss.buffer = getNoiseBuffer(context);
    hiss.loop = true;

    const hissLevel = context.createGain();
    hissLevel.gain.value = clamp(preset.noise, 0, 1) * 0.5;
    hiss.connect(hissLevel);
    hissLevel.connect(mixGain);
    hiss.start(time);

    sources.push(hiss);
    parts.push(hissLevel);
  }

  // A short filtered noise burst at note-on: the hammer on a piano, the pick on
  // a guitar, the breath on a flute. Cheap, and it does most of the work of
  // making a tone read as a real instrument.
  if (preset.attackNoise) {
    const burst = context.createBufferSource();
    burst.buffer = getNoiseBuffer(context);

    const burstFilter = context.createBiquadFilter();
    burstFilter.type = "lowpass";
    burstFilter.frequency.value = clamp(preset.attackNoise.cutoff, 200, nyquist - 1000);

    const burstGain = context.createGain();
    const burstDecay = Math.max(0.005, preset.attackNoise.decay);
    burstGain.gain.setValueAtTime(Math.max(0.0002, preset.attackNoise.gain * velocity), time);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, time + burstDecay);

    burst.connect(burstFilter);
    burstFilter.connect(burstGain);
    burstGain.connect(amp);

    burst.start(time);
    burst.stop(time + burstDecay + 0.02);

    sources.push(burst);
    parts.push(burstFilter, burstGain);
  }

  // Delayed vibrato, so held strings and winds don't sit perfectly still.
  if (preset.vibrato) {
    const lfo = context.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = preset.vibrato.rate;

    const lfoDepth = context.createGain();
    const onset = time + Math.max(0, preset.vibrato.delay);
    lfoDepth.gain.setValueAtTime(0, time);
    lfoDepth.gain.setValueAtTime(0, onset);
    lfoDepth.gain.linearRampToValueAtTime(preset.vibrato.depth, onset + 0.3);

    lfo.connect(lfoDepth);
    for (const osc of oscillators) lfoDepth.connect(osc.detune);
    lfo.start(time);

    sources.push(lfo);
    parts.push(lfoDepth);
  }

  let released = false;
  let endTime = Number.POSITIVE_INFINITY;

  /**
   * Where the amp envelope actually is at `at`, computed from the stages we
   * scheduled above. Reading `amp.gain.value` instead would report the node's
   * default of 1.0: for a sequenced note the release is scheduled up front, a
   * lookahead window before any of those events have run.
   */
  const envelopeValueAt = (at: number): number => {
    if (at <= attackEnd) return peak;
    if (at >= decayEnd) return sustain;

    // Mirror of the exponential decay ramp from `peak` to `sustain`.
    const progress = (at - attackEnd) / (decayEnd - attackEnd);
    return peak * Math.pow(sustain / peak, progress);
  };

  const doRelease = (at: number): void => {
    if (released) return;
    released = true;

    const releaseStart = Math.max(at, attackEnd);
    const releaseEnd = releaseStart + Math.max(0.01, preset.releaseTime);

    modulation?.release(releaseStart);
    cancelFrom(amp.gain, releaseStart);
    amp.gain.setValueAtTime(Math.max(0.0002, envelopeValueAt(releaseStart)), releaseStart);
    amp.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

    endTime = releaseEnd + 0.02;

    for (const source of sources) {
      try {
        source.stop(endTime);
      } catch {
        /* already scheduled, or already finished */
      }
    }
  };

  if (duration !== null) {
    doRelease(time + Math.max(0.02, duration));
  }

  oscillators[0].onended = () => disconnectAll([...sources, ...parts]);

  // Pitch bend rides on top of each oscillator's own detune (unison spread),
  // so bending keeps the chorus intact.
  const restDetune = oscillators.map((osc) => osc.detune.value);

  // The mod-wheel vibrato is only built the first time the wheel moves.
  let modDepth: GainNode | null = null;

  return {
    release: doRelease,
    kill(at) {
      released = true;
      stopSources(at, sources, [amp]);
    },
    bend(cents, at) {
      oscillators.forEach((osc, index) => {
        try {
          osc.detune.setTargetAtTime(restDetune[index] + cents, at, 0.008);
        } catch {
          /* voice already finished */
        }
      });
    },
    modulate(amount, at) {
      if (released && at >= endTime) return;

      if (!modDepth) {
        if (amount <= 0) return;
        const lfo = context.createOscillator();
        lfo.frequency.value = 5.6;
        modDepth = context.createGain();
        modDepth.gain.value = 0;
        lfo.connect(modDepth);
        for (const osc of oscillators) modDepth.connect(osc.detune);
        lfo.start(at);
        if (Number.isFinite(endTime)) lfo.stop(endTime);
        sources.push(lfo);
        parts.push(modDepth);
      }

      // Up to about a quarter-tone of vibrato at full wheel.
      modDepth.gain.setTargetAtTime(Math.max(0, Math.min(1, amount)) * 45, at, 0.03);
    }
  };
}

function stopSources(
  at: number,
  sources: Array<OscillatorNode | AudioBufferSourceNode | ConstantSourceNode>,
  gains: GainNode[]
): void {
  for (const gain of gains) {
    try {
      gain.gain.cancelScheduledValues(at);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), at);
      gain.gain.linearRampToValueAtTime(0.0001, at + 0.012);
    } catch {
      /* ignore */
    }
  }

  for (const source of sources) {
    try {
      source.stop(at + 0.02);
    } catch {
      /* already stopped */
    }
  }
}

/* ─────────────────────────────── entry point ─────────────────────────────── */

export interface TriggerOptions {
  time: number;
  /** 0..1 */
  velocity: number;
  /** MIDI note; drums use it as a tuning offset from 60. */
  pitch: number;
  /** Sustain length in seconds, or null for "hold until released". */
  duration: number | null;
}

export function triggerChannel(
  context: BaseAudioContext,
  channel: Channel,
  destination: AudioNode,
  options: TriggerOptions
): Voice | null {
  const velocity = clamp(options.velocity, 0, 1);
  if (velocity <= 0) return null;

  const { time, pitch, duration } = options;
  const tune = pitch - 60;

  if (isSampleChannel(channel.type)) {
    return createSampleVoice(context, channel, destination, time, velocity, tune, duration);
  }

  switch (channel.type) {
    case "kick":
      return createKick(context, destination, time, velocity, tune);
    case "snare":
      return createSnare(context, destination, time, velocity, tune);
    case "hat":
      // A long step gate opens the hat, exactly like an open/closed hi-hat pair.
      return createHat(context, destination, time, velocity, tune, (duration ?? 0) > 0.22);
    case "clap":
      return createClap(context, destination, time, velocity, tune);
    case "tom":
      return createTom(context, destination, time, velocity, tune);
    case "rim":
      return createRim(context, destination, time, velocity, tune);
    case "cymbal":
      return createCymbal(context, destination, time, velocity, tune);
    case "cowbell":
      return createCowbell(context, destination, time, velocity, tune);
    case "shaker":
      return createShaker(context, destination, time, velocity, tune, (duration ?? 0) > 0.22);
    case "synth": {
      const preset = channel.synthPatch
        ? patchToPreset(channel.synthPatch)
        : (getSynthPreset(channel.synthPreset) ?? defaultSynthPreset);
      return createSynthVoice(context, preset, destination, time, pitch, velocity, duration);
    }
    default:
      return null;
  }
}
