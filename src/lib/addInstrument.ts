import { midiManager } from "../audio/midi";
import { BUILTIN_ID, BUILTIN_NAME, requestFont } from "../audio/soundfont/registry";
import type { InstrumentMenuEntry } from "../presets/presets";
import { DRUM_KITS, DRUM_SET_PIECES, KIT_PIECES, kitPieceColor } from "./drumKits";
import { showPluginWindow, usePluginStore, type ChannelPluginStatus } from "../audio/plugins/host";
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
  if (entry.vst3) return addPluginChannel(entry.vst3);

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

/**
 * A VST3 instrument as a new channel. The plugin loads in the plugin host, and its window opens once it has, the way
 * a newly chosen instrument opens in FL.
 */
export function addPluginChannel(plugin: { path: string; uid: string; name: string; vendor: string }): string {
  const project = useProjectStore.getState();
  project.beginEdit("Add plugin");
  let id = "";
  try {
    id = project.addChannel("synth", plugin.name);
    project.updateChannelPlugin(id, { format: "vst3", path: plugin.path, uid: plugin.uid, name: plugin.name, vendor: plugin.vendor });
  } finally {
    project.endEdit();
  }
  useSessionStore.getState().selectChannel(id);
  openPluginWindowWhenReady(id);
  return id;
}

/** Open a plugin channel's window as soon as its plugin has loaded (or give up quietly if it doesn't). */
export function openPluginWindowWhenReady(channelId: string, timeoutMs = 30000): void {
  const tryOpen = (status: ChannelPluginStatus | undefined): boolean => {
    if (status?.kind === "ready") {
      if (status.hasEditor) void showPluginWindow(channelId).catch(() => undefined);
      return true;
    }
    return status?.kind === "error";
  };
  if (tryOpen(usePluginStore.getState().status[channelId])) return;
  const timer = window.setTimeout(() => unsubscribe(), timeoutMs);
  const unsubscribe = usePluginStore.subscribe((state) => {
    if (!tryOpen(state.status[channelId])) return;
    window.clearTimeout(timer);
    unsubscribe();
  });
}
