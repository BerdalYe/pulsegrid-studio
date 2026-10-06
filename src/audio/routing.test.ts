import { describe, expect, it } from "vitest";

import { MASTER_OUTPUT, audibleInserts, repairRouting, wouldCreateCycle } from "./routing";
import type { MixerSend } from "../types";

interface Track {
  id: number;
  output: number;
  sends: MixerSend[];
  mute: boolean;
  solo: boolean;
}

const track = (id: number, output = MASTER_OUTPUT, sends: number[] = []): Track => ({
  id,
  output,
  sends: sends.map((target) => ({ target, level: 0.5 })),
  mute: false,
  solo: false
});

describe("mixer routing", () => {
  it("refuses a route that would close a loop", () => {
    // 1 → 2 (bus) → 3 (bus); routing 3 back into 1 would silence all three.
    const tracks = [track(1, 2), track(2, 3), track(3)];

    expect(wouldCreateCycle(tracks, 3, 1)).toBe(true);
    expect(wouldCreateCycle(tracks, 2, 1)).toBe(true);
    expect(wouldCreateCycle(tracks, 1, 1)).toBe(true);
    expect(wouldCreateCycle(tracks, 1, 3)).toBe(false);
    expect(wouldCreateCycle(tracks, 3, MASTER_OUTPUT)).toBe(false);
  });

  it("follows sends as well as outputs when looking for loops", () => {
    const tracks = [track(1, MASTER_OUTPUT, [5]), track(5)];
    expect(wouldCreateCycle(tracks, 5, 1)).toBe(true);
  });

  it("keeps a soloed insert's reverb bus audible", () => {
    const tracks = [track(1, MASTER_OUTPUT, [15]), track(2), track(15)];
    tracks[0].solo = true;

    expect([...audibleInserts(tracks)].sort((a, b) => a - b)).toEqual([1, 15]);
  });

  it("keeps whatever feeds a soloed bus audible", () => {
    const tracks = [track(1, 10), track(2, 10), track(3), track(10)];
    tracks[3].solo = true;

    expect([...audibleInserts(tracks)].sort((a, b) => a - b)).toEqual([1, 2, 10]);
  });

  it("lets mute win over solo", () => {
    const tracks = [track(1), track(2)];
    tracks[0].solo = true;
    tracks[0].mute = true;

    expect(audibleInserts(tracks).size).toBe(0);
  });

  it("repairs loops, dangling targets and duplicate sends from a file", () => {
    const tracks = [track(1, 2, [3, 3, 99]), track(2, 1), track(3)];
    const repaired = repairRouting(tracks);

    // 1 → 2 is kept; 2 → 1 would close the loop, so 2 falls back to master.
    expect(repaired[0].output).toBe(2);
    expect(repaired[1].output).toBe(MASTER_OUTPUT);
    expect(repaired[0].sends.map((send) => send.target)).toEqual([3]);
  });
});
