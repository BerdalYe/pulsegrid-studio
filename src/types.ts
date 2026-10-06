import type { SynthPatch } from "./audio/synthPatch";

export type ChannelType =
  | "kick"
  | "snare"
  | "hat"
  | "clap"
  | "tom"
  | "rim"
  | "cymbal"
  | "cowbell"
  | "shaker"
  | "synth"
  | "sample";

export type PlaybackMode = "pattern" | "song";

export type ViewName = "rack" | "piano" | "playlist" | "mixer";

export const SCHEMA_VERSION = 3;

/**
 * A single step in a drum/sample lane.
 * `null` means the step is off; a number is its velocity in the 0..1 range.
 */
export type StepCell = number | null;

export interface NoteData {
  id: string;
  pitch: number;
  start: number;
  length: number;
  /** MIDI velocity, 1..127. */
  velocity: number;
}

export interface PatternChannelState {
  steps: StepCell[];
  notes: NoteData[];
}

export interface Pattern {
  id: string;
  name: string;
  length: number;
  channels: Record<string, PatternChannelState>;
}

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  color: string;
  mute: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  mixerTrackId: number;
  sampleId?: string;
  /** Semitones, -24..+24. */
  pitchOffset?: number;
  /** Normalised 0..1 offsets into the sample. */
  trimStart?: number;
  trimEnd?: number;
  reverse?: boolean;
  loop?: boolean;
  synthPreset?: string;
  /** A sound the person built or changed; it replaces the preset while it is set. */
  synthPatch?: SynthPatch;
}

export type ClipType = "pattern" | "audio" | "automation";

export interface BasePlaylistClip {
  id: string;
  trackIndex: number;
  startStep: number;
}

export interface PatternClip extends BasePlaylistClip {
  type: "pattern";
  patternId: string;
  /** Total clip length; the pattern repeats to fill it. */
  lengthSteps: number;
}

export interface AudioClip extends BasePlaylistClip {
  type: "audio";
  sampleId: string;
  name: string;
  durationSteps: number;
  offsetSteps: number;
  volume: number;
  pitch: number;
}

export type AutomationTargetType = "channel" | "mixer" | "master";

export type AutomationParam = "volume" | "pan";

export interface AutomationPoint {
  id: string;
  /** Step relative to the start of the clip. */
  step: number;
  /** Normalised 0..1. */
  value: number;
}

export interface AutomationClip extends BasePlaylistClip {
  type: "automation";
  name: string;
  durationSteps: number;
  targetType: AutomationTargetType;
  /** Channel id, mixer track id as a string, or "master". */
  targetId: string;
  targetParam: AutomationParam;
  points: AutomationPoint[];
}

export type PlaylistClip = PatternClip | AudioClip | AutomationClip;

export interface PlaylistTrack {
  id: string;
  name: string;
  mute: boolean;
  solo: boolean;
  /** Lane height in pixels. Tall lanes make an audio waveform readable. */
  height: number;
  /** Lane accent colour; its clips are tinted with it. */
  color: string;
}

/**
 * A named place in the arrangement — "Verse", "Drop", "Outro". Purely an
 * editing aid: markers make nothing sound, they just let you find your way
 * around a long song and jump the playhead to a section.
 */
export interface PlaylistMarker {
  id: string;
  name: string;
  /** Position on the arrangement timeline, in steps. */
  step: number;
}

export interface PlaylistState {
  tracks: PlaylistTrack[];
  clips: PlaylistClip[];
  markers: PlaylistMarker[];
}

export type EffectType =
  | "delay"
  | "reverb"
  | "eq"
  | "compressor"
  | "filter"
  | "distortion"
  | "chorus"
  | "flanger"
  | "phaser"
  | "tremolo"
  | "autopan"
  | "stereo"
  | "bitcrush"
  | "limiter";

export interface DelayParams {
  /** Seconds. */
  time: number;
  feedback: number;
  mix: number;
  /** Hz. */
  cutoff: number;
}

export interface ReverbParams {
  /** Seconds. */
  decay: number;
  preDelay: number;
  mix: number;
}

export interface EqParams {
  lowGain: number;
  midGain: number;
  midFreq: number;
  highGain: number;
}

export interface CompressorParams {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  /** Makeup gain in dB. */
  gain: number;
}

export interface FilterParams {
  /** 0 = lowpass, 1 = highpass, 2 = bandpass. */
  mode: number;
  cutoff: number;
  resonance: number;
}

export interface DistortionParams {
  drive: number;
  tone: number;
  mix: number;
}

export type EffectParams =
  | DelayParams
  | ReverbParams
  | EqParams
  | CompressorParams
  | FilterParams
  | DistortionParams;

export interface EffectInstance {
  id: string;
  type: EffectType;
  name: string;
  enabled: boolean;
  params: Record<string, number>;
}

export interface MixerTrack {
  id: number;
  name: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  effects: EffectInstance[];
  /** Where the insert's main output goes: 0 is the master bus, else another insert. */
  output: number;
  /** Post-fader sends to other inserts, e.g. a shared reverb bus. */
  sends: MixerSend[];
}

export interface MixerSend {
  /** Id of the insert this send feeds. */
  target: number;
  /** Linear gain, 0..1. */
  level: number;
}

export interface MixerState {
  tracks: MixerTrack[];
  masterEffects: EffectInstance[];
}

/**
 * Everything that belongs to the song itself. This is what gets saved,
 * exported and captured in the undo history — nothing else.
 */
export interface ProjectData {
  schemaVersion: number;
  projectName: string;
  bpm: number;
  swing: number;
  masterVolume: number;
  songBars: number;
  /**
   * Loop region on the playlist ruler, in steps. Null plays the whole song.
   * Lets you audition eight bars without replaying the arrangement from bar 1.
   */
  loopStart: number | null;
  loopEnd: number | null;
  channels: Channel[];
  patterns: Record<string, Pattern>;
  patternOrder: string[];
  playlist: PlaylistState;
  mixer: MixerState;
}

/**
 * Where the user happens to be looking. Persisted for convenience but never
 * part of the undo history, so undoing a note edit can't move your windows.
 */
export interface SessionData {
  theme: string;
  view: ViewName;
  mode: PlaybackMode;
  selectedPatternId: string;
  selectedChannelId: string | null;
  selectedMixerTrackId: number;
  /** Playlist grid snap, in steps. */
  snapSteps: number;
  /** Piano roll grid snap, in steps — a much finer grid than the playlist. */
  pianoSnapSteps: number;
}

/** A project file on disk: the song, plus optional embedded sample audio. */
export interface ProjectFile {
  schemaVersion: number;
  project: ProjectData;
  session?: Partial<SessionData>;
  assets?: SerializedSample[];
}

export interface SerializedSample {
  id: string;
  name: string;
  /** Base64-encoded source bytes of the original audio file. */
  data: string;
  mimeType: string;
}
