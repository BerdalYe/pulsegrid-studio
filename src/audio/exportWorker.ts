// Off-main-thread encoding for exported audio.

import { Mp3Encoder } from "lamejs";

import BitStream from "lamejs/src/js/BitStream.js";
import Encoder from "lamejs/src/js/Encoder.js";
import GainAnalysis from "lamejs/src/js/GainAnalysis.js";
import Lame from "lamejs/src/js/Lame.js";
import MPEGMode from "lamejs/src/js/MPEGMode.js";

/**
 * lamejs 1.2.1 is only module-safe by accident. Several of its internal files
 * reach for `MPEGMode`, `Lame`, `BitStream`, `GainAnalysis` and `Encoder` as
 * bare globals, which exist only in its concatenated UMD build — under a real
 * module graph `new Mp3Encoder(...)` throws "MPEGMode is not defined" and every
 * MP3 export fails. Publishing them here is the documented workaround.
 */
Object.assign(globalThis as unknown as Record<string, unknown>, {
  MPEGMode,
  Lame,
  BitStream,
  GainAnalysis,
  Encoder
});

interface EncodeRequest {
  format: "wav" | "mp3";
  channels: Float32Array[];
  sampleRate: number;
  length: number;
  bitrate: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

function toInt16(value: number): number {
  const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  length: number
): ArrayBuffer {
  const channelCount = Math.min(2, channels.length);
  const blockAlign = channelCount * 2;
  const dataSize = length * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const reportEvery = Math.max(1, Math.floor(length / 20));

  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < channelCount; ch++) {
      view.setInt16(offset, toInt16(channels[ch][i]), true);
      offset += 2;
    }

    if (i % reportEvery === 0) {
      scope.postMessage({ type: "progress", progress: (i / length) * 100 });
    }
  }

  return buffer;
}

function encodeMp3(
  channels: Float32Array[],
  sampleRate: number,
  length: number,
  bitrate: number
): ArrayBuffer {
  const channelCount = Math.min(2, channels.length);
  const encoder = new Mp3Encoder(channelCount, sampleRate, bitrate);

  const left = channels[0];
  const right = channelCount > 1 ? channels[1] : left;

  const blockSize = 1152;
  const chunks: Uint8Array[] = [];
  const leftPcm = new Int16Array(blockSize);
  const rightPcm = new Int16Array(blockSize);

  // Report ~20 times over the whole encode, like the WAV path. One message per
  // block is ~7,600 for a three-minute track, and each one lands in a React
  // state update on the main thread.
  const reportEvery = Math.max(1, Math.floor(length / blockSize / 20));
  let blockIndex = 0;

  for (let offset = 0; offset < length; offset += blockSize) {
    const size = Math.min(blockSize, length - offset);

    for (let i = 0; i < size; i++) {
      leftPcm[i] = toInt16(left[offset + i]);
      rightPcm[i] = toInt16(right[offset + i]);
    }

    const block =
      size === blockSize
        ? channelCount > 1
          ? encoder.encodeBuffer(leftPcm, rightPcm)
          : encoder.encodeBuffer(leftPcm)
        : channelCount > 1
          ? encoder.encodeBuffer(leftPcm.subarray(0, size), rightPcm.subarray(0, size))
          : encoder.encodeBuffer(leftPcm.subarray(0, size));

    if (block.length > 0) chunks.push(new Uint8Array(block));

    if (blockIndex % reportEvery === 0) {
      scope.postMessage({ type: "progress", progress: (offset / length) * 100 });
    }

    blockIndex += 1;
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) chunks.push(new Uint8Array(flushed));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let position = 0;

  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }

  return output.buffer;
}

scope.onmessage = (event) => {
  const { format, channels, sampleRate, length, bitrate } = event.data;

  try {
    const buffer =
      format === "mp3"
        ? encodeMp3(channels, sampleRate, length, bitrate)
        : encodeWav(channels, sampleRate, length);

    scope.postMessage({ type: "done", buffer }, [buffer]);
  } catch (error) {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Encoding failed"
    });
  }
};
