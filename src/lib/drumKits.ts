import type { Channel, ChannelType } from "../types";
import { channelColors } from "./utils";

/**
 * The recorded drum kits and what is on their keys. Every kit in the built-in set follows the General MIDI drum
 * map (with Roland's GS additions at either end), so one table names the drums for all of them.
 */

/** Short names for the drums of the General MIDI map, by note number. */
export const GM_DRUM_NAMES: Readonly<Record<number, string>> = {
  27: "High Q",
  28: "Slap",
  29: "Scratch Push",
  30: "Scratch Pull",
  31: "Sticks",
  32: "Square Click",
  33: "Metronome",
  34: "Metronome Bell",
  35: "Kick 2",
  36: "Kick",
  37: "Rimshot",
  38: "Snare",
  39: "Clap",
  40: "Snare 2",
  41: "Floor Tom Lo",
  42: "Closed Hat",
  43: "Floor Tom Hi",
  44: "Pedal Hat",
  45: "Low Tom",
  46: "Open Hat",
  47: "Mid Tom Lo",
  48: "Mid Tom Hi",
  49: "Crash",
  50: "High Tom",
  51: "Ride",
  52: "China",
  53: "Ride Bell",
  54: "Tambourine",
  55: "Splash",
  56: "Cowbell",
  57: "Crash 2",
  58: "Vibraslap",
  59: "Ride 2",
  60: "Bongo Hi",
  61: "Bongo Lo",
  62: "Conga Mute",
  63: "Conga Hi",
  64: "Conga Lo",
  65: "Timbale Hi",
  66: "Timbale Lo",
  67: "Agogo Hi",
  68: "Agogo Lo",
  69: "Cabasa",
  70: "Maracas",
  71: "Whistle Short",
  72: "Whistle Long",
  73: "Guiro Short",
  74: "Guiro Long",
  75: "Claves",
  76: "Wood Block Hi",
  77: "Wood Block Lo",
  78: "Cuica Mute",
  79: "Cuica Open",
  80: "Triangle Mute",
  81: "Triangle Open",
  82: "Shaker",
  83: "Jingle Bell",
  84: "Bell Tree",
  85: "Castanets",
  86: "Surdo Mute",
  87: "Surdo Open"
};

export interface DrumKitDef {
  /** As shown in the lists, e.g. "808/909 Kit". */
  name: string;
  /** Put in front of a single drum's name, e.g. "808 Kick". */
  short: string;
  /** Program number in the drum bank (128). */
  program: number;
}

/** The kits that follow the usual drum map, so each can be split into its drums. */
export const DRUM_KITS: readonly DrumKitDef[] = [
  { name: "Standard Kit", short: "Standard", program: 0 },
  { name: "Room Kit", short: "Room", program: 8 },
  { name: "Power Kit", short: "Power", program: 16 },
  { name: "Electronic Kit", short: "Electronic", program: 24 },
  { name: "808/909 Kit", short: "808", program: 25 },
  { name: "Dance Kit", short: "Dance", program: 26 },
  { name: "Jazz Kit", short: "Jazz", program: 32 },
  { name: "Brush Kit", short: "Brush", program: 40 }
];

/** The drums each kit offers on their own, as channels of one drum each. */
export const KIT_PIECES: ReadonlyArray<{ name: string; note: number; kind: ChannelType }> = [
  { name: "Kick", note: 36, kind: "kick" },
  { name: "Snare", note: 38, kind: "snare" },
  { name: "Rimshot", note: 37, kind: "rim" },
  { name: "Clap", note: 39, kind: "clap" },
  { name: "Closed Hat", note: 42, kind: "hat" },
  { name: "Open Hat", note: 46, kind: "hat" },
  { name: "Low Tom", note: 45, kind: "tom" },
  { name: "High Tom", note: 50, kind: "tom" },
  { name: "Crash", note: 49, kind: "cymbal" },
  { name: "Ride", note: 51, kind: "cymbal" }
];

/** The colour a single drum's channel gets: the same as the drum machine's drum of that kind. */
export function kitPieceColor(note: number): string | undefined {
  const piece = KIT_PIECES.find((candidate) => candidate.note === note);
  return piece ? channelColors[piece.kind] : undefined;
}

/** What a drum set adds: the drums a beat is made of, each on a channel of its own. */
export const DRUM_SET_PIECES: readonly string[] = ["Kick", "Snare", "Clap", "Closed Hat", "Open Hat"];

/** The pads the kit panel shows, bottom-left first like a pad controller: the drums people reach for most. */
export const KIT_PADS: readonly number[] = [36, 38, 39, 37, 42, 44, 46, 54, 45, 47, 50, 56, 49, 51, 55, 53];

/** The note a single-drum channel plays at its own pitch; other notes play the same drum higher or lower. */
export const DRUM_ROOT = 60;

/** Is this channel a whole recorded kit, with a different drum on every key? */
export function isFullKit(channel: Pick<Channel, "soundfont"> | undefined | null): boolean {
  return channel?.soundfont?.bank === 128 && channel.soundfont.drumNote === undefined;
}

/** The note a step on the channel rack plays: the kick for a whole kit, middle C for everything else. */
export function stepPitchOf(channel: Pick<Channel, "soundfont"> | undefined | null): number {
  return isFullKit(channel) ? 36 : 60;
}

/** The name of the drum on a key of a whole kit, or null where the map has nothing. */
export function drumName(pitch: number): string | null {
  return GM_DRUM_NAMES[pitch] ?? null;
}
