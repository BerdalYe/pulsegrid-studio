/**
 * Reading SoundFont 2 files (.sf2): banks of recorded instruments.
 *
 * A SoundFont holds recorded samples, and describes instruments made of them.
 * A preset (what you pick: "Grand Piano") is a list of zones, each pointing at
 * an instrument; an instrument is a list of zones, each pointing at a sample
 * and saying which keys and velocities it covers, how it is tuned, whether it
 * loops, and how its volume rises and falls.
 *
 * Only what is needed to play notes is read. The big sample data is kept as a
 * view onto the file's own memory, and turned into audio a sample at a time.
 */

/** One recorded sound. Positions are in sample frames inside `SoundFont.pcm`. */
export interface SfSample {
  name: string;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  sampleRate: number;
  /** The key the recording was made at. */
  originalPitch: number;
  /** Cents to add to be exactly in tune. */
  pitchCorrection: number;
  /** 1 mono, 2 right, 4 left (linked pairs are stereo). */
  type: number;
}

/** The numbers that describe a zone, by the SoundFont generator that sets them. */
export const GEN = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startloopAddrsOffset: 2,
  endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4,
  endAddrsCoarseOffset: 12,
  startloopAddrsCoarseOffset: 45,
  endloopAddrsCoarseOffset: 50,
  initialFilterFc: 8,
  initialFilterQ: 9,
  pan: 17,
  delayVolEnv: 33,
  attackVolEnv: 34,
  holdVolEnv: 35,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  releaseVolEnv: 38,
  keynumToVolEnvHold: 39,
  keynumToVolEnvDecay: 40,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  initialAttenuation: 48,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  scaleTuning: 56,
  exclusiveClass: 57,
  overridingRootKey: 58
} as const;

export interface SfZone {
  /** Generator number → value, exactly as stored (ranges are handled separately). */
  gens: Map<number, number>;
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
}

export interface SfInstrument {
  name: string;
  /** A zone without a sample, first in the list, sets defaults for the rest. */
  global: SfZone | null;
  zones: Array<SfZone & { sample: number }>;
}

export interface SfPreset {
  name: string;
  program: number;
  /** 0 is the melodic bank; 128 holds the percussion kits. */
  bank: number;
  global: SfZone | null;
  zones: Array<SfZone & { instrument: number }>;
}

export interface SoundFont {
  name: string;
  presets: SfPreset[];
  instruments: SfInstrument[];
  samples: SfSample[];
  /** All the recorded audio, 16-bit, one after another. */
  pcm: Int16Array;
}

/* ───────────────────────────────── reading ───────────────────────────────── */

interface Chunk {
  id: string;
  offset: number;
  size: number;
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** The chunks inside `from..to`, descending into LIST chunks by their type. */
function readChunks(view: DataView, from: number, to: number, into: Map<string, Chunk>): void {
  let at = from;
  while (at + 8 <= to) {
    const id = fourcc(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > to + 1) break;

    if (id === "LIST") {
      into.set(`LIST:${fourcc(view, body)}`, { id, offset: body + 4, size: size - 4 });
      readChunks(view, body + 4, body + size, into);
    } else {
      into.set(id, { id, offset: body, size });
    }
    at = body + size + (size % 2);
  }
}

function text(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

function zoneFrom(gens: Map<number, number>): SfZone {
  const key = gens.get(GEN.keyRange);
  const vel = gens.get(GEN.velRange);
  return {
    gens,
    keyLo: key === undefined ? 0 : key & 0xff,
    keyHi: key === undefined ? 127 : (key >> 8) & 0xff,
    velLo: vel === undefined ? 0 : vel & 0xff,
    velHi: vel === undefined ? 127 : (vel >> 8) & 0xff
  };
}

/** Generators as signed 16-bit numbers; the two range generators keep their raw two bytes. */
function readGenerators(view: DataView, chunk: Chunk | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!chunk) return out;
  for (let at = chunk.offset; at + 4 <= chunk.offset + chunk.size; at += 4) {
    const oper = view.getUint16(at, true);
    const raw = view.getUint16(at + 2, true);
    out.push([oper, oper === GEN.keyRange || oper === GEN.velRange ? raw : view.getInt16(at + 2, true)]);
  }
  return out;
}

export function parseSoundFont(buffer: ArrayBuffer, fileName = "SoundFont"): SoundFont {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "sfbk") {
    throw new Error("That isn't a SoundFont (.sf2) file.");
  }

  const chunks = new Map<string, Chunk>();
  readChunks(view, 12, Math.min(buffer.byteLength, 8 + view.getUint32(4, true)), chunks);

  const need = (id: string): Chunk => {
    const chunk = chunks.get(id);
    if (!chunk) throw new Error(`This SoundFont is incomplete (it has no ${id} data).`);
    return chunk;
  };

  const smpl = need("smpl");
  const phdr = need("phdr");
  const pbag = need("pbag");
  const pgen = chunks.get("pgen");
  const inst = need("inst");
  const ibag = need("ibag");
  const igen = chunks.get("igen");
  const shdr = need("shdr");

  // Samples. The last record is a terminator.
  const samples: SfSample[] = [];
  for (let at = shdr.offset; at + 46 <= shdr.offset + shdr.size - 46; at += 46) {
    samples.push({
      name: text(view, at, 20),
      start: view.getUint32(at + 20, true),
      end: view.getUint32(at + 24, true),
      loopStart: view.getUint32(at + 28, true),
      loopEnd: view.getUint32(at + 32, true),
      sampleRate: view.getUint32(at + 36, true),
      originalPitch: view.getUint8(at + 40),
      pitchCorrection: view.getInt8(at + 41),
      type: view.getUint16(at + 44, true)
    });
  }

  // Instruments: bags of zones, each zone a run of generators.
  const igens = readGenerators(view, igen);
  const ibags: Array<{ gen: number }> = [];
  for (let at = ibag.offset; at + 4 <= ibag.offset + ibag.size; at += 4) ibags.push({ gen: view.getUint16(at, true) });

  const instruments: SfInstrument[] = [];
  const instCount = Math.floor(inst.size / 22) - 1;
  for (let i = 0; i < instCount; i++) {
    const at = inst.offset + i * 22;
    const firstBag = view.getUint16(at + 20, true);
    const lastBag = view.getUint16(at + 22 + 20, true);

    const zones: SfInstrument["zones"] = [];
    let global: SfZone | null = null;
    for (let bag = firstBag; bag < lastBag; bag++) {
      const gens = new Map<number, number>();
      for (let g = ibags[bag].gen; g < (ibags[bag + 1]?.gen ?? igens.length); g++) gens.set(igens[g][0], igens[g][1]);

      const zone = zoneFrom(gens);
      const sample = gens.get(GEN.sampleID);
      if (sample === undefined) {
        if (bag === firstBag) global = zone;
      } else if (sample >= 0 && sample < samples.length) {
        zones.push({ ...zone, sample });
      }
    }
    instruments.push({ name: text(view, at, 20), global, zones });
  }

  // Presets: the same, with zones pointing at instruments.
  const pgens = readGenerators(view, pgen);
  const pbags: Array<{ gen: number }> = [];
  for (let at = pbag.offset; at + 4 <= pbag.offset + pbag.size; at += 4) pbags.push({ gen: view.getUint16(at, true) });

  const presets: SfPreset[] = [];
  const presetCount = Math.floor(phdr.size / 38) - 1;
  for (let i = 0; i < presetCount; i++) {
    const at = phdr.offset + i * 38;
    const firstBag = view.getUint16(at + 24, true);
    const lastBag = view.getUint16(at + 38 + 24, true);

    const zones: SfPreset["zones"] = [];
    let global: SfZone | null = null;
    for (let bag = firstBag; bag < lastBag; bag++) {
      const gens = new Map<number, number>();
      for (let g = pbags[bag].gen; g < (pbags[bag + 1]?.gen ?? pgens.length); g++) gens.set(pgens[g][0], pgens[g][1]);

      const zone = zoneFrom(gens);
      const instrument = gens.get(GEN.instrument);
      if (instrument === undefined) {
        if (bag === firstBag) global = zone;
      } else if (instrument >= 0 && instrument < instruments.length) {
        zones.push({ ...zone, instrument });
      }
    }
    presets.push({ name: text(view, at, 20), program: view.getUint16(at + 20, true), bank: view.getUint16(at + 22, true), global, zones });
  }

  // The recorded audio, viewed in place (16-bit little-endian: the same on every PC that runs this).
  const length = Math.floor(smpl.size / 2);
  const pcm = new Int16Array(buffer, smpl.offset, length);

  return { name: fileName.replace(/\.sf2$/i, ""), presets, instruments, samples, pcm };
}

/* ───────────────────────── which recordings play a note ───────────────────────── */

/** Everything needed to play one recording for a note, with the preset's and instrument's settings combined. */
export interface PlayableZone {
  sample: SfSample;
  sampleIndex: number;
  /** The key the recording sounds natural at. */
  rootKey: number;
  /** Cents added to the pitch: coarse and fine tuning. */
  tuneCents: number;
  /** Cents of pitch per key (100 is normal). */
  scaleTuning: number;
  loop: boolean;
  /** Sample frames to move the start, end and loop points by. */
  startOffset: number;
  endOffset: number;
  loopStartOffset: number;
  loopEndOffset: number;
  /** Quieter by this many centibels (10 centibels is 1 dB). */
  attenuationCb: number;
  /** -1 left … 1 right. */
  pan: number;
  /** Where the low-pass filter sits, in absolute cents; 13500 and up means no filter. */
  filterFcCents: number;
  filterQCb: number;
  /** Volume envelope, in seconds (and centibels for the sustain level). */
  delay: number;
  attack: number;
  hold: number;
  decay: number;
  sustainCb: number;
  release: number;
  /** Zones with the same non-zero class cut each other off (a closed hi-hat stops an open one). */
  exclusiveClass: number;
}

/** What a generator is when nothing sets it. */
const DEFAULTS: Record<number, number> = {
  [GEN.initialFilterFc]: 13500,
  [GEN.initialFilterQ]: 0,
  [GEN.pan]: 0,
  [GEN.delayVolEnv]: -12000,
  [GEN.attackVolEnv]: -12000,
  [GEN.holdVolEnv]: -12000,
  [GEN.decayVolEnv]: -12000,
  [GEN.sustainVolEnv]: 0,
  [GEN.releaseVolEnv]: -12000,
  [GEN.keynumToVolEnvHold]: 0,
  [GEN.keynumToVolEnvDecay]: 0,
  [GEN.initialAttenuation]: 0,
  [GEN.coarseTune]: 0,
  [GEN.fineTune]: 0,
  [GEN.scaleTuning]: 100,
  [GEN.sampleModes]: 0,
  [GEN.exclusiveClass]: 0,
  [GEN.overridingRootKey]: -1
};

/** Generators a preset can only set for the instrument, never add to. */
const INSTRUMENT_ONLY = new Set<number>([
  GEN.startAddrsOffset,
  GEN.endAddrsOffset,
  GEN.startloopAddrsOffset,
  GEN.endloopAddrsOffset,
  GEN.startAddrsCoarseOffset,
  GEN.endAddrsCoarseOffset,
  GEN.startloopAddrsCoarseOffset,
  GEN.endloopAddrsCoarseOffset,
  GEN.sampleModes,
  GEN.exclusiveClass,
  GEN.overridingRootKey,
  GEN.sampleID,
  GEN.instrument,
  GEN.keyRange,
  GEN.velRange
]);

const inRange = (zone: SfZone, key: number, velocity: number) =>
  key >= zone.keyLo && key <= zone.keyHi && velocity >= zone.velLo && velocity <= zone.velHi;

const seconds = (timecents: number) => Math.pow(2, Math.max(-12000, Math.min(8000, timecents)) / 1200);

/**
 * The recordings that sound when `key` (0–127) is struck at `velocity` (0–127):
 * several for a layered or stereo sound, one for a simple one, none if the
 * preset has nothing there.
 */
export function zonesFor(font: SoundFont, preset: SfPreset, key: number, velocity: number): PlayableZone[] {
  const out: PlayableZone[] = [];

  for (const presetZone of preset.zones) {
    if (!inRange(presetZone, key, velocity)) continue;

    const instrument = font.instruments[presetZone.instrument];
    if (!instrument) continue;

    for (const zone of instrument.zones) {
      if (!inRange(zone, key, velocity)) continue;
      const sample = font.samples[zone.sample];
      if (!sample || (sample.type & 0x8000) !== 0) continue;

      // Instrument settings: defaults, then the instrument's global zone, then this zone.
      const value = (gen: number): number => {
        let base = zone.gens.get(gen) ?? instrument.global?.gens.get(gen) ?? DEFAULTS[gen] ?? 0;
        if (!INSTRUMENT_ONLY.has(gen)) {
          // The preset adds to it: its own zone, or else its global zone.
          base += presetZone.gens.get(gen) ?? preset.global?.gens.get(gen) ?? 0;
        }
        return base;
      };

      const keyOffset = 60 - key;
      const mode = value(GEN.sampleModes) & 3;
      const root = value(GEN.overridingRootKey);

      out.push({
        sample,
        sampleIndex: zone.sample,
        rootKey: root >= 0 ? root : sample.originalPitch,
        tuneCents: value(GEN.coarseTune) * 100 + value(GEN.fineTune) + sample.pitchCorrection,
        scaleTuning: value(GEN.scaleTuning),
        loop: mode === 1 || mode === 3,
        startOffset: value(GEN.startAddrsOffset) + value(GEN.startAddrsCoarseOffset) * 32768,
        endOffset: value(GEN.endAddrsOffset) + value(GEN.endAddrsCoarseOffset) * 32768,
        loopStartOffset: value(GEN.startloopAddrsOffset) + value(GEN.startloopAddrsCoarseOffset) * 32768,
        loopEndOffset: value(GEN.endloopAddrsOffset) + value(GEN.endloopAddrsCoarseOffset) * 32768,
        attenuationCb: Math.max(0, Math.min(1440, value(GEN.initialAttenuation))),
        pan: Math.max(-1, Math.min(1, value(GEN.pan) / 500)),
        filterFcCents: value(GEN.initialFilterFc),
        filterQCb: Math.max(0, Math.min(960, value(GEN.initialFilterQ))),
        delay: seconds(value(GEN.delayVolEnv)),
        attack: seconds(value(GEN.attackVolEnv)),
        hold: seconds(value(GEN.holdVolEnv) + keyOffset * value(GEN.keynumToVolEnvHold)),
        decay: seconds(value(GEN.decayVolEnv) + keyOffset * value(GEN.keynumToVolEnvDecay)),
        sustainCb: Math.max(0, Math.min(1440, value(GEN.sustainVolEnv))),
        release: seconds(value(GEN.releaseVolEnv)),
        exclusiveClass: value(GEN.exclusiveClass)
      });
    }
  }

  return out;
}

/** Find a preset by bank and program number. */
export function findPreset(font: SoundFont, bank: number, program: number): SfPreset | undefined {
  return font.presets.find((preset) => preset.bank === bank && preset.program === program);
}
