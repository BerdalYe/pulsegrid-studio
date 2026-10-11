import { describe, expect, it } from "vitest";

import { GEN, parseSoundFont } from "./sf2";
import { buildSoundFont, sine } from "./testFont";
import { createSoundFontVoice } from "./voice";

interface Event {
  method: string;
  value: number;
  time: number;
}

/** A stand-in for Web Audio that remembers what was built and what was scheduled. */
function fakeContext() {
  const sources: Array<ReturnType<typeof makeSource>> = [];
  const gains: Array<{ gain: ReturnType<typeof makeParam> }> = [];
  const filters: Array<{ type: string; frequency: { value: number }; Q: { value: number } }> = [];
  const panners: Array<{ pan: { value: number } }> = [];

  function makeParam(initial = 1) {
    const events: Event[] = [];
    const param = {
      value: initial,
      events,
      setValueAtTime(value: number, time: number) {
        events.push({ method: "set", value, time });
        return param;
      },
      linearRampToValueAtTime(value: number, time: number) {
        events.push({ method: "linear", value, time });
        return param;
      },
      exponentialRampToValueAtTime(value: number, time: number) {
        events.push({ method: "exponential", value, time });
        return param;
      },
      setTargetAtTime(value: number, time: number) {
        events.push({ method: "target", value, time });
        return param;
      },
      cancelScheduledValues(time: number) {
        events.push({ method: "cancel", value: 0, time });
        return param;
      }
    };
    return param;
  }

  function makeSource() {
    return {
      buffer: null as null | { duration: number; length: number; sampleRate: number },
      playbackRate: makeParam(1),
      detune: makeParam(0),
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      startedAt: null as number | null,
      stoppedAt: null as number | null,
      onended: null as null | ((event?: unknown) => void),
      connect() {},
      disconnect() {},
      start(time: number) {
        this.startedAt = time;
      },
      stop(time: number) {
        this.stoppedAt = time;
      }
    };
  }

  const context = {
    sampleRate: 44100,
    createBuffer: (channels: number, length: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length)
    }),
    createBufferSource: () => {
      const source = makeSource();
      sources.push(source);
      return source;
    },
    createGain: () => {
      const node = { gain: makeParam(1), connect() {}, disconnect() {} };
      gains.push(node);
      return node;
    },
    createBiquadFilter: () => {
      const node = { type: "lowpass", frequency: { value: 0 }, Q: { value: 0 }, connect() {}, disconnect() {} };
      filters.push(node);
      return node;
    },
    createStereoPanner: () => {
      const node = { pan: { value: 0 }, connect() {}, disconnect() {} };
      panners.push(node);
      return node;
    },
    createOscillator: () => ({ frequency: { value: 0 }, connect() {}, start() {}, stop() {}, disconnect() {} })
  } as unknown as BaseAudioContext;

  return { context, sources, gains, filters, panners };
}

const destination = { connect() {} } as unknown as AudioNode;

/** A font with one recording at C4, tuned by whatever generators a test passes. */
function font(gens: Record<number, number> = {}, bank = 0, options: { rate?: number; loop?: [number, number] } = {}) {
  return parseSoundFont(
    buildSoundFont(
      [
        {
          name: "Tone",
          data: sine(4410),
          rate: options.rate ?? 44100,
          rootKey: 60,
          loopStart: options.loop?.[0],
          loopEnd: options.loop?.[1]
        }
      ],
      [{ name: "I", zones: [{ sample: 0, gens }] }],
      [{ name: "P", program: 0, bank, zones: [{ instrument: 0 }] }]
    )
  );
}

function play(
  loaded: ReturnType<typeof font>,
  options: { pitch?: number; velocity?: number; duration?: number | null; time?: number; tweaks?: Parameters<typeof createSoundFontVoice>[8]; owner?: string } = {},
  fake = fakeContext()
) {
  const voice = createSoundFontVoice(
    fake.context,
    loaded,
    loaded.presets[0],
    destination,
    options.time ?? 1,
    options.pitch ?? 60,
    options.velocity ?? 1,
    options.duration === undefined ? 1 : options.duration,
    options.tweaks,
    options.owner
  );
  return { voice, ...fake };
}

describe("playing a SoundFont note", () => {
  it("plays the recording at its own pitch for its own key, an octave up for twelve keys higher", () => {
    expect(play(font(), { pitch: 60 }).sources[0].playbackRate.value).toBeCloseTo(1, 5);
    expect(play(font(), { pitch: 72 }).sources[0].playbackRate.value).toBeCloseTo(2, 5);
    expect(play(font(), { pitch: 48 }).sources[0].playbackRate.value).toBeCloseTo(0.5, 5);
    expect(play(font(), { pitch: 67 }).sources[0].playbackRate.value).toBeCloseTo(Math.pow(2, 7 / 12), 5);
  });

  it("follows the instrument's tuning: fine, coarse, and how many cents each key is worth", () => {
    expect(play(font({ [GEN.coarseTune]: 12 })).sources[0].playbackRate.value).toBeCloseTo(2, 5);
    expect(play(font({ [GEN.fineTune]: 600 })).sources[0].playbackRate.value).toBeCloseTo(Math.SQRT2, 5);
    // A drum that doesn't follow the key: every key sounds the same.
    expect(play(font({ [GEN.scaleTuning]: 0 }), { pitch: 80 }).sources[0].playbackRate.value).toBeCloseTo(1, 5);
  });

  it("starts the recording at the time asked, on the audio clock", () => {
    const { sources } = play(font(), { time: 3.25 });
    expect(sources[0].startedAt).toBe(3.25);
  });

  it("makes a recording at its own sample rate, so the browser handles the rest", () => {
    const { sources } = play(font({}, 0, { rate: 22050 }));
    expect(sources[0].buffer?.sampleRate).toBe(22050);
    expect(sources[0].buffer?.length).toBe(4410);
  });

  it("loops a held sound between the points the instrument gives, in seconds", () => {
    const looped = play(font({ [GEN.sampleModes]: 1 }, 0, { loop: [1000, 3000] }));
    expect(looped.sources[0].loop).toBe(true);
    expect(looped.sources[0].loopStart).toBeCloseTo(1000 / 44100, 6);
    expect(looped.sources[0].loopEnd).toBeCloseTo(3000 / 44100, 6);

    expect(play(font({ [GEN.sampleModes]: 0 }, 0, { loop: [1000, 3000] })).sources[0].loop).toBe(false);
  });

  it("loops a very short cycle: the single-cycle waveform of a high synth note is under a millisecond", () => {
    // 40 frames at 48 kHz is 0.83 ms.
    const tiny = play(font({ [GEN.sampleModes]: 1 }, 0, { rate: 48000, loop: [60, 100] }));
    expect(tiny.sources[0].loop).toBe(true);
    expect(tiny.sources[0].loopEnd - tiny.sources[0].loopStart).toBeCloseTo(40 / 48000, 8);
  });

  it("does not loop when the loop points make no sense", () => {
    expect(play(font({ [GEN.sampleModes]: 1 }, 0, { loop: [3000, 3000] })).sources[0].loop).toBe(false);
  });

  it("plays nothing for a key the preset has no recording for", () => {
    const sparse = parseSoundFont(
      buildSoundFont([{ name: "A", data: sine(200) }], [{ name: "I", zones: [{ keyRange: [60, 72], sample: 0 }] }], [{ name: "P", program: 0, zones: [{ instrument: 0 }] }])
    );
    expect(play(sparse, { pitch: 20 }).voice).toBeNull();
    expect(play(sparse, { pitch: 66 }).voice).not.toBeNull();
  });

  it("makes harder notes louder, and soft ones follow the SoundFont's curve", () => {
    const peak = (velocity: number) => {
      const { gains } = play(font(), { velocity });
      return gains[0].gain.events.find((event) => event.method === "linear")!.value;
    };
    expect(peak(1)).toBeCloseTo(1, 3);
    expect(peak(0.5)).toBeCloseTo(0.25, 3);
    expect(peak(0.5)).toBeGreaterThan(peak(0.25));
  });

  it("makes the instrument quieter by its own attenuation", () => {
    const { gains } = play(font({ [GEN.initialAttenuation]: 200 }));
    // 200 centibels is 20 dB: a tenth of the level.
    expect(gains[0].gain.events.find((event) => event.method === "linear")!.value).toBeCloseTo(0.1, 3);
  });

  it("shapes the volume with the instrument's own envelope: rise, hold, fall to the sustain level", () => {
    const { gains } = play(font({ [GEN.attackVolEnv]: 0, [GEN.holdVolEnv]: 0, [GEN.decayVolEnv]: 0, [GEN.sustainVolEnv]: 200 }), { time: 2 });
    const events = gains[0].gain.events;
    expect(events[0]).toMatchObject({ method: "set", value: 0.0001, time: 2 });
    // Attack: one second (after the format's default thousandth-of-a-second delay), up to full.
    const rise = events.find((event) => event.method === "linear")!;
    expect(rise.value).toBe(1);
    expect(rise.time).toBeCloseTo(3, 2);
    // Decay: a second later, down by 20 dB.
    const fall = events.find((event) => event.method === "exponential")!;
    expect(fall.value).toBeCloseTo(0.1, 3);
    expect(fall.time).toBeCloseTo(5, 2);
  });

  it("lengthens or shortens the attack when asked", () => {
    const attackEnd = (scale: number) => {
      const { gains } = play(font({ [GEN.attackVolEnv]: 0 }), { time: 0, tweaks: { attack: scale } });
      return gains[0].gain.events.find((event) => event.method === "linear")!.time;
    };
    expect(attackEnd(1)).toBeCloseTo(1, 2);
    expect(attackEnd(2)).toBeCloseTo(2, 2);
    expect(attackEnd(0.5)).toBeCloseTo(0.5, 2);
  });

  it("lets go with the instrument's release when the note ends, and stops the sound after it", () => {
    const { gains, sources } = play(font({ [GEN.releaseVolEnv]: 0 }), { time: 1, duration: 2 });
    const events = gains[0].gain.events;
    // Released at 3 s, fading over its one-second release.
    const fade = events.filter((event) => event.method === "exponential").pop()!;
    expect(fade.value).toBe(0.0001);
    expect(fade.time).toBeCloseTo(4, 3);
    expect(sources[0].stoppedAt).toBeGreaterThan(4);
  });

  it("holds a note until it is released when no length is given, then fades", () => {
    const { voice, sources, gains } = play(font({ [GEN.releaseVolEnv]: 0 }), { duration: null });
    expect(sources[0].stoppedAt).toBeNull();
    voice!.release(5);
    expect(gains[0].gain.events.filter((event) => event.method === "exponential").pop()?.time).toBeCloseTo(6, 3);
    expect(sources[0].stoppedAt).toBeGreaterThan(6);
  });

  it("lengthens or shortens the release when asked", () => {
    const end = (scale: number) => {
      const { gains } = play(font({ [GEN.releaseVolEnv]: 0 }), { time: 0, duration: 1, tweaks: { release: scale } });
      return gains[0].gain.events.filter((event) => event.method === "exponential").pop()!.time;
    };
    expect(end(1)).toBeCloseTo(2, 3);
    expect(end(3)).toBeCloseTo(4, 3);
  });

  it("plays a drum kit's sound out whatever the length of the pad, ignoring the release", () => {
    const { sources, gains } = play(font({}, 128), { duration: 0.1 });
    expect(sources[0].stoppedAt).toBeNull();
    expect(gains[0].gain.events.some((event) => event.method === "exponential" && event.value === 0.0001)).toBe(false);
  });

  it("stops at once, with a short fade, when killed", () => {
    const { voice, sources, gains } = play(font(), { duration: null });
    voice!.kill(7);
    expect(sources[0].stoppedAt).toBeCloseTo(7.02, 5);
    expect(gains[0].gain.events.some((event) => event.method === "linear" && event.value === 0.0001 && Math.abs(event.time - 7.012) < 1e-6)).toBe(true);
  });

  it("bends the pitch of a held note", () => {
    const { voice, sources } = play(font(), { duration: null });
    voice!.bend!(100, 2);
    expect(sources[0].detune.events.some((event) => event.method === "target" && event.value === 100)).toBe(true);
  });

  it("moves the pitch by the transpose setting", () => {
    expect(play(font(), { pitch: 60, tweaks: { transpose: 12 } }).sources[0].playbackRate.value).toBeCloseTo(2, 5);
    expect(play(font(), { pitch: 60, tweaks: { transpose: -12 } }).sources[0].playbackRate.value).toBeCloseTo(0.5, 5);
  });

  it("plays one drum of a kit on every key, as recorded at C5 and tuned up or down from there", () => {
    // A drum's recording doesn't follow the key (scale tuning 0), as in every drum kit.
    const kit = font({ [GEN.scaleTuning]: 0 }, 128);
    expect(play(kit, { pitch: 60, tweaks: { fixedKey: 38 } }).sources[0].playbackRate.value).toBeCloseTo(1, 5);
    expect(play(kit, { pitch: 67, tweaks: { fixedKey: 38 } }).sources[0].playbackRate.value).toBeCloseTo(Math.pow(2, 7 / 12), 5);
    expect(play(kit, { pitch: 48, tweaks: { fixedKey: 38 } }).sources[0].playbackRate.value).toBeCloseTo(0.5, 5);
    expect(play(kit, { pitch: 60, tweaks: { fixedKey: 38, transpose: 12 } }).sources[0].playbackRate.value).toBeCloseTo(2, 5);
  });

  it("adds a low-pass filter where the instrument has one, at the frequency it asks for", () => {
    const filtered = play(font({ [GEN.initialFilterFc]: 9600, [GEN.initialFilterQ]: 100 }));
    expect(filtered.filters).toHaveLength(1);
    expect(filtered.filters[0].frequency.value).toBeCloseTo(8.176 * Math.pow(2, 9600 / 1200), 0);
    expect(filtered.filters[0].Q.value).toBeCloseTo(10, 5);

    // No filter asked for, and none added.
    expect(play(font()).filters).toHaveLength(0);
  });

  it("rolls off the highs when the brightness is turned down", () => {
    const dull = play(font(), { tweaks: { brightness: 0.5 } });
    expect(dull.filters).toHaveLength(1);
    expect(dull.filters[0].frequency.value).toBeLessThan(5000);
    expect(play(font(), { tweaks: { brightness: 1 } }).filters).toHaveLength(0);
  });

  it("pans a recording the way the instrument sets it", () => {
    const left = play(font({ [GEN.pan]: -500 }));
    expect(left.panners[0].pan.value).toBe(-1);
    // Centred recordings need no panner at all.
    expect(play(font()).panners).toHaveLength(0);
  });

  it("lets a closed hi-hat cut off an open one, for the same player only", () => {
    const hats = font({ [GEN.exclusiveClass]: 1 }, 128);
    const fake = fakeContext();
    const open = play(hats, { time: 1, owner: "drums" }, fake);
    expect(open.gains[0].gain.events.some((event) => event.method === "linear" && event.value === 0.0001)).toBe(false);

    play(hats, { time: 2, owner: "drums" }, fake);
    // The first hat is faded out at the moment the second starts.
    expect(fake.gains[0].gain.events.some((event) => event.method === "linear" && event.value === 0.0001 && Math.abs(event.time - 2.012) < 1e-6)).toBe(true);
    expect(fake.sources[0].stoppedAt).toBeCloseTo(2.02, 5);

    // Someone else's hat is left alone.
    const other = fakeContext();
    play(hats, { time: 1, owner: "drums" }, other);
    play(hats, { time: 2, owner: "another channel" }, other);
    expect(other.sources[0].stoppedAt).toBeNull();
  });

  it("caps how many recordings one note may start", () => {
    const many = parseSoundFont(
      buildSoundFont(
        Array.from({ length: 20 }, (_, index) => ({ name: `S${index}`, data: sine(100) })),
        [{ name: "Thick", zones: Array.from({ length: 20 }, (_, index) => ({ sample: index })) }],
        [{ name: "P", program: 0, zones: [{ instrument: 0 }] }]
      )
    );
    expect(play(many).sources.length).toBeLessThanOrEqual(8);
  });

  it("makes each recording's audio only once for a context", () => {
    const fake = fakeContext();
    let made = 0;
    const original = fake.context.createBuffer.bind(fake.context);
    fake.context.createBuffer = ((...args: Parameters<typeof original>) => {
      made += 1;
      return original(...args);
    }) as typeof fake.context.createBuffer;

    const loaded = font();
    play(loaded, {}, fake);
    play(loaded, { pitch: 72 }, fake);
    play(loaded, { pitch: 48 }, fake);
    expect(made).toBe(1);
  });
});
