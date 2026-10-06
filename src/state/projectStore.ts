import { sanitizeSynthPatch, type SynthPatch } from "../audio/synthPatch";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  SCHEMA_VERSION,
  type AutomationClip,
  type AutomationParam,
  type AutomationTargetType,
  type Channel,
  type ChannelType,
  type EffectInstance,
  type EffectType,
  type NoteData,
  type PlaylistClip,
  type PlaylistMarker,
  type ProjectData,
  type StepCell
} from "../types";

import {
  createInitialProjectData,
  createPattern,
  ensurePatternChannels,
  sanitizeProjectData
} from "./initialState";

import {
  beginGroup,
  canRedo,
  canUndo,
  capture,
  clearHistory,
  endGroup,
  popRedo,
  popUndo,
  revertCapture
} from "./history";

import { getProjectData, isSameProject } from "./serialize";
import { MASTER_OUTPUT, wouldCreateCycle } from "../audio/routing";

import {
  DEFAULT_STEP_VELOCITY,
  DEFAULT_TRACK_HEIGHT,
  MAX_BPM,
  MAX_TRACK_HEIGHT,
  MIN_BPM,
  MIN_TRACK_HEIGHT,
  STEPS_PER_BAR,
  channelColors,
  clamp,
  resizeSteps,
  trackColorAt,
  uid
} from "../lib/utils";

import { defaultEffectParams, effectTypeNames } from "../audio/effectDefs";
import { getEffectPreset, presetProjects } from "../presets/presets";

export type EffectTarget = number | "master";

export interface ProjectActions {
  setProjectName: (name: string) => void;
  setBpm: (value: number) => void;
  setSwing: (value: number) => void;
  setMasterVolume: (value: number) => void;
  setSongBars: (bars: number) => void;
  /** Pass null for either end to clear the loop region. */
  setLoopRegion: (start: number | null, end: number | null) => void;

  addPattern: (name?: string) => string;
  duplicatePattern: (patternId: string) => string | null;
  removePattern: (patternId: string) => void;
  renamePattern: (patternId: string, name: string) => void;
  setPatternLength: (patternId: string, length: number) => void;
  clearPattern: (patternId: string) => void;
  reorderPattern: (patternId: string, toIndex: number) => void;

  addChannel: (
    type: ChannelType,
    name?: string,
    sampleId?: string,
    synthPreset?: string
  ) => string;
  removeChannel: (channelId: string) => void;
  duplicateChannel: (channelId: string) => string | null;
  moveChannel: (from: number, to: number) => void;
  updateChannelName: (channelId: string, name: string) => void;
  setChannelColor: (channelId: string, color: string) => void;
  toggleChannelMute: (channelId: string) => void;
  toggleChannelSolo: (channelId: string) => void;
  clearChannelSolo: () => void;
  setChannelVolume: (channelId: string, volume: number) => void;
  setChannelPan: (channelId: string, pan: number) => void;
  setChannelMixerTrack: (channelId: string, trackId: number) => void;
  updateChannelSample: (
    channelId: string,
    updates: Partial<
      Pick<Channel, "sampleId" | "pitchOffset" | "trimStart" | "trimEnd" | "reverse" | "loop">
    >
  ) => void;
  updateChannelSynthPreset: (channelId: string, presetId: string) => void;
  /** Set the sound a person built for a synth channel, or pass null to go back to its preset. */
  updateChannelSynthPatch: (channelId: string, patch: SynthPatch | null) => void;

  setStep: (patternId: string, channelId: string, stepIndex: number, cell: StepCell) => void;
  toggleStep: (patternId: string, channelId: string, stepIndex: number) => void;
  clearChannelSteps: (patternId: string, channelId: string) => void;
  shiftChannelSteps: (patternId: string, channelId: string, offset: number) => void;

  addNote: (patternId: string, channelId: string, note: NoteData) => void;
  removeNote: (patternId: string, channelId: string, noteId: string) => void;
  updateNote: (
    patternId: string,
    channelId: string,
    noteId: string,
    updates: Partial<Omit<NoteData, "id">>
  ) => void;
  toggleNote: (patternId: string, channelId: string, step: number, pitch: number) => void;
  setNoteVelocity: (
    patternId: string,
    channelId: string,
    noteId: string,
    velocity: number
  ) => void;
  clearNotes: (patternId: string, channelId: string) => void;
  transposeNotes: (patternId: string, channelId: string, semitones: number) => void;

  addPlaylistClip: (clip: PlaylistClip) => void;
  removePlaylistClip: (clipId: string) => void;
  updatePlaylistClip: (
    clipId: string,
    updates: { trackIndex?: number; startStep?: number; lengthSteps?: number }
  ) => void;
  duplicatePlaylistClip: (clipId: string) => string | null;
  clearPlaylistTrack: (trackIndex: number) => void;
  toggleTrackMute: (trackIndex: number) => void;
  toggleTrackSolo: (trackIndex: number) => void;
  addPlaylistTrack: (name?: string) => void;
  removePlaylistTrack: (trackIndex: number) => void;
  renamePlaylistTrack: (trackIndex: number, name: string) => void;
  movePlaylistTrack: (fromIndex: number, toIndex: number) => void;
  setPlaylistTrackHeight: (trackIndex: number, height: number) => void;
  setPlaylistTrackColor: (trackIndex: number, color: string) => void;

  addMarker: (step: number, name?: string) => string | null;
  removeMarker: (markerId: string) => void;
  renameMarker: (markerId: string, name: string) => void;
  moveMarker: (markerId: string, step: number) => void;

  setMixerTrackVolume: (trackId: number, volume: number) => void;
  setMixerTrackPan: (trackId: number, pan: number) => void;
  toggleMixerTrackMute: (trackId: number) => void;
  toggleMixerTrackSolo: (trackId: number) => void;
  renameMixerTrack: (trackId: number, name: string) => void;
  /** Route an insert's main output. Refused (returns false) if it would close a loop. */
  setMixerTrackOutput: (trackId: number, output: number) => boolean;
  /** Add a post-fader send. Refused (returns false) if it would close a loop. */
  addMixerSend: (trackId: number, target: number, level?: number) => boolean;
  setMixerSendLevel: (trackId: number, target: number, level: number) => void;
  removeMixerSend: (trackId: number, target: number) => void;
  addEffect: (target: EffectTarget, type: EffectType) => void;
  addEffectPreset: (target: EffectTarget, presetId: string) => void;
  removeEffect: (target: EffectTarget, effectId: string) => void;
  toggleEffect: (target: EffectTarget, effectId: string) => void;
  moveEffect: (target: EffectTarget, effectId: string, direction: -1 | 1) => void;
  updateEffectParam: (
    target: EffectTarget,
    effectId: string,
    param: string,
    value: number
  ) => void;
  resetEffect: (target: EffectTarget, effectId: string) => void;

  addAutomationPoint: (clipId: string, step: number, value: number) => void;
  updateAutomationPoint: (clipId: string, pointId: string, value: number, step?: number) => void;
  removeAutomationPoint: (clipId: string, pointId: string) => void;
  setAutomationTarget: (
    clipId: string,
    targetType: AutomationTargetType,
    targetId: string,
    targetParam: AutomationParam
  ) => void;

  beginEdit: (label: string) => void;
  endEdit: () => void;
  undo: () => void;
  redo: () => void;

  hydrate: (data: ProjectData) => void;
  reset: () => void;
  loadPresetProject: (presetId: string) => boolean;
}

export type ProjectState = ProjectData & ProjectActions;

const clampVolume = (value: number) => clamp(Number(value) || 0, 0, 1);

/** Markers are kept in timeline order so the ruler can render them in one pass. */
const sortMarkers = (markers: PlaylistMarker[]): void => {
  markers.sort((a, b) => a.step - b.step);
};

export const useProjectStore = create<ProjectState>()(
  immer((set, get) => {
    /**
     * Every mutation goes through here: snapshot first, mutate second, and
     * throw the snapshot away if nothing actually changed.
     */
    const edit = (label: string, mutator: (state: ProjectState) => void): void => {
      const before = getProjectData(get());
      const pushed = capture(before, label);

      set(mutator as never);

      if (pushed && isSameProject(before, getProjectData(get()))) revertCapture();
    };

    const findChannel = (state: ProjectState, channelId: string) =>
      state.channels.find((channel) => channel.id === channelId);

    const getPatternChannel = (
      state: ProjectState,
      patternId: string,
      channelId: string
    ) => {
      const pattern = state.patterns[patternId];
      if (!pattern) return null;

      // Never mint a lane for a channel that doesn't exist. This runs on the
      // read path, so an unknown id would both create a permanent orphan lane
      // and defeat the no-op check in `edit()` — burning an undo entry on a
      // click that changed nothing the user can see.
      if (!state.channels.some((channel) => channel.id === channelId)) return null;

      let patternChannel = pattern.channels[channelId];

      if (!patternChannel) {
        patternChannel = { steps: Array<StepCell>(pattern.length).fill(null), notes: [] };
        pattern.channels[channelId] = patternChannel;
      }

      return { pattern, patternChannel };
    };

    const effectListOf = (state: ProjectState, target: EffectTarget) =>
      target === "master"
        ? state.mixer.masterEffects
        : state.mixer.tracks.find((track) => track.id === target)?.effects;

    /** Lowest mixer insert that no channel is using yet. */
    const nextFreeMixerTrack = (state: ProjectState): number => {
      const used = new Set(state.channels.map((channel) => channel.mixerTrackId));
      for (const track of state.mixer.tracks) {
        if (!used.has(track.id)) return track.id;
      }
      return state.mixer.tracks[state.mixer.tracks.length - 1]?.id ?? 1;
    };

    const dropClipsForPattern = (state: ProjectState, patternId: string) => {
      state.playlist.clips = state.playlist.clips.filter(
        (clip) => clip.type !== "pattern" || clip.patternId !== patternId
      );
    };

    return {
      ...createInitialProjectData(),

      /* ───────────────────────────── transport-ish ───────────────────────────── */

      setProjectName: (name) =>
        edit("Rename project", (state) => {
          const trimmed = name.trim();
          if (!trimmed || trimmed === state.projectName) return;
          state.projectName = trimmed;
        }),

      setBpm: (value) =>
        edit("Tempo", (state) => {
          const bpm = clamp(Number(value) || state.bpm, MIN_BPM, MAX_BPM);
          if (bpm === state.bpm) return;
          state.bpm = bpm;
        }),

      setSwing: (value) =>
        edit("Swing", (state) => {
          const swing = clamp(Number(value) || 0, 0, 1);
          if (swing === state.swing) return;
          state.swing = swing;
        }),

      setMasterVolume: (value) =>
        edit("Master volume", (state) => {
          const volume = clampVolume(value);
          if (volume === state.masterVolume) return;
          state.masterVolume = volume;
        }),

      setSongBars: (bars) =>
        edit("Song length", (state) => {
          const next = clamp(Math.round(Number(bars) || 1), 1, 512);
          if (next === state.songBars) return;
          state.songBars = next;
        }),

      /* ─────────────────────────────── patterns ─────────────────────────────── */

      setLoopRegion: (start, end) =>
        edit("Loop region", (state) => {
          if (start === null || end === null || end <= start) {
            state.loopStart = null;
            state.loopEnd = null;
            return;
          }

          state.loopStart = Math.max(0, Math.round(start));
          state.loopEnd = Math.max(state.loopStart + 1, Math.round(end));
        }),

      addPattern: (name) => {
        const id = uid();

        edit("Add pattern", (state) => {
          const reference = state.patterns[state.patternOrder[state.patternOrder.length - 1]];
          const pattern = createPattern(
            name?.trim() || `Pattern ${state.patternOrder.length + 1}`,
            reference?.length ?? STEPS_PER_BAR
          );

          pattern.id = id;
          ensurePatternChannels(pattern, state.channels);

          state.patterns[id] = pattern;
          state.patternOrder.push(id);
        });

        return id;
      },

      duplicatePattern: (patternId) => {
        const source = get().patterns[patternId];
        if (!source) return null;

        const id = uid();

        edit("Duplicate pattern", (state) => {
          const original = state.patterns[patternId];
          if (!original) return;

          state.patterns[id] = {
            id,
            name: `${original.name} copy`,
            length: original.length,
            channels: Object.fromEntries(
              Object.entries(original.channels).map(([channelId, channel]) => [
                channelId,
                {
                  steps: [...channel.steps],
                  notes: channel.notes.map((note) => ({ ...note, id: uid() }))
                }
              ])
            )
          };

          const index = state.patternOrder.indexOf(patternId);
          state.patternOrder.splice(index + 1, 0, id);
        });

        return id;
      },

      removePattern: (patternId) =>
        edit("Delete pattern", (state) => {
          if (state.patternOrder.length <= 1) return;
          if (!state.patterns[patternId]) return;

          delete state.patterns[patternId];
          state.patternOrder = state.patternOrder.filter((id) => id !== patternId);
          dropClipsForPattern(state, patternId);
        }),

      renamePattern: (patternId, name) =>
        edit("Rename pattern", (state) => {
          const pattern = state.patterns[patternId];
          const trimmed = name.trim();
          if (!pattern || !trimmed || pattern.name === trimmed) return;
          pattern.name = trimmed;
        }),

      setPatternLength: (patternId, length) =>
        edit("Pattern length", (state) => {
          const pattern = state.patterns[patternId];
          if (!pattern) return;

          const next = clamp(Math.round(Number(length) || 1), 1, 512);
          if (next === pattern.length) return;

          pattern.length = next;

          for (const patternChannel of Object.values(pattern.channels)) {
            patternChannel.steps = resizeSteps(patternChannel.steps, next);
            // Drop notes that fall outside the new length so nothing lingers
            // invisibly past the end of the pattern.
            patternChannel.notes = patternChannel.notes
              .filter((note) => note.start < next)
              .map((note) => ({ ...note, length: Math.min(note.length, next - note.start) }));
          }
        }),

      clearPattern: (patternId) =>
        edit("Clear pattern", (state) => {
          const pattern = state.patterns[patternId];
          if (!pattern) return;

          for (const patternChannel of Object.values(pattern.channels)) {
            patternChannel.steps = Array<StepCell>(pattern.length).fill(null);
            patternChannel.notes = [];
          }
        }),

      reorderPattern: (patternId, toIndex) =>
        edit("Reorder patterns", (state) => {
          const from = state.patternOrder.indexOf(patternId);
          const to = clamp(toIndex, 0, state.patternOrder.length - 1);
          if (from < 0 || from === to) return;

          state.patternOrder.splice(from, 1);
          state.patternOrder.splice(to, 0, patternId);
        }),

      /* ─────────────────────────────── channels ─────────────────────────────── */

      addChannel: (type, name, sampleId, synthPreset) => {
        const id = uid();

        edit("Add channel", (state) => {
          const channel: Channel = {
            id,
            name: name ?? type.charAt(0).toUpperCase() + type.slice(1),
            type,
            color: channelColors[type],
            mute: false,
            solo: false,
            volume: 0.85,
            pan: 0,
            mixerTrackId: nextFreeMixerTrack(state),
            sampleId,
            pitchOffset: 0,
            trimStart: 0,
            trimEnd: 1,
            reverse: false,
            loop: false,
            synthPreset
          };

          state.channels.push(channel);

          for (const pattern of Object.values(state.patterns)) {
            pattern.channels[id] = {
              steps: Array<StepCell>(pattern.length).fill(null),
              notes: []
            };
          }
        });

        return id;
      },

      removeChannel: (channelId) =>
        edit("Delete channel", (state) => {
          if (!findChannel(state, channelId)) return;

          state.channels = state.channels.filter((channel) => channel.id !== channelId);

          for (const pattern of Object.values(state.patterns)) {
            delete pattern.channels[channelId];
          }

          // Automation pointing at a channel that no longer exists is dead
          // weight, so clear it out with the channel.
          state.playlist.clips = state.playlist.clips.filter(
            (clip) =>
              !(clip.type === "automation" &&
                clip.targetType === "channel" &&
                clip.targetId === channelId)
          );
        }),

      duplicateChannel: (channelId) => {
        const source = get().channels.find((channel) => channel.id === channelId);
        if (!source) return null;

        const id = uid();

        edit("Duplicate channel", (state) => {
          const index = state.channels.findIndex((channel) => channel.id === channelId);
          if (index < 0) return;

          const original = state.channels[index];

          state.channels.splice(index + 1, 0, {
            ...original,
            id,
            name: `${original.name} copy`,
            solo: false,
            mixerTrackId: nextFreeMixerTrack(state)
          });

          for (const pattern of Object.values(state.patterns)) {
            const from = pattern.channels[channelId];
            pattern.channels[id] = from
              ? { steps: [...from.steps], notes: from.notes.map((note) => ({ ...note, id: uid() })) }
              : { steps: Array<StepCell>(pattern.length).fill(null), notes: [] };
          }
        });

        return id;
      },

      moveChannel: (from, to) =>
        edit("Reorder channels", (state) => {
          if (from === to) return;
          if (from < 0 || from >= state.channels.length) return;

          const target = clamp(to, 0, state.channels.length - 1);
          const [moved] = state.channels.splice(from, 1);
          state.channels.splice(target, 0, moved);
        }),

      updateChannelName: (channelId, name) =>
        edit("Rename channel", (state) => {
          const channel = findChannel(state, channelId);
          const trimmed = name.trim();
          if (!channel || !trimmed || channel.name === trimmed) return;
          channel.name = trimmed;
        }),

      setChannelColor: (channelId, color) =>
        edit("Channel colour", (state) => {
          const channel = findChannel(state, channelId);
          if (!channel || channel.color === color) return;
          channel.color = color;
        }),

      toggleChannelMute: (channelId) =>
        edit("Mute channel", (state) => {
          const channel = findChannel(state, channelId);
          if (channel) channel.mute = !channel.mute;
        }),

      toggleChannelSolo: (channelId) =>
        edit("Solo channel", (state) => {
          const channel = findChannel(state, channelId);
          if (channel) channel.solo = !channel.solo;
        }),

      clearChannelSolo: () =>
        edit("Clear solo", (state) => {
          for (const channel of state.channels) channel.solo = false;
        }),

      setChannelVolume: (channelId, volume) =>
        edit("Channel volume", (state) => {
          const channel = findChannel(state, channelId);
          const next = clampVolume(volume);
          if (!channel || channel.volume === next) return;
          channel.volume = next;
        }),

      setChannelPan: (channelId, pan) =>
        edit("Channel pan", (state) => {
          const channel = findChannel(state, channelId);
          const next = clamp(Number(pan) || 0, -1, 1);
          if (!channel || channel.pan === next) return;
          channel.pan = next;
        }),

      setChannelMixerTrack: (channelId, trackId) =>
        edit("Route channel", (state) => {
          const channel = findChannel(state, channelId);
          const next = clamp(Math.round(trackId), 1, state.mixer.tracks.length);
          if (!channel || channel.mixerTrackId === next) return;
          channel.mixerTrackId = next;
        }),

      updateChannelSample: (channelId, updates) =>
        edit("Sample settings", (state) => {
          const channel = findChannel(state, channelId);
          if (!channel) return;

          if (updates.sampleId !== undefined) channel.sampleId = updates.sampleId;
          if (updates.pitchOffset !== undefined) {
            channel.pitchOffset = clamp(Math.round(updates.pitchOffset), -24, 24);
          }
          if (updates.trimStart !== undefined) {
            channel.trimStart = clamp(updates.trimStart, 0, (channel.trimEnd ?? 1) - 0.01);
          }
          if (updates.trimEnd !== undefined) {
            channel.trimEnd = clamp(updates.trimEnd, (channel.trimStart ?? 0) + 0.01, 1);
          }
          if (updates.reverse !== undefined) channel.reverse = updates.reverse;
          if (updates.loop !== undefined) channel.loop = updates.loop;
        }),

      updateChannelSynthPreset: (channelId, presetId) =>
        edit("Synth preset", (state) => {
          const channel = findChannel(state, channelId);
          if (!channel || channel.synthPreset === presetId) return;
          channel.synthPreset = presetId || undefined;
          // Choosing a preset by name means the preset, not an old custom sound.
          channel.synthPatch = undefined;
        }),

      updateChannelSynthPatch: (channelId, patch) =>
        edit("Synth sound", (state) => {
          const channel = findChannel(state, channelId);
          if (!channel || channel.type !== "synth") return;
          channel.synthPatch = patch ? (sanitizeSynthPatch(patch) ?? undefined) : undefined;
        }),

      /* ──────────────────────────────── steps ──────────────────────────────── */

      setStep: (patternId, channelId, stepIndex, cell) =>
        edit("Step", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found) return;

          const { patternChannel } = found;
          if (stepIndex < 0 || stepIndex >= patternChannel.steps.length) return;
          if (patternChannel.steps[stepIndex] === cell) return;

          patternChannel.steps[stepIndex] = cell;
        }),

      toggleStep: (patternId, channelId, stepIndex) =>
        edit("Step", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found) return;

          const { patternChannel } = found;
          if (stepIndex < 0 || stepIndex >= patternChannel.steps.length) return;

          patternChannel.steps[stepIndex] =
            patternChannel.steps[stepIndex] === null ? DEFAULT_STEP_VELOCITY : null;
        }),

      clearChannelSteps: (patternId, channelId) =>
        edit("Clear steps", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found) return;
          found.patternChannel.steps = Array<StepCell>(found.pattern.length).fill(null);
        }),

      shiftChannelSteps: (patternId, channelId, offset) =>
        edit("Shift steps", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found || offset === 0) return;

          const { pattern, patternChannel } = found;
          const length = pattern.length;
          const next = Array<StepCell>(length).fill(null);

          for (let i = 0; i < length; i++) {
            next[(((i + offset) % length) + length) % length] = patternChannel.steps[i];
          }

          patternChannel.steps = next;
        }),

      /* ──────────────────────────────── notes ──────────────────────────────── */

      addNote: (patternId, channelId, note) =>
        edit("Add note", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found) return;
          found.patternChannel.notes.push(note);
        }),

      removeNote: (patternId, channelId, noteId) =>
        edit("Delete note", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found) return;

          const { patternChannel } = found;
          const next = patternChannel.notes.filter((note) => note.id !== noteId);
          if (next.length === patternChannel.notes.length) return;
          patternChannel.notes = next;
        }),

      updateNote: (patternId, channelId, noteId, updates) =>
        edit("Edit note", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found) return;

          const { pattern, patternChannel } = found;
          const note = patternChannel.notes.find((entry) => entry.id === noteId);
          if (!note) return;

          if (updates.pitch !== undefined) note.pitch = clamp(Math.round(updates.pitch), 0, 127);
          if (updates.start !== undefined) {
            note.start = clamp(Math.round(updates.start), 0, pattern.length - 1);
          }
          if (updates.length !== undefined) {
            note.length = clamp(Math.round(updates.length), 1, pattern.length - note.start);
          }
          if (updates.velocity !== undefined) {
            note.velocity = clamp(Math.round(updates.velocity), 1, 127);
          }
        }),

      toggleNote: (patternId, channelId, step, pitch) =>
        edit("Note", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found) return;

          const { patternChannel } = found;
          const index = patternChannel.notes.findIndex(
            (note) => note.start === step && note.pitch === pitch
          );

          if (index >= 0) {
            patternChannel.notes.splice(index, 1);
          } else {
            patternChannel.notes.push({
              id: uid(),
              pitch,
              start: step,
              length: 1,
              velocity: 100
            });
          }
        }),

      setNoteVelocity: (patternId, channelId, noteId, velocity) =>
        edit("Note velocity", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found) return;

          const note = found.patternChannel.notes.find((entry) => entry.id === noteId);
          const next = clamp(Math.round(velocity), 1, 127);
          if (!note || note.velocity === next) return;
          note.velocity = next;
        }),

      clearNotes: (patternId, channelId) =>
        edit("Clear notes", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found || found.patternChannel.notes.length === 0) return;
          found.patternChannel.notes = [];
        }),

      transposeNotes: (patternId, channelId, semitones) =>
        edit("Transpose", (state) => {
          const found = getPatternChannel(state, patternId, channelId);
          if (!found || semitones === 0) return;

          for (const note of found.patternChannel.notes) {
            note.pitch = clamp(note.pitch + semitones, 0, 127);
          }
        }),

      /* ─────────────────────────────── playlist ─────────────────────────────── */

      addPlaylistClip: (clip) =>
        edit("Add clip", (state) => {
          state.playlist.clips.push(clip);
        }),

      removePlaylistClip: (clipId) =>
        edit("Delete clip", (state) => {
          const next = state.playlist.clips.filter((clip) => clip.id !== clipId);
          if (next.length === state.playlist.clips.length) return;
          state.playlist.clips = next;
        }),

      updatePlaylistClip: (clipId, updates) =>
        edit("Move clip", (state) => {
          const clip = state.playlist.clips.find((entry) => entry.id === clipId);
          if (!clip) return;

          if (updates.trackIndex !== undefined) {
            clip.trackIndex = clamp(
              Math.round(updates.trackIndex),
              0,
              state.playlist.tracks.length - 1
            );
          }

          if (updates.startStep !== undefined) {
            clip.startStep = Math.max(0, Math.round(updates.startStep));
          }

          if (updates.lengthSteps !== undefined) {
            const length = Math.max(1, Math.round(updates.lengthSteps));
            if (clip.type === "pattern") clip.lengthSteps = length;
            else clip.durationSteps = length;
          }
        }),

      duplicatePlaylistClip: (clipId) => {
        const source = get().playlist.clips.find((clip) => clip.id === clipId);
        if (!source) return null;

        const id = uid();

        edit("Duplicate clip", (state) => {
          const clip = state.playlist.clips.find((entry) => entry.id === clipId);
          if (!clip) return;

          const length =
            clip.type === "pattern" ? clip.lengthSteps : clip.durationSteps;

          state.playlist.clips.push({
            ...(JSON.parse(JSON.stringify(clip)) as PlaylistClip),
            id,
            startStep: clip.startStep + length
          });
        });

        return id;
      },

      clearPlaylistTrack: (trackIndex) =>
        edit("Clear track", (state) => {
          const next = state.playlist.clips.filter((clip) => clip.trackIndex !== trackIndex);
          if (next.length === state.playlist.clips.length) return;
          state.playlist.clips = next;
        }),

      toggleTrackMute: (trackIndex) =>
        edit("Mute track", (state) => {
          const track = state.playlist.tracks[trackIndex];
          if (track) track.mute = !track.mute;
        }),

      toggleTrackSolo: (trackIndex) =>
        edit("Solo track", (state) => {
          const track = state.playlist.tracks[trackIndex];
          if (track) track.solo = !track.solo;
        }),

      addPlaylistTrack: (name) =>
        edit("Add track", (state) => {
          const index = state.playlist.tracks.length;

          state.playlist.tracks.push({
            id: uid(),
            name: name?.trim() || `Track ${index + 1}`,
            mute: false,
            solo: false,
            height: DEFAULT_TRACK_HEIGHT,
            color: trackColorAt(index)
          });
        }),

      removePlaylistTrack: (trackIndex) =>
        edit("Delete track", (state) => {
          if (state.playlist.tracks.length <= 1) return;
          if (trackIndex < 0 || trackIndex >= state.playlist.tracks.length) return;

          state.playlist.tracks.splice(trackIndex, 1);
          state.playlist.clips = state.playlist.clips
            .filter((clip) => clip.trackIndex !== trackIndex)
            .map((clip) =>
              clip.trackIndex > trackIndex
                ? { ...clip, trackIndex: clip.trackIndex - 1 }
                : clip
            );
        }),

      renamePlaylistTrack: (trackIndex, name) =>
        edit("Rename track", (state) => {
          const track = state.playlist.tracks[trackIndex];
          const trimmed = name.trim();
          if (!track || !trimmed || track.name === trimmed) return;
          track.name = trimmed;
        }),

      movePlaylistTrack: (fromIndex, toIndex) =>
        edit("Reorder tracks", (state) => {
          const tracks = state.playlist.tracks;
          if (fromIndex === toIndex) return;
          if (fromIndex < 0 || fromIndex >= tracks.length) return;
          if (toIndex < 0 || toIndex >= tracks.length) return;

          // A real move, not a swap — dragging a track down shifts the rest up.
          const [moved] = tracks.splice(fromIndex, 1);
          tracks.splice(toIndex, 0, moved);

          for (const clip of state.playlist.clips) {
            if (clip.trackIndex === fromIndex) {
              clip.trackIndex = toIndex;
            } else if (fromIndex < toIndex) {
              if (clip.trackIndex > fromIndex && clip.trackIndex <= toIndex) clip.trackIndex -= 1;
            } else if (clip.trackIndex >= toIndex && clip.trackIndex < fromIndex) {
              clip.trackIndex += 1;
            }
          }
        }),

      setPlaylistTrackHeight: (trackIndex, height) =>
        edit("Resize track", (state) => {
          const track = state.playlist.tracks[trackIndex];
          if (!track) return;

          const next = clamp(Math.round(height), MIN_TRACK_HEIGHT, MAX_TRACK_HEIGHT);
          if (track.height === next) return;

          track.height = next;
        }),

      setPlaylistTrackColor: (trackIndex, color) =>
        edit("Recolour track", (state) => {
          const track = state.playlist.tracks[trackIndex];
          if (!track || track.color === color) return;
          track.color = color;
        }),

      /* ─────────────────────────────── markers ─────────────────────────────── */

      addMarker: (step, name) => {
        const at = Math.max(0, Math.round(step));

        // One marker per step. Dropping a second one on an occupied step would
        // hide the first behind it, with no way to reach it again.
        const existing = get().playlist.markers.find((marker) => marker.step === at);
        if (existing) return existing.id;

        const id = uid();

        edit("Add marker", (state) => {
          state.playlist.markers.push({
            id,
            name: name?.trim() || `Marker ${state.playlist.markers.length + 1}`,
            step: at
          });
          sortMarkers(state.playlist.markers);
        });

        return id;
      },

      removeMarker: (markerId) =>
        edit("Delete marker", (state) => {
          const next = state.playlist.markers.filter((marker) => marker.id !== markerId);
          if (next.length === state.playlist.markers.length) return;
          state.playlist.markers = next;
        }),

      renameMarker: (markerId, name) =>
        edit("Rename marker", (state) => {
          const marker = state.playlist.markers.find((entry) => entry.id === markerId);
          const trimmed = name.trim().slice(0, 40);
          if (!marker || !trimmed || marker.name === trimmed) return;
          marker.name = trimmed;
        }),

      moveMarker: (markerId, step) =>
        edit("Move marker", (state) => {
          const marker = state.playlist.markers.find((entry) => entry.id === markerId);
          if (!marker) return;

          const at = Math.max(0, Math.round(step));
          if (marker.step === at) return;
          if (state.playlist.markers.some((entry) => entry.id !== markerId && entry.step === at)) {
            return;
          }

          marker.step = at;
          sortMarkers(state.playlist.markers);
        }),

      /* ──────────────────────────────── mixer ──────────────────────────────── */

      setMixerTrackVolume: (trackId, volume) =>
        edit("Insert volume", (state) => {
          const track = state.mixer.tracks.find((entry) => entry.id === trackId);
          const next = clamp(Number(volume) || 0, 0, 1.5);
          if (!track || track.volume === next) return;
          track.volume = next;
        }),

      setMixerTrackPan: (trackId, pan) =>
        edit("Insert pan", (state) => {
          const track = state.mixer.tracks.find((entry) => entry.id === trackId);
          const next = clamp(Number(pan) || 0, -1, 1);
          if (!track || track.pan === next) return;
          track.pan = next;
        }),

      toggleMixerTrackMute: (trackId) =>
        edit("Mute insert", (state) => {
          const track = state.mixer.tracks.find((entry) => entry.id === trackId);
          if (track) track.mute = !track.mute;
        }),

      toggleMixerTrackSolo: (trackId) =>
        edit("Solo insert", (state) => {
          const track = state.mixer.tracks.find((entry) => entry.id === trackId);
          if (track) track.solo = !track.solo;
        }),

      renameMixerTrack: (trackId, name) =>
        edit("Rename insert", (state) => {
          const track = state.mixer.tracks.find((entry) => entry.id === trackId);
          const trimmed = name.trim();
          if (!track || !trimmed || track.name === trimmed) return;
          track.name = trimmed;
        }),

      setMixerTrackOutput: (trackId, output) => {
        const tracks = get().mixer.tracks;
        const track = tracks.find((entry) => entry.id === trackId);
        const next = Math.max(MASTER_OUTPUT, Math.round(output));

        if (!track) return false;
        if (next !== MASTER_OUTPUT && !tracks.some((entry) => entry.id === next)) return false;
        if (wouldCreateCycle(tracks, trackId, next)) return false;

        edit("Route insert", (state) => {
          const live = state.mixer.tracks.find((entry) => entry.id === trackId);
          if (!live || live.output === next) return;
          live.output = next;
          // A send to the bus the insert now outputs to would double it up.
          live.sends = live.sends.filter((send) => send.target !== next);
        });
        return true;
      },

      addMixerSend: (trackId, target, level = 0.5) => {
        const tracks = get().mixer.tracks;
        const track = tracks.find((entry) => entry.id === trackId);

        if (!track || !tracks.some((entry) => entry.id === target)) return false;
        if (track.output === target || track.sends.some((send) => send.target === target)) return false;
        if (wouldCreateCycle(tracks, trackId, target)) return false;

        edit("Add send", (state) => {
          const live = state.mixer.tracks.find((entry) => entry.id === trackId);
          live?.sends.push({ target, level: clamp(level, 0, 1) });
        });
        return true;
      },

      setMixerSendLevel: (trackId, target, level) =>
        edit("Send level", (state) => {
          const send = state.mixer.tracks
            .find((entry) => entry.id === trackId)
            ?.sends.find((entry) => entry.target === target);
          const next = clamp(Number(level) || 0, 0, 1);
          if (!send || send.level === next) return;
          send.level = next;
        }),

      removeMixerSend: (trackId, target) =>
        edit("Remove send", (state) => {
          const track = state.mixer.tracks.find((entry) => entry.id === trackId);
          if (!track) return;
          const next = track.sends.filter((send) => send.target !== target);
          if (next.length !== track.sends.length) track.sends = next;
        }),

      addEffect: (target, type) =>
        edit("Add effect", (state) => {
          const effects = effectListOf(state, target);
          if (!effects) return;

          effects.push({
            id: uid(),
            type,
            name: effectTypeNames[type],
            enabled: true,
            params: defaultEffectParams(type)
          });
        }),

      addEffectPreset: (target, presetId) =>
        edit("Add effect", (state) => {
          const effects = effectListOf(state, target);
          const preset = getEffectPreset(presetId);
          if (!effects || !preset) return;

          const effect: EffectInstance = {
            id: uid(),
            type: preset.type,
            name: preset.name,
            enabled: true,
            params: { ...defaultEffectParams(preset.type), ...preset.params }
          };

          effects.push(effect);
        }),

      removeEffect: (target, effectId) =>
        edit("Remove effect", (state) => {
          const effects = effectListOf(state, target);
          if (!effects) return;

          const index = effects.findIndex((effect) => effect.id === effectId);
          if (index < 0) return;
          effects.splice(index, 1);
        }),

      toggleEffect: (target, effectId) =>
        edit("Bypass effect", (state) => {
          const effect = effectListOf(state, target)?.find((entry) => entry.id === effectId);
          if (effect) effect.enabled = !effect.enabled;
        }),

      moveEffect: (target, effectId, direction) =>
        edit("Reorder effects", (state) => {
          const effects = effectListOf(state, target);
          if (!effects) return;

          const index = effects.findIndex((effect) => effect.id === effectId);
          const next = index + direction;
          if (index < 0 || next < 0 || next >= effects.length) return;

          const [moved] = effects.splice(index, 1);
          effects.splice(next, 0, moved);
        }),

      updateEffectParam: (target, effectId, param, value) =>
        edit("Effect parameter", (state) => {
          const effect = effectListOf(state, target)?.find((entry) => entry.id === effectId);
          if (!effect) return;

          const next = Number(value);
          if (!Number.isFinite(next) || effect.params[param] === next) return;
          effect.params[param] = next;
        }),

      resetEffect: (target, effectId) =>
        edit("Reset effect", (state) => {
          const effect = effectListOf(state, target)?.find((entry) => entry.id === effectId);
          if (!effect) return;
          effect.params = defaultEffectParams(effect.type);
        }),

      /* ───────────────────────────── automation ───────────────────────────── */

      addAutomationPoint: (clipId, step, value) =>
        edit("Automation point", (state) => {
          const clip = state.playlist.clips.find(
            (entry): entry is AutomationClip => entry.id === clipId && entry.type === "automation"
          );
          if (!clip) return;

          const snapped = clamp(Math.round(step), 0, clip.durationSteps);
          clip.points = clip.points.filter((point) => point.step !== snapped);
          clip.points.push({ id: uid(), step: snapped, value: clamp(value, 0, 1) });
          clip.points.sort((a, b) => a.step - b.step);
        }),

      updateAutomationPoint: (clipId, pointId, value, step) =>
        edit("Automation point", (state) => {
          const clip = state.playlist.clips.find(
            (entry): entry is AutomationClip => entry.id === clipId && entry.type === "automation"
          );
          if (!clip) return;

          const point = clip.points.find((entry) => entry.id === pointId);
          if (!point) return;

          point.value = clamp(value, 0, 1);
          if (step !== undefined) {
            point.step = clamp(Math.round(step), 0, clip.durationSteps);
            clip.points.sort((a, b) => a.step - b.step);
          }
        }),

      removeAutomationPoint: (clipId, pointId) =>
        edit("Remove automation point", (state) => {
          const clip = state.playlist.clips.find(
            (entry): entry is AutomationClip => entry.id === clipId && entry.type === "automation"
          );
          if (!clip || clip.points.length <= 2) return;

          clip.points = clip.points.filter((point) => point.id !== pointId);
        }),

      setAutomationTarget: (clipId, targetType, targetId, targetParam) =>
        edit("Automation target", (state) => {
          const clip = state.playlist.clips.find(
            (entry): entry is AutomationClip => entry.id === clipId && entry.type === "automation"
          );
          if (!clip) return;

          clip.targetType = targetType;
          clip.targetId = targetId;
          clip.targetParam = targetParam;

          const label =
            targetType === "master"
              ? "Master"
              : targetType === "mixer"
                ? state.mixer.tracks.find((track) => String(track.id) === targetId)?.name ?? "Insert"
                : state.channels.find((channel) => channel.id === targetId)?.name ?? "Channel";

          clip.name = `${label} ${targetParam}`;
        }),

      /* ────────────────────────────── history ────────────────────────────── */

      beginEdit: (label) => beginGroup(label),
      endEdit: () => endGroup(),

      undo: () => {
        endGroup();
        const entry = popUndo(getProjectData(get()));
        if (!entry) return;
        set((state) => {
          Object.assign(state, entry.state);
        });
      },

      redo: () => {
        endGroup();
        const entry = popRedo(getProjectData(get()));
        if (!entry) return;
        set((state) => {
          Object.assign(state, entry.state);
        });
      },

      /* ───────────────────────── load / reset / presets ───────────────────────── */

      hydrate: (data) => {
        clearHistory();
        const clean = sanitizeProjectData(data);
        set((state) => {
          Object.assign(state, clean);
        });
      },

      reset: () => {
        clearHistory();
        const fresh = createInitialProjectData();
        set((state) => {
          Object.assign(state, fresh);
        });
      },

      loadPresetProject: (presetId) => {
        const preset = presetProjects.find((entry) => entry.id === presetId);
        if (!preset) return false;

        clearHistory();
        const clean = sanitizeProjectData(preset.create());
        set((state) => {
          Object.assign(state, clean);
        });

        return true;
      }
    };
  })
);

export { canUndo, canRedo, SCHEMA_VERSION };
