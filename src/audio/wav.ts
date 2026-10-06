/** 16-bit PCM WAV encoder. Used for the main-thread fallback and for tests. */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  length: number
): ArrayBuffer {
  const channelCount = Math.min(2, channels.length);
  const blockAlign = channelCount * 2;
  const dataSize = length * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string): void => {
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

  for (let i = 0; i < length; i++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const raw = channels[channel][i];
      const clamped = raw < -1 ? -1 : raw > 1 ? 1 : raw;
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return buffer;
}

export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    channels.push(buffer.getChannelData(c));
  }

  return new Blob([encodeWav(channels, buffer.sampleRate, buffer.length)], {
    type: "audio/wav"
  });
}
