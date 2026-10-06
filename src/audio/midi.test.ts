import { beforeEach, describe, expect, it } from "vitest";

import { parseMidiMessage } from "./midi";
import { padTarget } from "./drumMap";
import { DEFAULT_CC_MAP, handleControlChange, useMidiStore } from "./midiMap";
import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { clearHistory } from "../state/history";

// The session store persists itself through `window.setTimeout`; the test
// runner has no DOM, so give it the global timers.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

describe("MIDI parsing", () => {
  it("reads notes, with velocity 0 as a release", () => {
    expect(parseMidiMessage([0x90, 60, 100])).toMatchObject({ type: "noteon", channel: 1, note: 60 });
    expect(parseMidiMessage([0x90, 60, 0])).toMatchObject({ type: "noteoff", note: 60 });
    expect(parseMidiMessage([0x80, 60, 64])).toMatchObject({ type: "noteoff", note: 60 });
    // Pads on the MPK Mini play on MIDI channel 10.
    expect(parseMidiMessage([0x99, 36, 127])).toMatchObject({ type: "noteon", channel: 10, note: 36, velocity: 1 });
  });

  it("reads knobs, the sustain pedal and the pitch joystick", () => {
    expect(parseMidiMessage([0xb0, 70, 127])).toMatchObject({ type: "cc", controller: 70, value: 1 });
    expect(parseMidiMessage([0xb0, 64, 0])).toMatchObject({ type: "cc", controller: 64, value: 0 });

    const centre = parseMidiMessage([0xe0, 0x00, 0x40]);
    const up = parseMidiMessage([0xe0, 0x7f, 0x7f]);
    const down = parseMidiMessage([0xe0, 0x00, 0x00]);
    expect(centre).toMatchObject({ type: "pitchbend", value: 0 });
    expect(up).toMatchObject({ type: "pitchbend", value: 1 });
    expect(down).toMatchObject({ type: "pitchbend", value: -1 });
  });

  it("ignores clock, active sensing and other system traffic", () => {
    expect(parseMidiMessage([0xf8])).toBeNull();
    expect(parseMidiMessage([0xfe])).toBeNull();
    expect(parseMidiMessage([0xf0, 0x47, 0x00, 0xf7])).toBeNull();
    expect(parseMidiMessage([])).toBeNull();
  });
});

describe("drum pads", () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    clearHistory();
  });

  it("hits the matching drum channel by the General MIDI drum map", () => {
    const channels = useProjectStore.getState().channels;
    const kick = channels.find((channel) => channel.type === "kick");
    const snare = channels.find((channel) => channel.type === "snare");
    const hat = channels.find((channel) => channel.type === "hat");

    expect(padTarget(36, channels)?.channelId).toBe(kick?.id);
    expect(padTarget(38, channels)?.channelId).toBe(snare?.id);
    expect(padTarget(42, channels)).toMatchObject({ channelId: hat?.id, open: false });
    expect(padTarget(46, channels)).toMatchObject({ channelId: hat?.id, open: true });
  });

  it("falls back to the rack order for a drum the project doesn't have", () => {
    const channels = useProjectStore.getState().channels;
    // 43 is a tom; the default project has none, so pad 8 → the 8th channel,
    // which doesn't exist either — and the 2nd pad (37, rimshot) → channel 2.
    expect(padTarget(37, channels)?.channelId).toBe(channels[1].id);
    expect(padTarget(43, channels)).toBeNull();
  });
});

describe("MIDI knobs", () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useMidiStore.getState().resetMappings();
    const first = useProjectStore.getState().channels[0];
    useSessionStore.getState().selectChannel(first.id);
    clearHistory();
  });

  it("maps the MPK Mini's first knob to the selected channel's volume out of the box", () => {
    expect(DEFAULT_CC_MAP[70]).toBe("selected:volume");

    handleControlChange(70, 0.5);
    const channel = useProjectStore.getState().channels[0];
    expect(channel.volume).toBeCloseTo(0.5, 2);
  });

  it("learns a knob for a control and moves it from then on", () => {
    useMidiStore.getState().startLearning("tempo");

    const message = handleControlChange(21, 0.3);
    expect(message).toContain("Tempo");
    expect(useMidiStore.getState().learningId).toBeNull();
    expect(useMidiStore.getState().mappings[21]).toBe("tempo");

    handleControlChange(21, 1);
    expect(useProjectStore.getState().bpm).toBe(200);
  });

  it("does nothing for a knob that isn't mapped", () => {
    const before = useProjectStore.getState().bpm;
    expect(handleControlChange(99, 1)).toBeNull();
    expect(useProjectStore.getState().bpm).toBe(before);
  });
});
