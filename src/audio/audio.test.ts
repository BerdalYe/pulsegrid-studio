import { describe, expect, it } from "vitest";

import { encodeWav } from "./wav";
import { evaluateAutomation } from "./sequencer";
import { defaultEffectParams, getEffectDef, effectTypeDefs } from "./effectDefs";
import type { AutomationClip } from "../types";

describe("encodeWav", () => {
  const channels = [
    new Float32Array([0, 0.5, -0.5, 1]),
    new Float32Array([0, -0.5, 0.5, -1])
  ];

  it("writes a valid RIFF/WAVE header", () => {
    const buffer = encodeWav(channels, 44100, 4);
    const view = new DataView(buffer);
    const text = (offset: number) =>
      String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );

    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(text(12)).toBe("fmt ");
    expect(text(36)).toBe("data");

    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16); // bit depth
  });

  it("sizes the buffer from the frame count", () => {
    const buffer = encodeWav(channels, 44100, 4);
    // 44-byte header + 4 frames × 2 channels × 2 bytes.
    expect(buffer.byteLength).toBe(44 + 16);

    const view = new DataView(buffer);
    expect(view.getUint32(4, true)).toBe(36 + 16);
    expect(view.getUint32(40, true)).toBe(16);
  });

  it("interleaves channels and clamps to full scale", () => {
    const buffer = encodeWav(channels, 44100, 4);
    const view = new DataView(buffer);

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0);
    // Sample 4 is +1.0 left / −1.0 right.
    expect(view.getInt16(44 + 12, true)).toBe(32767);
    expect(view.getInt16(44 + 14, true)).toBe(-32768);
  });

  it("survives values outside the -1..1 range", () => {
    const hot = [new Float32Array([4, -4])];
    const view = new DataView(encodeWav(hot, 44100, 2));

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});

describe("evaluateAutomation", () => {
  const clip: AutomationClip = {
    id: "a",
    type: "automation",
    trackIndex: 0,
    startStep: 0,
    name: "Master volume",
    durationSteps: 16,
    targetType: "master",
    targetId: "master",
    targetParam: "volume",
    points: [
      { id: "p1", step: 0, value: 0 },
      { id: "p2", step: 8, value: 1 },
      { id: "p3", step: 16, value: 0.5 }
    ]
  };

  it("returns the exact value at a point", () => {
    expect(evaluateAutomation(clip, 0)).toBe(0);
    expect(evaluateAutomation(clip, 8)).toBe(1);
    expect(evaluateAutomation(clip, 16)).toBe(0.5);
  });

  it("interpolates between points", () => {
    expect(evaluateAutomation(clip, 4)).toBeCloseTo(0.5, 6);
    expect(evaluateAutomation(clip, 12)).toBeCloseTo(0.75, 6);
  });

  it("holds the end values outside the point range", () => {
    expect(evaluateAutomation(clip, -5)).toBe(0);
    expect(evaluateAutomation(clip, 40)).toBe(0.5);
  });

  it("handles a clip with a single point", () => {
    const single = { ...clip, points: [{ id: "only", step: 4, value: 0.3 }] };
    expect(evaluateAutomation(single, 0)).toBe(0.3);
    expect(evaluateAutomation(single, 99)).toBe(0.3);
  });

  it("doesn't divide by zero when two points share a step", () => {
    const stacked = {
      ...clip,
      points: [
        { id: "a", step: 4, value: 0.2 },
        { id: "b", step: 4, value: 0.8 }
      ]
    };

    expect(Number.isFinite(evaluateAutomation(stacked, 4))).toBe(true);
  });
});

describe("effect definitions", () => {
  it("has defaults inside the declared range for every parameter", () => {
    for (const def of effectTypeDefs) {
      const defaults = defaultEffectParams(def.type);

      for (const param of def.params) {
        const value = defaults[param.key];
        expect(value, `${def.type}.${param.key}`).toBeTypeOf("number");
        expect(value).toBeGreaterThanOrEqual(param.min);
        expect(value).toBeLessThanOrEqual(param.max);
      }
    }
  });

  it("looks up definitions by type", () => {
    expect(getEffectDef("reverb")?.name).toBe("Reverb");
    expect(getEffectDef("nonsense" as never)).toBeUndefined();
  });
});
