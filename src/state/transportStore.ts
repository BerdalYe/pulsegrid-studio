import { create } from "zustand";

/**
 * High-frequency playback state, deliberately kept out of the project store so
 * that a moving playhead never triggers project subscribers (and therefore
 * never rebuilds the audio graph).
 */
interface TransportState {
  isPlaying: boolean;
  /** Step the playhead is on, or -1 when stopped. */
  playheadStep: number;
  /** Where playback starts from / where the user last clicked the ruler. */
  startStep: number;
  isRecording: boolean;
  recordLevel: number;
  activeMidiNotes: number[];
  cpuLoad: number;

  setPlaying: (value: boolean) => void;
  setPlayheadStep: (step: number) => void;
  setStartStep: (step: number) => void;
  setIsRecording: (value: boolean) => void;
  setRecordLevel: (level: number) => void;
  noteOn: (pitch: number) => void;
  noteOff: (pitch: number) => void;
  clearNotes: () => void;
}

export const useTransportStore = create<TransportState>()((set) => ({
  isPlaying: false,
  playheadStep: -1,
  startStep: 0,
  isRecording: false,
  recordLevel: 0,
  activeMidiNotes: [],
  cpuLoad: 0,

  setPlaying: (value) => set({ isPlaying: value }),

  setPlayheadStep: (step) =>
    set((state) => (state.playheadStep === step ? state : { playheadStep: step })),

  setStartStep: (step) => set({ startStep: Math.max(0, Math.floor(step)) }),

  setIsRecording: (value) => set({ isRecording: value }),

  setRecordLevel: (level) =>
    set((state) =>
      Math.abs(state.recordLevel - level) < 0.01 ? state : { recordLevel: level }
    ),

  noteOn: (pitch) =>
    set((state) =>
      state.activeMidiNotes.includes(pitch)
        ? state
        : { activeMidiNotes: [...state.activeMidiNotes, pitch] }
    ),

  noteOff: (pitch) =>
    set((state) => ({
      activeMidiNotes: state.activeMidiNotes.filter((note) => note !== pitch)
    })),

  clearNotes: () => set({ activeMidiNotes: [] })
}));
