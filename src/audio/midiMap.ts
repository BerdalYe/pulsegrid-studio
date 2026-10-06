import { create } from "zustand";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { MAX_BPM, MIN_BPM, clamp } from "../lib/utils";

/**
 * Hardware knobs and faders → studio controls.
 *
 * Every mappable control has a string id. On-screen knobs register themselves
 * under an id while they're mounted (right-click one to "learn" a hardware
 * knob); a handful of "follow the selection" targets are always available, and
 * the MPK Mini's eight knobs come mapped to them out of the box.
 */
export interface ControlTarget {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(value: number): void;
}

const STORAGE_KEY = "pulsegrid:midi-map";

/**
 * Akai MPK Mini knobs K1–K8 send CC 70–77 by default, which is also a common
 * layout on other small controllers. Anything else can be learned.
 */
export const DEFAULT_CC_MAP: Record<number, string> = {
  70: "selected:volume",
  71: "selected:pan",
  72: "selected-insert:volume",
  73: "selected-insert:pan",
  74: "master:volume",
  75: "swing",
  76: "tempo"
};

function loadMappings(): Record<number, string> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Record<string, string> | null;
    if (stored && typeof stored === "object") {
      return Object.fromEntries(
        Object.entries(stored)
          .map(([cc, id]) => [Number(cc), id] as const)
          .filter(([cc, id]) => Number.isInteger(cc) && cc >= 0 && cc < 128 && typeof id === "string")
      );
    }
  } catch {
    /* storage blocked or corrupt — fall back to the defaults */
  }
  return { ...DEFAULT_CC_MAP };
}

function saveMappings(mappings: Record<number, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings));
  } catch {
    /* mappings still work for this session */
  }
}

interface MidiState {
  /** The on-screen control waiting for a hardware knob, if any. */
  learningId: string | null;
  mappings: Record<number, string>;
  /** Arms recording of MIDI notes into the pattern while playing. */
  recordArmed: boolean;
  /** Time of the last incoming message, for the activity light. */
  lastActivity: number;

  startLearning(id: string | null): void;
  mapController(cc: number, id: string): void;
  unmapTarget(id: string): void;
  resetMappings(): void;
  setRecordArmed(armed: boolean): void;
  markActivity(): void;
}

export const useMidiStore = create<MidiState>()((set, get) => ({
  learningId: null,
  mappings: loadMappings(),
  recordArmed: false,
  lastActivity: 0,

  startLearning: (id) => set({ learningId: id }),

  mapController: (cc, id) => {
    // One knob per control: learning a new knob moves the mapping.
    const mappings = Object.fromEntries(
      Object.entries(get().mappings).filter(([, target]) => target !== id)
    ) as Record<number, string>;
    mappings[cc] = id;
    saveMappings(mappings);
    set({ mappings, learningId: null });
  },

  unmapTarget: (id) => {
    const mappings = Object.fromEntries(
      Object.entries(get().mappings).filter(([, target]) => target !== id)
    ) as Record<number, string>;
    saveMappings(mappings);
    set({ mappings });
  },

  resetMappings: () => {
    const mappings = { ...DEFAULT_CC_MAP };
    saveMappings(mappings);
    set({ mappings, learningId: null });
  },

  setRecordArmed: (recordArmed) => set({ recordArmed }),
  markActivity: () => set({ lastActivity: Date.now() })
}));

/* ─────────────────────────────── targets ─────────────────────────────── */

const mounted = new Map<string, ControlTarget>();

/** Called by knobs and faders with a `learnId` while they're on screen. */
export function registerControl(id: string, target: ControlTarget): () => void {
  mounted.set(id, target);
  return () => {
    if (mounted.get(id) === target) mounted.delete(id);
  };
}

function selectedChannel() {
  const id = useSessionStore.getState().selectedChannelId;
  const channels = useProjectStore.getState().channels;
  return channels.find((channel) => channel.id === id) ?? channels[0] ?? null;
}

/** Targets that exist whether or not any window is open. */
function builtinTarget(id: string): ControlTarget | null {
  const project = useProjectStore.getState();

  switch (id) {
    case "selected:volume": {
      const channel = selectedChannel();
      if (!channel) return null;
      return {
        label: `${channel.name} volume`,
        min: 0,
        max: 1,
        step: 0.01,
        get: () => channel.volume,
        set: (value) => useProjectStore.getState().setChannelVolume(channel.id, value)
      };
    }
    case "selected:pan": {
      const channel = selectedChannel();
      if (!channel) return null;
      return {
        label: `${channel.name} pan`,
        min: -1,
        max: 1,
        step: 0.01,
        get: () => channel.pan,
        set: (value) => useProjectStore.getState().setChannelPan(channel.id, value)
      };
    }
    case "selected-insert:volume":
    case "selected-insert:pan": {
      const channel = selectedChannel();
      const track = project.mixer.tracks.find((entry) => entry.id === channel?.mixerTrackId);
      if (!track) return null;
      const pan = id.endsWith("pan");
      return {
        label: `${track.name} ${pan ? "pan" : "volume"}`,
        min: pan ? -1 : 0,
        max: pan ? 1 : 1.5,
        step: 0.01,
        get: () => (pan ? track.pan : track.volume),
        set: (value) =>
          pan
            ? useProjectStore.getState().setMixerTrackPan(track.id, value)
            : useProjectStore.getState().setMixerTrackVolume(track.id, value)
      };
    }
    case "master:volume":
      return {
        label: "Master volume",
        min: 0,
        max: 1,
        step: 0.01,
        get: () => project.masterVolume,
        set: (value) => useProjectStore.getState().setMasterVolume(value)
      };
    case "swing":
      return {
        label: "Swing",
        min: 0,
        max: 1,
        step: 0.01,
        get: () => project.swing,
        set: (value) => useProjectStore.getState().setSwing(value)
      };
    case "tempo":
      return {
        label: "Tempo",
        min: Math.max(MIN_BPM, 60),
        max: Math.min(MAX_BPM, 200),
        step: 1,
        get: () => project.bpm,
        set: (value) => useProjectStore.getState().setBpm(value)
      };
    default:
      return null;
  }
}

export function resolveTarget(id: string): ControlTarget | null {
  return mounted.get(id) ?? builtinTarget(id);
}

/* ─────────────────────────────── handling ─────────────────────────────── */

/**
 * A turn of a hardware knob sends dozens of messages. They are gathered into
 * one undo step, closed once the knob has been still for a moment.
 */
let groupTimer: ReturnType<typeof setTimeout> | null = null;

function inGesture(label: string): void {
  if (groupTimer === null) useProjectStore.getState().beginEdit(label);
  else clearTimeout(groupTimer);

  groupTimer = setTimeout(() => {
    groupTimer = null;
    useProjectStore.getState().endEdit();
  }, 450);
}

/**
 * Apply a control change (value 0..1). Returns a status message when a knob
 * was just learned, so the UI can confirm it.
 */
export function handleControlChange(controller: number, value: number): string | null {
  const midi = useMidiStore.getState();

  if (midi.learningId) {
    const id = midi.learningId;
    const target = resolveTarget(id);
    midi.mapController(controller, id);
    return `Controller ${controller} now moves ${target?.label ?? id}.`;
  }

  const id = midi.mappings[controller];
  if (!id) return null;

  const target = resolveTarget(id);
  if (!target) return null;

  const raw = target.min + clamp(value, 0, 1) * (target.max - target.min);
  const snapped = Math.round(raw / target.step) * target.step;

  inGesture(target.label);
  target.set(clamp(Number(snapped.toFixed(6)), target.min, target.max));
  return null;
}

/** Which controller number, if any, is mapped to this control. */
export function controllerFor(mappings: Record<number, string>, id: string): number | null {
  const entry = Object.entries(mappings).find(([, target]) => target === id);
  return entry ? Number(entry[0]) : null;
}
