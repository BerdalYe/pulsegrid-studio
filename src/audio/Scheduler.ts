export interface SchedulerStepEvent {
  stepIndex: number;
  time: number;
  stepDuration: number;
}

export interface SchedulerOptions {
  context: AudioContext;
  getStepDuration: () => number;
  getSwing: () => number;
  getLengthSteps: () => number;
  /** False plays once and stops at the end instead of wrapping. Defaults to looping. */
  getLoop?: () => boolean;
  /** Optional [start, end) the playhead wraps inside, in steps. */
  getLoopRegion?: () => { start: number; end: number } | null;
  onStep: (event: SchedulerStepEvent) => void;
  /** Fired once when a non-looping run has scheduled its final step. */
  onEnd?: (atTime: number) => void;
}

interface QueuedStep {
  stepIndex: number;
  time: number;
  duration: number;
}

/**
 * Lookahead scheduler. A timer wakes up every ~25 ms and schedules every step
 * that falls inside the lookahead window, so the audio thread always has work
 * queued well ahead of time.
 *
 * The UI playhead is *not* driven by timers here — the scheduler keeps a small
 * queue of upcoming steps and `getCurrentStep()` reads it against the audio
 * clock, so callers can poll it from requestAnimationFrame and stay in sync.
 */
export class Scheduler {
  private readonly opts: SchedulerOptions;

  private timerId: number | null = null;
  private clock: Worker | null = null;
  private playing = false;

  /** Bumped by every start/stop so an in-flight `start()` can tell it was superseded. */
  private runToken = 0;

  private stepIndex = 0;
  private nextStepTime = 0;
  private startStep = 0;

  /** Steps played since start, ignoring the loop wrap. */
  private playedSteps = 0;
  private ended = false;

  private queue: QueuedStep[] = [];

  private readonly lookaheadSeconds = 0.12;
  private readonly timerIntervalMs = 25;

  constructor(options: SchedulerOptions) {
    this.opts = options;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async start(fromStep = 0, delaySeconds = 0): Promise<void> {
    if (this.playing) return;

    // Claim the run before awaiting. A stop() during the resume() would
    // otherwise be a no-op — it sees `playing === false` — and this method
    // would go on to start the clock anyway, leaving audio running that the
    // transport thinks is stopped and that Play refuses to restart.
    const token = ++this.runToken;
    this.playing = true;

    if (this.opts.context.state !== "running") {
      await this.opts.context.resume();
    }

    if (token !== this.runToken || !this.playing) return;

    const length = Math.max(1, this.opts.getLengthSteps());

    this.startStep = Math.max(0, Math.floor(fromStep));
    this.stepIndex = this.startStep % length;
    // A count-in pushes the first step out by a bar; the clicks are scheduled
    // by the caller into the gap.
    this.nextStepTime = this.opts.context.currentTime + 0.06 + Math.max(0, delaySeconds);
    this.queue = [];
    this.playedSteps = 0;
    this.ended = false;

    this.startClock();
    this.schedule();
  }

  stop(): void {
    this.runToken += 1;
    this.ended = false;
    this.playedSteps = 0;
    this.stopClock();
    this.playing = false;
    this.queue = [];
  }

  /**
   * Prefer a worker-driven clock: hidden tabs throttle window timers to ~1 Hz,
   * which would starve the lookahead window and drop audio while the user is
   * looking at something else.
   */
  private startClock(): void {
    if (this.clock === null && typeof Worker !== "undefined") {
      try {
        this.clock = new Worker(new URL("./clockWorker.ts", import.meta.url), { type: "module" });
        this.clock.onmessage = () => this.schedule();
      } catch {
        this.clock = null;
      }
    }

    if (this.clock) {
      this.clock.postMessage({ type: "start", interval: this.timerIntervalMs });
      return;
    }

    // Never stack intervals: an overwritten id can never be cleared, and that
    // orphan would keep scheduling steps that no Stop can reach.
    if (this.timerId !== null) return;

    this.timerId = window.setInterval(() => this.schedule(), this.timerIntervalMs);
  }

  private stopClock(): void {
    this.clock?.postMessage({ type: "stop" });

    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /** Release the worker; call when the engine is torn down. */
  dispose(): void {
    this.stop();
    this.clock?.terminate();
    this.clock = null;
  }

  /** Step the playhead is on right now, or -1 when stopped. */
  getCurrentStep(): number {
    if (!this.playing) return -1;

    const now = this.opts.context.currentTime;
    let current = -1;

    // Drop steps that are comfortably in the past, keep the newest one that
    // has already sounded.
    while (this.queue.length > 1 && this.queue[1].time <= now) {
      this.queue.shift();
    }

    if (this.queue.length > 0 && this.queue[0].time <= now) {
      current = this.queue[0].stepIndex;
    }

    return current;
  }

  /**
   * Where the playhead is right now, in fractional steps — the step that has
   * most recently sounded plus how far through it we are. Recording from a
   * MIDI keyboard needs this; a whole-step answer would drag every note late.
   * Null when stopped or during a count-in.
   */
  getPosition(): number | null {
    const step = this.getCurrentStep();
    if (step < 0 || this.queue.length === 0) return null;

    const entry = this.queue[0];
    const into = (this.opts.context.currentTime - entry.time) / Math.max(1e-6, entry.duration);
    return step + Math.min(0.999, Math.max(0, into));
  }

  private schedule(): void {
    // A worker tick already sitting in the message queue when stop() ran would
    // otherwise schedule a whole lookahead window of notes *after* the voices
    // were killed — one stray hit every time the user presses Stop.
    if (!this.playing) return;

    // A non-looping run that has reached its end must not queue anything more.
    // Returning from the loop below only ends *this* tick — the next one would
    // schedule another step and carry on past the end of the song.
    if (this.ended) return;

    const context = this.opts.context;
    const length = Math.max(1, Math.floor(this.opts.getLengthSteps()));
    const stepDuration = this.opts.getStepDuration();

    // Guard against a nonsensical tempo turning this into an infinite loop.
    if (!Number.isFinite(stepDuration) || stepDuration <= 0) return;

    const looping = this.opts.getLoop?.() ?? true;

    // A loop region overrides the song length: wrap inside it so eight bars in
    // the middle of an arrangement can be auditioned on their own.
    const region = this.opts.getLoopRegion?.() ?? null;
    const regionStart = region && region.start < length ? region.start : 0;
    const regionEnd = region ? Math.min(region.end, length) : length;
    const usingRegion = region !== null && regionEnd > regionStart;
    const horizon = context.currentTime + this.lookaheadSeconds;
    let guard = 0;

    while (this.nextStepTime < horizon && guard < 512) {
      guard += 1;

      const stepIndex = usingRegion
        ? this.stepIndex < regionStart || this.stepIndex >= regionEnd
          ? regionStart
          : this.stepIndex
        : this.stepIndex % length;
      const swing = this.opts.getSwing();
      const time =
        swing > 0 && stepIndex % 2 === 1
          ? this.nextStepTime + stepDuration * Math.min(1, swing) * 0.5
          : this.nextStepTime;

      // Advance before dispatching. If `onStep` throws, the transport must
      // still move on — leaving the cursor put would retrigger the same failing
      // step on every tick forever, freezing the playhead.
      this.queue.push({ stepIndex, time, duration: stepDuration });

      // Keep the queue bounded; it only ever needs the lookahead window.
      if (this.queue.length > 64) this.queue.splice(0, this.queue.length - 64);

      this.nextStepTime += stepDuration;
      this.stepIndex = usingRegion
        ? stepIndex + 1 >= regionEnd
          ? regionStart
          : stepIndex + 1
        : (stepIndex + 1) % length;
      this.playedSteps += 1;

      try {
        this.opts.onStep({ stepIndex, time, stepDuration });
      } catch (error) {
        console.error("PulseGrid: step scheduling failed", error);
      }

      // Play-once: hand the end time to the caller and stop queueing. The audio
      // already scheduled still plays out.
      if (!looping && this.startStep + this.playedSteps >= length) {
        if (!this.ended) {
          this.ended = true;
          this.opts.onEnd?.(time + stepDuration);
        }
        return;
      }
    }
  }
}
