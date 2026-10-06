import { describe, expect, it } from "vitest";

import { HARMONICS, WAVETABLES, getPeriodicWave, harmonicsAt, isWavetable, sampleWavetable } from "./wavetables";

describe("wavetables", () => {
  it("has a handful of tables with distinct ids", () => {
    expect(WAVETABLES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(WAVETABLES.map((table) => table.id)).size).toBe(WAVETABLES.length);
    expect(isWavetable("basic")).toBe(true);
    expect(isWavetable("nonsense")).toBe(false);
    expect(isWavetable(7)).toBe(false);
  });

  it("every table gives finite, audible harmonics at every position", () => {
    for (const table of WAVETABLES) {
      for (const position of [0, 0.13, 0.5, 0.87, 1]) {
        const { real, imag } = harmonicsAt(table.id, position);
        expect(real.length, table.id).toBe(HARMONICS + 1);
        let energy = 0;
        for (let n = 1; n <= HARMONICS; n++) {
          expect(Number.isFinite(real[n]) && Number.isFinite(imag[n]), `${table.id} @ ${position}`).toBe(true);
          energy += real[n] ** 2 + imag[n] ** 2;
        }
        expect(energy, `${table.id} @ ${position}`).toBeGreaterThan(1e-4);
      }
    }
  });

  it("every table actually changes along its position", () => {
    for (const table of WAVETABLES) {
      const start = sampleWavetable(table.id, 0);
      const end = sampleWavetable(table.id, 1);
      const difference = start.reduce((sum, value, i) => sum + Math.abs(value - end[i]), 0) / start.length;
      expect(difference, table.id).toBeGreaterThan(0.02);
    }
  });

  it("Basic Shapes runs from a sine to a square", () => {
    const sine = harmonicsAt("basic", 0);
    expect(Math.abs(sine.imag[1])).toBeGreaterThan(0.9);
    for (let n = 2; n <= 10; n++) expect(Math.abs(sine.imag[n]) + Math.abs(sine.real[n])).toBeLessThan(0.02);

    const square = harmonicsAt("basic", 1);
    // A square has only odd harmonics, falling as 1/n.
    expect(Math.abs(square.imag[2])).toBeLessThan(0.02);
    expect(Math.abs(square.imag[3])).toBeGreaterThan(0.2);
    expect(Math.abs(square.imag[3])).toBeLessThan(Math.abs(square.imag[1]));
  });

  it("draws a cycle scaled to fit the display", () => {
    for (const table of WAVETABLES) {
      const points = sampleWavetable(table.id, 0.4, 64);
      expect(points).toHaveLength(64);
      expect(Math.max(...points.map(Math.abs))).toBeCloseTo(1, 5);
    }
  });

  it("makes each browser wave once per context and position", () => {
    let made = 0;
    const context = {
      createPeriodicWave: () => {
        made += 1;
        return {} as PeriodicWave;
      }
    } as unknown as BaseAudioContext;

    const a = getPeriodicWave(context, "pwm", 0.5);
    const b = getPeriodicWave(context, "pwm", 0.5);
    getPeriodicWave(context, "pwm", 0.5001); // lands on the same cached step
    getPeriodicWave(context, "pwm", 0.9);
    expect(a).toBe(b);
    expect(made).toBe(2);
  });

  it("falls back to a real table for an unknown id", () => {
    expect(() => harmonicsAt("nope", 0.5)).not.toThrow();
  });
});
