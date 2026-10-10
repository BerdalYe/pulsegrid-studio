import { clamp } from "../../lib/utils";
import type { Voice } from "../voices";
import { zonesFor, type PlayableZone, type SfPreset, type SoundFont } from "./sf2";

/**
 * Playing a note from a SoundFont: for each recording that covers the note, a
 * looping or one-shot sample at the right pitch, shaped by the instrument's own
 * volume envelope, filter and pan. Everything is scheduled on the audio clock,
 * so notes land exactly on the beat.
 */

/** Changes a person can make to how an instrument plays, on top of the SoundFont's own settings. */
export interface SoundFontTweaks {
  /** Multiplies the attack time (1 = as recorded). */
  attack?: number;
  /** Multiplies the release time. */
  release?: number;
  /** 1 leaves the sound alone; lower rolls off the highs. */
  brightness?: number;
  /** Semitones. */
  transpose?: number;
}

/** The most recordings one note may start; thick layered instruments are cut off here. */
const MAX_LAYERS = 8;

/* ───────────────────────────── the audio, a sample at a time ───────────────────────────── */

const bufferCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
const fontIds = new WeakMap<SoundFont, number>();
let nextFontId = 1;

function fontKey(font: SoundFont): number {
  let id = fontIds.get(font);
  if (id === undefined) {
    id = nextFontId++;
    fontIds.set(font, id);
  }
  return id;
}

/** The recording as audio, made once per audio context and kept. Null for an empty or broken sample. */
function sampleBuffer(context: BaseAudioContext, font: SoundFont, zone: PlayableZone): AudioBuffer | null {
  const { sample } = zone;
  const start = Math.max(0, sample.start + zone.startOffset);
  const end = Math.min(font.pcm.length, sample.end + zone.endOffset);
  const length = end - start;
  if (length < 2 || sample.sampleRate < 3000) return null;

  let cache = bufferCache.get(context);
  if (!cache) {
    cache = new Map();
    bufferCache.set(context, cache);
  }

  const key = `${fontKey(font)}:${zone.sampleIndex}:${start}:${end}`;
  let buffer = cache.get(key);
  if (!buffer) {
    buffer = context.createBuffer(1, length, sample.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = font.pcm[start + i] / 32768;
    cache.set(key, buffer);
  }
  return buffer;
}

/* ───────────────────────────── choking (a closed hi-hat stops an open one) ───────────────────────────── */

const choke = new Map<string, (at: number) => void>();

/* ──────────────────────────────────────── the voice ──────────────────────────────────────── */

const amplitude = (centibels: number) => Math.pow(10, -centibels / 200);

export function createSoundFontVoice(
  context: BaseAudioContext,
  font: SoundFont,
  preset: SfPreset,
  destination: AudioNode,
  time: number,
  pitch: number,
  velocity: number,
  /** Sustain length in seconds, or null to hold until released. */
  duration: number | null,
  tweaks: SoundFontTweaks = {},
  /** Who is playing, so a closed hi-hat only chokes this channel's open one. */
  owner = ""
): Voice | null {
  const key = clamp(Math.round(pitch + (tweaks.transpose ?? 0)), 0, 127);
  const zones = zonesFor(font, preset, key, Math.max(1, Math.round(clamp(velocity, 0, 1) * 127))).slice(0, MAX_LAYERS);
  if (zones.length === 0) return null;

  const canPan = typeof context.createStereoPanner === "function";
  // Drum kits play their recordings out; the pad's length doesn't matter.
  const percussion = preset.bank === 128;
  const attackScale = clamp(tweaks.attack ?? 1, 0.02, 8);
  const releaseScale = clamp(tweaks.release ?? 1, 0.05, 8);
  const brightness = clamp(tweaks.brightness ?? 1, 0, 1);

  // The SoundFont's velocity response is a 40 dB-per-decade curve: gentle notes are quieter.
  const loudness = Math.pow(clamp(velocity, 0.01, 1), 2);

  const sources: AudioBufferSourceNode[] = [];
  const nodes: AudioNode[] = [];
  const envelopes: Array<{
    gain: GainNode;
    peak: number;
    attackEnd: number;
    holdEnd: number;
    decayEnd: number;
    sustain: number;
    release: number;
  }> = [];

  for (const zone of zones) {
    const buffer = sampleBuffer(context, font, zone);
    if (!buffer) continue;

    const source = context.createBufferSource();
    source.buffer = buffer;
    const cents = (key - zone.rootKey) * zone.scaleTuning + zone.tuneCents;
    source.playbackRate.value = Math.pow(2, cents / 1200);

    if (zone.loop) {
      const rate = zone.sample.sampleRate;
      const offset = Math.max(0, zone.sample.start + zone.startOffset);
      // Counted in sample frames, so a very short loop is judged by its length in samples. A single
      // cycle of a high synth note is under a millisecond long, and is exactly how those notes are made.
      const loopStartFrame = zone.sample.loopStart + zone.loopStartOffset - offset;
      const loopEndFrame = zone.sample.loopEnd + zone.loopEndOffset - offset;
      if (loopStartFrame >= 0 && loopEndFrame - loopStartFrame >= 2 && loopEndFrame <= buffer.length) {
        source.loop = true;
        source.loopStart = loopStartFrame / rate;
        source.loopEnd = loopEndFrame / rate;
      }
    }

    // The filter: the instrument's own, and a brightness control on top.
    let tail: AudioNode = source;
    const ownCutoff = zone.filterFcCents < 13000 ? 8.176 * Math.pow(2, zone.filterFcCents / 1200) : 20000;
    if (zone.filterFcCents < 13000 || brightness < 1) {
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = clamp(ownCutoff * Math.pow(2, -(1 - brightness) * 6), 80, 20000);
      // Web Audio's low-pass resonance is in decibels, like the SoundFont's centibels.
      filter.Q.value = zone.filterQCb / 10;
      tail.connect(filter);
      tail = filter;
      nodes.push(filter);
    }

    const gain = context.createGain();
    tail.connect(gain);
    nodes.push(gain);

    let output: AudioNode = gain;
    if (canPan && zone.pan !== 0) {
      const panner = context.createStereoPanner();
      panner.pan.value = zone.pan;
      gain.connect(panner);
      output = panner;
      nodes.push(panner);
    }
    output.connect(destination);

    // Volume envelope: delay, attack, hold, decay down to the sustain level.
    const peak = Math.max(0.0001, amplitude(zone.attenuationCb) * loudness);
    const sustain = Math.max(0.0001, peak * amplitude(zone.sustainCb));
    const attackEnd = time + zone.delay + zone.attack * attackScale;
    const holdEnd = attackEnd + zone.hold;
    const decayEnd = holdEnd + zone.decay;

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.setValueAtTime(0.0001, time + zone.delay);
    gain.gain.linearRampToValueAtTime(peak, attackEnd);
    gain.gain.setValueAtTime(peak, holdEnd);
    if (sustain < peak) gain.gain.exponentialRampToValueAtTime(sustain, Math.max(holdEnd + 0.005, decayEnd));

    envelopes.push({ gain, peak, attackEnd, holdEnd, decayEnd, sustain, release: zone.release * releaseScale });
    sources.push(source);

    // A closed hi-hat cuts off an open one, and so on for any class the instrument sets.
    if (zone.exclusiveClass > 0) {
      const id = `${owner}:${zone.exclusiveClass}`;
      choke.get(id)?.(time);
      const fade = (at: number) => {
        try {
          gain.gain.cancelScheduledValues(at);
          gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), at);
          gain.gain.linearRampToValueAtTime(0.0001, at + 0.012);
          source.stop(at + 0.02);
        } catch {
          /* already finished */
        }
      };
      choke.set(id, fade);
      source.onended = () => {
        if (choke.get(id) === fade) choke.delete(id);
      };
    }
  }

  if (sources.length === 0) return null;

  for (const source of sources) source.start(time);

  /** Where an envelope is at `at`, worked out from the stages scheduled above. */
  const levelAt = (envelope: (typeof envelopes)[number], at: number): number => {
    if (at <= time) return 0.0001;
    if (at < envelope.attackEnd) return Math.max(0.0001, (envelope.peak * (at - time)) / Math.max(0.001, envelope.attackEnd - time));
    if (at < envelope.holdEnd) return envelope.peak;
    if (at >= envelope.decayEnd) return envelope.sustain;
    const progress = (at - envelope.holdEnd) / Math.max(0.005, envelope.decayEnd - envelope.holdEnd);
    return envelope.peak * Math.pow(envelope.sustain / envelope.peak, progress);
  };

  let released = false;
  let endTime = Number.POSITIVE_INFINITY;

  const doRelease = (at: number): void => {
    if (released || percussion) return;
    released = true;

    let latest = at;
    envelopes.forEach((envelope, index) => {
      const begin = Math.max(at, time);
      const finish = begin + Math.max(0.01, envelope.release);
      try {
        envelope.gain.gain.cancelScheduledValues(begin);
        envelope.gain.gain.setValueAtTime(levelAt(envelope, begin), begin);
        envelope.gain.gain.exponentialRampToValueAtTime(0.0001, finish);
        sources[index].stop(finish + 0.02);
      } catch {
        /* already finished */
      }
      latest = Math.max(latest, finish);
    });
    endTime = latest + 0.03;
  };

  if (duration !== null) doRelease(time + Math.max(0.02, duration));

  // When the last recording ends, let go of everything.
  let remaining = sources.length;
  for (const source of sources) {
    const previous = source.onended;
    source.onended = (event) => {
      if (typeof previous === "function") previous.call(source, event);
      remaining -= 1;
      if (remaining === 0) {
        for (const node of [...sources, ...nodes]) {
          try {
            node.disconnect();
          } catch {
            /* already gone */
          }
        }
      }
    };
  }

  let vibrato: GainNode | null = null;

  return {
    release: doRelease,
    kill(at) {
      released = true;
      for (const envelope of envelopes) {
        try {
          envelope.gain.gain.cancelScheduledValues(at);
          envelope.gain.gain.setValueAtTime(Math.max(0.0001, envelope.gain.gain.value), at);
          envelope.gain.gain.linearRampToValueAtTime(0.0001, at + 0.012);
        } catch {
          /* already finished */
        }
      }
      for (const source of sources) {
        try {
          source.stop(at + 0.02);
        } catch {
          /* already finished */
        }
      }
    },
    bend(cents, at) {
      for (const source of sources) {
        try {
          source.detune.setTargetAtTime(cents, at, 0.008);
        } catch {
          /* voice already finished */
        }
      }
    },
    modulate(amount, at) {
      if (released && at >= endTime) return;
      if (!vibrato) {
        if (amount <= 0) return;
        const lfo = context.createOscillator();
        lfo.frequency.value = 5.6;
        vibrato = context.createGain();
        vibrato.gain.value = 0;
        lfo.connect(vibrato);
        for (const source of sources) vibrato.connect(source.detune);
        lfo.start(at);
        if (Number.isFinite(endTime)) lfo.stop(endTime);
        nodes.push(vibrato);
      }
      vibrato.gain.setTargetAtTime(clamp(amount, 0, 1) * 45, at, 0.03);
    }
  };
}
