import { sanitizeSynthPatch } from "../audio/synthPatch";
import { sanitizeMidiOutRef } from "../audio/midiOutRef";
import { sanitizeSoundFontRef } from "../audio/soundfont/ref";
import {
  SCHEMA_VERSION,
  type AutomationClip,
  type AutomationParam,
  type AutomationTargetType,
  type Channel,
  type ChannelType,
  type EffectInstance,
  type EffectType,
  type MixerState,
  type MixerTrack,
  type Pattern,
  type PlaylistClip,
  type PlaylistMarker,
  type PlaylistTrack,
  type ProjectData,
  type SessionData
} from "../types";

import { repairRouting } from "../audio/routing";

import {
  DEFAULT_TRACK_HEIGHT,
  DRUM_TYPES,
  MAX_BPM,
  MAX_TRACK_HEIGHT,
  MIN_BPM,
  MIN_TRACK_HEIGHT,
  STEPS_PER_BAR,
  channelColors,
  clamp,
  resizeSteps,
  toFinite,
  trackColorAt,
  uid
} from "../lib/utils";

import { defaultEffectParams, effectTypeNames, getEffectDef, isEffectType } from "../audio/effectDefs";

export const DEFAULT_MIXER_TRACKS = 16;

export function createPattern(name: string, length = STEPS_PER_BAR): Pattern {
  return { id: uid(), name, length, channels: {} };
}

export function ensurePatternChannels(pattern: Pattern, channels: Channel[]): void {
  for (const channel of channels) {
    if (!pattern.channels[channel.id]) {
      pattern.channels[channel.id] = {
        steps: Array<null>(pattern.length).fill(null),
        notes: []
      };
    }
  }
}

/** One empty pattern with a lane for each of the given channels. */
export function createDefaultPatterns(channels: Channel[]): Record<string, Pattern> {
  const pattern = createPattern("Pattern 1");
  ensurePatternChannels(pattern, channels);
  return { [pattern.id]: pattern };
}

export function createDefaultMixer(numTracks = DEFAULT_MIXER_TRACKS): MixerState {
  const tracks: MixerTrack[] = [];

  for (let i = 1; i <= numTracks; i++) {
    tracks.push({
      id: i,
      name: `Insert ${i}`,
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      effects: [],
      output: 0,
      sends: []
    });
  }

  return { tracks, masterEffects: [] };
}

export function createDefaultSession(project: ProjectData): SessionData {
  return {
    theme: "pulse-violet",
    view: "playlist",
    mode: "song",
    selectedPatternId: project.patternOrder[0] ?? "",
    selectedChannelId: project.channels[0]?.id ?? null,
    selectedMixerTrackId: 1,
    snapSteps: STEPS_PER_BAR,
    pianoSnapSteps: 1
  };
}
/**
 * A new project: the three drum channels every beat starts from, with nothing
 * written on them, and nothing on the playlist.
 *
 * No pattern content, no melody, no clips — you build it. The demo projects in
 * the browser panel are there for anyone who wants something to pull apart.
 */
export function createInitialProjectData(): ProjectData {
  const pattern = createPattern("Pattern 1", STEPS_PER_BAR);

  const starters: Array<{ name: string; type: ChannelType; volume: number; pan: number }> = [
    { name: "Kick", type: "kick", volume: 0.95, pan: 0 },
    { name: "Snare", type: "snare", volume: 0.85, pan: 0 },
    { name: "Hi-hat", type: "hat", volume: 0.52, pan: 0.16 }
  ];
  const channels: Channel[] = starters.map((entry, index) => ({
    id: uid(),
    name: entry.name,
    type: entry.type,
    color: channelColors[entry.type],
    mute: false,
    solo: false,
    volume: entry.volume,
    pan: entry.pan,
    mixerTrackId: index + 1
  }));

  // Lanes exist so the steps are clickable straight away; they are all empty.
  ensurePatternChannels(pattern, channels);

  const tracks: PlaylistTrack[] = Array.from({ length: 5 }, (_, index) => ({
    id: uid(),
    name: `Track ${index + 1}`,
    mute: false,
    solo: false,
    height: DEFAULT_TRACK_HEIGHT,
    color: trackColorAt(index)
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    projectName: "Untitled Project",
    bpm: 140,
    swing: 0,
    masterVolume: 0.9,
    songBars: 8,
    loopStart: null,
    loopEnd: null,
    channels,
    patterns: { [pattern.id]: pattern },
    patternOrder: [pattern.id],
    playlist: { tracks, clips: [], markers: [] },
    mixer: createDefaultMixer()
  };
}

/** A loop region is only kept when it is a real, forward range. */
function sanitizeLoop(
  rawStart: unknown,
  rawEnd: unknown
): { loopStart: number | null; loopEnd: number | null } {
  const start = Math.round(toFinite(rawStart, NaN));
  const end = Math.round(toFinite(rawEnd, NaN));

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { loopStart: null, loopEnd: null };
  if (end <= start || start < 0) return { loopStart: null, loopEnd: null };

  return { loopStart: start, loopEnd: Math.min(end, 512 * 16) };
}

/** Arrangement markers: named, in order, and never stacked on one step. */
function sanitizeMarkers(raw: unknown): PlaylistMarker[] {
  if (!Array.isArray(raw)) return [];

  const used = new Set<number>();

  return raw
    .map((entry, index) => {
      const marker = (entry ?? {}) as Record<string, unknown>;
      const step = Math.max(0, Math.round(toFinite(marker.step, 0)));

      return {
        id: typeof marker.id === "string" && marker.id ? marker.id : uid(),
        name:
          typeof marker.name === "string" && marker.name.trim()
            ? marker.name.trim().slice(0, 40)
            : `Marker ${index + 1}`,
        step
      };
    })
    .filter((marker) => {
      if (used.has(marker.step)) return false;
      used.add(marker.step);
      return true;
    })
    .sort((a, b) => a.step - b.step)
    .slice(0, 256);
}

const CHANNEL_TYPES: ChannelType[] = [...DRUM_TYPES, "synth", "sample"];

function sanitizeChannel(
  raw: unknown,
  index: number,
  trackCount: number,
  /** Ids already handed out, so a duplicate gets a fresh one instead. */
  usedIds: Set<string>
): Channel {
  const source = (raw ?? {}) as Record<string, unknown>;

  const type = CHANNEL_TYPES.includes(source.type as ChannelType)
    ? (source.type as ChannelType)
    : "synth";

  const trimStart = clamp(toFinite(source.trimStart, 0), 0, 0.99);
  const trimEnd = clamp(toFinite(source.trimEnd, 1), trimStart + 0.01, 1);

  // Two channels sharing an id would share one lane in every pattern and one
  // strip in the audio graph, and deleting either would delete both.
  const rawId = typeof source.id === "string" && source.id ? source.id : uid();
  const id = usedIds.has(rawId) ? uid() : rawId;
  usedIds.add(id);

  return {
    id,
    name: typeof source.name === "string" && source.name ? source.name : `Channel ${index + 1}`,
    type,
    color: typeof source.color === "string" && source.color ? source.color : channelColors[type],
    mute: Boolean(source.mute),
    solo: Boolean(source.solo),
    volume: clamp(toFinite(source.volume, 0.85), 0, 1),
    pan: clamp(toFinite(source.pan, 0), -1, 1),
    mixerTrackId: clamp(Math.round(toFinite(source.mixerTrackId, index + 1)), 1, trackCount),
    sampleId: typeof source.sampleId === "string" ? source.sampleId : undefined,
    pitchOffset: clamp(Math.round(toFinite(source.pitchOffset, 0)), -24, 24),
    trimStart,
    trimEnd,
    reverse: Boolean(source.reverse),
    loop: Boolean(source.loop),
    synthPreset: typeof source.synthPreset === "string" ? source.synthPreset : undefined,
    synthPatch: sanitizeSynthPatch(source.synthPatch),
    soundfont: type === "synth" ? sanitizeSoundFontRef(source.soundfont) : undefined,
    midiOut: type === "synth" ? sanitizeMidiOutRef(source.midiOut) : undefined
  };
}

function sanitizeEffect(raw: unknown): EffectInstance | null {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (!isEffectType(source.type)) return null;

  const type = source.type as EffectType;
  const defaults = defaultEffectParams(type);
  const rawParams = (source.params ?? {}) as Record<string, unknown>;
  const params: Record<string, number> = { ...defaults };

  // Clamp to each parameter's declared range, not just to "is a number". A
  // hand-edited or older file could otherwise carry a feedback of 5 or a
  // negative mix, which the knobs then render off their own scale.
  const ranges = new Map(getEffectDef(type)?.params.map((def) => [def.key, def]) ?? []);

  for (const key of Object.keys(defaults)) {
    const value = toFinite(rawParams[key], defaults[key]);
    const range = ranges.get(key);
    params[key] = range ? clamp(value, range.min, range.max) : value;
  }

  return {
    id: typeof source.id === "string" && source.id ? source.id : uid(),
    type,
    name: typeof source.name === "string" && source.name ? source.name : effectTypeNames[type],
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    params
  };
}

function sanitizeEffects(raw: unknown): EffectInstance[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeEffect).filter((effect): effect is EffectInstance => effect !== null);
}

function sanitizeMixer(raw: unknown, channelCount: number): MixerState {
  const source = (raw ?? {}) as Record<string, unknown>;
  const rawTracks = Array.isArray(source.tracks) ? source.tracks : [];

  const trackCount = Math.max(DEFAULT_MIXER_TRACKS, rawTracks.length, channelCount);
  const base = createDefaultMixer(trackCount);

  const byId = new Map<number, Record<string, unknown>>();
  for (const entry of rawTracks) {
    const track = (entry ?? {}) as Record<string, unknown>;
    const id = Math.round(toFinite(track.id, NaN));
    if (Number.isFinite(id)) byId.set(id, track);
  }

  const tracks = base.tracks.map((track) => {
    const stored = byId.get(track.id);
    if (!stored) return track;

    return {
      id: track.id,
      name: typeof stored.name === "string" && stored.name ? stored.name : track.name,
      volume: clamp(toFinite(stored.volume, 1), 0, 1.5),
      pan: clamp(toFinite(stored.pan, 0), -1, 1),
      mute: Boolean(stored.mute),
      solo: Boolean(stored.solo),
      effects: sanitizeEffects(stored.effects),
      output: Math.max(0, Math.round(toFinite(stored.output, 0))),
      sends: (Array.isArray(stored.sends) ? stored.sends : []).map((entry) => {
        const send = (entry ?? {}) as Record<string, unknown>;
        return {
          target: Math.round(toFinite(send.target, -1)),
          level: clamp(toFinite(send.level, 0.5), 0, 1)
        };
      })
    };
  });

  // Routing that points at a missing insert, or that would close a loop and
  // silence everything in it, is dropped rather than trusted.
  return { tracks: repairRouting(tracks), masterEffects: sanitizeEffects(source.masterEffects) };
}

const AUTOMATION_TARGETS: AutomationTargetType[] = ["channel", "mixer", "master"];
const AUTOMATION_PARAMS: AutomationParam[] = ["volume", "pan"];

/** A clip from a file, made safe; a muted one stays muted. */
function sanitizeClip(raw: unknown, patterns: Record<string, Pattern>, trackCount: number): PlaylistClip | null {
  const clip = sanitizeClipContent(raw, patterns, trackCount);
  if (clip && (raw as Record<string, unknown> | null)?.muted === true) clip.muted = true;
  return clip;
}

function sanitizeClipContent(
  raw: unknown,
  patterns: Record<string, Pattern>,
  trackCount: number
): PlaylistClip | null {
  const source = (raw ?? {}) as Record<string, unknown>;

  const trackIndex = Math.round(toFinite(source.trackIndex, -1));
  if (trackIndex < 0 || trackIndex >= trackCount) return null;

  const startStep = Math.max(0, Math.round(toFinite(source.startStep, 0)));
  const id = typeof source.id === "string" && source.id ? source.id : uid();

  const type = source.type;

  if (type === "audio") {
    if (typeof source.sampleId !== "string" || !source.sampleId) return null;
    return {
      id,
      type: "audio",
      trackIndex,
      startStep,
      sampleId: source.sampleId,
      name: typeof source.name === "string" && source.name ? source.name : "Audio",
      durationSteps: Math.max(1, Math.round(toFinite(source.durationSteps, STEPS_PER_BAR))),
      offsetSteps: Math.max(0, Math.round(toFinite(source.offsetSteps, 0))),
      volume: clamp(toFinite(source.volume, 1), 0, 1.5),
      pitch: clamp(Math.round(toFinite(source.pitch, 0)), -24, 24)
    };
  }

  if (type === "automation") {
    const targetType = AUTOMATION_TARGETS.includes(source.targetType as AutomationTargetType)
      ? (source.targetType as AutomationTargetType)
      : "master";

    const targetParam = AUTOMATION_PARAMS.includes(source.targetParam as AutomationParam)
      ? (source.targetParam as AutomationParam)
      : "volume";

    const rawPoints = Array.isArray(source.points) ? source.points : [];
    const durationSteps = Math.max(1, Math.round(toFinite(source.durationSteps, STEPS_PER_BAR)));

    const points = rawPoints
      .map((entry) => {
        const point = (entry ?? {}) as Record<string, unknown>;
        return {
          id: typeof point.id === "string" && point.id ? point.id : uid(),
          step: clamp(Math.round(toFinite(point.step, 0)), 0, durationSteps),
          value: clamp(toFinite(point.value, 0.8), 0, 1)
        };
      })
      .sort((a, b) => a.step - b.step);

    const clip: AutomationClip = {
      id,
      type: "automation",
      trackIndex,
      startStep,
      name: typeof source.name === "string" && source.name ? source.name : "Automation",
      durationSteps,
      targetType,
      targetId: typeof source.targetId === "string" ? source.targetId : "master",
      targetParam,
      points: points.length > 0 ? points : [
        { id: uid(), step: 0, value: 0.8 },
        { id: uid(), step: durationSteps, value: 0.8 }
      ]
    };

    return clip;
  }

  // Default: pattern clip.
  const patternId = typeof source.patternId === "string" ? source.patternId : "";
  const pattern = patterns[patternId];
  if (!pattern) return null;

  return {
    id,
    type: "pattern",
    trackIndex,
    startStep,
    patternId,
    lengthSteps: Math.max(1, Math.round(toFinite(source.lengthSteps, pattern.length)))
  };
}

export function sanitizeProjectData(raw: unknown): ProjectData {
  const base = createInitialProjectData();

  if (!raw || typeof raw !== "object") return base;

  const source = raw as Record<string, unknown>;

  const channelsInput = Array.isArray(source.channels) ? source.channels : [];
  const mixer = sanitizeMixer(source.mixer, channelsInput.length);

  const usedChannelIds = new Set<string>();

  const channels: Channel[] =
    channelsInput.length > 0
      ? channelsInput.map((channel, index) =>
          sanitizeChannel(channel, index, mixer.tracks.length, usedChannelIds)
        )
      : base.channels;

  // Patterns.
  // `typeof [] === "object"`, and walking an array here would re-key every
  // pattern to "0", "1", … — destroying the ids every playlist clip points at.
  const patternsInput =
    source.patterns && typeof source.patterns === "object" && !Array.isArray(source.patterns)
      ? (source.patterns as Record<string, unknown>)
      : {};

  const patterns: Record<string, Pattern> = {};

  for (const [patternId, rawPattern] of Object.entries(patternsInput)) {
    const entry = (rawPattern ?? {}) as Record<string, unknown>;
    const length = clamp(Math.round(toFinite(entry.length, STEPS_PER_BAR)), 1, 512);

    const pattern: Pattern = {
      id: patternId,
      name: typeof entry.name === "string" && entry.name ? entry.name : "Pattern",
      length,
      channels: {}
    };

    const rawChannels =
      entry.channels && typeof entry.channels === "object"
        ? (entry.channels as Record<string, unknown>)
        : {};

    for (const channel of channels) {
      const stored = (rawChannels[channel.id] ?? {}) as Record<string, unknown>;
      const rawNotes = Array.isArray(stored.notes) ? stored.notes : [];

      pattern.channels[channel.id] = {
        steps: resizeSteps(Array.isArray(stored.steps) ? stored.steps : undefined, length),
        // Keep notes inside the pattern, the same rule `setPatternLength`
        // enforces at runtime. A note past the end is unplayable, invisible in
        // the piano roll, and saved back out forever.
        notes: rawNotes
          .map((entryNote) => {
            const note = (entryNote ?? {}) as Record<string, unknown>;
            const start = clamp(Math.round(toFinite(note.start, 0)), 0, length - 1);

            return {
              id: typeof note.id === "string" && note.id ? note.id : uid(),
              pitch: clamp(Math.round(toFinite(note.pitch, 60)), 0, 127),
              start,
              length: clamp(Math.round(toFinite(note.length, 1)), 1, length - start),
              velocity: clamp(Math.round(toFinite(note.velocity, 100)), 1, 127)
            };
          })
      };
    }

    patterns[patternId] = pattern;
  }

  const hasPatterns = Object.keys(patterns).length > 0;

  // `base.patterns` is keyed by the throwaway channel ids of a fresh project,
  // which have nothing to do with the channels loaded above. Build the fallback
  // from the real channels instead, or every lane would be an orphan.
  const resolvedPatterns = hasPatterns ? patterns : createDefaultPatterns(channels);

  let patternOrder = Array.isArray(source.patternOrder)
    ? (source.patternOrder as unknown[])
        .filter((id): id is string => typeof id === "string" && Boolean(resolvedPatterns[id]))
    : [];

  // Append any pattern that exists but wasn't listed in the order.
  for (const id of Object.keys(resolvedPatterns)) {
    if (!patternOrder.includes(id)) patternOrder.push(id);
  }

  if (patternOrder.length === 0) patternOrder = Object.keys(resolvedPatterns);

  // Playlist.
  const playlistInput =
    source.playlist && typeof source.playlist === "object"
      ? (source.playlist as Record<string, unknown>)
      : {};

  const rawTracks = Array.isArray(playlistInput.tracks) ? playlistInput.tracks : [];

  const tracks: PlaylistTrack[] =
    rawTracks.length > 0
      ? rawTracks.map((entry, index) => {
          const track = (entry ?? {}) as Record<string, unknown>;
          return {
            id: typeof track.id === "string" && track.id ? track.id : uid(),
            name: typeof track.name === "string" && track.name ? track.name : `Track ${index + 1}`,
            mute: Boolean(track.mute),
            solo: Boolean(track.solo),
            height: clamp(
              Math.round(toFinite(track.height, DEFAULT_TRACK_HEIGHT)),
              MIN_TRACK_HEIGHT,
              MAX_TRACK_HEIGHT
            ),
            color:
              typeof track.color === "string" && /^#[0-9a-f]{3,8}$/i.test(track.color)
                ? track.color
                : trackColorAt(index)
          };
        })
      : base.playlist.tracks;

  const rawClips = Array.isArray(playlistInput.clips) ? playlistInput.clips : [];
  const clips = rawClips
    .map((clip) => sanitizeClip(clip, resolvedPatterns, tracks.length))
    .filter((clip): clip is PlaylistClip => clip !== null);

  return {
    schemaVersion: SCHEMA_VERSION,
    projectName:
      typeof source.projectName === "string" && source.projectName.trim()
        ? source.projectName.trim()
        : base.projectName,
    bpm: clamp(toFinite(source.bpm, base.bpm), MIN_BPM, MAX_BPM),
    swing: clamp(toFinite(source.swing, 0), 0, 1),
    masterVolume: clamp(toFinite(source.masterVolume, base.masterVolume), 0, 1),
    songBars: clamp(Math.round(toFinite(source.songBars, base.songBars)), 1, 512),
    ...sanitizeLoop(source.loopStart, source.loopEnd),
    channels,
    patterns: resolvedPatterns,
    patternOrder,
    playlist: { tracks, clips, markers: sanitizeMarkers(playlistInput.markers) },
    mixer
  };
}

export function sanitizeSession(
  raw: unknown,
  project: ProjectData
): SessionData {
  const base = createDefaultSession(project);
  if (!raw || typeof raw !== "object") return base;

  const source = raw as Record<string, unknown>;

  const selectedPatternId =
    typeof source.selectedPatternId === "string" && project.patterns[source.selectedPatternId]
      ? source.selectedPatternId
      : base.selectedPatternId;

  const selectedChannelId =
    typeof source.selectedChannelId === "string" &&
    project.channels.some((channel) => channel.id === source.selectedChannelId)
      ? source.selectedChannelId
      : base.selectedChannelId;

  return {
    theme: typeof source.theme === "string" && source.theme ? source.theme : base.theme,
    view: (["rack", "piano", "playlist", "mixer"] as const).includes(source.view as never)
      ? (source.view as SessionData["view"])
      : base.view,
    mode: source.mode === "pattern" ? "pattern" : "song",
    selectedPatternId,
    selectedChannelId,
    // 0 is the Master strip, not an out-of-range insert — flooring at 1 here
    // silently moved the selection to Insert 1 on every reload.
    selectedMixerTrackId: clamp(
      Math.round(toFinite(source.selectedMixerTrackId, 1)),
      0,
      project.mixer.tracks.length
    ),
    snapSteps: clamp(Math.round(toFinite(source.snapSteps, STEPS_PER_BAR)), 1, STEPS_PER_BAR),
    pianoSnapSteps: clamp(Math.round(toFinite(source.pianoSnapSteps, 1)), 1, STEPS_PER_BAR)
  };
}
