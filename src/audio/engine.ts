import { Scheduler } from "./Scheduler";
import { midiManager, parseMidiMessage } from "./midi";
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

  context = new AudioContextClass({ latencyHint: "interactive" });

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
          stepIndex % STEPS_PER_BAR === 0
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
      scheduleMetronomeClick(graph.context, graph.metronomeInput, from + i * beat, i === 0);
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
    getSession: () => useSessionStore.getState().toSessionData()
  };
}
