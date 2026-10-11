import "./windowShim";
import { describe, expect, it } from "vitest";

import { getSample, initDefaultSamples } from "./sampleRegistry";

/** An audio context with just enough of one to make the built-in samples. */
function fakeContext(sampleRate = 44100) {
  return {
    sampleRate,
    createBuffer(channels: number, length: number, rate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { sampleRate: rate, length, numberOfChannels: channels, duration: length / rate, getChannelData: (index: number) => data[index] };
    }
  } as unknown as BaseAudioContext;
}

/** RMS of the left channel between two points, as fractions of the length. */
function loudness(id: string, from: number, to: number): number {
  const data = getSample(id)!.buffer.getChannelData(0);
  const a = Math.floor(data.length * from);
  const b = Math.floor(data.length * to);
  let sum = 0;
  for (let i = a; i < b; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, b - a));
}

function peak(id: string): number {
  let max = 0;
  const buffer = getSample(id)!.buffer;
  for (let channel = 0; channel < 2; channel++) {
    for (const value of buffer.getChannelData(channel)) max = Math.max(max, Math.abs(value));
  }
  return max;
}

describe("the FX samples", () => {
  initDefaultSamples(fakeContext());
  const ids = ["sample-fx-noise-riser", "sample-fx-downlifter", "sample-fx-impact", "sample-fx-sub-drop", "sample-fx-reverse-crash", "sample-fx-noise-sweep"];

  it("are all made, audible and never past full scale", () => {
    for (const id of ids) {
      expect(getSample(id), id).toBeDefined();
      expect(peak(id), id).toBeGreaterThan(0.2);
      expect(peak(id), id).toBeLessThanOrEqual(1);
      expect(Number.isNaN(loudness(id, 0, 1)), id).toBe(false);
    }
  });

  it("rise where they should rise and fall where they should fall", () => {
    expect(loudness("sample-fx-noise-riser", 0.8, 0.95)).toBeGreaterThan(loudness("sample-fx-noise-riser", 0.05, 0.2) * 3);
    expect(loudness("sample-fx-downlifter", 0.02, 0.15)).toBeGreaterThan(loudness("sample-fx-downlifter", 0.7, 0.9) * 3);
    expect(loudness("sample-fx-reverse-crash", 0.85, 0.98)).toBeGreaterThan(loudness("sample-fx-reverse-crash", 0.05, 0.3) * 5);
    expect(loudness("sample-fx-impact", 0, 0.1)).toBeGreaterThan(loudness("sample-fx-impact", 0.7, 0.9) * 4);
    expect(loudness("sample-fx-sub-drop", 0, 0.2)).toBeGreaterThan(loudness("sample-fx-sub-drop", 0.8, 0.95) * 3);
    const sweep = loudness("sample-fx-noise-sweep", 0.4, 0.6);
    expect(sweep).toBeGreaterThan(loudness("sample-fx-noise-sweep", 0.02, 0.12) * 2);
    expect(sweep).toBeGreaterThan(loudness("sample-fx-noise-sweep", 0.88, 0.97) * 2);
  });

  it("end without a click", () => {
    for (const id of ids) {
      const data = getSample(id)!.buffer.getChannelData(0);
      expect(Math.abs(data[data.length - 1]), id).toBeLessThan(0.02);
    }
  });
});
