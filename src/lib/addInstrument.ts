import { midiManager } from "../audio/midi";
import { BUILTIN_ID, BUILTIN_NAME, requestFont } from "../audio/soundfont/registry";
import type { InstrumentMenuEntry } from "../presets/presets";
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
  const id = project.addChannel(entry.type, entry.label, undefined, entry.preset);

  if (entry.soundfont) {
    project.updateChannelSoundFont(id, {
      fontId: BUILTIN_ID,
      fontName: BUILTIN_NAME,
      bank: entry.soundfont.bank,
      program: entry.soundfont.program,
      name: entry.label.replace(/ \(recorded\)$/, "")
    });
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
