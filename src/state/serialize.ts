import { SCHEMA_VERSION, type ProjectData } from "../types";

/** Extract just the song data from the store, dropping actions and helpers. */
export function getProjectData(state: ProjectData): ProjectData {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectName: state.projectName,
    bpm: state.bpm,
    swing: state.swing,
    masterVolume: state.masterVolume,
    songBars: state.songBars,
    loopStart: state.loopStart,
    loopEnd: state.loopEnd,
    channels: state.channels,
    patterns: state.patterns,
    patternOrder: state.patternOrder,
    playlist: state.playlist,
    mixer: state.mixer
  };
}

const COMPARED_KEYS = [
  "projectName",
  "bpm",
  "swing",
  "masterVolume",
  "songBars",
  "loopStart",
  "loopEnd",
  "channels",
  "patterns",
  "patternOrder",
  "playlist",
  "mixer"
] as const;

/**
 * Reference comparison of the project fields. Immer gives us structural
 * sharing, so identical references genuinely mean "nothing changed".
 */
export function isSameProject(a: ProjectData, b: ProjectData): boolean {
  return COMPARED_KEYS.every((key) => a[key] === b[key]);
}
