export interface MidiDevice {
  id: string;
  name: string;
  manufacturer: string;
}

interface MidiInputLike {
  id: string;
  name: string | null;
  manufacturer?: string | null;
  state?: string;
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}

interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  onstatechange: ((event?: { port?: { name?: string | null; state?: string; type?: string } }) => void) | null;
}

/** One parsed message from a keyboard, pad controller or knob box. */
export type MidiEvent =
  | { type: "noteon"; channel: number; note: number; velocity: number; device: string }
  | { type: "noteoff"; channel: number; note: number; device: string }
  | { type: "cc"; channel: number; controller: number; value: number; device: string }
  /** −1..1, centre 0. */
  | { type: "pitchbend"; channel: number; value: number; device: string };

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
    default:
      return null;
  }
}

/**
 * Web MIDI, kept connected. Inputs that are plugged in later — or unplugged
 * and plugged back in — are picked up automatically.
 */
class MidiManager {
  private access: MidiAccessLike | null = null;
  private selectedInputId: string | null = null;
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
          if (port?.type === "input" && port.name) {
            this.announce(port.state === "connected" ? `${port.name} connected.` : `${port.name} disconnected.`);
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
      devices.push({
        id: input.id,
        name: input.name ?? `MIDI input ${input.id}`,
        manufacturer: input.manufacturer ?? ""
      });
    });

    return devices;
  }

  selectDevice(id: string | null): void {
    this.selectedInputId = id;
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
        if (this.selectedInputId && input.id !== this.selectedInputId) return;
        const event = parseMidiMessage(message.data, name);
        if (event) this.dispatch(event);
      };
    });
  }
}

export const midiManager = new MidiManager();
