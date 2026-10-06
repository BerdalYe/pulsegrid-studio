import { describe, expect, it } from "vitest";

import { patchFromPreset, patchToPreset, sanitizeSynthPatch } from "./synthPatch";
import { synthPresets } from "../presets/presets";

describe("sanitizeSynthPatch", () => {
  it("ignores anything that isn't a sound", () => {
    expect(sanitizeSynthPatch(undefined)).toBeUndefined();
    expect(sanitizeSynthPatch(null)).toBeUndefined();
    expect(sanitizeSynthPatch("saw")).toBeUndefined();
    expect(sanitizeSynthPatch([1, 2])).toBeUndefined();
  });

  it("fills in a playable sound from nothing", () => {
    const patch = sanitizeSynthPatch({});
    expect(patch).toBeDefined();
    expect(patch?.oscType).toBe("sawtooth");
    expect(patch?.filterType).toBe("lowpass");
    expect(patch?.gain).toBeGreaterThan(0);
  });

  it("clamps every number into the range the engine can handle", () => {
    const patch = sanitizeSynthPatch({
      oscType: "wobble",
      filterType: "notch-ish",
      filterFreq: 9e9,
      filterQ: -4,
      attackTime: 0,
      releaseTime: 1e6,
      gain: 12,
      sustainLevel: Number.NaN,
      detuneSpread: Number.POSITIVE_INFINITY,
      unison: 99,
      osc2: { type: "square", semitones: 400, detune: -4000, gain: 9 },
      fm: { ratio: 0, index: 1e9, decay: -1 }
    });

    expect(patch?.oscType).toBe("sawtooth");
    expect(patch?.filterType).toBe("lowpass");
    expect(patch?.filterFreq).toBe(18000);
    expect(patch?.filterQ).toBe(0.1);
    expect(patch?.attackTime).toBe(0.001);
    expect(patch?.releaseTime).toBe(6);
    expect(patch?.gain).toBe(1);
    expect(patch?.sustainLevel).toBe(0.7);
    expect(patch?.unison).toBe(9);
    expect(patch?.osc2).toEqual({ type: "square", semitones: 24, detune: -100, gain: 1 });
    expect(patch?.fm?.ratio).toBe(0.25);
    expect(patch?.fm?.index).toBe(12);
    expect(patch?.fm?.decay).toBe(0.01);
  });

  it("keeps unison to an odd number of voices", () => {
    expect(sanitizeSynthPatch({ unison: 4 })?.unison).toBe(5);
    expect(sanitizeSynthPatch({ unison: 6 })?.unison).toBe(7);
  });

  it("limits the partials and drops junk entries", () => {
    const partials = Array.from({ length: 30 }, () => ({ ratio: 2, gain: 0.1 }));
    expect(sanitizeSynthPatch({ partials })?.partials).toHaveLength(8);
    expect(sanitizeSynthPatch({ partials: [null, 3, "x"] })?.partials).toBeUndefined();
  });

  it("names an unnamed sound and shortens a very long name", () => {
    expect(sanitizeSynthPatch({ name: "   " })?.name).toBe("Custom sound");
    expect(sanitizeSynthPatch({ name: "x".repeat(200) })?.name).toHaveLength(40);
  });
});

describe("presets and patches", () => {
  it("every preset survives a trip through a patch unchanged", () => {
    for (const preset of synthPresets) {
      const patch = patchFromPreset(preset);
      expect("id" in patch).toBe(false);

      const clean = sanitizeSynthPatch(patch);
      expect(clean, preset.id).toBeDefined();
      // Numbers the sanitiser had to move would mean a preset sounds different once copied.
      expect(clean?.filterFreq, preset.id).toBe(patch.filterFreq);
      expect(clean?.attackTime, preset.id).toBe(patch.attackTime);
      expect(clean?.releaseTime, preset.id).toBe(patch.releaseTime);
      expect(clean?.detuneSpread, preset.id).toBe(patch.detuneSpread);
      expect(clean?.filterQ, preset.id).toBe(patch.filterQ);
    }
  });

  it("copying a preset does not share anything with the original", () => {
    const source = synthPresets.find((preset) => preset.partials) ?? synthPresets[0];
    const copy = patchFromPreset(source);
    if (copy.partials) copy.partials[0].gain = 0.99;
    expect(source.partials?.[0].gain).not.toBe(0.99);
  });

  it("turns a patch back into something the engine plays", () => {
    const preset = patchToPreset({ ...patchFromPreset(synthPresets[0]), name: "Mine" });
    expect(preset.id).toBe("custom");
    expect(preset.name).toBe("Mine");
  });
});

describe("wavetable and modulation settings", () => {
  it("leaves them out of a plain sound", () => {
    const patch = sanitizeSynthPatch({});
    expect(patch?.wt).toBeUndefined();
    expect(patch?.mod).toBeUndefined();
  });

  it("fills in both wavetable oscillators and clamps them", () => {
    const patch = sanitizeSynthPatch({
      wt: { a: { table: "nope", pos: 9, level: -3, semitones: 99, fine: -999, unison: 4, detune: 1e9, width: 7 } }
    });
    expect(patch?.wt?.a).toEqual({ table: "basic", pos: 1, level: 0, semitones: 36, fine: -100, unison: 5, detune: 60, width: 1 });
    // B was missing: it exists, but is silent
    expect(patch?.wt?.b.level).toBe(0);
  });

  it("keeps only routes that make sense, and no more than eight", () => {
    const routes = [
      { source: "lfo1", dest: "cutoff", amount: 0.5 },
      { source: "lfo1", dest: "cutoff", amount: 4 },
      { source: "mouse", dest: "cutoff", amount: 0.5 },
      { source: "lfo1", dest: "volume-of-the-moon", amount: 0.5 },
      null,
      "x",
      ...Array.from({ length: 20 }, () => ({ source: "env2", dest: "pitch", amount: 0.1 }))
    ];
    const patch = sanitizeSynthPatch({ mod: { routes } });
    expect(patch?.mod?.routes).toHaveLength(8);
    expect(patch?.mod?.routes[1].amount).toBe(1);
    expect(patch?.mod?.routes.every((route) => route.source !== ("mouse" as string))).toBe(true);
  });

  it("clamps the envelope and LFO settings", () => {
    const patch = sanitizeSynthPatch({
      mod: { env2: { attack: 0, release: 1e9, sustain: 5 }, lfo1: { shape: "wobble", rate: 1e6 } }
    });
    expect(patch?.mod?.env2.attack).toBe(0.001);
    expect(patch?.mod?.env2.release).toBe(6);
    expect(patch?.mod?.env2.sustain).toBe(1);
    expect(patch?.mod?.lfo1).toEqual({ shape: "sine", rate: 20 });
  });
});

describe("wavetable presets", () => {
  it("keep their wavetable and modulation settings exactly when copied into the editor", () => {
    const wavetablePresets = synthPresets.filter((preset) => preset.wt);
    expect(wavetablePresets.length).toBeGreaterThanOrEqual(10);

    for (const preset of wavetablePresets) {
      const clean = sanitizeSynthPatch(patchFromPreset(preset));
      expect(clean?.wt, preset.id).toEqual(preset.wt);
      if (preset.mod) {
        expect(clean?.mod, preset.id).toEqual(preset.mod);
        expect(preset.mod.routes.length, preset.id).toBeLessThanOrEqual(8);
      }
    }
  });
});
