import { describe, expect, it } from "vitest";

import {
  MAX_BPM,
  MIN_BPM,
  applySwing,
  formatBarBeat,
  getPlaybackLengthSteps,
  getSongEndStep,
  isStepActive,
  normaliseStepCell,
  resizeSteps,
  sanitizeFilename,
  secondsPerStep,
  snapStep
} from "./utils";

import { createInitialProjectData } from "../state/initialState";

describe("secondsPerStep", () => {
  it("gives a 16th note at the given tempo", () => {
    // 120 BPM → 0.5 s per beat → 0.125 s per 16th.
    expect(secondsPerStep(120)).toBeCloseTo(0.125, 6);
  });

  it("clamps nonsense tempos instead of producing zero or negative steps", () => {
    expect(secondsPerStep(0)).toBeGreaterThan(0);
    expect(secondsPerStep(-40)).toBeGreaterThan(0);
    expect(secondsPerStep(-40)).toBe(secondsPerStep(MIN_BPM));
    expect(secondsPerStep(100000)).toBe(secondsPerStep(MAX_BPM));
  });
});

describe("applySwing", () => {
  it("leaves on-beat steps alone", () => {
    expect(applySwing(1, 0, 0.125, 0.5)).toBe(1);
    expect(applySwing(1, 2, 0.125, 0.5)).toBe(1);
  });

  it("delays off-beat steps by up to half a step", () => {
    expect(applySwing(1, 1, 0.2, 1)).toBeCloseTo(1.1, 6);
    expect(applySwing(1, 1, 0.2, 0.5)).toBeCloseTo(1.05, 6);
  });

  it("does nothing when swing is off", () => {
    expect(applySwing(1, 1, 0.2, 0)).toBe(1);
  });
});

describe("step cells", () => {
  it("reads legacy boolean lanes", () => {
    expect(normaliseStepCell(true)).toBeGreaterThan(0);
    expect(normaliseStepCell(false)).toBeNull();
  });

  it("keeps velocities and rejects junk", () => {
    expect(normaliseStepCell(0.5)).toBe(0.5);
    expect(normaliseStepCell(0)).toBeNull();
    expect(normaliseStepCell(-3)).toBeNull();
    expect(normaliseStepCell("nope")).toBeNull();
    expect(normaliseStepCell(99)).toBe(1);
  });

  it("resizes lanes without losing existing steps", () => {
    const resized = resizeSteps([true, false, 0.5], 5);
    expect(resized).toHaveLength(5);
    expect(isStepActive(resized[0])).toBe(true);
    expect(resized[1]).toBeNull();
    expect(resized[2]).toBe(0.5);
    expect(resized[4]).toBeNull();
  });
});

describe("snapStep", () => {
  it("rounds to the nearest multiple", () => {
    expect(snapStep(5, 4)).toBe(4);
    expect(snapStep(6, 4)).toBe(8);
    expect(snapStep(6.4, 1)).toBe(6);
  });
});

describe("formatBarBeat", () => {
  it("counts from one", () => {
    expect(formatBarBeat(0)).toBe("1:1:1");
    expect(formatBarBeat(4)).toBe("1:2:1");
    expect(formatBarBeat(16)).toBe("2:1:1");
    expect(formatBarBeat(19)).toBe("2:1:4");
  });

  it("shows a dash when stopped", () => {
    expect(formatBarBeat(-1)).toBe("—");
  });
});

describe("song length", () => {
  it("covers both the bar count and any clip that runs past it", () => {
    const project = createInitialProjectData();
    project.songBars = 2;
    project.playlist.clips = [
      {
        id: "a",
        type: "pattern",
        patternId: project.patternOrder[0],
        trackIndex: 0,
        startStep: 100,
        lengthSteps: 16
      }
    ];

    expect(getSongEndStep(project)).toBe(116);
  });

  it("uses the selected pattern's length in pattern mode", () => {
    const project = createInitialProjectData();
    const patternId = project.patternOrder[0];
    project.patterns[patternId].length = 24;

    expect(getPlaybackLengthSteps(project, "pattern", patternId)).toBe(24);
    expect(getPlaybackLengthSteps(project, "pattern", "missing")).toBe(16);
  });
});

describe("sanitizeFilename", () => {
  it("strips characters that break downloads", () => {
    expect(sanitizeFilename('my/song:1?', "fallback")).toBe("my-song-1-");
    expect(sanitizeFilename("   ", "fallback")).toBe("fallback");
  });
});
