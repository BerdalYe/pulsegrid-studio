import { create } from "zustand";

import type { PlaybackMode, SessionData, ViewName } from "../types";
import { STEPS_PER_BAR, clamp } from "../lib/utils";
import { looseRect, scaleRect, type Rect, type Size } from "../lib/windowGeometry";

export interface WindowLayout {
  open: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  maximized: boolean;
  minimized: boolean;
}

export type WindowId = ViewName;

const STORAGE_KEY = "pulsegrid:session";

const defaultWindows: Record<WindowId, WindowLayout> = {
  playlist: { open: true, x: 12, y: 10, width: 900, height: 360, z: 4, maximized: false, minimized: false },
  rack: { open: true, x: 12, y: 384, width: 680, height: 300, z: 3, maximized: false, minimized: false },
  piano: { open: false, x: 180, y: 120, width: 880, height: 500, z: 2, maximized: false, minimized: false },
  mixer: { open: false, x: 120, y: 150, width: 900, height: 520, z: 1, maximized: false, minimized: false }
};

/**
 * Where the user is looking. Persisted to localStorage, never part of undo —
 * undoing a note edit shouldn't move your windows around.
 */
interface SessionState extends SessionData {
  windows: Record<WindowId, WindowLayout>;

  /**
   * Transport preferences. Store-only rather than part of `SessionData`: they
   * belong to this browser, not to the song, so they never travel in a project
   * file or get captured by undo.
   */
  metronome: boolean;
  countIn: boolean;
  loopPlayback: boolean;

  /** Piano roll helpers. Also browser-local rather than part of the song. */
  ghostNotes: boolean;
  /** The plain mouse wheel zooms the piano roll and playlist (Ctrl + wheel always does). */
  wheelZoom: boolean;
  /** Root note 0-11 (C..B), or -1 for no scale highlighting. */
  scaleRoot: number;
  scaleMode: string;

  setTheme: (theme: string) => void;
  setView: (view: ViewName) => void;
  setMode: (mode: PlaybackMode) => void;
  selectPattern: (patternId: string) => void;
  selectChannel: (channelId: string | null) => void;
  selectMixerTrack: (trackId: number) => void;
  setSnapSteps: (steps: number) => void;
  setPianoSnapSteps: (steps: number) => void;

  toggleMetronome: () => void;
  toggleCountIn: () => void;
  toggleLoopPlayback: () => void;
  toggleGhostNotes: () => void;
  toggleWheelZoom: () => void;
  setScale: (root: number, mode: string) => void;

  focusWindow: (id: WindowId) => void;
  openWindow: (id: WindowId) => void;
  closeWindow: (id: WindowId) => void;
  toggleWindow: (id: WindowId) => void;
  openAllWindows: () => void;
  moveWindow: (id: WindowId, x: number, y: number) => void;
  resizeWindow: (id: WindowId, width: number, height: number) => void;
  /** Place a window (moved and resized in one go). It may sit partly out of view, but a strip of it stays in the work area. */
  setWindowRect: (id: WindowId, rect: Rect) => void;
  /** The size of the area the windows float in, as measured. Windows follow it as it changes. */
  area: Size;
  setArea: (width: number, height: number) => void;
  setWindowFlag: (id: WindowId, flag: "maximized" | "minimized", value: boolean) => void;
  resetLayout: () => void;
  /** False until the windows have been sized to the screen they opened on. */
  layoutFitted: boolean;
  fitLayoutToArea: (width: number, height: number) => void;

  applySession: (session: Partial<SessionData>) => void;
  toSessionData: () => SessionData;
}

/**
 * Restack the windows as 1..n, with `front` (if given) moved to the top.
 *
 * Only the order of z values means anything, so they are kept as small ranks.
 * Handing out `max + 1` on every focus let them grow without bound — every
 * click inside a window focuses it — and once a window passed the dialogs'
 * z-index it painted straight over the delete-confirmation popup.
 */
export function restackWindows(
  windows: Record<WindowId, WindowLayout>,
  front?: WindowId
): Record<WindowId, WindowLayout> {
  const order = (Object.keys(windows) as WindowId[])
    .filter((id) => id !== front)
    .sort((a, b) => (Number(windows[a].z) || 0) - (Number(windows[b].z) || 0));

  if (front) order.push(front);

  const next = { ...windows };
  order.forEach((id, index) => {
    if (next[id].z !== index + 1) next[id] = { ...next[id], z: index + 1 };
  });
  return next;
}

/**
 * Bumped when the default layout changes, so everyone gets the new one once
 * rather than only people opening the studio for the first time.
 */
export const LAYOUT_VERSION = 2;

/**
 * The layout the studio opens with: the playlist maximized as the backdrop,
 * the channel rack floating over its lower-left corner, and the piano roll and
 * mixer sized to sit over most of the space when they are opened. Sized to
 * the window area it actually has, however big the screen.
 */
export function fitLayout(
  width: number,
  height: number,
  current: Record<WindowId, WindowLayout> = defaultWindows
): Record<WindowId, WindowLayout> {
  const gap = 8;
  const w = Math.max(480, Math.round(width));
  const h = Math.max(360, Math.round(height));

  // Wide enough for the channel header and a full bar of sixteen steps.
  const rackWidth = Math.min(w - gap * 2, Math.max(830, Math.round(w * 0.56)));
  const rackHeight = Math.min(h - gap * 2, Math.max(300, Math.round(h * 0.44)));
  const pianoLeft = Math.round(w * 0.16);
  const mixerTop = Math.round(h * 0.28);

  const place = (id: WindowId, x: number, y: number, width: number, height: number): WindowLayout => ({
    ...current[id],
    x,
    y,
    width: Math.max(320, width),
    height: Math.max(200, height),
    maximized: false,
    minimized: false
  });

  const layout: Record<WindowId, WindowLayout> = {
    // Its restored size, for when it is un-maximized.
    playlist: {
      ...place("playlist", gap, gap, w - gap * 2, Math.round((h - gap * 3) * 0.56)),
      open: true,
      maximized: true
    },
    rack: { ...place("rack", gap * 3, h - rackHeight - gap * 3, rackWidth, rackHeight), open: true },
    // Closed to start with; F7 and F9 open them where they fit.
    piano: { ...place("piano", pianoLeft, gap * 4, w - pianoLeft - gap, h - gap * 5), open: false },
    mixer: { ...place("mixer", gap, mixerTop, w - gap * 2, h - mixerTop - gap), open: false }
  };

  // The playlist at the back, everything else stacked in front of it.
  return restackWindows({ ...layout, playlist: { ...layout.playlist, z: 0 } });
}

function sanitizeArea(raw: unknown): Size {
  const source = (raw ?? {}) as Record<string, unknown>;
  const width = typeof source.width === "number" && Number.isFinite(source.width) ? source.width : 0;
  const height = typeof source.height === "number" && Number.isFinite(source.height) ? source.height : 0;
  return width >= 200 && height >= 150 ? { width, height } : { width: 0, height: 0 };
}

function loadPersisted(): Partial<SessionState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SessionState> & { layoutVersion?: number };

    const windows = { ...defaultWindows };
    if (parsed.windows) {
      for (const id of Object.keys(defaultWindows) as WindowId[]) {
        if (parsed.windows[id]) windows[id] = { ...windows[id], ...parsed.windows[id] };
      }
    }

    // Layouts saved before z was kept compact can carry values in the
    // thousands; squash them back down so they can't bury the dialogs.
    return {
      ...parsed,
      windows: restackWindows(windows),
      area: sanitizeArea((parsed as { layoutArea?: unknown }).layoutArea),
      // An older default layout is replaced once by the current one.
      layoutFitted: parsed.layoutFitted === true && parsed.layoutVersion === LAYOUT_VERSION
    };
  } catch {
    return {};
  }
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  theme: "pulse-violet",
  view: "playlist",
  mode: "song",
  selectedPatternId: "",
  selectedChannelId: null,
  selectedMixerTrackId: 1,
  snapSteps: STEPS_PER_BAR,
  pianoSnapSteps: 1,
  windows: defaultWindows,
  area: { width: 0, height: 0 },
  metronome: false,
  countIn: false,
  loopPlayback: true,
  ghostNotes: false,
  wheelZoom: true,
  scaleRoot: -1,
  scaleMode: "major",

  ...loadPersisted(),

  setTheme: (theme) => set({ theme }),
  setView: (view) => set({ view }),
  setMode: (mode) => set({ mode }),
  selectPattern: (selectedPatternId) => set({ selectedPatternId }),
  selectChannel: (selectedChannelId) => set({ selectedChannelId }),
  selectMixerTrack: (selectedMixerTrackId) => set({ selectedMixerTrackId }),
  setSnapSteps: (snapSteps) => set({ snapSteps: clamp(snapSteps, 1, STEPS_PER_BAR) }),
  setPianoSnapSteps: (pianoSnapSteps) =>
    set({ pianoSnapSteps: clamp(pianoSnapSteps, 1, STEPS_PER_BAR) }),

  toggleMetronome: () => set((state) => ({ metronome: !state.metronome })),
  toggleCountIn: () => set((state) => ({ countIn: !state.countIn })),
  toggleLoopPlayback: () => set((state) => ({ loopPlayback: !state.loopPlayback })),
  toggleGhostNotes: () => set((state) => ({ ghostNotes: !state.ghostNotes })),
  toggleWheelZoom: () => set((state) => ({ wheelZoom: !state.wheelZoom })),
  setScale: (scaleRoot, scaleMode) =>
    set({ scaleRoot: clamp(Math.round(scaleRoot), -1, 11), scaleMode }),

  focusWindow: (id) =>
    set((state) => {
      const current = state.windows[id];
      const onTop = Object.values(state.windows).every((layout) => layout.z <= current.z);

      // Clicking inside the window that is already in front is the common case
      // — every step, note and knob does it — so it must not touch the layout.
      if (onTop && current.open && !current.minimized && state.view === id) return state;

      const windows = restackWindows(state.windows, id);
      return {
        view: id,
        windows: { ...windows, [id]: { ...windows[id], open: true, minimized: false } }
      };
    }),

  openWindow: (id) => get().focusWindow(id),

  closeWindow: (id) =>
    set((state) => ({
      windows: { ...state.windows, [id]: { ...state.windows[id], open: false } }
    })),

  toggleWindow: (id) => {
    const current = get().windows[id];
    if (current.open && get().view === id) get().closeWindow(id);
    else get().focusWindow(id);
  },

  openAllWindows: () =>
    set((state) => {
      const windows = { ...state.windows };
      for (const id of Object.keys(windows) as WindowId[]) {
        windows[id] = { ...windows[id], open: true, minimized: false };
      }
      return { windows };
    }),

  moveWindow: (id, x, y) => get().setWindowRect(id, { ...get().windows[id], x, y }),

  resizeWindow: (id, width, height) => get().setWindowRect(id, { ...get().windows[id], width, height }),

  setWindowRect: (id, rect) =>
    set((state) => {
      const fitted = looseRect(rect, state.area);
      const current = state.windows[id];
      if (
        fitted.x === current.x &&
        fitted.y === current.y &&
        fitted.width === current.width &&
        fitted.height === current.height
      ) {
        return state;
      }
      return { windows: { ...state.windows, [id]: { ...current, ...fitted } } };
    }),

  setArea: (width, height) =>
    set((state) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      if (next.width <= 0 || next.height <= 0) return state;
      if (next.width === state.area.width && next.height === state.area.height) return state;

      // The windows keep their share of the area as it grows and shrinks, and always stay inside it.
      const windows = { ...state.windows };
      for (const id of Object.keys(windows) as WindowId[]) {
        const { x, y, width: w, height: h } = windows[id];
        windows[id] = { ...windows[id], ...scaleRect({ x, y, width: w, height: h }, state.area, next) };
      }
      return { area: next, windows };
    }),

  setWindowFlag: (id, flag, value) =>
    set((state) => ({
      windows: { ...state.windows, [id]: { ...state.windows[id], [flag]: value } }
    })),

  resetLayout: () => set({ windows: defaultWindows, layoutFitted: false }),

  layoutFitted: false,
  fitLayoutToArea: (width, height) =>
    set((state) => ({
      area: { width: Math.round(width), height: Math.round(height) },
      windows: fitLayout(width, height, state.windows),
      layoutFitted: true
    })),

  applySession: (session) =>
    set((state) => ({
      theme: session.theme ?? state.theme,
      view: session.view ?? state.view,
      mode: session.mode ?? state.mode,
      selectedPatternId: session.selectedPatternId ?? state.selectedPatternId,
      selectedChannelId:
        session.selectedChannelId !== undefined
          ? session.selectedChannelId
          : state.selectedChannelId,
      selectedMixerTrackId: session.selectedMixerTrackId ?? state.selectedMixerTrackId,
      snapSteps: session.snapSteps ?? state.snapSteps,
      pianoSnapSteps: session.pianoSnapSteps ?? state.pianoSnapSteps
    })),

  toSessionData: () => {
    const state = get();
    return {
      theme: state.theme,
      view: state.view,
      mode: state.mode,
      selectedPatternId: state.selectedPatternId,
      selectedChannelId: state.selectedChannelId,
      selectedMixerTrackId: state.selectedMixerTrackId,
      snapSteps: state.snapSteps,
      pianoSnapSteps: state.pianoSnapSteps
    };
  }
}));

// Persist quietly in the background; failures here should never break the app.
let persistTimer: number | null = null;

useSessionStore.subscribe((state) => {
  if (persistTimer !== null) window.clearTimeout(persistTimer);

  persistTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...state.toSessionData(),
          windows: state.windows,
          layoutFitted: state.layoutFitted,
          layoutArea: state.area,
          wheelZoom: state.wheelZoom,
          layoutVersion: LAYOUT_VERSION
        })
      );
    } catch {
      /* storage may be unavailable — not worth surfacing */
    }
  }, 400);
});
