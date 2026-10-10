import "./windowShim";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { midiManager } from "./midi";
import { handleMidiEvent } from "./midiController";
import {
  controlBytes,
  createMidiOutVoice,
  midiOutPanic,
  noteOffBytes,
  noteOnBytes,
  performanceTimeOf,
  pitchBendBytes,
  programBytes
} from "./midiOut";
import { sanitizeMidiOutRef } from "./midiOutRef";
import { triggerChannel } from "./voices";
import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import type { Channel, MidiOutRef } from "../types";

interface Sent {
  port: string;
  bytes: number[];
  at: number | undefined;
}

/** A fake MIDI system with two output ports, recording everything sent to them. */
function fakeOutputs() {
  const sent: Sent[] = [];
  const outputs = new Map(
    ["a", "b"].map((id) => [
      id,
      {
        id,
        name: id === "a" ? "loopMIDI Port" : "Other Port",
        manufacturer: "",
        state: "connected",
        send: (bytes: number[], at?: number) => sent.push({ port: id, bytes, at })
      }
    ])
  );
  (midiManager as unknown as { access: unknown }).access = { inputs: new Map(), outputs, onstatechange: null };
  return { sent, outputs };
}

/** An audio clock whose 0 seconds is 1000 ms on the performance clock. */
const clock = (extra: Record<string, unknown> = {}) =>
  ({
    currentTime: 0,
    getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 1000 }),
    ...extra
  }) as unknown as BaseAudioContext;

const REF: MidiOutRef = { portId: "a", portName: "loopMIDI Port", channel: 3 };

afterEach(() => {
  (midiManager as unknown as { access: unknown }).access = null;
});

describe("MIDI bytes", () => {
  it("builds notes on the right channel", () => {
    expect(noteOnBytes(1, 60, 100)).toEqual([0x90, 60, 100]);
    expect(noteOnBytes(16, 61, 1)).toEqual([0x9f, 61, 1]);
    // Velocity 0 would mean note off, so a note on is never sent with it.
    expect(noteOnBytes(1, 60, 0)).toEqual([0x90, 60, 1]);
    expect(noteOffBytes(3, 60)).toEqual([0x82, 60, 0]);
  });

  it("keeps every value inside MIDI's range", () => {
    expect(noteOnBytes(99, 300, 999)).toEqual([0x9f, 127, 127]);
    expect(controlBytes(2, 22, 127.6)).toEqual([0xb1, 22, 127]);
    expect(programBytes(1, 5)).toEqual([0xc0, 5]);
  });

  it("encodes pitch bend as a 14-bit number with 8192 in the middle", () => {
    expect(pitchBendBytes(1, 0)).toEqual([0xe0, 0, 64]);
    expect(pitchBendBytes(1, 1)).toEqual([0xe0, 127, 127]);
    expect(pitchBendBytes(1, -1)).toEqual([0xe0, 1, 0]);
  });
});

describe("timing", () => {
  it("maps the audio clock onto the clock Web MIDI uses", () => {
    expect(performanceTimeOf(clock(), 0)).toBe(1000);
    expect(performanceTimeOf(clock(), 0.5)).toBe(1500);
    // Chrome reports nothing before audio has run: fall back to now.
    const fallback = performanceTimeOf(clock({ getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }), 1);
    expect(fallback).toBeGreaterThan(performance.now() + 900);
  });
});

describe("a note sent out", () => {
  beforeEach(() => midiOutPanic());

  it("puts the note on and off at the right times", () => {
    const { sent } = fakeOutputs();
    createMidiOutVoice(clock(), REF, { time: 0.25, pitch: 64, velocity: 0.5, duration: 0.5 });
    expect(sent).toEqual([
      { port: "a", bytes: [0x92, 64, 64], at: 1250 },
      { port: "a", bytes: [0x82, 64, 0], at: 1750 }
    ]);
  });

  it("holds a note until it is released", () => {
    const { sent } = fakeOutputs();
    const voice = createMidiOutVoice(clock(), REF, { time: 0, pitch: 60, velocity: 1, duration: null })!;
    expect(sent).toHaveLength(1);
    voice.release(2);
    voice.release(3); // a second release does nothing
    expect(sent.map((message) => message.bytes[0])).toEqual([0x92, 0x82]);
    expect(sent[1].at).toBe(3000);
  });

  it("never stops a note before it has started", () => {
    const { sent } = fakeOutputs();
    // Planned for a quarter second from now, then cut off straight away.
    const voice = createMidiOutVoice(clock(), REF, { time: 0.25, pitch: 60, velocity: 1, duration: null })!;
    voice.kill(0);
    expect(sent[1].bytes[0]).toBe(0x82);
    expect(sent[1].at!).toBeGreaterThan(sent[0].at!);
  });

  it("sends the pitch wheel and the mod wheel on to a held note", () => {
    const { sent } = fakeOutputs();
    const voice = createMidiOutVoice(clock(), REF, { time: 0, pitch: 60, velocity: 1, duration: null })!;
    voice.bend!(100, 0);
    voice.modulate!(1, 0);
    expect(sent[1].bytes).toEqual(pitchBendBytes(3, 0.5));
    expect(sent[2].bytes).toEqual([0xb2, 1, 127]);
  });

  it("finds the port by name when its id has changed", () => {
    const { sent } = fakeOutputs();
    createMidiOutVoice(clock(), { ...REF, portId: "gone" }, { time: 0, pitch: 60, velocity: 1, duration: 1 });
    expect(sent.every((message) => message.port === "a")).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("stays quiet when the port isn't there, or when rendering to a file", () => {
    const { sent } = fakeOutputs();
    expect(createMidiOutVoice(clock(), { ...REF, portId: "x", portName: "Nothing" }, { time: 0, pitch: 60, velocity: 1, duration: 1 })).toBeNull();

    class OfflineAudioContext {}
    (globalThis as unknown as Record<string, unknown>).OfflineAudioContext = OfflineAudioContext;
    try {
      const offline = Object.assign(new OfflineAudioContext(), { currentTime: 0 }) as unknown as BaseAudioContext;
      expect(createMidiOutVoice(offline, REF, { time: 0, pitch: 60, velocity: 1, duration: 1 })).toBeNull();
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).OfflineAudioContext;
    }
    expect(sent).toHaveLength(0);
  });

  it("switches off everything that is still sounding on a panic, and tells each channel to let go", () => {
    const { sent } = fakeOutputs();
    createMidiOutVoice(clock(), REF, { time: 0, pitch: 60, velocity: 1, duration: null });
    createMidiOutVoice(clock(), REF, { time: 0, pitch: 67, velocity: 1, duration: null });
    sent.length = 0;

    midiOutPanic();
    const bytes = sent.map((message) => message.bytes);
    expect(bytes).toContainEqual([0x82, 60, 0]);
    expect(bytes).toContainEqual([0x82, 67, 0]);
    expect(bytes).toContainEqual([0xb2, 123, 0]);
    expect(bytes).toContainEqual([0xb2, 120, 0]);
    expect(bytes).toContainEqual(pitchBendBytes(3, 0));

    // Nothing left to switch off a second time.
    sent.length = 0;
    midiOutPanic();
    expect(sent.some((message) => message.bytes[0] === 0x82 && message.bytes[2] === 0 && message.bytes[1] === 60)).toBe(false);
  });
});

describe("a channel set to MIDI out", () => {
  const channelOf = (extra: Partial<Channel>): Channel =>
    ({
      id: "c1",
      name: "Ext",
      type: "synth",
      color: "#fff",
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      mixerTrackId: 1,
      ...extra
    }) as Channel;

  it("sends its notes out, and makes no sound of its own", () => {
    const { sent } = fakeOutputs();
    const context = clock();
    const voice = triggerChannel(context, channelOf({ midiOut: REF }), {} as AudioNode, {
      time: 0,
      velocity: 0.8,
      pitch: 62,
      duration: 0.25
    });
    expect(voice).not.toBeNull();
    expect(sent.map((message) => message.bytes)).toEqual([[0x92, 62, 102], [0x82, 62, 0]]);
  });

  it("ignores a MIDI out setting on anything but a synth channel", () => {
    expect(sanitizeMidiOutRef({ portId: "a", portName: "x", channel: 1 })).toBeDefined();
    const { sent } = fakeOutputs();
    // A drum channel never reaches the MIDI path (it would need the audio engine, which this test has none of).
    expect(() =>
      triggerChannel(clock(), channelOf({ type: "kick", midiOut: REF }), {} as AudioNode, { time: 0, velocity: 1, pitch: 60, duration: 1 })
    ).toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("saved settings", () => {
  it("keeps good settings and repairs bad ones", () => {
    expect(sanitizeMidiOutRef({ portId: "a", portName: "loopMIDI", channel: 5, alsoPlay: true })).toEqual({
      portId: "a",
      portName: "loopMIDI",
      channel: 5,
      alsoPlay: true
    });
    expect(sanitizeMidiOutRef({ portId: "a", portName: "x", channel: 99 })?.channel).toBe(16);
    expect(sanitizeMidiOutRef({ portId: "a", portName: "x", channel: -3 })?.channel).toBe(1);
    expect(sanitizeMidiOutRef({ portId: "a", portName: "x", channel: "loud" })?.channel).toBe(1);
    expect(sanitizeMidiOutRef({ portId: "a", portName: "x", channel: 1 })).not.toHaveProperty("alsoPlay");
    expect(sanitizeMidiOutRef(null)).toBeUndefined();
    expect(sanitizeMidiOutRef("port")).toBeUndefined();
    expect(sanitizeMidiOutRef({ channel: 2 })).toBeUndefined();
    expect(sanitizeMidiOutRef({ portName: "x".repeat(500), channel: 1 })?.portName).toHaveLength(120);
  });

  it("is saved with the channel, and only synth channels can have it", () => {
    const store = useProjectStore.getState();
    const synth = store.addChannel("synth", "Ext");
    const kick = store.addChannel("kick", "Kick");

    useProjectStore.getState().updateChannelMidiOut(synth, REF);
    useProjectStore.getState().updateChannelMidiOut(kick, REF);
    const channels = useProjectStore.getState().channels;
    expect(channels.find((entry) => entry.id === synth)?.midiOut).toEqual(REF);
    expect(channels.find((entry) => entry.id === kick)?.midiOut).toBeUndefined();

    useProjectStore.getState().updateChannelMidiOut(synth, null);
    expect(useProjectStore.getState().channels.find((entry) => entry.id === synth)?.midiOut).toBeUndefined();
  });
});

describe("a keyboard playing an outside instrument", () => {
  it("passes on knobs it isn't linked to, pressure and presets, but not the ones the studio uses", () => {
    const { sent } = fakeOutputs();
    const id = useProjectStore.getState().addChannel("synth", "Ext");
    useProjectStore.getState().updateChannelMidiOut(id, REF);
    useSessionStore.getState().selectChannel(id);

    const device = "MPK";
    handleMidiEvent({ type: "cc", channel: 1, controller: 22, value: 1, device });
    handleMidiEvent({ type: "aftertouch", channel: 1, note: null, value: 0.5, device });
    handleMidiEvent({ type: "program", channel: 1, program: 7, device });
    expect(sent.map((message) => message.bytes)).toEqual([[0xb2, 22, 127], [0xd2, 64], [0xc2, 7]]);

    // Even a knob PulseGrid would use (CC 70 is "volume" by default) goes to the instrument...
    sent.length = 0;
    handleMidiEvent({ type: "cc", channel: 1, controller: 70, value: 0.5, device });
    expect(sent.map((message) => message.bytes)).toEqual([[0xb2, 70, 64]]);

    // ...unless it is kept for the studio. The sustain pedal and mod wheel are handled by the studio either way.
    sent.length = 0;
    useProjectStore.getState().updateChannelMidiOut(id, { ...REF, knobsToStudio: true });
    handleMidiEvent({ type: "cc", channel: 1, controller: 70, value: 0.5, device });
    expect(sent).toHaveLength(0);
    handleMidiEvent({ type: "cc", channel: 1, controller: 22, value: 1, device });
    expect(sent).toHaveLength(1);
    sent.length = 0;
    handleMidiEvent({ type: "cc", channel: 1, controller: 64, value: 1, device });
    expect(sent).toHaveLength(0);
  });

  it("passes nothing on when the selected channel plays in the studio", () => {
    const { sent } = fakeOutputs();
    const id = useProjectStore.getState().addChannel("synth", "Inside");
    useSessionStore.getState().selectChannel(id);
    handleMidiEvent({ type: "cc", channel: 1, controller: 22, value: 1, device: "MPK" });
    handleMidiEvent({ type: "program", channel: 1, program: 7, device: "MPK" });
    expect(sent).toHaveLength(0);
  });
});
