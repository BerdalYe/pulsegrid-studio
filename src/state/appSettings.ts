import { create } from "zustand";

/**
 * The settings that belong to this computer and the way you like to work, rather than to a project: how loud the
 * metronome is, which speakers to use, how big the interface is. Kept in the browser's storage, never in a project.
 */

/** How much sound the computer buffers before it plays: less is more immediate, more is safer on a slow PC. */
export type LatencyChoice = "interactive" | "balanced" | "playback";

export interface AppSettings {
  /** The size of the whole interface, 0.8 to 1.5. The desktop app only; the web studio uses the browser's zoom. */
  uiScale: number;
  /** Show the hint for whatever the pointer is over, in the status bar. */
  showHints: boolean;
  /** Play a sound when a step or note is clicked in. */
  audition: boolean;
  /** 0 to 1. */
  metronomeVolume: number;
  /** How hard the computer keyboard plays, 0.1 to 1. */
  keyboardVelocity: number;
  /** Takes effect when the audio next starts. */
  latency: LatencyChoice;
  /** Which speakers to play through; empty is the system's own choice. */
  outputDeviceId: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  uiScale: 1,
  showHints: true,
  audition: true,
  metronomeVolume: 0.7,
  keyboardVelocity: 0.85,
  latency: "interactive",
  outputDeviceId: ""
};

export const UI_SCALE_RANGE = { min: 0.8, max: 1.5, step: 0.05 };

const STORAGE_KEY = "pulsegrid:settings";

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Whatever storage holds, made into settings that are safe to use: unknown or broken entries take their default. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const source = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const latency = source.latency === "balanced" || source.latency === "playback" || source.latency === "interactive" ? source.latency : DEFAULT_SETTINGS.latency;

  return {
    // Rounded to the step, so a stored 1.0000001 doesn't show up as a odd value.
    uiScale: Math.round(number(source.uiScale, DEFAULT_SETTINGS.uiScale, UI_SCALE_RANGE.min, UI_SCALE_RANGE.max) * 20) / 20,
    showHints: typeof source.showHints === "boolean" ? source.showHints : DEFAULT_SETTINGS.showHints,
    audition: typeof source.audition === "boolean" ? source.audition : DEFAULT_SETTINGS.audition,
    metronomeVolume: number(source.metronomeVolume, DEFAULT_SETTINGS.metronomeVolume, 0, 1),
    keyboardVelocity: number(source.keyboardVelocity, DEFAULT_SETTINGS.keyboardVelocity, 0.1, 1),
    latency,
    outputDeviceId: typeof source.outputDeviceId === "string" ? source.outputDeviceId.slice(0, 300) : ""
  };
}

function load(): AppSettings {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

interface SettingsState extends AppSettings {
  set: (changes: Partial<AppSettings>) => void;
  reset: () => void;
}

export const useAppSettings = create<SettingsState>()((set) => ({
  ...load(),
  set: (changes) => set((state) => ({ ...sanitizeSettings({ ...state, ...changes }) })),
  reset: () => set({ ...DEFAULT_SETTINGS })
}));

/** The settings alone, without the actions. */
export function currentSettings(): AppSettings {
  const { uiScale, showHints, audition, metronomeVolume, keyboardVelocity, latency, outputDeviceId } = useAppSettings.getState();
  return { uiScale, showHints, audition, metronomeVolume, keyboardVelocity, latency, outputDeviceId };
}

useAppSettings.subscribe(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings()));
  } catch {
    /* the settings hold until the app closes */
  }
});
