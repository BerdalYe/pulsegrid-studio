import type {
  AutomationClip,
  Pattern,
  PlaybackMode,
  ProjectData
} from "../types";

import { clamp, isPitchedChannel, isStepActive } from "../lib/utils";
import { getSample } from "./sampleRegistry";
import { triggerChannel, type Voice } from "./voices";
import type { RenderGraph } from "./graph";

export interface SequencerContext {
  mode: PlaybackMode;
  selectedPatternId: string;
}

/**
 * Turns project data into scheduled audio events. Everything it touches comes
 * from the `RenderGraph` it's handed, so the exact same code path renders live
 * playback and offline exports.
 */
export class Sequencer {
  private readonly graph: RenderGraph;
  private voices: Array<{ voice: Voice; endsAfter: number }> = [];
  private startedAudioClips = new Set<string>();
  private firstStepDone = false;

  /**
   * Local step last scheduled for each automation clip. It tells us both when a
   * clip has just been entered (so the ramp needs an anchor) and when one has
   * been left (so the parameter has to be handed back to the user's fader) —
   * including on a loop wrap, where the clip's own end step is never reached.
   */
  private automationCursor = new Map<string, number>();

  constructor(graph: RenderGraph) {
    this.graph = graph;
  }

  reset(): void {
    this.startedAudioClips.clear();
    this.automationCursor.clear();
    this.firstStepDone = false;
  }

  /** Fade out everything currently sounding. */
  allNotesOff(time: number): void {
    for (const entry of this.voices) entry.voice.kill(time);
    this.voices = [];
  }

  private track(voice: Voice | null, endsAfter: number): void {
    if (!voice) return;

    this.voices.push({ voice, endsAfter });

    // Keep the list from growing without bound during long sessions.
    if (this.voices.length > 512) {
      const now = this.graph.context.currentTime;
      this.voices = this.voices.filter((entry) => entry.endsAfter > now);
    }
  }

  scheduleStep(
    project: ProjectData,
    session: SequencerContext,
    stepIndex: number,
    time: number,
    stepDuration: number
  ): void {
    if (session.mode === "pattern") {
      const pattern = project.patterns[session.selectedPatternId];
      if (pattern && stepIndex < pattern.length) {
        this.schedulePattern(project, pattern, stepIndex, time, stepDuration);
      }
      this.firstStepDone = true;
      return;
    }

    this.scheduleSong(project, stepIndex, time, stepDuration);
    this.firstStepDone = true;
  }

  /* ─────────────────────────────── patterns ─────────────────────────────── */

  private schedulePattern(
    project: ProjectData,
    pattern: Pattern,
    step: number,
    time: number,
    stepDuration: number
  ): void {
    const anySolo = project.channels.some((channel) => channel.solo);

    for (const channel of project.channels) {
      if (channel.mute) continue;
      if (anySolo && !channel.solo) continue;

      const patternChannel = pattern.channels[channel.id];
      if (!patternChannel) continue;

      const destination = this.graph.getChannelInput(channel.id);
      if (!destination) continue;

      // Every channel plays both its notes and its steps. Gating on the channel
      // type meant a kick could never be placed off the grid or pitched from
      // the piano roll, and a melodic part could never be dotted in on the step
      // grid — the one structural split FL does not have.
      for (const note of patternChannel.notes) {
        if (note.start !== step) continue;

        this.track(
          triggerChannel(this.graph.context, channel, destination, {
            time,
            velocity: clamp(note.velocity / 127, 0, 1),
            pitch: note.pitch,
            duration: note.length * stepDuration
          }),
          time + note.length * stepDuration + 2
        );
      }

      const cell = patternChannel.steps[step];
      if (!isStepActive(cell)) continue;

      this.track(
        triggerChannel(this.graph.context, channel, destination, {
          time,
          velocity: cell as number,
          pitch: 60,
          duration: stepDuration
        }),
        time + stepDuration + 2
      );
    }
  }

  /* ──────────────────────────────── song ──────────────────────────────── */

  private scheduleSong(
    project: ProjectData,
    stepIndex: number,
    time: number,
    stepDuration: number
  ): void {
    const anyTrackSolo = project.playlist.tracks.some((track) => track.solo);

    for (const clip of project.playlist.clips) {
      const track = project.playlist.tracks[clip.trackIndex];
      if (!track || track.mute) continue;
      if (anyTrackSolo && !track.solo) continue;

      if (clip.type === "pattern") {
        const pattern = project.patterns[clip.patternId];
        if (!pattern) continue;

        const end = clip.startStep + clip.lengthSteps;
        if (stepIndex < clip.startStep || stepIndex >= end) continue;

        const localStep = (stepIndex - clip.startStep) % pattern.length;
        this.schedulePattern(project, pattern, localStep, time, stepDuration);
        continue;
      }

      if (clip.type === "audio") {
        this.scheduleAudioClip(clip, stepIndex, time, stepDuration);
      }
    }

    this.scheduleAutomation(project, stepIndex, time, stepDuration);
  }

  private scheduleAudioClip(
    clip: Extract<ProjectData["playlist"]["clips"][number], { type: "audio" }>,
    stepIndex: number,
    time: number,
    stepDuration: number
  ): void {
    const end = clip.startStep + clip.durationSteps;
    if (stepIndex < clip.startStep || stepIndex >= end) return;

    const atStart = stepIndex === clip.startStep;
    // If playback started in the middle of a clip, come in part-way through it
    // instead of skipping the clip entirely.
    const joiningLate = !this.firstStepDone && !this.startedAudioClips.has(clip.id);

    if (!atStart && !joiningLate) return;
    if (this.startedAudioClips.has(clip.id) && atStart === false) return;

    const sample = getSample(clip.sampleId);
    if (!sample) return;

    const stepsIn = stepIndex - clip.startStep;
    const offsetSeconds = (clip.offsetSteps + stepsIn) * stepDuration;
    const remainingSeconds = (clip.durationSteps - stepsIn) * stepDuration;

    if (offsetSeconds >= sample.duration) return;

    const source = this.graph.context.createBufferSource();
    source.buffer = sample.buffer;
    if (source.detune) source.detune.value = clamp(clip.pitch * 100, -4800, 4800);

    const gain = this.graph.context.createGain();
    gain.gain.value = clamp(clip.volume, 0, 1.5);

    source.connect(gain);
    gain.connect(this.graph.masterInput);

    const duration = Math.min(remainingSeconds, sample.duration - offsetSeconds);
    source.start(time, offsetSeconds, duration);

    source.onended = () => {
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        /* already gone */
      }
    };

    this.startedAudioClips.add(clip.id);

    this.track(
      {
        release: () => undefined,
        kill: (at) => {
          try {
            gain.gain.cancelScheduledValues(at);
            gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), at);
            gain.gain.linearRampToValueAtTime(0.0001, at + 0.02);
            source.stop(at + 0.03);
          } catch {
            /* already stopped */
          }
        }
      },
      time + duration + 0.5
    );
  }

  /* ───────────────────────────── automation ───────────────────────────── */

  private scheduleAutomation(
    project: ProjectData,
    stepIndex: number,
    time: number,
    stepDuration: number
  ): void {
    const stillActive = new Set<string>();

    for (const clip of project.playlist.clips) {
      if (clip.type !== "automation") continue;

      const target = this.resolveAutomationTarget(clip);
      if (!target) continue;

      const localStep = stepIndex - clip.startStep;
      if (localStep < 0 || localStep > clip.durationSteps) continue;

      stillActive.add(clip.id);

      const previous = this.automationCursor.get(clip.id);
      this.automationCursor.set(clip.id, localStep);

      const from = evaluateAutomation(clip, localStep);
      const to = evaluateAutomation(clip, Math.min(localStep + 1, clip.durationSteps));

      // Only anchor when the run isn't continuous. Re-anchoring every step
      // cancels the previous step's in-flight ramp — its end event lands on
      // exactly this time — which turns a smooth fade into a staircase.
      const continuous = previous !== undefined && localStep === previous + 1;

      if (clip.targetParam === "volume") {
        rampBetween(target.gain, from, to, time, stepDuration, continuous);
      } else if (target.pan) {
        rampBetween(target.pan, from * 2 - 1, to * 2 - 1, time, stepDuration, continuous);
      }
    }

    // Anything that was automating a moment ago and isn't any more gives the
    // parameter back. Watching for the clip being *left* rather than for one
    // specific step also covers the loop wrap and seeking.
    for (const clipId of [...this.automationCursor.keys()]) {
      if (stillActive.has(clipId)) continue;
      this.automationCursor.delete(clipId);

      const clip = project.playlist.clips.find(
        (entry): entry is AutomationClip => entry.id === clipId && entry.type === "automation"
      );
      if (!clip) continue;

      const target = this.resolveAutomationTarget(clip);
      if (!target) continue;

      if (clip.targetParam === "volume") rampTo(target.gain, 1, time, stepDuration);
      else if (target.pan) rampTo(target.pan, 0, time, stepDuration);
    }
  }

  private resolveAutomationTarget(
    clip: AutomationClip
  ): { gain: AudioParam; pan: AudioParam | null } | null {
    if (clip.targetType === "master") return this.graph.getMasterAutomation();
    if (clip.targetType === "mixer") {
      return this.graph.getMixerAutomation(Number(clip.targetId));
    }
    return this.graph.getChannelAutomation(clip.targetId);
  }
}

/** Linear interpolation between the clip's points at a given local step. */
export function evaluateAutomation(clip: AutomationClip, localStep: number): number {
  const points = clip.points;
  if (points.length === 0) return 1;
  if (localStep <= points[0].step) return points[0].value;

  const last = points[points.length - 1];
  if (localStep >= last.step) return last.value;

  for (let i = 1; i < points.length; i++) {
    const next = points[i];
    if (localStep > next.step) continue;

    const previous = points[i - 1];
    const span = next.step - previous.step;
    if (span <= 0) return next.value;

    const ratio = (localStep - previous.step) / span;
    return previous.value + (next.value - previous.value) * ratio;
  }

  return last.value;
}

function rampBetween(
  param: AudioParam,
  from: number,
  to: number,
  time: number,
  stepDuration: number,
  /** True when the previous step already ramped this param to `from` at `time`. */
  continuous: boolean
): void {
  try {
    if (!continuous) {
      param.cancelScheduledValues(time);
      param.setValueAtTime(from, time);
    }
    param.linearRampToValueAtTime(to, time + stepDuration);
  } catch {
    /* param may be detached */
  }
}

function rampTo(param: AudioParam, value: number, time: number, stepDuration: number): void {
  try {
    param.cancelScheduledValues(time);
    param.setValueAtTime(param.value, time);
    param.linearRampToValueAtTime(value, time + stepDuration);
  } catch {
    /* param may be detached */
  }
}
