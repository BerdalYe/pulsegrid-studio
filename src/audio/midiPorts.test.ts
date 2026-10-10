import "./windowShim";
import { beforeEach, describe, expect, it } from "vitest";

import { describeMidi, isControlPort, midiManager, noteName, parseMidiMessage, type MidiEvent } from "./midi";
import { handleMidiEvent } from "./midiController";
import { useMidiStore } from "./midiMap";
import { useProjectStore } from "../state/projectStore";
import { clearHistory } from "../state/history";

describe("more MIDI messages", () => {
  it("reads pressure and preset changes, which controllers like the MPK mini IV can send", () => {
    expect(parseMidiMessage([0xd0, 64])).toMatchObject({ type: "aftertouch", note: null });
    expect(parseMidiMessage([0xa0, 60, 127])).toMatchObject({ type: "aftertouch", note: 60, value: 1 });
    expect(parseMidiMessage([0xc9, 5])).toMatchObject({ type: "program", program: 5, channel: 10 });
  });

  it("names notes with middle C as C4", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(36)).toBe("C2");
    expect(noteName(61)).toBe("C#4");
    expect(noteName(0)).toBe("C-1");
  });

  it("describes what a control sent in plain words", () => {
    const text = (data: number[]) => describeMidi(parseMidiMessage(data, "x") as MidiEvent);
    expect(text([0x90, 60, 100])).toBe("Note on C4 (60), velocity 100, channel 1");
    expect(text([0x99, 36, 127])).toBe("Note on C2 (36), velocity 127, channel 10");
    expect(text([0xb0, 64, 127])).toContain("sustain pedal");
    expect(text([0xb0, 1, 64])).toContain("mod wheel");
    expect(text([0xb0, 22, 10])).toBe("Control 22 = 10, channel 1");
    expect(text([0xe0, 0x7f, 0x7f])).toContain("+100%");
  });
});

describe("keyboards with several MIDI ports", () => {
  it("knows the Akai MPK mini IV's playing port from its control ports", () => {
    // Port names as Akai lists them.
    expect(isControlPort("MPK Mini IV MIDI Port")).toBe(false);
    expect(isControlPort("MPK mini IV")).toBe(false);
    expect(isControlPort("MPK Mini IV DAW Port")).toBe(true);
    expect(isControlPort("MPK Mini IV Plugin Port")).toBe(true);
    expect(isControlPort("MPK Mini IV Software Control Port")).toBe(true);
    expect(isControlPort("MPK Mini IV DIN Port")).toBe(true);
    // Windows' names for a device's second and later ports.
    expect(isControlPort("MIDIIN2 (MPK mini IV)")).toBe(true);
    expect(isControlPort("MIDIIN3 (MPK mini IV)")).toBe(true);
  });

  it("does not mistake ordinary keyboards for control ports", () => {
    for (const name of ["Launchkey MK3 25", "Arturia KeyStep 37", "MPK mini 3", "USB MIDI Keyboard", "Digital Piano", "MIDI Keyboard 25"]) {
      expect(isControlPort(name), name).toBe(false);
    }
  });

  type FakeInput = {
    id: string;
    name: string;
    manufacturer: string;
    state: string;
    onmidimessage: null | ((event: { data: Uint8Array }) => void);
  };

  /** A fake MIDI system with the MPK mini IV's five ports, and a record of what got through. */
  async function connect(names: string[]) {
    const inputs = new Map<string, FakeInput>(
      names.map((name, index) => [
        `port${index}`,
        { id: `port${index}`, name, manufacturer: "Akai", state: "connected", onmidimessage: null }
      ])
    );
    Object.defineProperty(globalThis, "navigator", {
      value: { requestMIDIAccess: async () => ({ inputs, onstatechange: null }) },
      configurable: true
    });

    // The manager connects once; hand it this fake keyboard each time.
    (midiManager as unknown as { access: unknown }).access = null;
    await midiManager.init();

    const seen: string[] = [];
    const stop = midiManager.onEvent((event) => seen.push(event.device));
    const press = () => {
      for (const input of inputs.values()) input.onmidimessage?.({ data: new Uint8Array([0x90, 60, 100]) });
    };
    return { inputs, seen, press, stop };
  }

  const MPK_PORTS = [
    "MPK Mini IV MIDI Port",
    "MPK Mini IV DAW Port",
    "MPK Mini IV Plugin Port",
    "MPK Mini IV Software Control Port",
    "MPK Mini IV DIN Port"
  ];

  it("listens only to the playing port by default", async () => {
    midiManager.setInputChoice("auto");
    const keyboard = await connect(MPK_PORTS);
    keyboard.press();
    expect(keyboard.seen).toEqual(["MPK Mini IV MIDI Port"]);
    keyboard.stop();
  });

  it("can listen to every port, or to one port you choose", async () => {
    const keyboard = await connect(MPK_PORTS);

    midiManager.setInputChoice("all");
    keyboard.press();
    expect(keyboard.seen).toHaveLength(5);

    keyboard.seen.length = 0;
    midiManager.setInputChoice("port1");
    keyboard.press();
    expect(keyboard.seen).toEqual(["MPK Mini IV DAW Port"]);

    // The chosen port unplugged: back to the playing port.
    keyboard.inputs.get("port1")!.state = "disconnected";
    keyboard.seen.length = 0;
    keyboard.press();
    expect(keyboard.seen).toEqual(["MPK Mini IV MIDI Port"]);

    midiManager.setInputChoice("auto");
    keyboard.stop();
  });

  it("still listens when every port looks like a control port", async () => {
    midiManager.setInputChoice("auto");
    const keyboard = await connect(["Some DAW Controller"]);
    keyboard.press();
    expect(keyboard.seen).toHaveLength(1);
    keyboard.stop();
  });

  it("lists which ports are control ports, for the picker", async () => {
    const keyboard = await connect(MPK_PORTS);
    const devices = midiManager.getDevices();
    expect(devices.map((device) => device.control)).toEqual([false, true, true, true, true]);
    keyboard.stop();
  });
});

describe("the MIDI monitor and pad channel", () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useMidiStore.getState().resetMappings();
    useMidiStore.getState().clearMonitor();
    useMidiStore.getState().setPadChannel(10);
    clearHistory();
  });

  const cc = (controller: number, value = 0.5): MidiEvent => ({ type: "cc", channel: 1, controller, value, device: "MPK" });

  it("shows what arrived, newest first", () => {
    handleMidiEvent({ type: "noteon", channel: 1, note: 60, velocity: 0.8, device: "MPK" });
    handleMidiEvent({ type: "noteoff", channel: 1, note: 60, device: "MPK" });
    const lines = useMidiStore.getState().recent.map((line) => line.text);
    expect(lines[0]).toContain("Note off C4");
    expect(lines[1]).toContain("Note on C4");
  });

  it("keeps a knob turn to one line instead of a flood", () => {
    for (const value of [0.1, 0.2, 0.3, 0.4, 0.5]) handleMidiEvent(cc(70, value));
    expect(useMidiStore.getState().recent).toHaveLength(1);
    expect(useMidiStore.getState().recent[0].text).toContain("= 64");
  });

  it("says when a knob is not linked to anything, and only then", () => {
    handleMidiEvent(cc(22));
    expect(useMidiStore.getState().recent[0].hint).toMatch(/not linked/i);

    // Linked by default, and the pedal and mod wheel are handled by the studio itself.
    for (const linked of [70, 64, 1]) {
      useMidiStore.getState().clearMonitor();
      handleMidiEvent(cc(linked));
      expect(useMidiStore.getState().recent[0].hint, `CC ${linked}`).toBeUndefined();
    }
  });

  it("keeps only the latest few lines", () => {
    for (let note = 40; note < 70; note++) handleMidiEvent({ type: "noteon", channel: 1, note, velocity: 0.5, device: "MPK" });
    expect(useMidiStore.getState().recent.length).toBeLessThanOrEqual(8);
  });

  it("keeps the pad channel inside 1 to 16", () => {
    useMidiStore.getState().setPadChannel(3);
    expect(useMidiStore.getState().padChannel).toBe(3);
    useMidiStore.getState().setPadChannel(99);
    expect(useMidiStore.getState().padChannel).toBe(16);
    useMidiStore.getState().setPadChannel(-4);
    expect(useMidiStore.getState().padChannel).toBe(1);
  });
});
