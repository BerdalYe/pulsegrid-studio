import { describe, expect, it } from "vitest";

import { triggerChannel } from "./voices";
import { sanitizeSynthPatch } from "./synthPatch";
import { getSynthPreset, synthPresets } from "../presets/presets";
import { DRUM_TYPES } from "../lib/utils";
import type { Channel } from "../types";

interface ParamEvent {
  method: string;
  value: number;
  time: number;
}

/**
 * A BaseAudioContext stand-in that records every AudioParam call, so the tests
 * can assert on the envelope that *would* be scheduled without needing real
 * Web Audio.
 */
function recordingContext() {
  const events = new Map<string, ParamEvent[]>();

  const makeParam = (name: string, initial = 1) => {
    const log: ParamEvent[] = [];
    events.set(name, log);

    const param = {
      value: initial,
      setValueAtTime: (value: number, time: number) => {
        log.push({ method: "setValueAtTime", value, time });
        return param;
      },
      linearRampToValueAtTime: (value: number, time: number) => {
        log.push({ method: "linearRamp", value, time });
        return param;
      },
      exponentialRampToValueAtTime: (value: number, time: number) => {
        log.push({ method: "exponentialRamp", value, time });
        return param;
      },
      setTargetAtTime: (value: number, time: number) => {
        log.push({ method: "setTarget", value, time });
        return param;
      },
      cancelScheduledValues: (time: number) => {
        log.push({ method: "cancel", value: 0, time });
        return param;
      }
    };

    return param;
  };

  let gainCount = 0;

  const node = () => ({
    connect: () => undefined,
    disconnect: () => undefined
  });

  const context = {
    sampleRate: 44100,
    currentTime: 0,
    createGain: () => {
      const name = `gain${gainCount++}`;
      return { ...node(), gain: makeParam(name) };
    },
    createOscillator: () => ({
      ...node(),
      type: "sine" as OscillatorType,
      frequency: makeParam("oscFreq", 440),
      detune: makeParam("oscDetune", 0),
      setPeriodicWave: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      set onended(_fn: unknown) {
        /* ignored */
      }
    }),
    createBiquadFilter: () => ({
      ...node(),
      type: "lowpass" as BiquadFilterType,
      frequency: makeParam("filterFreq", 350),
      detune: makeParam("filterDetune", 0),
      Q: makeParam("filterQ", 1)
    }),
    createBufferSource: () => ({
      ...node(),
      buffer: null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      detune: makeParam("srcDetune", 0),
      start: () => undefined,
      stop: () => undefined,
      set onended(_fn: unknown) {
        /* ignored */
      }
    }),
    createPeriodicWave: () => ({}),
    createConstantSource: () => ({
      ...node(),
      offset: makeParam("constantOffset", 1),
      start: () => undefined,
      stop: () => undefined,
      set onended(_fn: unknown) {
        /* ignored */
      }
    }),
    createBuffer: (channels: number, length: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length)
    })
  } as unknown as BaseAudioContext;

  return { context, events };
}

function synthChannel(presetId: string): Channel {
  return {
    id: "c1",
    name: "Lead",
    type: "synth",
    color: "#fff",
    mute: false,
    solo: false,
    volume: 0.8,
    pan: 0,
    mixerTrackId: 1,
    synthPreset: presetId
  };
}

/** The amp envelope is the gain node whose log starts at near-silence. */
function ampEvents(events: Map<string, ParamEvent[]>): ParamEvent[] {
  for (const log of events.values()) {
    if (log.some((event) => event.method === "setValueAtTime" && event.value <= 0.001)) {
      return log;
    }
  }
  return [];
}

describe("synth voice envelope", () => {
  it("releases from the sustain level, not from the node's default gain", () => {
    const preset = getSynthPreset("cyber-saw");
    expect(preset).toBeDefined();
    if (!preset) return;

    const { context, events } = recordingContext();
    const destination = { connect: () => undefined } as unknown as AudioNode;

    // A note comfortably longer than attack + decay, scheduled in the future
    // the way the sequencer schedules one.
    triggerChannel(context, synthChannel(preset.id), destination, {
      time: 1,
      velocity: 1,
      pitch: 60,
      duration: 0.8
    });

    const amp = ampEvents(events);
    expect(amp.length).toBeGreaterThan(0);

    const peak = preset.gain;
    const sustain = peak * preset.sustainLevel;

    const attackEnd = 1 + Math.max(0.001, preset.attackTime);
    const decayEnd = attackEnd + Math.max(0.005, preset.decayTime);
    const releaseStart = Math.max(1 + 0.8, attackEnd);

    const anchor = amp.find(
      (event) => event.method === "setValueAtTime" && Math.abs(event.time - releaseStart) < 1e-6
    );

    expect(anchor).toBeDefined();
    // The bug this pins: the anchor used to be `amp.gain.value`, which reads
    // 1.0 for a note scheduled in the future — an ~11 dB jump at note-off.
    expect(anchor?.value).toBeLessThanOrEqual(peak + 1e-6);
    expect(anchor?.value).toBeCloseTo(sustain, 4);
    expect(releaseStart).toBeGreaterThan(decayEnd);
  });

  it("keeps the attack ramp when a note is released during the attack", () => {
    const preset = getSynthPreset("warm-pad") ?? getSynthPreset("cyber-saw");
    if (!preset) return;

    const { context, events } = recordingContext();
    const destination = { connect: () => undefined } as unknown as AudioNode;

    triggerChannel(context, synthChannel(preset.id), destination, {
      time: 0,
      velocity: 1,
      pitch: 60,
      // Far shorter than the attack, so the release lands on attackEnd exactly.
      duration: 0.001
    });

    const amp = ampEvents(events);
    const attackEnd = Math.max(0.001, preset.attackTime);

    const attackRamp = amp.find(
      (event) => event.method === "linearRamp" && Math.abs(event.time - attackEnd) < 1e-6
    );

    // The cancel must not sit at or before the attack ramp's own event time,
    // or it would delete the attack and the note would start silent.
    const cancel = amp.find((event) => event.method === "cancel");

    expect(attackRamp).toBeDefined();
    if (cancel) expect(cancel.time).toBeGreaterThan(attackEnd - 1e-9);
  });
});

describe("drum voices", () => {
  it("plays every drum type", () => {
    for (const type of DRUM_TYPES) {
      const { context } = recordingContext();
      const destination = { connect: () => undefined } as unknown as AudioNode;

      const voice = triggerChannel(
        context,
        { ...synthChannel("grand-piano"), type, synthPreset: undefined },
        destination,
        { time: 0, velocity: 0.9, pitch: 60, duration: 0.1 }
      );

      expect(voice, `${type} made no sound`).not.toBeNull();
    }
  });
});

describe("synth features", () => {
  it("builds every preset without throwing", () => {
    for (const preset of synthPresets) {
      const { context } = recordingContext();
      const destination = { connect: () => undefined } as unknown as AudioNode;

      expect(
        () =>
          triggerChannel(context, synthChannel(preset.id), destination, {
            time: 0,
            velocity: 0.8,
            pitch: 48,
            duration: 0.5
          }),
        preset.id
      ).not.toThrow();
    }
  });
});
describe("custom sounds", () => {
  const destination = { connect: () => undefined } as unknown as AudioNode;

  const custom = (changes: Record<string, unknown>, pitch = 60): Map<string, ParamEvent[]> => {
    const { context, events } = recordingContext();
    const base = synthPresets[1];
    const channel: Channel = {
      ...synthChannel(base.id),
      synthPatch: sanitizeSynthPatch({ ...base, ...changes })
    };
    triggerChannel(context, channel, destination, { time: 0, velocity: 0.8, pitch, duration: 0.5 });
    return events;
  };

  it("plays the person's own sound instead of the preset", () => {
    const quiet = ampEvents(custom({ gain: 0.1 }));
    const loud = ampEvents(custom({ gain: 0.9 }));
    const peak = (log: ParamEvent[]) => Math.max(...log.map((event) => event.value));
    expect(peak(loud)).toBeGreaterThan(peak(quiet) * 4);
  });

  it("builds with a second oscillator, noise, FM and every movement switched on", () => {
    expect(() =>
      custom({
        osc2: { type: "square", semitones: 7, detune: 9, gain: 0.6 },
        noise: 0.3,
        fm: { ratio: 2, index: 3, decay: 0.4, sustain: 0.2 },
        sub: { gain: 0.4, type: "sine" },
        filterLfo: { rate: 3, depth: 900 },
        tremolo: { rate: 6, depth: 0.4 },
        vibrato: { rate: 5, depth: 20, delay: 0.1 },
        pitchEnv: { semitones: -7, time: 0.2 },
        attackNoise: { gain: 0.2, decay: 0.05, cutoff: 3000 }
      })
    ).not.toThrow();
  });

  it("with key tracking on, higher notes open the filter further", () => {
    const low = custom({ filterKeytrack: 1, filterFreq: 1000, attackNoise: undefined }, 48).get("filterFreq") ?? [];
    const high = custom({ filterKeytrack: 1, filterFreq: 1000, attackNoise: undefined }, 84).get("filterFreq") ?? [];
    expect(high[0].value).toBeGreaterThan(low[0].value);

    const flatLow = custom({ filterKeytrack: 0, filterFreq: 1000, attackNoise: undefined }, 48).get("filterFreq") ?? [];
    const flatHigh = custom({ filterKeytrack: 0, filterFreq: 1000, attackNoise: undefined }, 84).get("filterFreq") ?? [];
    expect(flatHigh[0].value).toBe(flatLow[0].value);
  });

  it("closes the filter over its own time when it has one", () => {
    const events = custom({ filterDecay: 1.5, decayTime: 0.2, attackNoise: undefined }).get("filterFreq") ?? [];
    const ramp = events.find((event) => event.method === "exponentialRamp");
    expect(ramp?.time).toBeCloseTo(1.5, 5);
  });
});

describe("wavetable sounds", () => {
  const destination = { connect: () => undefined } as unknown as AudioNode;

  const wavetable = (changes: Record<string, unknown>, held = false) => {
    const { context, events } = recordingContext();
    let oscillators = 0;
    let constants = 0;
    const makeOscillator = context.createOscillator.bind(context);
    const makeConstant = context.createConstantSource.bind(context);
    context.createOscillator = () => {
      oscillators += 1;
      return makeOscillator();
    };
    context.createConstantSource = () => {
      constants += 1;
      return makeConstant();
    };

    const base = {
      name: "Test",
      oscType: "sawtooth",
      detuneSpread: 0,
      filterType: "lowpass",
      filterFreq: 3000,
      filterEnvAmount: 0,
      filterQ: 1,
      attackTime: 0.01,
      decayTime: 0.3,
      sustainLevel: 0.7,
      releaseTime: 0.3,
      gain: 0.5,
      wt: {
        a: { table: "basic", pos: 0.5, level: 1, semitones: 0, fine: 0, unison: 1, detune: 12, width: 0.5 },
        b: { table: "pwm", pos: 0.2, level: 0, semitones: 0, fine: 0, unison: 1, detune: 12, width: 0.5 }
      },
      ...changes
    };
    const channel: Channel = { ...synthChannel("x"), synthPatch: sanitizeSynthPatch(base) };
    const voice = triggerChannel(context, channel, destination, {
      time: 0,
      velocity: 0.8,
      pitch: 60,
      duration: held ? null : 0.5
    });
    return { events, voice, count: () => ({ oscillators, constants }) };
  };

  const route = (source: string, dest: string, amount: number) => ({ source, dest, amount });
  const mod = (routes: unknown[]) => ({
    env2: { attack: 0.01, decay: 0.4, sustain: 0.3, release: 0.3 },
    lfo1: { shape: "sine", rate: 3 },
    lfo2: { shape: "triangle", rate: 0.5 },
    routes
  });

  it("plays plain wavetable oscillators with one oscillator per voice", () => {
    expect(wavetable({}).count().oscillators).toBe(1);
  });

  it("counts unison voices, and a second oscillator only once it has a level", () => {
    const unison = { table: "basic", pos: 0.5, level: 1, semitones: 0, fine: 0, unison: 7, detune: 20, width: 0.5 };
    expect(wavetable({ wt: { a: unison, b: { ...unison, level: 0 } } }).count().oscillators).toBe(7);
    expect(wavetable({ wt: { a: unison, b: { ...unison, level: 0.5 } } }).count().oscillators).toBe(14);
  });

  it("unison stays off without detune", () => {
    const flat = { table: "basic", pos: 0.5, level: 1, semitones: 0, fine: 0, unison: 7, detune: 0, width: 0.5 };
    expect(wavetable({ wt: { a: flat, b: { ...flat, level: 0 } } }).count().oscillators).toBe(1);
  });

  it("builds only the modulation sources that a route uses", () => {
    expect(wavetable({}).count().constants).toBe(0);
    expect(wavetable({ mod: mod([route("lfo1", "cutoff", 0.5)]) }).count().constants).toBe(0);
    expect(wavetable({ mod: mod([route("env2", "cutoff", 0.5), route("velocity", "volume", 0.3)]) }).count().constants).toBe(2);
  });

  it("a modulated position doubles the oscillators so it can morph", () => {
    const plain = wavetable({}).count().oscillators;
    const morphing = wavetable({ mod: mod([route("lfo1", "posA", 0.4)]) }).count().oscillators;
    // two oscillators for the voice, plus the LFO itself
    expect(morphing).toBe(plain * 2 + 1);
  });

  it("does not morph when the position route has no amount", () => {
    expect(wavetable({ mod: mod([route("lfo1", "posA", 0)]) }).count().oscillators).toBe(2); // the voice and its LFO
  });

  it("builds with every source aimed at every destination", () => {
    const routes = [
      route("env2", "cutoff", 0.6),
      route("lfo1", "resonance", 0.4),
      route("lfo2", "pitch", 0.05),
      route("velocity", "levelA", 0.2),
      route("key", "levelB", -0.3),
      route("env2", "posA", 0.5),
      route("lfo2", "posB", 0.7),
      route("lfo1", "volume", 0.25)
    ];
    const b = { table: "pwm", pos: 0.2, level: 0.5, semitones: 7, fine: 5, unison: 3, detune: 15, width: 0.5 };
    expect(() => wavetable({ mod: mod(routes), wt: { a: { table: "vowel", pos: 0.3, level: 1, semitones: 0, fine: 0, unison: 5, detune: 18, width: 0.8 }, b } }, true)).not.toThrow();
  });

  it("releases the modulation envelope along with the note", () => {
    const { voice, events } = wavetable({ mod: mod([route("env2", "cutoff", 0.5)]) }, true);
    voice?.release(1);
    const offset = events.get("constantOffset") ?? [];
    const ramps = offset.filter((event) => event.method === "linearRamp");
    // up to full, down to sustain, then the release to zero
    expect(ramps.length).toBeGreaterThanOrEqual(3);
    expect(ramps[ramps.length - 1].value).toBe(0);
    expect(ramps[ramps.length - 1].time).toBeCloseTo(1.3, 5);
  });

  it("keeps working notes that are bent, modulated and killed", () => {
    const { voice } = wavetable({ mod: mod([route("lfo1", "pitch", 0.1)]) }, true);
    expect(() => {
      voice?.bend?.(100, 0.1);
      voice?.modulate?.(0.5, 0.1);
      voice?.release(0.5);
      voice?.kill(0.6);
    }).not.toThrow();
  });
});
