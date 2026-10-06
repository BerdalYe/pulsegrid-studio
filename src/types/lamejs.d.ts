declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}

/**
 * lamejs 1.2.1 ships its internals as separate CommonJS files that reference
 * each other through bare globals. They have to be imported and published by
 * hand — see the header of `src/audio/exportWorker.ts`.
 */
declare module "lamejs/src/js/MPEGMode.js" {
  const MPEGMode: unknown;
  export default MPEGMode;
}

declare module "lamejs/src/js/Lame.js" {
  const Lame: unknown;
  export default Lame;
}

declare module "lamejs/src/js/BitStream.js" {
  const BitStream: unknown;
  export default BitStream;
}

declare module "lamejs/src/js/GainAnalysis.js" {
  const GainAnalysis: unknown;
  export default GainAnalysis;
}

declare module "lamejs/src/js/Encoder.js" {
  const Encoder: unknown;
  export default Encoder;
}
