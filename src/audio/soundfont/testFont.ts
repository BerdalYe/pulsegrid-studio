/**
 * For tests only: builds a small, valid SoundFont 2 file in memory, so the
 * reader and the player can be checked against exact, known contents.
 */
import { GEN } from "./sf2";

export interface TestSample {
  name: string;
  /** Audio, 16-bit. */
  data: Int16Array;
  rate?: number;
  rootKey?: number;
  pitchCorrection?: number;
  /** Loop points, counted from the start of this sample. */
  loopStart?: number;
  loopEnd?: number;
  type?: number;
}

export interface TestZone {
  keyRange?: [number, number];
  velRange?: [number, number];
  gens?: Record<number, number>;
}

export interface TestInstrument {
  name: string;
  global?: TestZone;
  zones: Array<TestZone & { sample: number }>;
}

export interface TestPreset {
  name: string;
  bank?: number;
  program: number;
  global?: TestZone;
  zones: Array<TestZone & { instrument: number }>;
}

class Writer {
  private bytes: number[] = [];
  u8(value: number) {
    this.bytes.push(value & 0xff);
  }
  u16(value: number) {
    this.u8(value);
    this.u8(value >> 8);
  }
  i16(value: number) {
    this.u16(value < 0 ? value + 65536 : value);
  }
  u32(value: number) {
    this.u16(value & 0xffff);
    this.u16(value >>> 16);
  }
  text(value: string, length: number) {
    for (let i = 0; i < length; i++) this.u8(i < value.length ? value.charCodeAt(i) : 0);
  }
  tag(value: string) {
    for (let i = 0; i < 4; i++) this.u8(value.charCodeAt(i));
  }
  raw(other: Writer) {
    this.bytes.push(...other.bytes);
  }
  get length() {
    return this.bytes.length;
  }
  toArray() {
    return this.bytes;
  }
}

function chunk(id: string, body: Writer): Writer {
  const out = new Writer();
  out.tag(id);
  out.u32(body.length);
  out.raw(body);
  if (body.length % 2) out.u8(0);
  return out;
}

function list(type: string, ...parts: Writer[]): Writer {
  const body = new Writer();
  body.tag(type);
  for (const part of parts) body.raw(part);
  return chunk("LIST", body);
}

/** Generators of a zone as [oper, amount] pairs, with the two ranges first as the format asks. */
function generators(zone: TestZone, last?: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (zone.keyRange) out.push([GEN.keyRange, zone.keyRange[0] | (zone.keyRange[1] << 8)]);
  if (zone.velRange) out.push([GEN.velRange, zone.velRange[0] | (zone.velRange[1] << 8)]);
  for (const [oper, amount] of Object.entries(zone.gens ?? {})) out.push([Number(oper), amount]);
  if (last) out.push(last);
  return out;
}

export function buildSoundFont(samples: TestSample[], instruments: TestInstrument[], presets: TestPreset[]): ArrayBuffer {
  // Sample data: each sample followed by 46 frames of silence, as the format asks.
  const smpl = new Writer();
  const positions: Array<{ start: number; end: number }> = [];
  let frame = 0;
  for (const sample of samples) {
    const start = frame;
    for (const value of sample.data) smpl.i16(value);
    frame += sample.data.length;
    positions.push({ start, end: frame });
    for (let i = 0; i < 46; i++) smpl.i16(0);
    frame += 46;
  }

  const shdr = new Writer();
  samples.forEach((sample, index) => {
    const { start, end } = positions[index];
    shdr.text(sample.name, 20);
    shdr.u32(start);
    shdr.u32(end);
    shdr.u32(start + (sample.loopStart ?? 0));
    shdr.u32(start + (sample.loopEnd ?? sample.data.length));
    shdr.u32(sample.rate ?? 44100);
    shdr.u8(sample.rootKey ?? 60);
    shdr.u8(sample.pitchCorrection ?? 0);
    shdr.u16(0);
    shdr.u16(sample.type ?? 1);
  });
  shdr.text("EOS", 20);
  for (let i = 0; i < 26; i++) shdr.u8(0);

  const bags = (zones: Array<{ gens: Array<[number, number]> }>) => {
    const bag = new Writer();
    const gen = new Writer();
    let count = 0;
    for (const zone of zones) {
      bag.u16(count);
      bag.u16(0);
      for (const [oper, amount] of zone.gens) {
        gen.u16(oper);
        gen.i16(amount > 32767 ? amount - 65536 : amount);
        count++;
      }
    }
    bag.u16(count);
    bag.u16(0);
    gen.u16(0);
    gen.u16(0);
    return { bag, gen };
  };

  // Instruments.
  const inst = new Writer();
  const instZones: Array<{ gens: Array<[number, number]> }> = [];
  for (const instrument of instruments) {
    inst.text(instrument.name, 20);
    inst.u16(instZones.length);
    if (instrument.global) instZones.push({ gens: generators(instrument.global) });
    for (const zone of instrument.zones) instZones.push({ gens: generators(zone, [GEN.sampleID, zone.sample]) });
  }
  inst.text("EOI", 20);
  inst.u16(instZones.length);
  const ib = bags(instZones);

  // Presets.
  const phdr = new Writer();
  const presetZones: Array<{ gens: Array<[number, number]> }> = [];
  for (const preset of presets) {
    phdr.text(preset.name, 20);
    phdr.u16(preset.program);
    phdr.u16(preset.bank ?? 0);
    phdr.u16(presetZones.length);
    phdr.u32(0);
    phdr.u32(0);
    phdr.u32(0);
    if (preset.global) presetZones.push({ gens: generators(preset.global) });
    for (const zone of preset.zones) presetZones.push({ gens: generators(zone, [GEN.instrument, zone.instrument]) });
  }
  phdr.text("EOP", 20);
  phdr.u16(255);
  phdr.u16(255);
  phdr.u16(presetZones.length);
  phdr.u32(0);
  phdr.u32(0);
  phdr.u32(0);
  const pb = bags(presetZones);

  const emptyMod = new Writer();
  for (let i = 0; i < 10; i++) emptyMod.u8(0);

  const info = new Writer();
  const version = new Writer();
  version.u16(2);
  version.u16(1);
  info.raw(chunk("ifil", version));
  const name = new Writer();
  name.text("Test", 4);
  info.raw(chunk("INAM", name));

  const body = new Writer();
  body.tag("sfbk");
  body.raw(list("INFO", info));
  body.raw(list("sdta", chunk("smpl", smpl)));
  body.raw(
    list(
      "pdta",
      chunk("phdr", phdr),
      chunk("pbag", pb.bag),
      chunk("pmod", emptyMod),
      chunk("pgen", pb.gen),
      chunk("inst", inst),
      chunk("ibag", ib.bag),
      chunk("imod", emptyMod),
      chunk("igen", ib.gen),
      chunk("shdr", shdr)
    )
  );

  const file = new Writer();
  file.tag("RIFF");
  file.u32(body.length);
  file.raw(body);

  return new Uint8Array(file.toArray()).buffer;
}

/** A tone worth looking at: `length` frames of a sine at `cycles` cycles per sample. */
export function sine(length: number, cycles = 8): Int16Array {
  return Int16Array.from({ length }, (_, i) => Math.round(Math.sin((2 * Math.PI * cycles * i) / length) * 20000));
}
