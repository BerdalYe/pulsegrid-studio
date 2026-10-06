import type { Channel, EffectInstance, ProjectData } from "../types";
import { clamp } from "../lib/utils";
import { buildEffectChain, type EffectChain } from "./effects";
import { MASTER_OUTPUT, audibleInserts } from "./routing";

export type PanNode = StereoPannerNode | GainNode;

export function createPanNode(context: BaseAudioContext): PanNode {
  if (typeof context.createStereoPanner === "function") return context.createStereoPanner();
  return context.createGain();
}

export function setPan(node: PanNode, value: number): void {
  if ("pan" in node) node.pan.value = clamp(value, -1, 1);
}

export function panParam(node: PanNode): AudioParam | null {
  return "pan" in node ? node.pan : null;
}

/**
 * Safety ceiling for the master bus.
 *
 * The compressor in front of this is a *musical* limiter — with a 6 dB knee and
 * a 2 ms attack, transients still get past 0 dBFS, and those samples hard-clip
 * on the way into a 16-bit WAV. A shaper can't emit anything outside the range
 * of its own curve, so this guarantees the ceiling. It is exactly transparent
 * below the knee and saturates gently above it.
 */
const CEILING = 0.985;
const CEILING_KNEE = 0.86;

function createCeilingCurve() {
  const length = 2048;
  const curve = new Float32Array(length);
  const range = CEILING - CEILING_KNEE;

  for (let i = 0; i < length; i++) {
    const x = (i / (length - 1)) * 2 - 1;
    const magnitude = Math.abs(x);

    const shaped =
      magnitude <= CEILING_KNEE
        ? magnitude
        : CEILING_KNEE + range * Math.tanh((magnitude - CEILING_KNEE) / range);

    curve[i] = x < 0 ? -shaped : shaped;
  }

  return curve;
}

interface ChannelStrip {
  input: GainNode;
  pan: PanNode;
  autoPan: PanNode;
  fader: GainNode;
  autoGain: GainNode;
  routedTo: number | null;
}

interface MixerStrip {
  input: GainNode;
  chain: EffectChain;
  pan: PanNode;
  autoPan: PanNode;
  fader: GainNode;
  autoGain: GainNode;
  /** Main output tap, so re-routing never disturbs the sends or the meter. */
  out: GainNode;
  routedTo: number | null;
  /** Post-fader send gains, keyed by the insert they feed. */
  sends: Map<number, GainNode>;
  analyser: AnalyserNode | null;
}

/**
 * The whole signal path, built once and then updated in place.
 *
 *   channel input → pan → autoPan → fader → autoGain ─┐
 *                                                     ├→ insert input → FX → pan → autoPan → fader → autoGain ─┬→ out ─┐
 *                                                     │                           (sends → other inserts) ┘       │
 *   audio clips ─────────────────────────────────────────────────────────────────────────────────────────────┤
 *                                                                                                             ↓
 *                                                              master gain → master autoGain → master FX → limiter → out
 *
 * The `auto*` nodes exist purely so automation and the user's own faders never
 * write to the same AudioParam and fight over it.
 */
export class RenderGraph {
  readonly context: BaseAudioContext;
  readonly masterInput: GainNode;
  readonly masterGain: GainNode;
  readonly masterAutoGain: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly ceiling: WaveShaperNode;
  /** Metronome clicks, kept out of the master FX chain. */
  readonly metronomeInput: GainNode;
  readonly masterAnalyser: AnalyserNode | null;

  private masterChain: EffectChain;
  private readonly channels = new Map<string, ChannelStrip>();
  private readonly mixerStrips = new Map<number, MixerStrip>();
  private readonly withAnalysers: boolean;

  constructor(context: BaseAudioContext, project: ProjectData, options: { analysers?: boolean } = {}) {
    this.context = context;
    this.withAnalysers = options.analysers ?? false;

    this.masterInput = context.createGain();
    this.masterGain = context.createGain();
    this.masterAutoGain = context.createGain();

    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;

    this.ceiling = context.createWaveShaper();
    this.ceiling.curve = createCeilingCurve();
    // Deliberately not oversampled: the resampling filter overshoots by a few
    // tenths of a dB, which is exactly the guarantee this node exists to make.
    // The curve is near-transparent anyway, so there is little to alias.
    this.ceiling.oversample = "none";

    // Straight into the limiter: a click should not be reverbed by whatever
    // the user has on the master bus, but should still respect the ceiling.
    this.metronomeInput = context.createGain();
    this.metronomeInput.gain.value = 0.9;

    this.masterChain = buildEffectChain(context, project.mixer.masterEffects);

    this.masterInput.connect(this.masterGain);
    this.masterGain.connect(this.masterAutoGain);
    this.masterAutoGain.connect(this.masterChain.input);
    this.masterChain.output.connect(this.limiter);
    this.metronomeInput.connect(this.limiter);
    this.limiter.connect(this.ceiling);
    this.ceiling.connect(context.destination);

    if (this.withAnalysers) {
      this.masterAnalyser = context.createAnalyser();
      this.masterAnalyser.fftSize = 1024;
      this.ceiling.connect(this.masterAnalyser);
    } else {
      this.masterAnalyser = null;
    }

    this.sync(project, context.currentTime, false);
  }

  /* ───────────────────────────── lookups ───────────────────────────── */

  getChannelInput(channelId: string): GainNode | undefined {
    return this.channels.get(channelId)?.input;
  }

  getMixerInput(trackId: number): GainNode | undefined {
    return this.mixerStrips.get(trackId)?.input;
  }

  getChannelAutomation(channelId: string): { gain: AudioParam; pan: AudioParam | null } | null {
    const strip = this.channels.get(channelId);
    if (!strip) return null;
    return { gain: strip.autoGain.gain, pan: panParam(strip.autoPan) };
  }

  getMixerAutomation(trackId: number): { gain: AudioParam; pan: AudioParam | null } | null {
    const strip = this.mixerStrips.get(trackId);
    if (!strip) return null;
    return { gain: strip.autoGain.gain, pan: panParam(strip.autoPan) };
  }

  getMasterAutomation(): { gain: AudioParam; pan: AudioParam | null } {
    return { gain: this.masterAutoGain.gain, pan: null };
  }

  getMixerAnalyser(trackId: number): AnalyserNode | null {
    return this.mixerStrips.get(trackId)?.analyser ?? null;
  }

  /** Return every automation node to unity — called when playback stops. */
  resetAutomation(): void {
    const now = this.context.currentTime;

    const reset = (gain: AudioParam, pan: AudioParam | null) => {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(1, now);
      if (pan) {
        pan.cancelScheduledValues(now);
        pan.setValueAtTime(0, now);
      }
    };

    for (const strip of this.channels.values()) reset(strip.autoGain.gain, panParam(strip.autoPan));
    for (const strip of this.mixerStrips.values()) reset(strip.autoGain.gain, panParam(strip.autoPan));
    reset(this.masterAutoGain.gain, null);
  }

  /* ───────────────────────────── syncing ───────────────────────────── */

  sync(project: ProjectData, time: number, smooth: boolean): void {
    this.syncMixer(project, time, smooth);
    this.syncChannels(project, time, smooth);

    setValue(this.masterGain.gain, project.masterVolume, time, smooth);
    this.masterChain = this.syncChain(this.masterChain, project.mixer.masterEffects, time, smooth, (chain) => {
      this.masterAutoGain.disconnect();
      this.masterAutoGain.connect(chain.input);
      chain.output.connect(this.limiter);
    });
  }

  private syncChain(
    current: EffectChain,
    effects: EffectInstance[],
    time: number,
    smooth: boolean,
    rewire: (chain: EffectChain) => void
  ): EffectChain {
    if (current.matches(effects)) {
      current.update(effects, time, smooth);
      return current;
    }

    // Structure changed (an effect was added, removed, reordered or bypassed),
    // so this one genuinely has to be rebuilt.
    const next = buildEffectChain(this.context, effects);
    rewire(next);
    current.dispose();
    return next;
  }

  private disposeMixerStrip(strip: MixerStrip): void {
    strip.chain.dispose();
    strip.input.disconnect();
    strip.pan.disconnect();
    strip.autoPan.disconnect();
    strip.fader.disconnect();
    strip.autoGain.disconnect();
    strip.out.disconnect();
    for (const send of strip.sends.values()) send.disconnect();
    strip.analyser?.disconnect();
  }

  private syncMixer(project: ProjectData, time: number, smooth: boolean): void {
    const wanted = new Set(project.mixer.tracks.map((track) => track.id));

    for (const [id, strip] of this.mixerStrips) {
      if (wanted.has(id)) continue;
      this.disposeMixerStrip(strip);
      this.mixerStrips.delete(id);
    }

    // Every strip has to exist before any routing is wired, since an insert
    // can send to one further down the list.
    for (const track of project.mixer.tracks) {
      if (this.mixerStrips.has(track.id)) continue;

      const input = this.context.createGain();
      const chain = buildEffectChain(this.context, track.effects);
      const pan = createPanNode(this.context);
      const autoPan = createPanNode(this.context);
      const fader = this.context.createGain();
      const autoGain = this.context.createGain();
      const out = this.context.createGain();

      input.connect(chain.input);
      chain.output.connect(pan);
      pan.connect(autoPan);
      autoPan.connect(fader);
      fader.connect(autoGain);
      autoGain.connect(out);

      let analyser: AnalyserNode | null = null;
      if (this.withAnalysers) {
        analyser = this.context.createAnalyser();
        analyser.fftSize = 512;
        autoGain.connect(analyser);
      }

      this.mixerStrips.set(track.id, {
        input,
        chain,
        pan,
        autoPan,
        fader,
        autoGain,
        out,
        routedTo: null,
        sends: new Map(),
        analyser
      });
    }

    const audible = audibleInserts(project.mixer.tracks);

    for (const track of project.mixer.tracks) {
      const strip = this.mixerStrips.get(track.id);
      if (!strip) continue;

      setValue(strip.fader.gain, audible.has(track.id) ? track.volume : 0, time, smooth);

      // Main output: master, or another insert acting as a bus.
      const output = track.output ?? MASTER_OUTPUT;
      if (strip.routedTo !== output) {
        const destination =
          output === MASTER_OUTPUT ? this.masterInput : this.getMixerInput(output) ?? this.masterInput;
        strip.out.disconnect();
        strip.out.connect(destination);
        strip.routedTo = output;
      }

      // Sends: add, level and remove, touching only the ones that changed.
      const wantedSends = new Map((track.sends ?? []).map((send) => [send.target, send.level]));

      for (const [target, node] of strip.sends) {
        if (wantedSends.has(target) && this.mixerStrips.has(target)) continue;
        node.disconnect();
        strip.sends.delete(target);
      }

      for (const [target, level] of wantedSends) {
        const destination = this.getMixerInput(target);
        if (!destination) continue;

        let node = strip.sends.get(target);
        if (!node) {
          node = this.context.createGain();
          node.gain.value = 0;
          strip.autoGain.connect(node);
          node.connect(destination);
          strip.sends.set(target, node);
        }
        setValue(node.gain, level, time, smooth);
      }
      setPan(strip.pan, track.pan);

      const currentStrip = strip;
      currentStrip.chain = this.syncChain(
        currentStrip.chain,
        track.effects,
        time,
        smooth,
        (chain) => {
          currentStrip.input.disconnect();
          currentStrip.input.connect(chain.input);
          chain.output.connect(currentStrip.pan);
        }
      );
    }
  }

  private syncChannels(project: ProjectData, time: number, smooth: boolean): void {
    const wanted = new Set(project.channels.map((channel) => channel.id));

    for (const [id, strip] of this.channels) {
      if (wanted.has(id)) continue;
      strip.input.disconnect();
      strip.pan.disconnect();
      strip.autoPan.disconnect();
      strip.fader.disconnect();
      strip.autoGain.disconnect();
      this.channels.delete(id);
    }

    const anySolo = project.channels.some((channel) => channel.solo);

    for (const channel of project.channels) {
      let strip = this.channels.get(channel.id);

      if (!strip) {
        const input = this.context.createGain();
        const pan = createPanNode(this.context);
        const autoPan = createPanNode(this.context);
        const fader = this.context.createGain();
        const autoGain = this.context.createGain();

        input.connect(pan);
        pan.connect(autoPan);
        autoPan.connect(fader);
        fader.connect(autoGain);

        strip = { input, pan, autoPan, fader, autoGain, routedTo: null };
        this.channels.set(channel.id, strip);
      }

      const audible = !channel.mute && (!anySolo || channel.solo);
      setValue(strip.fader.gain, audible ? channel.volume : 0, time, smooth);
      setPan(strip.pan, channel.pan);

      // Only touch the wiring when the routing actually changed — reconnecting
      // a live node every sync is what produced clicks.
      if (strip.routedTo !== channel.mixerTrackId) {
        const destination = this.getMixerInput(channel.mixerTrackId) ?? this.masterInput;
        strip.autoGain.disconnect();
        strip.autoGain.connect(destination);
        strip.routedTo = channel.mixerTrackId;
      }
    }
  }

  dispose(): void {
    for (const strip of this.channels.values()) {
      strip.input.disconnect();
      strip.pan.disconnect();
      strip.autoPan.disconnect();
      strip.fader.disconnect();
      strip.autoGain.disconnect();
    }
    this.channels.clear();

    for (const strip of this.mixerStrips.values()) this.disposeMixerStrip(strip);
    this.mixerStrips.clear();

    this.masterChain.dispose();
    this.masterInput.disconnect();
    this.masterGain.disconnect();
    this.masterAutoGain.disconnect();
    this.limiter.disconnect();
    this.ceiling.disconnect();
    this.metronomeInput.disconnect();
    this.masterAnalyser?.disconnect();
  }
}

function setValue(param: AudioParam, value: number, time: number, smooth: boolean): void {
  if (!Number.isFinite(value)) return;
  if (smooth) param.setTargetAtTime(value, time, 0.012);
  else param.value = value;
}

/** Convenience for building an export graph from plain project data. */
export function channelOf(project: ProjectData, channelId: string): Channel | undefined {
  return project.channels.find((channel) => channel.id === channelId);
}
