import { describe, expect, it } from "vitest";

import { DRUM_TYPES } from "../lib/utils";
import { effectTypeDefs, defaultEffectParams } from "../audio/effectDefs";

import {
  INSTRUMENT_GROUPS,
  INSTRUMENT_MENU,
  availableInstruments,
  getSynthPreset,
  presetProjects,
  synthPresets,
  type SynthPresetDef
} from "./presets";

/** A4 = 440, so the lowest and highest notes the piano roll offers. */
const lowestFundamental = 440 * Math.pow(2, (24 - 69) / 12); // MIDI 24, ~32.7 Hz
const middleC = 440 * Math.pow(2, (60 - 69) / 12); // MIDI 60, ~261.6 Hz

describe("synth presets", () => {
  it("has unique ids", () => {
    const ids = synthPresets.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every envelope and gain value in a usable range", () => {
    for (const preset of synthPresets) {
      expect(preset.gain, preset.id).toBeGreaterThan(0);
      expect(preset.gain, preset.id).toBeLessThanOrEqual(1);
      expect(preset.sustainLevel, preset.id).toBeGreaterThanOrEqual(0);
      expect(preset.sustainLevel, preset.id).toBeLessThanOrEqual(1);
      expect(preset.attackTime, preset.id).toBeGreaterThanOrEqual(0);
      expect(preset.decayTime, preset.id).toBeGreaterThan(0);
      expect(preset.releaseTime, preset.id).toBeGreaterThan(0);
      expect(preset.filterFreq, preset.id).toBeGreaterThan(20);
      expect(preset.filterQ, preset.id).toBeGreaterThan(0);
    }
  });

  it("describes partials that stay inside the audible range", () => {
    for (const preset of synthPresets) {
      for (const partial of preset.partials ?? []) {
        expect(partial.ratio, preset.id).toBeGreaterThan(0);
        expect(partial.gain, preset.id).toBeGreaterThan(0);
        expect(partial.gain, preset.id).toBeLessThanOrEqual(1);
        // The voice skips partials past Nyquist, but one that is inaudible on
        // every note in range is just dead weight in the preset.
        expect(lowestFundamental * partial.ratio, preset.id).toBeLessThan(20000);
      }
    }
  });

  /**
   * `glass-bell` used to run a pure sine through a bandpass fixed at 2600 Hz,
   * which removed essentially the whole note below the top octave — it was
   * silent in normal playing. A band-limiting filter has to sit somewhere the
   * source actually has energy.
   */
  const hasEnergyInBand = (preset: SynthPresetDef): boolean => {
    // Rich waveforms have harmonics far above the fundamental.
    if (preset.oscType === "sawtooth" || preset.oscType === "square") return true;

    const ratios = [1, ...(preset.partials ?? []).map((partial) => partial.ratio)];
    const band = preset.filterFreq;

    // Judge at a note someone would actually play. Checking the extremes of the
    // range lets a preset pass on the strength of its top octave alone, which
    // is exactly how the silent bell slipped through in the first place.
    return ratios.some((ratio) => {
      const partialHz = middleC * ratio;
      return partialHz >= band / 2 && partialHz <= band * 2;
    });
  };

  it("never band-limits a pure tone away from all of its energy", () => {
    for (const preset of synthPresets) {
      if (preset.filterType !== "bandpass" && preset.filterType !== "highpass") continue;
      expect(hasEnergyInBand(preset), `${preset.id} is filtered into silence`).toBe(true);
    }
  });
});

describe("instrument menu", () => {
  it("only offers presets that exist", () => {
    for (const entry of INSTRUMENT_MENU) {
      if (!entry.preset) continue;
      expect(getSynthPreset(entry.preset), `${entry.label} -> ${entry.preset}`).toBeDefined();
    }
  });

  it("gives every synth entry a preset", () => {
    for (const entry of INSTRUMENT_MENU) {
      // A recorded instrument plays from a SoundFont, not from a synth preset.
      if (entry.type === "synth" && !entry.soundfont && !entry.midiOut) expect(entry.preset, entry.label).toBeTruthy();
    }
  });

  it("has no duplicate labels", () => {
    const labels = INSTRUMENT_MENU.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("puts every entry in a group the pickers actually render", () => {
    for (const entry of INSTRUMENT_MENU) {
      expect(INSTRUMENT_GROUPS, entry.label).toContain(entry.group);
    }
  });

  it("leaves no group empty", () => {
    for (const group of INSTRUMENT_GROUPS) {
      expect(
        INSTRUMENT_MENU.some((entry) => entry.group === group),
        `${group} has no instruments`
      ).toBe(true);
    }
  });

  /**
   * The channel rack used to carry its own list of five raw channel types, so
   * picking "Synth" gave you an unnamed default instead of any of the named
   * instruments. Both pickers read this table now; this keeps it that way.
   */
  it("offers every synth preset somewhere in the list", () => {
    const offered = new Set(
      INSTRUMENT_MENU.map((entry) => entry.preset).filter((id): id is string => Boolean(id))
    );

    for (const preset of synthPresets) {
      expect(offered.has(preset.id), `${preset.name} is not reachable from any picker`).toBe(true);
    }
  });

  it("covers every channel type", () => {
    const types = new Set(INSTRUMENT_MENU.map((entry) => entry.type));
    for (const type of [...DRUM_TYPES, "synth", "sample"]) {
      expect(types.has(type as never), `no way to add a ${type} channel`).toBe(true);
    }
  });
});

describe("demo projects", () => {
  it("only reference synth presets that exist", () => {
    for (const preset of presetProjects) {
      const project = preset.create();

      for (const channel of project.channels) {
        if (!channel.synthPreset) continue;
        expect(
          getSynthPreset(channel.synthPreset),
          `${preset.name} / ${channel.name} -> ${channel.synthPreset}`
        ).toBeDefined();
      }
    }
  });
});

describe("synth engine settings", () => {
  it("keeps the newer synth options in a usable range", () => {
    for (const preset of synthPresets) {
      if (preset.unison !== undefined) {
        expect(preset.unison, preset.id).toBeGreaterThanOrEqual(3);
        expect(preset.unison, preset.id).toBeLessThanOrEqual(9);
        expect(preset.detuneSpread, `${preset.id} sets unison without detune`).toBeGreaterThan(0);
      }
      if (preset.stereoSpread !== undefined) {
        expect(preset.stereoSpread, preset.id).toBeGreaterThanOrEqual(0);
        expect(preset.stereoSpread, preset.id).toBeLessThanOrEqual(1);
      }
      if (preset.fm) {
        expect(preset.fm.ratio, preset.id).toBeGreaterThan(0);
        expect(preset.fm.index, preset.id).toBeGreaterThan(0);
        expect(preset.fm.index, preset.id).toBeLessThanOrEqual(10);
      }
      if (preset.tremolo) {
        expect(preset.tremolo.depth, preset.id).toBeLessThanOrEqual(1);
      }
      if (preset.sub) {
        expect(preset.sub.gain, preset.id).toBeLessThanOrEqual(1);
      }
    }
  });

  it("offers at least fifty instruments", () => {
    expect(INSTRUMENT_MENU.length).toBeGreaterThanOrEqual(50);
  });
});

describe("effect plugins", () => {
  it("gives every parameter a default inside its own range", () => {
    for (const def of effectTypeDefs) {
      const defaults = defaultEffectParams(def.type);
      for (const param of def.params) {
        const value = defaults[param.key];
        expect(value, `${def.type}.${param.key}`).toBeGreaterThanOrEqual(param.min);
        expect(value, `${def.type}.${param.key}`).toBeLessThanOrEqual(param.max);
      }
    }
  });

  it("has unique effect types", () => {
    const types = effectTypeDefs.map((def) => def.type);
    expect(new Set(types).size).toBe(types.length);
  });
});
describe("plugins", () => {
  it("offers the Wavetable Synth first, as a plugin that opens its editor when added", () => {
    expect(INSTRUMENT_GROUPS[0]).toBe("Plugins");

    const plugins = INSTRUMENT_MENU.filter((entry) => entry.group === "Plugins");
    expect(plugins.length).toBeGreaterThanOrEqual(1);
    for (const entry of plugins) {
      expect(entry.plugin, entry.label).toBe(true);
      expect(entry.type, entry.label).toBe("synth");
    }

    const wavetable = plugins.find((entry) => entry.label === "Wavetable Synth");
    expect(wavetable?.preset).toBe("wt-init");
    expect(getSynthPreset(wavetable?.preset)?.wt).toBeDefined();
  });

  it("is the only kind of entry that opens an editor when added", () => {
    for (const entry of INSTRUMENT_MENU) {
      if (entry.plugin) expect(entry.group).toBe("Plugins");
    }
  });
});

describe("recorded instruments", () => {
  const recorded = INSTRUMENT_MENU.filter((entry) => entry.group === "Recorded instruments");

  it("offers a good spread of them, each with a bank and program inside General MIDI's range", () => {
    expect(recorded.length).toBeGreaterThanOrEqual(30);
    for (const entry of recorded) {
      expect(entry.soundfont, entry.label).toBeDefined();
      expect([0, 128], entry.label).toContain(entry.soundfont!.bank);
      expect(entry.soundfont!.program, entry.label).toBeGreaterThanOrEqual(0);
      expect(entry.soundfont!.program, entry.label).toBeLessThanOrEqual(127);
      expect(entry.label, entry.label).toMatch(/\(recorded\)$/);
    }
  });

  it("includes drum kits as well as melodic instruments", () => {
    expect(recorded.some((entry) => entry.soundfont!.bank === 128)).toBe(true);
    expect(recorded.some((entry) => entry.soundfont!.bank === 0)).toBe(true);
  });

  it("has a SoundFont Instrument plugin that opens its own picker", () => {
    const plugin = INSTRUMENT_MENU.find((entry) => entry.label === "SoundFont Instrument");
    expect(plugin).toMatchObject({ group: "Plugins", plugin: true, type: "synth" });
    expect(plugin?.soundfont).toBeDefined();
  });

  it("leaves out the recorded ones where the built-in set isn't there, and keeps everything else", () => {
    const without = availableInstruments(false);
    expect(without.some((entry) => entry.group === "Recorded instruments")).toBe(false);
    expect(without.some((entry) => entry.label === "SoundFont Instrument")).toBe(true);
    expect(without.some((entry) => entry.label === "Kick")).toBe(true);

    expect(availableInstruments(true)).toHaveLength(INSTRUMENT_MENU.length);
    // Not known yet: offer everything.
    expect(availableInstruments(null)).toHaveLength(INSTRUMENT_MENU.length);
  });
});
