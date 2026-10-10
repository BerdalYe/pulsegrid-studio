import { create } from "zustand";

import type { Channel, SoundFontRef } from "../../types";
import { findPreset, parseSoundFont, type SfPreset, type SoundFont } from "./sf2";
import { fontStorage } from "./storage";

/**
 * Which SoundFonts are available and loaded. The studio ships one, the
 * GeneralUser GS set (the desktop app carries it; the web studio can't), and a
 * person can add their own. A font is read from disk the first time something
 * plays from it, and then kept.
 */

export const BUILTIN_ID = "generaluser-gs";
export const BUILTIN_NAME = "GeneralUser GS";

/** A SoundFont this big is refused: it would not fit in memory alongside everything else. */
const MAX_BYTES = 1024 * 1024 * 1024;

export interface FontEntry {
  id: string;
  name: string;
  builtin: boolean;
  /** Null until it has been read. */
  font: SoundFont | null;
  loading: boolean;
  error: string | null;
}

interface FontStore {
  fonts: Record<string, FontEntry>;
  /** Null until the first look; false on a system that has no built-in set. */
  builtinAvailable: boolean | null;
}

export const useSoundFontStore = create<FontStore>()(() => ({ fonts: {}, builtinAvailable: null }));

function setEntry(id: string, changes: Partial<FontEntry> & { name?: string; builtin?: boolean }): void {
  useSoundFontStore.setState((state) => {
    const previous = state.fonts[id] ?? { id, name: id, builtin: id === BUILTIN_ID, font: null, loading: false, error: null };
    return { fonts: { ...state.fonts, [id]: { ...previous, ...changes } } };
  });
}

/** Where the built-in set is served from. The desktop app carries it; a dev server finds it in the project. */
export function builtinUrl(): string {
  return import.meta.env.DEV ? "/assets/soundfonts/GeneralUser-GS.sf2" : "/soundfonts/GeneralUser-GS.sf2";
}

export function getFont(id: string): SoundFont | null {
  return useSoundFontStore.getState().fonts[id]?.font ?? null;
}

const loading = new Map<string, Promise<SoundFont | null>>();

async function readFont(id: string): Promise<SoundFont | null> {
  if (id === BUILTIN_ID) {
    const response = await fetch(builtinUrl());
    if (!response.ok) {
      useSoundFontStore.setState({ builtinAvailable: false });
      return null;
    }
    // A web server can answer a missing file with its home page; that isn't a SoundFont.
    const bytes = await response.arrayBuffer();
    try {
      const font = parseSoundFont(bytes, BUILTIN_NAME);
      useSoundFontStore.setState({ builtinAvailable: true });
      return font;
    } catch {
      useSoundFontStore.setState({ builtinAvailable: false });
      return null;
    }
  }

  const storage = fontStorage();
  const saved = storage ? await storage.read(id) : null;
  if (!saved) throw new Error("This SoundFont isn't on this computer any more. Add it again to use it.");
  return parseSoundFont(saved, useSoundFontStore.getState().fonts[id]?.name ?? id);
}

/** Read a font into memory (once), and say when it is ready. Resolves to null if it can't be had. */
export function loadFont(id: string): Promise<SoundFont | null> {
  const ready = getFont(id);
  if (ready) return Promise.resolve(ready);

  const pending = loading.get(id);
  if (pending) return pending;

  setEntry(id, { loading: true, error: null, name: id === BUILTIN_ID ? BUILTIN_NAME : undefined });

  const promise = readFont(id)
    .then((font) => {
      setEntry(id, { font, loading: false, error: font ? null : "This version of PulseGrid Studio doesn't include the built-in instruments." });
      return font;
    })
    .catch((error: unknown) => {
      setEntry(id, { loading: false, error: error instanceof Error ? error.message : "The SoundFont couldn't be read." });
      return null;
    })
    .finally(() => {
      loading.delete(id);
    });

  loading.set(id, promise);
  return promise;
}

/** Start reading a font without waiting: for a note that arrives before its sounds do. */
export function requestFont(id: string): void {
  if (getFont(id) || loading.has(id)) return;
  // A font that already failed isn't retried on every note.
  if (useSoundFontStore.getState().fonts[id]?.error) return;
  void loadFont(id);
}

/** Make sure every SoundFont these channels use is in memory (before an export, say). */
export async function ensureFontsFor(channels: readonly Channel[]): Promise<void> {
  const ids = new Set<string>();
  for (const channel of channels) {
    if (channel.soundfont) ids.add(channel.soundfont.fontId);
  }
  // A project whose own font is missing plays the built-in set instead.
  await Promise.all([...ids].map(async (id) => ((await loadFont(id)) ? null : id !== BUILTIN_ID ? loadFont(BUILTIN_ID) : null)));
}

/** The font a channel plays from, and the preset it asked for, with sensible fallbacks. */
export function resolveChannelSound(ref: SoundFontRef): { font: SoundFont; preset: SfPreset } | null {
  const font = getFont(ref.fontId) ?? getFont(BUILTIN_ID);
  if (!font) return null;

  const preset =
    findPreset(font, ref.bank, ref.program) ??
    // Another SoundFont: the same instrument number in the ordinary bank, or whatever it starts with.
    findPreset(font, ref.bank === 128 ? 128 : 0, ref.program) ??
    findPreset(font, ref.bank === 128 ? 128 : 0, 0) ??
    font.presets[0];

  return preset ? { font, preset } : null;
}

/* ─────────────────────────────────── adding and removing ─────────────────────────────────── */

async function idFor(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `user-${[...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Add a SoundFont a person picked: check it, keep a copy on this computer, and load it. */
export async function importSoundFont(file: File): Promise<FontEntry> {
  if (file.size > MAX_BYTES) throw new Error("That SoundFont is too big (over 1 GB).");
  if (!/\.sf2$/i.test(file.name)) throw new Error("Choose a SoundFont file, which ends in .sf2.");

  const bytes = await file.arrayBuffer();
  // Parsing doubles as the check that it is a real SoundFont.
  const font = parseSoundFont(bytes, file.name);
  if (font.presets.length === 0) throw new Error("That SoundFont has no instruments in it.");

  const id = await idFor(bytes);
  const storage = fontStorage();
  if (storage) await storage.write(id, font.name, bytes);

  setEntry(id, { name: font.name, builtin: false, font, loading: false, error: null });
  return useSoundFontStore.getState().fonts[id];
}

export async function removeSoundFont(id: string): Promise<void> {
  if (id === BUILTIN_ID) return;
  await fontStorage()?.remove(id);
  useSoundFontStore.setState((state) => {
    const { [id]: _removed, ...rest } = state.fonts;
    void _removed;
    return { fonts: rest };
  });
}

/** List the SoundFonts kept on this computer, so they can be chosen. They are read when first used. */
export async function refreshSavedFonts(): Promise<void> {
  const storage = fontStorage();
  if (!storage) return;

  try {
    for (const saved of await storage.list()) {
      if (!useSoundFontStore.getState().fonts[saved.id]) setEntry(saved.id, { name: saved.name, builtin: false });
    }
  } catch {
    /* storage unavailable: only the built-in set is offered */
  }
}

/** The names of a font's presets, for the picker, in a stable order. */
export function listPresets(font: SoundFont): Array<{ bank: number; program: number; name: string }> {
  return font.presets
    .map((preset) => ({ bank: preset.bank, program: preset.program, name: preset.name }))
    .sort((a, b) => a.bank - b.bank || a.program - b.program);
}

/**
 * Is the built-in set here? The desktop app carries it; the web studio can't (it is too big to
 * serve to everyone who opens the page). Reads only the start of the answer.
 */
export async function probeBuiltinSoundFont(): Promise<boolean> {
  try {
    const response = await fetch(builtinUrl());
    const present = response.ok && !/html/i.test(response.headers.get("content-type") ?? "");
    await response.body?.cancel();
    useSoundFontStore.setState({ builtinAvailable: present });
    return present;
  } catch {
    useSoundFontStore.setState({ builtinAvailable: false });
    return false;
  }
}

/** Keep every SoundFont a project's channels use loading as projects open and channels are added. Returns a teardown. */
export function watchProjectFonts(
  getChannels: () => readonly Channel[],
  subscribe: (listener: () => void) => () => void
): () => void {
  const wake = () => {
    for (const channel of getChannels()) {
      if (channel.soundfont) requestFont(channel.soundfont.fontId);
    }
  };
  wake();
  return subscribe(wake);
}
