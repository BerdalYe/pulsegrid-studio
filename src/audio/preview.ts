import type { Channel } from "../types";
import type { InstrumentMenuEntry } from "../presets/presets";
import { DRUM_TYPES } from "../lib/utils";
import { getSample } from "./sampleRegistry";
import { BUILTIN_ID, BUILTIN_NAME, loadFont } from "./soundfont/registry";
import { playPreview, stopPreview, type PreviewNote } from "./engine";

/**
 * Hearing an instrument or a sample in the browser before using it. Nothing is added to the project: a channel is
 * made up for the moment, played straight to the master, and forgotten.
 */

const PREVIEW_ID = "__preview__";

/** A made-up channel for an instrument from the list, with the same settings adding it would give. */
export function previewChannelFor(entry: InstrumentMenuEntry): Channel {
  return {
    id: PREVIEW_ID,
    name: entry.label,
    type: entry.type,
    color: "#ffffff",
    mute: false,
    solo: false,
    volume: 0.85,
    pan: 0,
    mixerTrackId: 0,
    sampleId: entry.sample,
    pitchOffset: 0,
    trimStart: 0,
    trimEnd: 1,
    reverse: false,
    loop: false,
    synthPreset: entry.preset,
    soundfont: entry.soundfont
      ? {
          fontId: BUILTIN_ID,
          fontName: BUILTIN_NAME,
          bank: entry.soundfont.bank,
          program: entry.soundfont.program,
          name: entry.label,
          ...(entry.soundfont.drumNote !== undefined ? { drumNote: entry.soundfont.drumNote } : {})
        }
      : undefined
  };
}

/** A note at a time, `gap` seconds apart. */
const run = (pitches: number[], gap: number, length: number): PreviewNote[] =>
  pitches.map((pitch, index) => ({ at: index * gap, pitch, duration: index === pitches.length - 1 ? length * 2.5 : length }));

const chord = (pitches: number[], length: number): PreviewNote[] => pitches.map((pitch) => ({ at: 0, pitch, duration: length }));

/** A bar of beat for a drum kit: kick, hats and snare, General MIDI's drum keys. */
const BEAT: PreviewNote[] = [
  { at: 0, pitch: 36, duration: 0.3 },
  { at: 0, pitch: 42, duration: 0.1, velocity: 0.6 },
  { at: 0.25, pitch: 42, duration: 0.1, velocity: 0.5 },
  { at: 0.5, pitch: 38, duration: 0.3 },
  { at: 0.5, pitch: 42, duration: 0.1, velocity: 0.6 },
  { at: 0.75, pitch: 42, duration: 0.1, velocity: 0.5 },
  { at: 0.875, pitch: 36, duration: 0.3, velocity: 0.7 },
  { at: 1.0, pitch: 36, duration: 0.3 },
  { at: 1.0, pitch: 49, duration: 0.8, velocity: 0.6 }
];

/** What to play to show off an instrument, chosen by what kind of instrument it is. */
export function previewNotesFor(entry: InstrumentMenuEntry): PreviewNote[] {
  // One drum of a kit: hit twice, the second softer, the way it would sit in a beat.
  if (entry.soundfont?.drumNote !== undefined) {
    return [
      { at: 0, pitch: 60, duration: 0.4 },
      { at: 0.3, pitch: 60, duration: 0.4, velocity: 0.6 }
    ];
  }
  // A whole kit, or a drum set made from one.
  if (entry.soundfont?.bank === 128) return BEAT;
  if ((DRUM_TYPES as readonly string[]).includes(entry.type)) return [{ at: 0, pitch: 60, duration: 0.5 }];

  if (entry.type === "sample") {
    const seconds = entry.sample ? (getSample(entry.sample)?.buffer.duration ?? 2) : 2;
    return [{ at: 0, pitch: 60, duration: Math.min(6, seconds) }];
  }

  switch (entry.group) {
    case "Drums":
      return [
        { at: 0, pitch: 48, duration: 0.6 },
        { at: 0.35, pitch: 45, duration: 0.6 }
      ];
    case "Bass":
      return run([36, 36, 43, 39], 0.26, 0.22);
    case "Pads":
    case "Strings":
    case "Voices":
      return chord([60, 64, 67, 72], 1.6);
    case "FX":
      return [{ at: 0, pitch: 60, duration: 2.4 }];
    case "Brass & Winds":
      return run([60, 64, 67], 0.3, 0.26);
    default:
      // Keys, mallets, guitars, synths and the plugins: a quick rising arpeggio.
      return run([60, 64, 67, 72], 0.17, 0.16);
  }
}

/**
 * Play an instrument from the list. Returns a message when it has no sound of its own to play, so the browser can
 * say why nothing was heard.
 */
export async function previewInstrument(entry: InstrumentMenuEntry): Promise<string | null> {
  if (entry.midiOut) return "MIDI Out plays through another program. Drag it onto the channel rack to set it up.";
  if (entry.type === "sample" && !entry.sample) return "The Sampler plays a sound you give it. Drag it onto the channel rack, then load a sample.";

  // A recorded instrument needs its sounds in memory first; the first preview waits for them.
  if (entry.soundfont) {
    const font = await loadFont(BUILTIN_ID);
    if (!font) return "The built-in instruments aren't available here.";
  }

  playPreview(previewChannelFor(entry), previewNotesFor(entry));
  return null;
}

/** Play a sample from the browser, once, as it is. */
export function previewSample(sampleId: string): void {
  const sample = getSample(sampleId);
  if (!sample) return;
  previewOf({ label: sample.name, type: "sample", group: "FX", sample: sampleId });
}

function previewOf(entry: InstrumentMenuEntry): void {
  playPreview(previewChannelFor(entry), previewNotesFor(entry));
}

export { stopPreview };
