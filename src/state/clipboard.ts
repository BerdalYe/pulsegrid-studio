import type { NoteData, PlaylistClip } from "../types";

/**
 * A clipboard for the editors.
 *
 * Deliberately not the system clipboard: copying notes has to survive a click
 * into another pattern without asking for clipboard permissions, and pasting
 * needs the original objects rather than a text round-trip. Nothing here is
 * part of the project, so none of it is saved or undoable.
 */

let notes: NoteData[] = [];
let clips: PlaylistClip[] = [];

export function copyNotes(source: NoteData[]): number {
  notes = source.map((note) => ({ ...note }));
  return notes.length;
}

/** Copies held at their original positions, so pasting elsewhere keeps the shape. */
export function pastedNotes(): NoteData[] {
  return notes.map((note) => ({ ...note }));
}

export function hasNotes(): boolean {
  return notes.length > 0;
}

/** Steps from the earliest note to the end of the last — the span to step over. */
export function notesSpan(source: NoteData[]): number {
  if (source.length === 0) return 0;

  const start = Math.min(...source.map((note) => note.start));
  const end = Math.max(...source.map((note) => note.start + note.length));

  return Math.max(1, end - start);
}

export function copyClips(source: PlaylistClip[]): number {
  clips = source.map((clip) => ({ ...clip }));
  return clips.length;
}

export function pastedClips(): PlaylistClip[] {
  return clips.map((clip) => ({ ...clip }));
}

export function hasClips(): boolean {
  return clips.length > 0;
}

/** Length of a clip whatever its type, so callers don't have to narrow. */
export function clipLength(clip: PlaylistClip): number {
  return clip.type === "pattern" ? clip.lengthSteps : clip.durationSteps;
}

export function clipsSpan(source: PlaylistClip[]): number {
  if (source.length === 0) return 0;

  const start = Math.min(...source.map((clip) => clip.startStep));
  const end = Math.max(...source.map((clip) => clip.startStep + clipLength(clip)));

  return Math.max(1, end - start);
}
