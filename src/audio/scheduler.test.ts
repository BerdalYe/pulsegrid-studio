import { beforeEach, describe, expect, it, vi } from "vitest";

import { Scheduler, type SchedulerStepEvent } from "./Scheduler";

/**
 * A hand-driven AudioContext stand-in. `currentTime` only moves when the test
 * moves it, so scheduling is fully deterministic.
 */
function fakeContext(): AudioContext & { advance: (seconds: number) => void } {
  let now = 0;

  return {
    get currentTime() {
      return now;
    },
    state: "running",
    resume: () => Promise.resolve(),
    advance(seconds: number) {
      now += seconds;
    }
  } as unknown as AudioContext & { advance: (seconds: number) => void };
}

/** The worker clock is unavailable in node, so the scheduler falls back to setInterval. */
beforeEach(() => {
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal("window", {
    setInterval: () => 1,
    clearInterval: () => undefined
  });
});

function build(lengthSteps = 16, stepDuration = 0.125) {
  const context = fakeContext();
  const steps: SchedulerStepEvent[] = [];

  const scheduler = new Scheduler({
    context,
    getStepDuration: () => stepDuration,
    getSwing: () => 0,
    getLengthSteps: () => lengthSteps,
    onStep: (event) => steps.push(event)
  });

  return { context, steps, scheduler };
}

describe("Scheduler", () => {
  it("emits each step once, in order, as time advances", async () => {
    const { context, steps, scheduler } = build();

    await scheduler.start(0);
    for (let i = 0; i < 8; i++) context.advance(0.125);
    scheduler["schedule"]();

    const indices = steps.map((step) => step.stepIndex);
    expect(indices).toEqual([...indices].sort((a, b) => a - b).slice(0, indices.length));
    expect(new Set(indices).size).toBe(indices.length);
    expect(steps.every((step, i) => i === 0 || step.time > steps[i - 1].time)).toBe(true);
  });

  it("schedules nothing after stop, even on a tick already in flight", async () => {
    const { context, steps, scheduler } = build();

    await scheduler.start(0);
    const before = steps.length;
    expect(before).toBeGreaterThan(0);

    scheduler.stop();
    context.advance(1);

    // A worker message queued before stop() still arrives afterwards.
    scheduler["schedule"]();

    expect(steps.length).toBe(before);
  });

  it("wraps at the pattern length", async () => {
    const { context, steps, scheduler } = build(4);

    await scheduler.start(0);
    for (let i = 0; i < 12; i++) {
      context.advance(0.125);
      scheduler["schedule"]();
    }

    expect(steps.every((step) => step.stepIndex >= 0 && step.stepIndex < 4)).toBe(true);
    expect(new Set(steps.map((step) => step.stepIndex))).toEqual(new Set([0, 1, 2, 3]));
  });

  it("respects a tempo change without repeating or skipping a step", async () => {
    const context = fakeContext();
    const steps: SchedulerStepEvent[] = [];
    let stepDuration = 0.125;

    const scheduler = new Scheduler({
      context,
      getStepDuration: () => stepDuration,
      getSwing: () => 0,
      getLengthSteps: () => 64,
      onStep: (event) => steps.push(event)
    });

    await scheduler.start(0);
    context.advance(0.5);
    scheduler["schedule"]();

    const beforeChange = steps.length;
    stepDuration = 0.05;

    context.advance(0.5);
    scheduler["schedule"]();

    const indices = steps.map((step) => step.stepIndex);
    expect(new Set(indices).size).toBe(indices.length);
    expect(steps.length).toBeGreaterThan(beforeChange);

    // The later steps must be spaced by the new, shorter duration.
    const tail = steps.slice(-3);
    expect(tail[1].time - tail[0].time).toBeCloseTo(0.05, 5);
  });

  it("keeps running when a step handler throws", async () => {
    const context = fakeContext();
    const seen: number[] = [];
    let failures = 0;

    const scheduler = new Scheduler({
      context,
      getStepDuration: () => 0.125,
      getSwing: () => 0,
      getLengthSteps: () => 16,
      onStep: (event) => {
        if (event.stepIndex === 1) {
          failures += 1;
          throw new Error("bad channel");
        }
        seen.push(event.stepIndex);
      }
    });

    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await scheduler.start(0);
    for (let i = 0; i < 6; i++) {
      context.advance(0.125);
      scheduler["schedule"]();
    }

    // The failing step is attempted once and the transport moves past it.
    expect(failures).toBe(1);
    expect(seen).toContain(2);
    expect(seen).toContain(3);
  });

  it("ignores a nonsensical step duration instead of spinning", async () => {
    const context = fakeContext();
    const steps: SchedulerStepEvent[] = [];

    const scheduler = new Scheduler({
      context,
      getStepDuration: () => 0,
      getSwing: () => 0,
      getLengthSteps: () => 16,
      onStep: (event) => steps.push(event)
    });

    await scheduler.start(0);
    context.advance(1);
    scheduler["schedule"]();

    expect(steps).toHaveLength(0);
  });

  it("stops at the end of the range when looping is off", async () => {
    const context = fakeContext();
    const steps: SchedulerStepEvent[] = [];
    let endedAt: number | null = null;

    const scheduler = new Scheduler({
      context,
      getStepDuration: () => 0.125,
      getSwing: () => 0,
      getLengthSteps: () => 4,
      getLoop: () => false,
      onStep: (event) => steps.push(event),
      onEnd: (time) => {
        endedAt = time;
      }
    });

    await scheduler.start(0);
    for (let i = 0; i < 12; i++) {
      context.advance(0.125);
      scheduler["schedule"]();
    }

    // Exactly one pass: four steps, no wrap, and the end reported once.
    expect(steps.map((step) => step.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(endedAt).not.toBeNull();
  });

  it("keeps wrapping when looping is on", async () => {
    const context = fakeContext();
    const steps: SchedulerStepEvent[] = [];
    let ends = 0;

    const scheduler = new Scheduler({
      context,
      getStepDuration: () => 0.125,
      getSwing: () => 0,
      getLengthSteps: () => 4,
      getLoop: () => true,
      onStep: (event) => steps.push(event),
      onEnd: () => {
        ends += 1;
      }
    });

    await scheduler.start(0);
    for (let i = 0; i < 12; i++) {
      context.advance(0.125);
      scheduler["schedule"]();
    }

    expect(steps.length).toBeGreaterThan(4);
    expect(ends).toBe(0);
  });

  it("delays the first step by the count-in", async () => {
    const { context, steps, scheduler } = build(16, 0.125);

    await scheduler.start(0, 2);
    context.advance(0.5);
    scheduler["schedule"]();

    // Nothing may sound during the count-in bar.
    expect(steps.every((step) => step.time >= 2)).toBe(true);
  });

  it("wraps inside a loop region instead of the whole song", async () => {
    const context = fakeContext();
    const steps: SchedulerStepEvent[] = [];

    const scheduler = new Scheduler({
      context,
      getStepDuration: () => 0.125,
      getSwing: () => 0,
      getLengthSteps: () => 64,
      getLoopRegion: () => ({ start: 16, end: 20 }),
      onStep: (event) => steps.push(event)
    });

    await scheduler.start(16);
    for (let i = 0; i < 16; i++) {
      context.advance(0.125);
      scheduler["schedule"]();
    }

    const seen = new Set(steps.map((step) => step.stepIndex));
    expect([...seen].sort((a, b) => a - b)).toEqual([16, 17, 18, 19]);
    expect(steps.length).toBeGreaterThan(4);
  });

  it("pulls a playhead outside the region back into it", async () => {
    const context = fakeContext();
    const steps: SchedulerStepEvent[] = [];

    const scheduler = new Scheduler({
      context,
      getStepDuration: () => 0.125,
      getSwing: () => 0,
      getLengthSteps: () => 64,
      getLoopRegion: () => ({ start: 32, end: 36 }),
      onStep: (event) => steps.push(event)
    });

    // Start well before the region: the first step must jump to its start.
    await scheduler.start(0);
    context.advance(0.125);
    scheduler["schedule"]();

    expect(steps[0].stepIndex).toBe(32);
  });
});
