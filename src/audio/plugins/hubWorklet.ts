/**
 * The plugin hub: runs on the audio thread. The plugin bridge (electron/pluginBridge.cjs) sends it each plugin's
 * sound, a few milliseconds ahead and stamped with the frame it belongs at; the hub plays it out of that plugin's
 * output at exactly that frame, and tells the bridge where playback has got to so it can keep ahead.
 *
 * One output per plugin slot, each connected to its channel's strip in the mixer.
 */

declare const currentFrame: number;
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const SLOTS = 16;
/** About two thirds of a second of sound per slot: far more than the bridge ever sends ahead. */
const RING = 1 << 15;
const MASK = RING - 1;
/** Tell the bridge where playback is every this many frames. */
const TICK_EVERY = 256;

interface Chunk {
  type: "chunk";
  start: number;
  frames: number;
  slots: number[];
  data: Float32Array;
}

class PluginHub extends AudioWorkletProcessor {
  private bridge: MessagePort | null = null;
  private readonly left: Float32Array[] = [];
  private readonly right: Float32Array[] = [];
  private sinceTick = TICK_EVERY;

  constructor() {
    super();
    for (let slot = 0; slot < SLOTS; slot += 1) {
      this.left.push(new Float32Array(RING));
      this.right.push(new Float32Array(RING));
    }
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; port?: MessagePort };
      if (message?.type === "port" && message.port) {
        this.bridge = message.port;
        this.bridge.onmessage = (incoming: MessageEvent) => this.receive(incoming.data as Chunk);
      }
    };
  }

  private receive(chunk: Chunk): void {
    if (chunk?.type !== "chunk") return;
    const { start, frames, slots, data } = chunk;
    // Sound for frames already played has missed its moment; the rest is written where it will be read.
    slots.forEach((slot, index) => {
      if (slot < 0 || slot >= SLOTS) return;
      const base = index * frames * 2;
      const left = this.left[slot];
      const right = this.right[slot];
      for (let i = 0; i < frames; i += 1) {
        if (start + i < currentFrame) continue;
        const at = (start + i) & MASK;
        left[at] = data[base + i];
        right[at] = data[base + frames + i];
      }
    });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const frame = currentFrame;
    for (let slot = 0; slot < SLOTS; slot += 1) {
      const out = outputs[slot];
      if (!out || out.length < 2) continue;
      const left = this.left[slot];
      const right = this.right[slot];
      const length = out[0].length;
      for (let i = 0; i < length; i += 1) {
        const at = (frame + i) & MASK;
        out[0][i] = left[at];
        out[1][i] = right[at];
        // Read once: a gap in what the bridge sends is silence, never the same sound again.
        left[at] = 0;
        right[at] = 0;
      }
    }

    this.sinceTick += outputs[0]?.[0]?.length ?? 128;
    if (this.sinceTick >= TICK_EVERY && this.bridge) {
      this.sinceTick = 0;
      this.bridge.postMessage({ type: "tick", frame, sampleRate });
    }
    return true;
  }
}

registerProcessor("pulsegrid-plugin-hub", PluginHub);

// A module, so the audio-thread names declared above stay in this file.
export {};
