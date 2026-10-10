import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GEN, findPreset, parseSoundFont, zonesFor } from "./sf2";
import { buildSoundFont, sine } from "./testFont";

/** One instrument with a low and a high recording, in a preset of its own. */
function simpleFont() {
  return parseSoundFont(
    buildSoundFont(
      [
        { name: "Low", data: sine(400), rootKey: 48, loopStart: 100, loopEnd: 300 },
        { name: "High", data: sine(300), rootKey: 72, rate: 22050 }
      ],
      [
        {
          name: "Pair",
          zones: [
            { keyRange: [0, 59], sample: 0, gens: { [GEN.sampleModes]: 1 } },
            { keyRange: [60, 127], sample: 1 }
          ]
        }
      ],
      [{ name: "Test Piano", program: 0, zones: [{ instrument: 0 }] }]
    ),
    "test.sf2"
  );
}

describe("reading a SoundFont", () => {
  it("finds the presets, instruments and recordings", () => {
    const font = simpleFont();
    expect(font.name).toBe("test");
    expect(font.presets.map((preset) => preset.name)).toEqual(["Test Piano"]);
    expect(font.instruments.map((instrument) => instrument.name)).toEqual(["Pair"]);
    expect(font.samples.map((sample) => sample.name)).toEqual(["Low", "High"]);
    expect(font.samples[0]).toMatchObject({ originalPitch: 48, sampleRate: 44100 });
    expect(font.samples[1]).toMatchObject({ originalPitch: 72, sampleRate: 22050 });
  });

  it("keeps the recorded audio exactly, viewed in place", () => {
    const font = simpleFont();
    const low = font.samples[0];
    expect(low.end - low.start).toBe(400);
    expect(Array.from(font.pcm.slice(low.start, low.start + 5))).toEqual(Array.from(sine(400).slice(0, 5)));
    // The loop points are counted from the start of the file's sample data.
    expect(low.loopStart - low.start).toBe(100);
    expect(low.loopEnd - low.start).toBe(300);
  });

  it("finds a preset by bank and program", () => {
    const font = simpleFont();
    expect(findPreset(font, 0, 0)?.name).toBe("Test Piano");
    expect(findPreset(font, 0, 1)).toBeUndefined();
    expect(findPreset(font, 128, 0)).toBeUndefined();
  });

  it("refuses anything that isn't a SoundFont", () => {
    expect(() => parseSoundFont(new ArrayBuffer(0))).toThrow(/isn't a SoundFont/);
    expect(() => parseSoundFont(new TextEncoder().encode("RIFF....WAVEfmt ").buffer as ArrayBuffer)).toThrow(/isn't a SoundFont/);
    expect(() => parseSoundFont(new TextEncoder().encode("hello world, not audio at all").buffer as ArrayBuffer)).toThrow();
  });

  it("refuses a SoundFont with its sample data cut off", () => {
    const whole = new Uint8Array(buildSoundFont([{ name: "A", data: sine(100) }], [{ name: "I", zones: [{ sample: 0 }] }], [{ name: "P", program: 0, zones: [{ instrument: 0 }] }]));
    // Keep only the start of the file: the header and the first chunks.
    expect(() => parseSoundFont(whole.slice(0, 80).buffer)).toThrow();
  });
});

describe("which recordings play a note", () => {
  it("picks the recording by key", () => {
    const font = simpleFont();
    const preset = font.presets[0];
    expect(zonesFor(font, preset, 40, 100).map((zone) => zone.sample.name)).toEqual(["Low"]);
    expect(zonesFor(font, preset, 59, 100).map((zone) => zone.sample.name)).toEqual(["Low"]);
    expect(zonesFor(font, preset, 60, 100).map((zone) => zone.sample.name)).toEqual(["High"]);
    expect(zonesFor(font, preset, 100, 100).map((zone) => zone.sample.name)).toEqual(["High"]);
  });

  it("picks by how hard the note is struck", () => {
    const font = parseSoundFont(
      buildSoundFont(
        [{ name: "Soft", data: sine(200) }, { name: "Hard", data: sine(200) }],
        [{ name: "Layers", zones: [{ velRange: [0, 80], sample: 0 }, { velRange: [81, 127], sample: 1 }] }],
        [{ name: "P", program: 0, zones: [{ instrument: 0 }] }]
      )
    );
    const preset = font.presets[0];
    expect(zonesFor(font, preset, 60, 40).map((zone) => zone.sample.name)).toEqual(["Soft"]);
    expect(zonesFor(font, preset, 60, 81).map((zone) => zone.sample.name)).toEqual(["Hard"]);
  });

  it("plays nothing where the preset has no recording", () => {
    const font = parseSoundFont(
      buildSoundFont([{ name: "A", data: sine(200) }], [{ name: "I", zones: [{ keyRange: [60, 72], sample: 0 }] }], [{ name: "P", program: 0, zones: [{ instrument: 0 }] }])
    );
    expect(zonesFor(font, font.presets[0], 30, 100)).toEqual([]);
    expect(zonesFor(font, font.presets[0], 66, 100)).toHaveLength(1);
  });

  it("layers every recording that covers the note", () => {
    const font = parseSoundFont(
      buildSoundFont(
        [{ name: "L", data: sine(200), type: 4 }, { name: "R", data: sine(200), type: 2 }],
        [{ name: "Stereo", zones: [{ sample: 0, gens: { [GEN.pan]: -500 } }, { sample: 1, gens: { [GEN.pan]: 500 } }] }],
        [{ name: "P", program: 0, zones: [{ instrument: 0 }] }]
      )
    );
    const zones = zonesFor(font, font.presets[0], 60, 100);
    expect(zones.map((zone) => zone.pan)).toEqual([-1, 1]);
  });

  it("reads tuning, looping and the root key", () => {
    const font = simpleFont();
    const [low] = zonesFor(font, font.presets[0], 40, 100);
    expect(low.rootKey).toBe(48);
    expect(low.loop).toBe(true);
    expect(low.scaleTuning).toBe(100);
    expect(low.tuneCents).toBe(0);

    const [high] = zonesFor(font, font.presets[0], 80, 100);
    expect(high.loop).toBe(false);
  });

  it("lets the instrument override the recording's root key, and adds coarse and fine tuning", () => {
    const font = parseSoundFont(
      buildSoundFont(
        [{ name: "A", data: sine(200), rootKey: 60, pitchCorrection: 5 }],
        [{ name: "I", zones: [{ sample: 0, gens: { [GEN.overridingRootKey]: 55, [GEN.coarseTune]: 2, [GEN.fineTune]: 30 } }] }],
        [{ name: "P", program: 0, zones: [{ instrument: 0 }] }]
      )
    );
    const [zone] = zonesFor(font, font.presets[0], 60, 100);
    expect(zone.rootKey).toBe(55);
    expect(zone.tuneCents).toBe(2 * 100 + 30 + 5);
  });

  it("gives a zone the instrument's global settings unless it sets its own", () => {
    const font = parseSoundFont(
      buildSoundFont(
        [{ name: "A", data: sine(200) }, { name: "B", data: sine(200) }],
        [
          {
            name: "I",
            global: { gens: { [GEN.attackVolEnv]: 0, [GEN.initialAttenuation]: 100 } },
            zones: [{ keyRange: [0, 59], sample: 0 }, { keyRange: [60, 127], sample: 1, gens: { [GEN.initialAttenuation]: 300 } }]
          }
        ],
        [{ name: "P", program: 0, zones: [{ instrument: 0 }] }]
      )
    );
    const [first] = zonesFor(font, font.presets[0], 30, 100);
    const [second] = zonesFor(font, font.presets[0], 80, 100);
    expect(first.attenuationCb).toBe(100);
    expect(second.attenuationCb).toBe(300);
    // An attack of 0 timecents is one second.
    expect(first.attack).toBeCloseTo(1, 5);
    expect(second.attack).toBeCloseTo(1, 5);
  });

  it("adds the preset's settings to the instrument's, but not the ones only an instrument can set", () => {
    const font = parseSoundFont(
      buildSoundFont(
        [{ name: "A", data: sine(200), rootKey: 60 }],
        [{ name: "I", zones: [{ sample: 0, gens: { [GEN.coarseTune]: 1, [GEN.sampleModes]: 0, [GEN.exclusiveClass]: 4 } }] }],
        [{ name: "P", program: 0, zones: [{ instrument: 0, gens: { [GEN.coarseTune]: 12, [GEN.sampleModes]: 1, [GEN.exclusiveClass]: 9, [GEN.initialAttenuation]: 50 } }] }]
      )
    );
    const [zone] = zonesFor(font, font.presets[0], 60, 100);
    expect(zone.tuneCents).toBe((1 + 12) * 100);
    expect(zone.attenuationCb).toBe(50);
    expect(zone.loop).toBe(false);
    expect(zone.exclusiveClass).toBe(4);
  });

  it("uses the preset's global zone for what a preset zone leaves out", () => {
    const font = parseSoundFont(
      buildSoundFont(
        [{ name: "A", data: sine(200) }],
        [{ name: "I", zones: [{ sample: 0 }] }],
        [{ name: "P", program: 0, global: { gens: { [GEN.initialAttenuation]: 120 } }, zones: [{ instrument: 0 }] }]
      )
    );
    expect(zonesFor(font, font.presets[0], 60, 100)[0].attenuationCb).toBe(120);
  });

  it("turns envelope times from timecents into seconds, with sensible limits", () => {
    const font = parseSoundFont(
      buildSoundFont(
        [{ name: "A", data: sine(200) }],
        [{ name: "I", zones: [{ sample: 0, gens: { [GEN.attackVolEnv]: 1200, [GEN.releaseVolEnv]: -1200, [GEN.sustainVolEnv]: 30000 } }] }],
        [{ name: "P", program: 0, zones: [{ instrument: 0 }] }]
      )
    );
    const [zone] = zonesFor(font, font.presets[0], 60, 100);
    expect(zone.attack).toBeCloseTo(2, 5);
    expect(zone.release).toBeCloseTo(0.5, 5);
    expect(zone.sustainCb).toBe(1440);
    // Nothing set: a thousandth of a second, not zero.
    expect(zone.delay).toBeGreaterThan(0);
    expect(zone.delay).toBeLessThan(0.002);
  });

  it("makes high notes shorter when the instrument asks (key-number scaling of the decay)", () => {
    const font = parseSoundFont(
      buildSoundFont(
        [{ name: "A", data: sine(200) }],
        [{ name: "I", zones: [{ sample: 0, gens: { [GEN.decayVolEnv]: 0, [GEN.keynumToVolEnvDecay]: 50 } }] }],
        [{ name: "P", program: 0, zones: [{ instrument: 0 }] }]
      )
    );
    const low = zonesFor(font, font.presets[0], 48, 100)[0].decay;
    const middle = zonesFor(font, font.presets[0], 60, 100)[0].decay;
    const high = zonesFor(font, font.presets[0], 72, 100)[0].decay;
    expect(middle).toBeCloseTo(1, 5);
    expect(low).toBeGreaterThan(middle);
    expect(high).toBeLessThan(middle);
  });
});

/** The real GeneralUser GS file, when it is there, to be sure the reader copes with a full-size one. */
describe.skipIf(!existsSync("assets/soundfonts/GeneralUser-GS.sf2"))("the built-in GeneralUser GS set", () => {
  const raw = readFileSync("assets/soundfonts/GeneralUser-GS.sf2");
  const font = parseSoundFont(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer, "GeneralUser-GS.sf2");

  it("has the General MIDI instruments, and the drum kits", () => {
    expect(font.presets.length).toBeGreaterThanOrEqual(260);
    // All 128 General MIDI melodic instruments are in the ordinary bank.
    for (let program = 0; program < 128; program++) {
      expect(findPreset(font, 0, program), `program ${program}`).toBeDefined();
    }
    expect(findPreset(font, 128, 0)?.name).toMatch(/standard/i);
  });

  it("plays every instrument on every key from C1 to C7, with no silent gaps", () => {
    for (let program = 0; program < 128; program++) {
      const preset = findPreset(font, 0, program)!;
      for (let key = 24; key <= 96; key++) {
        expect(zonesFor(font, preset, key, 100).length, `${preset.name} at ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("includes the tiny looped waveforms synth leads use, whose loops are shorter than a millisecond", () => {
    const lead = findPreset(font, 0, 80)!;
    const [zone] = zonesFor(font, lead, 90, 100);
    const loopFrames = zone.sample.loopEnd - zone.sample.loopStart;
    expect(zone.loop).toBe(true);
    expect(loopFrames / zone.sample.sampleRate).toBeLessThan(0.001);
  });

  it("has every instrument the Add menu offers, and each one makes sound at middle C or on the kick", async () => {
    const { INSTRUMENT_MENU } = await import("../../presets/presets");
    for (const entry of INSTRUMENT_MENU) {
      if (!entry.soundfont) continue;
      const preset = findPreset(font, entry.soundfont.bank, entry.soundfont.program);
      expect(preset, entry.label).toBeDefined();
      const key = entry.soundfont.bank === 128 ? 36 : 60;
      expect(zonesFor(font, preset!, key, 100).length, entry.label).toBeGreaterThan(0);
    }
  });

  it("has a kick, a snare and both hi-hats in the standard kit, with the hats cutting each other off", () => {
    const kit = findPreset(font, 128, 0)!;
    for (const key of [36, 38, 42, 46]) expect(zonesFor(font, kit, key, 100).length, `key ${key}`).toBeGreaterThan(0);

    const closed = zonesFor(font, kit, 42, 100).map((zone) => zone.exclusiveClass);
    const open = zonesFor(font, kit, 46, 100).map((zone) => zone.exclusiveClass);
    expect(closed.some((value) => value > 0 && open.includes(value))).toBe(true);
  });
});
