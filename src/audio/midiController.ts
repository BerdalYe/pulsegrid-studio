import { midiManager, type MidiEvent } from "./midi";
import { handleControlChange, useMidiStore } from "./midiMap";
import {
  getPlayPosition,
  noteOff,
  noteOn,
  previewChannel,
  setModulation,
  setPitchBend
} from "./engine";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { useTransportStore } from "../state/transportStore";
import { clamp, uid } from "../lib/utils";

import { padTarget } from "./drumMap";

/**
 * What a MIDI keyboard does in the studio.
 *
 *  - Keys play the keyboard-target channel with velocity, held until release.
 *  - Drum pads (MIDI channel 10, as on the MPK Mini) hit the matching drum
 *    channel by the General MIDI drum map — kick pad → your kick — or, for a
 *    pad with no match, the channel in that position in the rack.
 *  - Sustain pedal, pitch wheel/joystick (±2 semitones) and mod wheel work.
 *  - Knobs go through the MIDI map (defaults for the MPK Mini, or learned).
 *  - With record armed and the transport running, keys are written into the
 *    piano roll and pads into the step grid of the selected pattern.
 */

/** MIDI channel 10 is the drum channel by convention. */
export const DRUM_MIDI_CHANNEL = 10;
const BEND_RANGE_CENTS = 200;

function keyboardTarget(): string | null {
  const session = useSessionStore.getState();
  const channels = useProjectStore.getState().channels;
  if (session.selectedChannelId && channels.some((entry) => entry.id === session.selectedChannelId)) {
    return session.selectedChannelId;
  }
  // Nothing selected: the first melodic channel is the sensible guess.
  return (channels.find((entry) => entry.type === "synth") ?? channels[0])?.id ?? null;
}

/* ─────────────────────────────── recording ─────────────────────────────── */

interface PendingNote {
  channelId: string;
  patternId: string;
  start: number;
  velocity: number;
}

const pending = new Map<number, PendingNote>();

function recording(): boolean {
  return useMidiStore.getState().recordArmed && useTransportStore.getState().isPlaying;
}

/** Map the playhead to a position inside the selected pattern. */
function patternPosition(): { patternId: string; position: number; length: number } | null {
  const raw = getPlayPosition();
  if (raw === null) return null;

  const session = useSessionStore.getState();
  const pattern = useProjectStore.getState().patterns[session.selectedPatternId];
  if (!pattern) return null;

  return { patternId: pattern.id, position: raw % pattern.length, length: pattern.length };
}

function commitNote(note: number, entry: PendingNote): void {
  const end = patternPosition();
  const pattern = useProjectStore.getState().patterns[entry.patternId];
  if (!pattern) return;

  const snap = Math.max(1, useSessionStore.getState().pianoSnapSteps);
  const length = pattern.length;

  let startStep = Math.round(entry.start / snap) * snap;
  if (startStep >= length) startStep = 0;

  let held = (end?.position ?? entry.start + snap) - entry.start;
  if (held <= 0) held += length; // released after the pattern looped

  const noteLength = clamp(Math.round(held / snap) * snap || snap, snap, length - startStep);

  useProjectStore.getState().addNote(entry.patternId, entry.channelId, {
    id: uid(),
    pitch: note,
    start: startStep,
    length: noteLength,
    velocity: clamp(Math.round(entry.velocity * 127), 1, 127)
  });
}

/* ─────────────────────────────── handling ─────────────────────────────── */

/** Which channel each held key is sounding on, so release finds it. */
const heldKeys = new Map<number, string>();
const sustained = new Set<number>();
let sustainDown = false;

function releaseKey(note: number): void {
  const channelId = heldKeys.get(note);
  if (!channelId) return;
  heldKeys.delete(note);
  noteOff(channelId, note);
  useTransportStore.getState().noteOff(note);
}

export function handleMidiEvent(event: MidiEvent, onStatus?: (message: string) => void): void {
  useMidiStore.getState().markActivity();

  switch (event.type) {
    case "noteon": {
      if (event.channel === DRUM_MIDI_CHANNEL) {
        const target = padTarget(event.note, useProjectStore.getState().channels);
        if (!target) return;

        // A drum is a one-shot: the pad's length doesn't matter, except that
        // an open hat is asked for with a longer gate.
        previewChannel(target.channelId, target.pitch, event.velocity, target.open ? 0.4 : 0.1);

        if (recording()) {
          const at = patternPosition();
          if (at) {
            const step = Math.round(at.position) % at.length;
            useProjectStore.getState().setStep(at.patternId, target.channelId, step, clamp(event.velocity, 0.05, 1));
          }
        }
        return;
      }

      const channelId = keyboardTarget();
      if (!channelId) return;

      // Re-striking a sustained key restarts it rather than stacking a copy.
      if (heldKeys.has(event.note)) releaseKey(event.note);
      sustained.delete(event.note);

      heldKeys.set(event.note, channelId);
      noteOn(channelId, event.note, event.velocity);
      useTransportStore.getState().noteOn(event.note);

      if (recording()) {
        const at = patternPosition();
        if (at) {
          pending.set(event.note, {
            channelId,
            patternId: at.patternId,
            start: at.position,
            velocity: event.velocity
          });
        }
      }
      return;
    }

    case "noteoff": {
      if (event.channel === DRUM_MIDI_CHANNEL) return;

      const entry = pending.get(event.note);
      if (entry) {
        pending.delete(event.note);
        commitNote(event.note, entry);
      }

      if (sustainDown) sustained.add(event.note);
      else releaseKey(event.note);
      return;
    }

    case "pitchbend": {
      const channelId = keyboardTarget();
      if (channelId) setPitchBend(channelId, event.value * BEND_RANGE_CENTS);
      return;
    }

    case "cc": {
      // Sustain pedal.
      if (event.controller === 64) {
        sustainDown = event.value >= 0.5;
        if (!sustainDown) {
          for (const note of sustained) releaseKey(note);
          sustained.clear();
        }
        return;
      }

      // Mod wheel (the MPK joystick's vertical axis).
      if (event.controller === 1) {
        const channelId = keyboardTarget();
        if (channelId) setModulation(channelId, event.value);
        return;
      }

      // All notes off / all sound off.
      if (event.controller === 123 || event.controller === 120) {
        releaseAllKeys();
        return;
      }

      const message = handleControlChange(event.controller, event.value);
      if (message) onStatus?.(message);
      return;
    }
  }
}

export function releaseAllKeys(): void {
  for (const note of [...heldKeys.keys()]) releaseKey(note);
  sustained.clear();
  sustainDown = false;
  pending.clear();
}

/**
 * Connect MIDI (without a permission prompt where one would be needed) and
 * route every message through `handleMidiEvent`. Returns a teardown.
 */
export function startMidi(onStatus: (message: string) => void): () => void {
  const unsubscribeEvents = midiManager.onEvent((event) => handleMidiEvent(event, onStatus));
  const unsubscribeConnections = midiManager.onConnectionMessage(onStatus);

  // Stopping the transport ends any note still being recorded.
  const unsubscribeTransport = useTransportStore.subscribe((state, previous) => {
    if (previous.isPlaying && !state.isPlaying) pending.clear();
  });

  void midiManager.initIfAllowed().then((connected) => {
    if (!connected) return;
    const devices = midiManager.getDevices();
    if (devices.length > 0) onStatus(`MIDI ready: ${devices.map((device) => device.name).join(", ")}.`);
  });

  return () => {
    unsubscribeEvents();
    unsubscribeConnections();
    unsubscribeTransport();
    releaseAllKeys();
  };
}
