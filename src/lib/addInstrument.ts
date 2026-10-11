import { midiManager } from "../audio/midi";
import { BUILTIN_ID, BUILTIN_NAME, requestFont } from "../audio/soundfont/registry";
import type { InstrumentMenuEntry } from "../presets/presets";
import { DRUM_KITS, DRUM_SET_PIECES, KIT_PIECES, kitPieceColor } from "./drumKits";
import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { looksLikeCable } from "../components/MidiOutEditor";
import { useSynthEditor } from "../components/SynthEditor";

/**
 * Add an instrument from the Add menu (or the channel rack's Add list): a drum,
 * a synth, a recorded instrument. Recorded ones start reading their sounds
 * straight away, and a plugin opens its editor.
 */
export function addInstrument(entry: InstrumentMenuEntry): string {
  const project = useProjectStore.getState();
  if (entry.drumSet && entry.soundfont) return addDrumSet(entry.soundfont.program);

  const id = project.addChannel(entry.type, entry.label, entry.sample, entry.preset);

  if (entry.soundfont) {
    project.updateChannelSoundFont(id, {
      fontId: BUILTIN_ID,
      fontName: BUILTIN_NAME,
      bank: entry.soundfont.bank,
      program: entry.soundfont.program,
      name: entry.label,
      ...(entry.soundfont.drumNote !== undefined ? { drumNote: entry.soundfont.drumNote } : {})
    });
    const color = entry.soundfont.drumNote !== undefined ? kitPieceColor(entry.soundfont.drumNote) : undefined;
    if (color) project.setChannelColor(id, color);
    requestFont(BUILTIN_ID);
  }

  if (entry.midiOut) {
    // The first virtual cable if there is one, otherwise the first port; the panel lets the person change it.
    const outputs = midiManager.getOutputs();
    const port = outputs.find((output) => looksLikeCable(output.name)) ?? outputs[0];
    project.updateChannelMidiOut(id, { portId: port?.id ?? "", portName: port?.name ?? "(choose a port)", channel: 1 });
    void midiManager.init();
  }

  useSessionStore.getState().selectChannel(id);
  if (entry.plugin) useSynthEditor.getState().open(id);
  return id;
}

/**
 * A kit's main drums as channels of their own (kick, snare, clap and the hats), so a beat is clicked in on the
 * channel rack the way it is in FL. The kick is selected afterwards, and undo takes the whole set back at once.
 */
export function addDrumSet(program: number): string {
  const kit = DRUM_KITS.find((candidate) => candidate.program === program);
  const project = useProjectStore.getState();
  const ids: string[] = [];

  project.beginEdit("Add drum set");
  try {
    for (const name of DRUM_SET_PIECES) {
      const piece = KIT_PIECES.find((candidate) => candidate.name === name);
      if (!piece) continue;
      const label = `${kit?.short ?? "Kit"} ${piece.name}`;
      const id = project.addChannel("synth", label);
      project.updateChannelSoundFont(id, {
        fontId: BUILTIN_ID,
        fontName: BUILTIN_NAME,
        bank: 128,
        program,
        name: label,
        drumNote: piece.note
      });
      project.setChannelColor(id, kitPieceColor(piece.note) ?? "#ff5d5d");
      ids.push(id);
    }
  } finally {
    project.endEdit();
  }

  requestFont(BUILTIN_ID);
  if (ids[0]) useSessionStore.getState().selectChannel(ids[0]);
  return ids[0] ?? "";
}
