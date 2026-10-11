import { Scheduler } from "./Scheduler";
import type { Channel } from "../types";
import { midiManager, parseMidiMessage } from "./midi";
import { midiOutPanic } from "./midiOut";
import { currentSettings, useAppSettings } from "../state/appSettings";
import { Sequencer } from "./sequencer";
import { RenderGraph } from "./graph";
import { initDefaultSamples } from "./sampleRegistry";
import { scheduleMetronomeClick, triggerChannel, type Voice } from "./voices";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { useTransportStore } from "../state/transportStore";
import { getProjectData } from "../state/serialize";

import {
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  clamp,
  getPlaybackLengthSteps,
  secondsPerStep
} from "../lib/utils";

let context: AudioContext | null = null;
let graph: RenderGraph | null = null;
let sequencer: Sequencer | null = null;
let scheduler: Scheduler | null = null;

let unsubscribeProject: (() => void) | null = null;
let playheadFrame: number | null = null;

/** Live MIDI / keyboard voices, so note-off can find what to release. */
const heldVoices = new Map<string, Voice>();

function heldKey(channelId: string, pitch: number): string {
  return `${channelId}:${pitch}`;
}

export function getAudioContext(): AudioContext | null {
  return context;
}

export function isAudioReady(): boolean {
  return context !== null;
}

/**
 * Create the audio context and graph. Must be called from a user gesture the
 * first time, which is why every entry point that makes sound calls it.
 */
export function ensureAudio(): AudioContext | null {
  if (context) {
    if (context.state === "suspended") void context.resume();
    return context;
  }

  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextClass) return null;

  context = new AudioContextClass({ latencyHint: currentSettings().latency });
  // The speakers chosen in the settings, if any.
  void applyOutputDevice();

  initDefaultSamples(context);

  const project = getProjectData(useProjectStore.getState());
  graph = new RenderGraph(context, project, { analysers: true });
  sequencer = new Sequencer(graph);

  scheduler = new Scheduler({
    context,
    getStepDuration: () => secondsPerStep(useProjectStore.getState().bpm),
    getSwing: () => useProjectStore.getState().swing,
    getLengthSteps: () => {
      const session = useSessionStore.getState();
      return getPlaybackLengthSteps(
        getProjectData(useProjectStore.getState()),
        session.mode,
        session.selectedPatternId
      );
    },
    getLoop: () => useSessionStore.getState().loopPlayback,
    getLoopRegion: () => {
      const project = useProjectStore.getState();
      if (project.loopStart === null || project.loopEnd === null) return null;
      return { start: project.loopStart, end: project.loopEnd };
    },
    onStep: ({ stepIndex, time, stepDuration }) => {
      if (!sequencer) return;
      const session = useSessionStore.getState();
      sequencer.scheduleStep(
        getProjectData(useProjectStore.getState()),
        { mode: session.mode, selectedPatternId: session.selectedPatternId },
        stepIndex,
        time,
        stepDuration
      );

      // The metronome lives here rather than in the Sequencer on purpose: the
      // Sequencer is shared with offline rendering, and a click has no business
      // being in an exported file.
      if (session.metronome && stepIndex % STEPS_PER_BEAT === 0 && graph) {
        scheduleMetronomeClick(
          graph.context,
          graph.metronomeInput,
          time,
          stepIndex % STEPS_PER_BAR === 0,
          currentSettings().metronomeVolume
        );
      }
    },
    onEnd: (atTime) => {
      // Not looping: let the scheduled audio play out, then stop the transport.
      const remaining = Math.max(0, atTime - (context?.currentTime ?? 0));
      window.setTimeout(() => {
        if (scheduler?.isPlaying) stopTransport();
      }, remaining * 1000 + 80);
    }
  });

  // Only real project edits reach here — the playhead lives in its own store,
  // so a moving playhead never touches the audio graph.
  unsubscribeProject = useProjectStore.subscribe(() => syncWithState());

  syncWithState();

  return context;
}

export function syncWithState(): void {
  if (!context || !graph) return;
  graph.sync(getProjectData(useProjectStore.getState()), context.currentTime, true);
}

export function disposeAudio(): void {
  stopTransport();
  unsubscribeProject?.();
  unsubscribeProject = null;
  graph?.dispose();
  graph = null;
  sequencer = null;
  scheduler?.dispose();
  scheduler = null;
  void context?.close();
  context = null;
}

/* ─────────────────────────────── transport ─────────────────────────────── */

function startPlayheadLoop(): void {
  if (playheadFrame !== null) return;

  const tick = () => {
    if (!scheduler?.isPlaying) {
      playheadFrame = null;
      return;
    }

    useTransportStore.getState().setPlayheadStep(scheduler.getCurrentStep());
    playheadFrame = requestAnimationFrame(tick);
  };

  playheadFrame = requestAnimationFrame(tick);
}

function stopPlayheadLoop(): void {
  if (playheadFrame !== null) {
    cancelAnimationFrame(playheadFrame);
    playheadFrame = null;
  }
  useTransportStore.getState().setPlayheadStep(-1);
}

export async function startTransport(fromStep?: number): Promise<void> {
  const audioContext = ensureAudio();
  if (!scheduler || !sequencer || !audioContext) return;
  if (scheduler.isPlaying) return;

  const transport = useTransportStore.getState();
  const session = useSessionStore.getState();
  const start = fromStep ?? transport.startStep;

  // One bar of clicks before the first step, so you can come in on time.
  let countInSeconds = 0;

  if (session.countIn && graph) {
    const stepDuration = secondsPerStep(useProjectStore.getState().bpm);
    const beat = stepDuration * STEPS_PER_BEAT;
    const beats = STEPS_PER_BAR / STEPS_PER_BEAT;
    const from = audioContext.currentTime + 0.06;

    for (let i = 0; i < beats; i++) {
      scheduleMetronomeClick(graph.context, graph.metronomeInput, from + i * beat, i === 0, currentSettings().metronomeVolume);
    }

    countInSeconds = beats * beat;
  }

  sequencer.reset();
  await scheduler.start(start, countInSeconds);

  transport.setPlaying(true);
  startPlayheadLoop();
}

export function stopTransport(): void {
  if (!scheduler) return;

  scheduler.stop();

  if (context && sequencer) {
    sequencer.allNotesOff(context.currentTime);
    for (const voice of heldVoices.values()) voice.kill(context.currentTime);
    graph?.resetAutomation();
  }

  heldVoices.clear();
  midiOutPanic();
  stopPlayheadLoop();
  useTransportStore.getState().setPlaying(false);

  // Re-apply the user's own fader values after automation let go of them.
  syncWithState();
}

export async function toggleTransport(): Promise<void> {
  ensureAudio();
  if (!scheduler) return;

  if (scheduler.isPlaying) stopTransport();
  else await startTransport();
}

export function seekTo(step: number): void {
  const transport = useTransportStore.getState();
  transport.setStartStep(step);

  if (scheduler?.isPlaying) {
    stopTransport();
    void startTransport(step);
  } else {
    transport.setPlayheadStep(-1);
  }
}

export function panic(): void {
  if (!context || !sequencer) return;

  const now = context.currentTime;
  sequencer.allNotesOff(now);

  // Kill before dropping the references — clearing the map first would strand
  // every held voice with no handle left to stop it, so the note rings until
  // the page is reloaded.
  for (const voice of heldVoices.values()) voice.kill(now);
  heldVoices.clear();
  midiOutPanic();
}

/* ────────────────────────────── speakers and latency ────────────────────────────── */

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string | { type: string } };

/** Play through the speakers chosen in the settings (or the system's own choice). False where that can't be done. */
export async function applyOutputDevice(): Promise<boolean> {
  const live = context as SinkContext | null;
  if (!live || typeof live.setSinkId !== "function") return false;
  try {
    await live.setSinkId(currentSettings().outputDeviceId);
    return true;
  } catch (error) {
    console.warn("The chosen output device couldn't be used:", error);
    return false;
  }
}

// Choosing other speakers takes effect straight away.
let lastDevice = currentSettings().outputDeviceId;
useAppSettings.subscribe((state) => {
  if (state.outputDeviceId === lastDevice) return;
  lastDevice = state.outputDeviceId;
  void applyOutputDevice();
});

/** What the audio is running at, for the settings window. Null until the audio has started. */
export function getAudioInfo(): { sampleRate: number; baseLatencyMs: number; outputLatencyMs: number; canChooseOutput: boolean } | null {
  const live = context as SinkContext | null;
  if (!live) return null;
  return {
    sampleRate: live.sampleRate,
    baseLatencyMs: Math.round((live.baseLatency ?? 0) * 1000),
    outputLatencyMs: Math.round(((live as AudioContext & { outputLatency?: number }).outputLatency ?? 0) * 1000),
    canChooseOutput: typeof live.setSinkId === "function"
  };
}

/** One metronome click through the master, so a person can check they hear the speakers they chose. */
export function playTestClick(): void {
  const live = ensureAudio();
  if (!live || !graph) return;
  const volume = Math.max(0.5, currentSettings().metronomeVolume);
  scheduleMetronomeClick(graph.context, graph.metronomeInput, live.currentTime + 0.03, true, volume);
  scheduleMetronomeClick(graph.context, graph.metronomeInput, live.currentTime + 0.4, false, volume);
}

/* ────────────────────────────── live playing ────────────────────────────── */

/** Note-on from MIDI or the on-screen keyboard. */
export function noteOn(channelId: string, pitch: number, velocity = 0.8): void {
  const audioContext = ensureAudio();
  if (!audioContext || !graph) return;

  const project = getProjectData(useProjectStore.getState());
  const channel = project.channels.find((entry) => entry.id === channelId);
  if (!channel) return;

  const destination = graph.getChannelInput(channelId);
  if (!destination) return;

  const key = heldKey(channelId, pitch);
  heldVoices.get(key)?.release(audioContext.currentTime);

  const voice = triggerChannel(audioContext, channel, destination, {
    time: audioContext.currentTime,
    velocity: clamp(velocity, 0, 1),
    pitch,
    // Held until note-off, which is what makes pads and leads playable.
    duration: null
  });

  if (voice) {
    // A note played while the wheel is already bent starts bent.
    const bend = channelBend.get(channelId) ?? 0;
    if (bend !== 0) voice.bend?.(bend, audioContext.currentTime);
    const mod = channelMod.get(channelId) ?? 0;
    if (mod > 0) voice.modulate?.(mod, audioContext.currentTime);

    heldVoices.set(key, voice);
  }
}

/* ─────────────────────────── MIDI expression ─────────────────────────── */

const channelBend = new Map<string, number>();
const channelMod = new Map<string, number>();

function heldVoicesOf(channelId: string): Voice[] {
  const prefix = `${channelId}:`;
  const voices: Voice[] = [];
  for (const [key, voice] of heldVoices) if (key.startsWith(prefix)) voices.push(voice);
  return voices;
}

/** Pitch wheel / joystick X: bend every held note on the channel, in cents. */
export function setPitchBend(channelId: string, cents: number): void {
  channelBend.set(channelId, cents);
  if (!context) return;
  for (const voice of heldVoicesOf(channelId)) voice.bend?.(cents, context.currentTime);
}

/** Mod wheel / joystick Y, 0..1: vibrato on every held note on the channel. */
export function setModulation(channelId: string, amount: number): void {
  channelMod.set(channelId, amount);
  if (!context) return;
  for (const voice of heldVoicesOf(channelId)) voice.modulate?.(amount, context.currentTime);
}

/** Fractional playhead position in steps, for recording; null when stopped. */
export function getPlayPosition(): number | null {
  return scheduler?.getPosition() ?? null;
}

export function noteOff(channelId: string, pitch: number): void {
  if (!context) return;

  const key = heldKey(channelId, pitch);
  const voice = heldVoices.get(key);
  if (!voice) return;

  voice.release(context.currentTime);
  heldVoices.delete(key);
}

/** A one-shot for clicking a step or a note in, which stays quiet when the settings say so. */
export function auditionChannel(channelId: string, pitch = 60, velocity = 0.85, seconds = 0.4): void {
  if (!currentSettings().audition) return;
  previewChannel(channelId, pitch, velocity, seconds);
}

/** One-shot audition, e.g. clicking a step or a piano-roll note. */
export function previewChannel(channelId: string, pitch = 60, velocity = 0.85, seconds = 0.4): void {
  const audioContext = ensureAudio();
  if (!audioContext || !graph) return;

  const project = getProjectData(useProjectStore.getState());
  const channel = project.channels.find((entry) => entry.id === channelId);
  if (!channel) return;

  const destination = graph.getChannelInput(channelId);
  if (!destination) return;

  triggerChannel(audioContext, channel, destination, {
    time: audioContext.currentTime,
    velocity: clamp(velocity, 0, 1),
    pitch,
    duration: seconds
  });
  oneShotEnds.push(audioContext.currentTime + seconds + 0.3);
  if (oneShotEnds.length > 256) oneShotEnds = oneShotEnds.filter((end) => end > audioContext.currentTime);
}

/* ─────────────────────────────── browser previews ─────────────────────────────── */

/** Notes for hearing something before it is used: when (seconds from now), which, how long, how hard. */
export interface PreviewNote {
  at: number;
  pitch: number;
  duration: number;
  velocity?: number;
}

let previewVoices: Voice[] = [];
/** When each one-shot (previews, clicked-in notes) stops sounding, for the voice count. */
let oneShotEnds: number[] = [];

/**
 * Play an instrument that isn't in the project yet, straight to the master: what the browser does when an
 * instrument or a sample is clicked. A new preview stops the last one.
 */
export function playPreview(channel: Channel, notes: PreviewNote[]): void {
  const audioContext = ensureAudio();
  if (!audioContext || !graph) return;

  stopPreview();
  const start = audioContext.currentTime + 0.03;
  for (const note of notes) {
    const voice = triggerChannel(audioContext, channel, graph.masterInput, {
      time: start + note.at,
      velocity: clamp(note.velocity ?? 0.8, 0, 1),
      pitch: note.pitch,
      duration: note.duration
    });
    if (voice) previewVoices.push(voice);
    oneShotEnds.push(start + note.at + note.duration + 0.3);
  }
}

export function stopPreview(): void {
  const now = context?.currentTime ?? 0;
  for (const voice of previewVoices) voice.kill(now);
  previewVoices = [];
}

/** How many times the sound has dropped out (the computer couldn't keep up) since the audio started. */
export function getDropouts(): number {
  const stats = (context as (AudioContext & { playbackStats?: { underrunEvents?: number } }) | null)?.playbackStats;
  return stats?.underrunEvents ?? 0;
}

/** How many notes are sounding right now: the song, held keys and previews. For the performance readout. */
export function getVoiceCount(): number {
  if (!context) return 0;
  const now = context.currentTime;
  oneShotEnds = oneShotEnds.filter((end) => end > now);
  return heldVoices.size + (sequencer?.activeVoices(now) ?? 0) + oneShotEnds.length;
}

/* ─────────────────────────────── metering ─────────────────────────────── */

const createFloatBuffer = (length: number) => new Float32Array(length);
const meterBuffers = new WeakMap<AnalyserNode, ReturnType<typeof createFloatBuffer>>();

function readLevel(analyser: AnalyserNode | null): number {
  if (!analyser) return 0;

  let buffer = meterBuffers.get(analyser);
  if (!buffer || buffer.length !== analyser.fftSize) {
    buffer = createFloatBuffer(analyser.fftSize);
    meterBuffers.set(analyser, buffer);
  }

  analyser.getFloatTimeDomainData(buffer);

  // Sample peak, like a DAW meter: it has to show when something hits 0 dBFS,
  // which an average never will. Allowed past 1 so the meter can show a clip.
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const magnitude = Math.abs(buffer[i]);
    if (magnitude > peak) peak = magnitude;
  }

  return Math.min(2, peak);
}

export function getMixerLevel(trackId: number): number {
  return readLevel(graph?.getMixerAnalyser(trackId) ?? null);
}

/** The master output's peak on each side (0..2, past 1 is clipping), for the top bar's meter. */
export function getMasterPeaks(): [number, number] {
  const sides = graph?.masterSides;
  if (!sides) return [0, 0];
  return [readLevel(sides[0]), readLevel(sides[1])];
}

const scopeBuffers = new WeakMap<AnalyserNode, Float32Array<ArrayBuffer>>();

/** The last few milliseconds of the master output, for the top bar's oscilloscope. Null before audio starts. */
export function getMasterWave(): Float32Array<ArrayBuffer> | null {
  const analyser = graph?.masterAnalyser;
  if (!analyser) return null;
  let buffer = scopeBuffers.get(analyser);
  if (!buffer) {
    buffer = new Float32Array(analyser.fftSize);
    scopeBuffers.set(analyser, buffer);
  }
  analyser.getFloatTimeDomainData(buffer);
  return buffer;
}

export function getMasterLevel(): number {
  return readLevel(graph?.masterAnalyser ?? null);
}

/** Snapshot of the engine's internals, for debugging in the dev console. */
export function getEngineDiagnostics(): {
  contextState: string | null;
  currentTime: number | null;
  sampleRate: number | null;
  isPlaying: boolean;
  currentStep: number;
  heldVoices: number;
} {
  return {
    contextState: context?.state ?? null,
    currentTime: context?.currentTime ?? null,
    sampleRate: context?.sampleRate ?? null,
    isPlaying: scheduler?.isPlaying ?? false,
    currentStep: scheduler?.getCurrentStep() ?? -1,
    heldVoices: heldVoices.size
  };
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).pulsegrid = {
    getEngineDiagnostics,
    getProject: () => getProjectData(useProjectStore.getState()),
    /** Feed raw MIDI bytes in as if a keyboard sent them, e.g. [0x90, 60, 100]. */
    sendMidi: (bytes: number[]) => {
      const event = parseMidiMessage(bytes, "dev");
      if (event) midiManager.dispatch(event);
    },
    getSession: () => useSessionStore.getState().toSessionData(),
    getTransport: () => {
      const { playheadStep, startStep, isPlaying, activeMidiNotes } = useTransportStore.getState();
      return { playheadStep, startStep, isPlaying, activeMidiNotes };
    }
  };
}
