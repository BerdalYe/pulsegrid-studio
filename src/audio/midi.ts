export interface MidiDevice {
  id: string;
  name: string;
  manufacturer: string;
  /** A port for the keyboard's own screen, transport and software control, not for playing. */
  control: boolean;
}

/**
 * Some controllers show up as several MIDI ports. The Akai MPK mini IV has a
 * "MIDI Port" that sends what you play (keys, pads, wheels, pedal, knobs), and
 * further ports ("DAW", "Plugin", "Software Control", "DIN") that carry its screen
 * and transport traffic for software made for them. Listening to those as well
 * would turn that traffic into stray notes and knob moves.
 */
export function isControlPort(name: string): boolean {
  // Windows names a device's second and later ports "MIDIIN2 (name)", "MIDIIN3 (name)", …
  return /\b(daw|plugin|software control|control surface|mackie|mcu|din)\b/i.test(name) || /^midiin[2-9]\b/i.test(name);
}

/** Which inputs are listened to: the playing ports, every port, or one chosen port. */
export type MidiInputChoice = "auto" | "all" | string;

const INPUT_KEY = "pulsegrid:midi-input";

function loadInputChoice(): MidiInputChoice {
  try {
    return localStorage.getItem(INPUT_KEY) || "auto";
  } catch {
    return "auto";
  }
}

interface MidiInputLike {
  id: string;
  name: string | null;
  manufacturer?: string | null;
  state?: string;
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}

interface MidiOutputLike {
  id: string;
  name: string | null;
  manufacturer?: string | null;
  state?: string;
  send: (data: number[], timestamp?: number) => void;
}

interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  outputs?: Map<string, MidiOutputLike>;
  onstatechange: ((event?: { port?: { name?: string | null; state?: string; type?: string } }) => void) | null;
}

/** One parsed message from a keyboard, pad controller or knob box. */
export type MidiEvent =
  | { type: "noteon"; channel: number; note: number; velocity: number; device: string }
  | { type: "noteoff"; channel: number; note: number; device: string }
  | { type: "cc"; channel: number; controller: number; value: number; device: string }
  /** −1..1, centre 0. */
  | { type: "pitchbend"; channel: number; value: number; device: string }
  /** Pressure on a held key or pad, 0..1 (note is set for a single key's pressure). */
  | { type: "aftertouch"; channel: number; note: number | null; value: number; device: string }
  /** A preset change from the controller. */
  | { type: "program"; channel: number; program: number; device: string };

export type MidiNoteListener = (pitch: number, velocity: number, isNoteOn: boolean) => void;

/**
 * Turn raw MIDI bytes into events. Exported for tests — real devices send
 * running status rarely over USB, but note-on with velocity 0 as note-off is
 * common (the Akai MPK range does it), and must not start a note.
 */
export function parseMidiMessage(data: ArrayLike<number>, device = ""): MidiEvent | null {
  if (!data || data.length === 0) return null;

  const statusByte = data[0];
  // System messages (clock, active sensing, sysex) carry no playing data.
  if (statusByte >= 0xf0) return null;

  const status = statusByte & 0xf0;
  const channel = (statusByte & 0x0f) + 1;
  const a = data[1] ?? 0;
  const b = data[2] ?? 0;

  switch (status) {
    case 0x90:
      return b > 0
        ? { type: "noteon", channel, note: a, velocity: b / 127, device }
        : { type: "noteoff", channel, note: a, device };
    case 0x80:
      return { type: "noteoff", channel, note: a, device };
    case 0xb0:
      return { type: "cc", channel, controller: a, value: b / 127, device };
    case 0xe0: {
      const raw = (b << 7) | a; // 14-bit, 8192 is centre
      return { type: "pitchbend", channel, value: Math.max(-1, Math.min(1, (raw - 8192) / 8191)), device };
    }
    case 0xa0:
      return { type: "aftertouch", channel, note: a, value: b / 127, device };
    case 0xd0:
      return { type: "aftertouch", channel, note: null, value: a / 127, device };
    case 0xc0:
      return { type: "program", channel, program: a, device };
    default:
      return null;
  }
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** "C3", "F#4": the name of a MIDI note, with middle C (60) as C4. */
export function noteName(note: number): string {
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

/** A line of plain words for the MIDI monitor: what a control just sent. */
export function describeMidi(event: MidiEvent): string {
  switch (event.type) {
    case "noteon":
      return `Note on ${noteName(event.note)} (${event.note}), velocity ${Math.round(event.velocity * 127)}, channel ${event.channel}`;
    case "noteoff":
      return `Note off ${noteName(event.note)} (${event.note}), channel ${event.channel}`;
    case "cc": {
      const known: Record<number, string> = {
        1: "mod wheel",
        2: "breath / joystick down",
        64: "sustain pedal",
        120: "all sound off",
        123: "all notes off"
      };
      const label = known[event.controller] ? ` (${known[event.controller]})` : "";
      return `Control ${event.controller}${label} = ${Math.round(event.value * 127)}, channel ${event.channel}`;
    }
    case "pitchbend":
      return `Pitch bend ${event.value > 0 ? "+" : ""}${Math.round(event.value * 100)}%, channel ${event.channel}`;
    case "aftertouch":
      return event.note === null
        ? `Pressure ${Math.round(event.value * 127)}, channel ${event.channel}`
        : `Pressure on ${noteName(event.note)} ${Math.round(event.value * 127)}, channel ${event.channel}`;
    case "program":
      return `Program change ${event.program}, channel ${event.channel}`;
  }
}

/**
 * Web MIDI, kept connected. Inputs that are plugged in later — or unplugged
 * and plugged back in — are picked up automatically.
 */
class MidiManager {
  private access: MidiAccessLike | null = null;
  private choice: MidiInputChoice = loadInputChoice();
  private initPromise: Promise<boolean> | null = null;

  private readonly noteListeners = new Set<MidiNoteListener>();
  private readonly eventListeners = new Set<(event: MidiEvent) => void>();
  private readonly deviceListeners = new Set<(devices: MidiDevice[]) => void>();
  private readonly connectionListeners = new Set<(message: string) => void>();

  private knownNames = new Map<string, string>();

  get isAvailable(): boolean {
    return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
  }

  get isConnected(): boolean {
    return this.access !== null;
  }

  init(): Promise<boolean> {
    if (this.access) return Promise.resolve(true);
    if (!this.isAvailable) return Promise.resolve(false);
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        this.access = (await (
          navigator as unknown as { requestMIDIAccess: (options?: { sysex?: boolean }) => Promise<MidiAccessLike> }
        ).requestMIDIAccess({ sysex: false })) as MidiAccessLike;

        this.bindInputs();

        this.access.onstatechange = (event) => {
          this.bindInputs();
          this.emitDevices();

          const port = event?.port;
          if ((port?.type === "input" || port?.type === "output") && port.name) {
            const what = port.type === "output" ? " (output)" : "";
            this.announce(port.state === "connected" ? `${port.name}${what} connected.` : `${port.name}${what} disconnected.`);
          }
        };

        this.emitDevices();
        return true;
      } catch (error) {
        console.warn("MIDI access was denied or failed:", error);
        return false;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Connect without asking, if the browser has already been granted MIDI (or
   * never asks, like the desktop app). Otherwise stay quiet until the user
   * presses Enable MIDI, rather than popping a permission prompt at startup.
   */
  async initIfAllowed(): Promise<boolean> {
    if (!this.isAvailable) return false;

    try {
      const status = await navigator.permissions?.query({ name: "midi" as PermissionName });
      if (status && status.state !== "granted") return false;
    } catch {
      // Browsers that can't answer the question: only the desktop app, which
      // always grants MIDI, gets here without a prompt risk worth avoiding.
      if (!("pulsegridDesktop" in window)) return false;
    }

    return this.init();
  }

  getDevices(): MidiDevice[] {
    if (!this.access) return [];

    const devices: MidiDevice[] = [];
    this.access.inputs.forEach((input) => {
      if (input.state === "disconnected") return;
      const name = input.name ?? `MIDI input ${input.id}`;
      devices.push({ id: input.id, name, manufacturer: input.manufacturer ?? "", control: isControlPort(name) });
    });

    return devices;
  }

  /** Where notes can be sent: virtual cables, hardware synths, the computer's own synth. */
  getOutputs(): MidiDevice[] {
    const devices: MidiDevice[] = [];
    this.access?.outputs?.forEach((output) => {
      if (output.state === "disconnected") return;
      devices.push({
        id: output.id,
        name: output.name ?? `MIDI output ${output.id}`,
        manufacturer: output.manufacturer ?? "",
        control: false
      });
    });
    return devices;
  }

  /** The output a project asks for: by id, or failing that by name (ids can change between sessions). */
  findOutput(portId: string, portName: string): MidiOutputLike | null {
    const outputs = this.access?.outputs;
    if (!outputs) return null;

    const byId = portId ? outputs.get(portId) : undefined;
    if (byId && byId.state !== "disconnected") return byId;

    if (portName) {
      for (const output of outputs.values()) {
        if (output.state !== "disconnected" && output.name === portName) return output;
      }
    }
    return null;
  }

  /**
   * Send raw MIDI bytes. `timestamp` is on the performance.now() clock, in
   * milliseconds, so a note can be placed exactly where the audio clock wants it.
   * Returns false when the port isn't there (unplugged, or MIDI not enabled).
   */
  send(portId: string, portName: string, bytes: number[], timestamp?: number): boolean {
    const output = this.findOutput(portId, portName);
    if (!output) return false;
    try {
      output.send(bytes, timestamp);
      return true;
    } catch (error) {
      console.warn("MIDI output failed:", error);
      return false;
    }
  }

  getInputChoice(): MidiInputChoice {
    return this.choice;
  }

  /** "auto" (the ports you play on), "all", or one port's id. Remembered for next time. */
  setInputChoice(choice: MidiInputChoice): void {
    this.choice = choice;
    try {
      localStorage.setItem(INPUT_KEY, choice);
    } catch {
      /* the choice still holds until the app closes */
    }
  }

  /** Is this port listened to, under the current choice? */
  private accepts(input: MidiInputLike): boolean {
    if (this.choice === "all") return true;

    if (this.choice !== "auto") {
      const chosen = this.access?.inputs.get(this.choice);
      // A chosen port that has been unplugged falls back to the automatic choice.
      if (chosen && chosen.state !== "disconnected") return input.id === this.choice;
    }

    // Automatic: the ports you play on. A device with only control-looking ports is listened to anyway.
    const playable = [...(this.access?.inputs.values() ?? [])].some(
      (other) => other.state !== "disconnected" && !isControlPort(other.name ?? "")
    );
    return !playable || !isControlPort(input.name ?? "");
  }

  onNote(listener: MidiNoteListener): () => void {
    this.noteListeners.add(listener);
    return () => {
      this.noteListeners.delete(listener);
    };
  }

  onEvent(listener: (event: MidiEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onDevices(listener: (devices: MidiDevice[]) => void): () => void {
    this.deviceListeners.add(listener);
    listener(this.getDevices());
    return () => {
      this.deviceListeners.delete(listener);
    };
  }

  /** "MPK mini 4 connected." — for the status line. */
  onConnectionMessage(listener: (message: string) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  /** Feed an event in as if it came from a device (tests, on-screen pads). */
  dispatch(event: MidiEvent): void {
    for (const listener of this.eventListeners) listener(event);

    if (event.type === "noteon") {
      for (const listener of this.noteListeners) listener(event.note, event.velocity, true);
    } else if (event.type === "noteoff") {
      for (const listener of this.noteListeners) listener(event.note, 0, false);
    }
  }

  private announce(message: string): void {
    for (const listener of this.connectionListeners) listener(message);
  }

  private emitDevices(): void {
    const devices = this.getDevices();
    for (const listener of this.deviceListeners) listener(devices);
  }

  private bindInputs(): void {
    if (!this.access) return;

    this.access.inputs.forEach((input) => {
      const name = input.name ?? `MIDI input ${input.id}`;
      this.knownNames.set(input.id, name);

      input.onmidimessage = (message) => {
        if (!this.accepts(input)) return;
        const event = parseMidiMessage(message.data, name);
        if (event) this.dispatch(event);
      };
    });
  }
}

export const midiManager = new MidiManager();
