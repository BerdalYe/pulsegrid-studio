import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from "react";
import { create } from "zustand";

import { previewChannel } from "../audio/engine";
import {
  DEFAULT_MOD,
  MAX_ROUTES,
  MOD_DESTS,
  MOD_DEST_NAMES,
  MOD_SOURCES,
  MOD_SOURCE_NAMES,
  amountFor,
  routeRange,
  type ModDest,
  type ModRoute,
  type ModSource,
  type SynthMod,
  type WavetableOsc
} from "../audio/modulation";
import {
  DEFAULT_WT_A,
  DEFAULT_WT_B,
  FILTER_TYPES,
  WAVEFORMS,
  patchFromPreset,
  type SynthPatch
} from "../audio/synthPatch";
import { WAVETABLES, sampleWavetable } from "../audio/wavetables";
import { useGesture } from "../hooks/useStudio";
import { defaultSynthPreset, getSynthPreset, synthPresets } from "../presets/presets";
import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { Knob } from "./controls";

/** Which synth channel's sound is being edited, if any. */
interface SynthEditorState {
  channelId: string | null;
  open: (channelId: string) => void;
  close: () => void;
}

export const useSynthEditor = create<SynthEditorState>()((set) => ({
  channelId: null,
  open: (channelId) => set({ channelId }),
  close: () => set({ channelId: null })
}));

/* ─────────────────────────────── helpers ─────────────────────────────── */

type Curve = "linear" | "log" | "slow";

/**
 * Knobs turn a 0..1 position; this maps it to the real value. "log" suits
 * frequencies, "slow" gives times fine control near zero.
 */
function toPosition(value: number, min: number, max: number, curve: Curve): number {
  const clamped = Math.min(max, Math.max(min, value));
  if (curve === "log") return Math.log(clamped / min) / Math.log(max / min);
  if (curve === "slow") return Math.sqrt((clamped - min) / (max - min));
  return (clamped - min) / (max - min);
}

function fromPosition(position: number, min: number, max: number, curve: Curve): number {
  const p = Math.min(1, Math.max(0, position));
  if (curve === "log") return min * Math.pow(max / min, p);
  if (curve === "slow") return min + (max - min) * p * p;
  return min + (max - min) * p;
}

const seconds = (value: number) => (value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`);
const hertz = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`);
const percent = (value: number) => `${Math.round(value * 100)}%`;
const cents = (value: number) => `${Math.round(value)} ct`;
const signedPercent = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 100)}%`;

/** What a modulation amount of 1 does to the knob's own sweep, so its ring can be drawn. */
function ringFraction(dest: ModDest, amount: number): number {
  switch (dest) {
    case "cutoff":
      return amount * (4 / Math.log2(18000 / 40));
    case "resonance":
      return amount * 0.5;
    default:
      return amount;
  }
}

/** A starting amount for a new route, in the destination's own terms. */
const DEFAULT_AMOUNT: Record<ModDest, number> = {
  cutoff: 0.5,
  resonance: 0.3,
  pitch: 0.05,
  posA: 0.4,
  posB: 0.4,
  levelA: 0.5,
  levelB: 0.5,
  volume: 0.5
};

/** Where a classic waveform sits along the "Basic Shapes" table. */
const WAVE_POSITION: Record<string, number> = { sine: 0, triangle: 0.33, sawtooth: 0.67, square: 1 };

/** A wavetable version of the classic oscillators, so switching modes keeps the sound close. */
function wavetableFromClassic(patch: SynthPatch): { a: WavetableOsc; b: WavetableOsc } {
  const voices = patch.detuneSpread > 0 ? (patch.unison ?? 3) : 1;
  const a: WavetableOsc = {
    ...DEFAULT_WT_A,
    pos: WAVE_POSITION[patch.oscType] ?? 0.67,
    unison: voices,
    detune: patch.detuneSpread > 0 ? patch.detuneSpread : DEFAULT_WT_A.detune,
    width: patch.stereoSpread ?? DEFAULT_WT_A.width
  };
  const second = patch.osc2;
  const b: WavetableOsc = second
    ? {
        ...DEFAULT_WT_B,
        pos: WAVE_POSITION[second.type] ?? 0.33,
        level: second.gain,
        semitones: second.semitones,
        fine: second.detune
      }
    : DEFAULT_WT_B;
  return { a, b };
}

/* ─────────────────────── modulation, shared by the knobs ─────────────────────── */

interface ModApi {
  routes: readonly ModRoute[];
  /** The source picked up by clicking its chip, waiting to be put on a knob. */
  armed: ModSource | null;
  /** A source is being dragged. */
  dragging: boolean;
  arm: (source: ModSource | null) => void;
  setDragging: (dragging: boolean) => void;
  attach: (source: ModSource, dest: ModDest) => void;
  /** Which destinations make sense for this sound. */
  dests: readonly ModDest[];
}

const ModContext = createContext<ModApi | null>(null);

const DRAG_TYPE = "application/x-pulsegrid-mod";

/** A modulation source you can drag onto a knob, or click and then click a knob. */
function SourceChip({ source }: { source: ModSource }) {
  const mod = useContext(ModContext);
  if (!mod) return null;

  const armed = mod.armed === source;
  return (
    <button
      type="button"
      className={`mod-chip mod-${source}${armed ? " armed" : ""}`}
      draggable
      title={`${MOD_SOURCE_NAMES[source]}: drag it onto a knob, or click it and then click a knob`}
      onDragStart={(event: DragEvent) => {
        event.dataTransfer.setData(DRAG_TYPE, source);
        event.dataTransfer.setData("text/plain", source);
        event.dataTransfer.effectAllowed = "copy";
        mod.setDragging(true);
      }}
      onDragEnd={() => mod.setDragging(false)}
      onClick={() => mod.arm(armed ? null : source)}
    >
      {MOD_SOURCE_NAMES[source]}
    </button>
  );
}

/** The arc around a knob showing how far modulation pushes it. */
function ModRing({ size, position, dest }: { size: number; position: number; dest: ModDest }) {
  const mod = useContext(ModContext);
  if (!mod) return null;

  const routes = mod.routes.filter((route) => route.dest === dest);
  if (routes.length === 0) return null;

  const total = amountFor(mod.routes, dest);
  const range = routeRange(mod.routes, dest);

  const centre = size / 2 + 4;
  const radius = size / 2 + 0.5;
  const start = -135 + position * 270;

  const point = (angle: number) => {
    const radians = (angle * Math.PI) / 180;
    return [centre + radius * Math.sin(radians), centre - radius * Math.cos(radians)] as const;
  };

  const lowAngle = Math.max(-135, Math.min(135, start + ringFraction(dest, range.min) * 270));
  const highAngle = Math.max(-135, Math.min(135, start + ringFraction(dest, range.max) * 270));
  const [x0, y0] = point(Math.min(lowAngle, highAngle));
  const [x1, y1] = point(Math.max(lowAngle, highAngle));
  const sweep = Math.abs(highAngle - lowAngle);

  return (
    <svg className="mod-ring" width={size + 8} height={size + 8} viewBox={`0 0 ${size + 8} ${size + 8}`} aria-hidden="true">
      {sweep > 0.5 ? (
        <path
          d={`M ${x0} ${y0} A ${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 1 ${x1} ${y1}`}
          className={`mod-arc ${total < 0 ? "negative" : ""}`}
        />
      ) : null}
      <circle cx={centre} cy={centre - radius - 2.2} r="2" className="mod-dot" />
    </svg>
  );
}

interface ParamProps {
  label: string;
  value: number;
  min: number;
  max: number;
  curve?: Curve;
  format: (value: number) => string;
  onChange: (value: number) => void;
  /** Where a double-click puts it back. */
  reset: number;
  /** Round to this step, for whole-number settings. */
  step?: number;
  gesture: { begin: () => void; end: () => void };
  /** What can be modulated here: drop a source on the knob to link it. */
  dest?: ModDest;
}

function Param({ label, value, min, max, curve = "linear", format, onChange, reset, step, gesture, dest }: ParamProps) {
  const mod = useContext(ModContext);
  const snap = (raw: number) => (step ? min + Math.round((raw - min) / step) * step : raw);
  const position = toPosition(value, min, max, curve);
  const canTarget = Boolean(dest && mod && mod.dests.includes(dest));
  const waiting = canTarget && mod && (mod.armed !== null || mod.dragging);
  const size = 38;

  const knob = (
    <Knob
      label={label}
      value={position}
      min={0}
      max={1}
      step={0.002}
      size={size}
      display={format(value)}
      defaultValue={toPosition(reset, min, max, curve)}
      onChange={(next) => onChange(snap(fromPosition(next, min, max, curve)))}
      onCommitStart={gesture.begin}
      onCommitEnd={gesture.end}
    />
  );

  if (!canTarget || !dest || !mod) return knob;

  return (
    <div className="mod-target" data-mod-dest={dest}>
      {knob}
      <ModRing size={size} position={position} dest={dest} />
      {waiting ? (
        <div
          className="mod-drop"
          role="button"
          aria-label={`Put the modulation on ${label}`}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(DRAG_TYPE)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            const source = event.dataTransfer.getData(DRAG_TYPE) as ModSource;
            if ((MOD_SOURCES as readonly string[]).includes(source)) mod.attach(source, dest);
            mod.setDragging(false);
          }}
          onClick={() => {
            if (mod.armed) mod.attach(mod.armed, dest);
          }}
        />
      ) : null}
    </div>
  );
}

function Section({ title, children, className = "", aside }: { title: string; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={`synth-section ${className}`}>
      <h4>
        <span>{title}</span>
        {aside}
      </h4>
      {children}
    </section>
  );
}

const WAVE_LABELS: Record<string, string> = { sine: "Sine", triangle: "Tri", sawtooth: "Saw", square: "Sqr" };
const FILTER_LABELS: Record<string, string> = { lowpass: "Low-pass", highpass: "High-pass", bandpass: "Band-pass" };

function Choice<T extends string>({
  label,
  options,
  names,
  value,
  onChange
}: {
  label: string;
  options: readonly T[];
  names: Record<string, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="synth-choice" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          className={option === value ? "active" : ""}
          onClick={() => onChange(option)}
        >
          {names[option] ?? option}
        </button>
      ))}
    </div>
  );
}

/** An envelope drawn out, so attack, decay, sustain and release can be seen. */
function EnvelopeGraph({ attack, decay, sustain, release }: { attack: number; decay: number; sustain: number; release: number }) {
  const width = 200;
  const height = 54;
  const hold = 0.35;

  // Square-root time so a 5 ms attack and a 2 s release are both readable.
  const scale = (t: number) => Math.sqrt(t);
  const total = scale(attack) + scale(decay) + hold + scale(release);
  const x = (t: number) => (t / total) * (width - 4) + 2;

  const a = scale(attack);
  const d = a + scale(decay);
  const h = d + hold;
  const r = h + scale(release);
  const top = 4;
  const bottom = height - 3;
  const sustainY = bottom - (bottom - top) * sustain;

  const points = [
    [x(0), bottom],
    [x(a), top],
    [x(d), sustainY],
    [x(h), sustainY],
    [x(r), bottom]
  ];

  return (
    <svg className="synth-envelope" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Envelope">
      <polyline points={points.map((point) => point.join(",")).join(" ")} />
    </svg>
  );
}

/* ─────────────────────────── the wavetable display ─────────────────────────── */

const STACK_FRAMES = 10;

/**
 * The waveform at the current position in front, with the rest of the table
 * stacked behind it. Drag across it to move the position.
 */
function WavetableDisplay({
  table,
  pos,
  reach,
  onPosition,
  gesture
}: {
  table: string;
  pos: number;
  reach: { min: number; max: number };
  onPosition: (position: number) => void;
  gesture: { begin: () => void; end: () => void };
}) {
  const width = 300;
  const height = 120;
  const left = 14;
  const span = 200;
  const baseY = 82;
  const amplitude = 26;

  const frames = useMemo(
    () => Array.from({ length: STACK_FRAMES }, (_, i) => sampleWavetable(table, i / (STACK_FRAMES - 1), 72)),
    [table]
  );
  const current = useMemo(() => sampleWavetable(table, pos, 96), [table, pos]);

  const draw = (samples: number[], dx: number, dy: number, scale = 1) =>
    samples
      .map((value, k) => `${(left + dx + (k / (samples.length - 1)) * span).toFixed(1)},${(baseY + dy - value * amplitude * scale).toFixed(1)}`)
      .join(" ");

  const dragging = useRef(false);
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - box.left) / box.width;
    onPosition(Math.min(1, Math.max(0, fraction)));
  };

  const lowPos = Math.max(0, pos + reach.min);
  const highPos = Math.min(1, pos + reach.max);
  const modulated = reach.max - reach.min > 1e-4;

  return (
    <svg
      className="wt-display"
      viewBox={`0 0 ${width} ${height}`}
      role="slider"
      aria-label="Wavetable position"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(pos.toFixed(2))}
      tabIndex={0}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.begin();
        move(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) move(event);
      }}
      onPointerUp={() => {
        dragging.current = false;
        gesture.end();
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 0.1 : 0.02;
        if (event.key === "ArrowRight" || event.key === "ArrowUp") onPosition(Math.min(1, pos + step));
        else if (event.key === "ArrowLeft" || event.key === "ArrowDown") onPosition(Math.max(0, pos - step));
        else return;
        event.preventDefault();
      }}
    >
      <rect x="0" y="0" width={width} height={height} className="wt-bg" />
      {frames.map((samples, i) => {
        const back = STACK_FRAMES - 1 - i;
        return (
          <polyline
            key={i}
            points={draw(samples, 6 + back * 4.5, -back * 3.4 - 10, 0.55)}
            className="wt-ghost"
            style={{ opacity: 0.12 + (1 - back / STACK_FRAMES) * 0.28 }}
          />
        );
      })}
      <polygon points={`${draw(current, 0, 0)} ${left + span},${baseY + 8} ${left},${baseY + 8}`} className="wt-fill" />
      <polyline points={draw(current, 0, 0)} className="wt-line" />

      {/* the position, and how far modulation moves it */}
      <line x1={left} x2={left + span} y1={104} y2={104} className="wt-track" />
      {modulated ? (
        <line x1={left + lowPos * span} x2={left + highPos * span} y1={104} y2={104} className="wt-range" />
      ) : null}
      <circle cx={left + pos * span} cy={104} r="4.5" className="wt-thumb" />
    </svg>
  );
}

/* ─────────────────────────────── the editor ─────────────────────────────── */

interface Gesture {
  begin: () => void;
  end: () => void;
}

export function SynthEditor() {
  const channelId = useSynthEditor((state) => state.channelId);
  const close = useSynthEditor((state) => state.close);
  const channel = useProjectStore((state) => state.channels.find((entry) => entry.id === channelId));
  const updatePatch = useProjectStore((state) => state.updateChannelSynthPatch);
  const selectChannel = useSessionStore((state) => state.selectChannel);
  const gesture = useGesture("Synth sound");

  // Where the panel sits; dragging its title bar moves it.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);

  // Modulation: a source waiting to be put on a knob.
  const [armed, setArmed] = useState<ModSource | null>(null);
  const [dragging, setDragging] = useState(false);

  const open = channel !== undefined && channel.type === "synth";

  // The channel being edited is the one the keyboard plays.
  useEffect(() => {
    if (open && channelId) selectChannel(channelId);
  }, [open, channelId, selectChannel]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      event.stopPropagation();
      if (armed) setArmed(null);
      else close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close, armed]);

  // The sound being edited: the person's own, or a copy of the preset it starts from.
  const base = useMemo(() => {
    if (!channel) return null;
    const preset = getSynthPreset(channel.synthPreset) ?? defaultSynthPreset;
    return patchFromPreset(preset);
  }, [channel]);

  if (!open || !channel || !base) return null;

  const patch: SynthPatch = channel.synthPatch ?? base;
  const isCustom = channel.synthPatch !== undefined;
  const wt = patch.wt;
  const mod: SynthMod = patch.mod ?? DEFAULT_MOD;
  const routes = mod.routes;

  /** Change one or more settings; the first change turns the preset into the person's own sound. */
  const change = (changes: Partial<SynthPatch>) => {
    updatePatch(channel.id, { ...patch, ...changes });
  };
  const changeMod = (changes: Partial<SynthMod>) => change({ mod: { ...mod, ...changes } });
  const changeOsc = (which: "a" | "b", changes: Partial<WavetableOsc>) => {
    if (!wt) return;
    change({ wt: { ...wt, [which]: { ...wt[which], ...changes } } });
  };

  const dests: readonly ModDest[] = wt ? MOD_DESTS : MOD_DESTS.filter((dest) => !/^(pos|level)[AB]$/.test(dest));

  const modApi: ModApi = {
    routes,
    armed,
    dragging,
    dests,
    arm: setArmed,
    setDragging,
    attach: (source, dest) => {
      setArmed(null);
      setDragging(false);
      if (routes.some((route) => route.source === source && route.dest === dest)) return;
      if (routes.length >= MAX_ROUTES) return;
      changeMod({ routes: [...routes, { source, dest, amount: DEFAULT_AMOUNT[dest] }] });
    }
  };

  const setRoute = (index: number, changes: Partial<ModRoute>) => {
    changeMod({ routes: routes.map((route, i) => (i === index ? { ...route, ...changes } : route)) });
  };

  const sub = patch.sub ?? { gain: 0, type: "sine" as OscillatorType };
  const fm = patch.fm ?? { ratio: 2, index: 0, decay: 0.5, sustain: 0.15 };
  const pitchEnv = patch.pitchEnv ?? { semitones: 0, time: 0.1 };
  const vibrato = patch.vibrato ?? { rate: 5.5, depth: 0, delay: 0.2 };
  const tremolo = patch.tremolo ?? { rate: 5, depth: 0 };
  const filterLfo = patch.filterLfo ?? { rate: 2, depth: 0 };
  const osc2 = patch.osc2 ?? { type: "square" as OscillatorType, semitones: 0, detune: 7, gain: 0 };
  const unison = patch.unison ?? 3;
  const voices = patch.detuneSpread > 0 ? unison : 1;

  const play = () => previewChannel(channel.id, 60, 0.85, 1.1);
  const playChord = () => {
    previewChannel(channel.id, 60, 0.8, 1.4);
    previewChannel(channel.id, 64, 0.8, 1.4);
    previewChannel(channel.id, 67, 0.8, 1.4);
  };

  const wavetableOscillator = (which: "a" | "b") => {
    if (!wt) return null;
    const osc = wt[which];
    const dest: ModDest = which === "a" ? "posA" : "posB";
    const levelDest: ModDest = which === "a" ? "levelA" : "levelB";
    const upper = which.toUpperCase();
    const set = (changes: Partial<WavetableOsc>) => changeOsc(which, changes);
    const tableIndex = WAVETABLES.findIndex((entry) => entry.id === osc.table);
    const hint = WAVETABLES[tableIndex]?.hint ?? "";

    return (
      <Section title={`Oscillator ${upper}`} className="synth-osc">
        <div className="wt-pick">
          <button type="button" aria-label="Previous wavetable" onClick={() => set({ table: WAVETABLES[(tableIndex + WAVETABLES.length - 1) % WAVETABLES.length].id })}>
            ‹
          </button>
          <select value={osc.table} aria-label={`Oscillator ${upper} wavetable`} onChange={(event) => set({ table: event.target.value })}>
            {WAVETABLES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <button type="button" aria-label="Next wavetable" onClick={() => set({ table: WAVETABLES[(tableIndex + 1) % WAVETABLES.length].id })}>
            ›
          </button>
        </div>

        <WavetableDisplay
          table={osc.table}
          pos={osc.pos}
          reach={routeRange(routes, dest)}
          onPosition={(pos) => set({ pos })}
          gesture={gesture}
        />
        <span className="wt-hint">{hint}</span>

        <div className="synth-knobs">
          <Param label="Position" value={osc.pos} min={0} max={1} format={percent} reset={which === "a" ? 0.67 : 0.33} gesture={gesture} dest={dest} onChange={(pos) => set({ pos })} />
          <Param label="Level" value={osc.level} min={0} max={1} format={percent} reset={which === "a" ? 1 : 0} gesture={gesture} dest={levelDest} onChange={(level) => set({ level })} />
          <Param label="Pitch" value={osc.semitones} min={-36} max={36} step={1} format={(v) => `${v > 0 ? "+" : ""}${v} st`} reset={0} gesture={gesture} onChange={(semitones) => set({ semitones })} />
          <Param label="Fine" value={osc.fine} min={-100} max={100} format={cents} reset={0} gesture={gesture} onChange={(fine) => set({ fine })} />
          <Param
            label="Unison"
            value={osc.detune > 0 ? osc.unison : 1}
            min={1}
            max={9}
            step={2}
            format={(v) => `${v} voice${v === 1 ? "" : "s"}`}
            reset={1}
            gesture={gesture}
            onChange={(value) => set(value <= 1 ? { unison: 1 } : { unison: value, detune: osc.detune > 0 ? osc.detune : 12 })}
          />
          <Param label="Detune" value={osc.detune} min={0} max={60} format={cents} reset={12} gesture={gesture} onChange={(detune) => set({ detune })} />
          <Param label="Width" value={osc.width} min={0} max={1} format={percent} reset={0.7} gesture={gesture} onChange={(width) => set({ width })} />
        </div>
      </Section>
    );
  };

  return (
    <ModContext.Provider value={modApi}>
      <div
        className={`synth-editor${armed || dragging ? " modding" : ""}`}
        role="dialog"
        aria-label={`Sound editor for ${channel.name}`}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        <header
          className="synth-editor-bar"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button, select")) return;
            dragStart.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = dragStart.current;
            if (!start) return;
            setOffset({ x: start.startX + event.clientX - start.x, y: start.startY + event.clientY - start.y });
          }}
          onPointerUp={() => {
            dragStart.current = null;
          }}
        >
          <strong>
            {wt ? "Wavetable Synth" : "Synth"} <span>· {channel.name}</span>
          </strong>

          <label className="synth-start">
            Start from
            <select
              value=""
              onChange={(event) => {
                const preset = synthPresets.find((entry) => entry.id === event.target.value);
                if (preset) updatePatch(channel.id, patchFromPreset(preset));
              }}
            >
              <option value="">{isCustom ? `${patch.name} (yours)` : `${patch.name}`}</option>
              {synthPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>

          <span className="menu-spacer" />
          <button type="button" onClick={play} title="Play one note (C)">
            Play note
          </button>
          <button type="button" onClick={playChord} title="Play a C major chord">
            Play chord
          </button>
          <button
            type="button"
            disabled={!isCustom}
            onClick={() => updatePatch(channel.id, null)}
            title="Throw away your changes and go back to the preset"
          >
            Back to preset
          </button>
          <button type="button" className="synth-close" onClick={close} aria-label="Close the sound editor" title="Close">
            ×
          </button>
        </header>

        <div className="synth-toolbar">
          <div className="synth-mode">
            <span>Oscillators</span>
            <Choice
              label="Oscillator type"
              options={["classic", "wavetable"] as const}
              names={{ classic: "Classic", wavetable: "Wavetable" }}
              value={wt ? "wavetable" : "classic"}
              onChange={(kind) => {
                if (kind === "wavetable" && !wt) change({ wt: wavetableFromClassic(patch) });
                else if (kind === "classic" && wt) change({ wt: undefined });
              }}
            />
          </div>

          <div className="mod-sources">
            <span>{armed ? `Now click a knob to link ${MOD_SOURCE_NAMES[armed]}` : "Drag onto a knob"}</span>
            {MOD_SOURCES.map((source) => (
              <SourceChip key={source} source={source} />
            ))}
          </div>
        </div>

        <div className="synth-editor-body">
          {wt ? (
            <>
              {wavetableOscillator("a")}
              {wavetableOscillator("b")}
            </>
          ) : (
            <>
              <Section title="Oscillator 1">
                <Choice label="Waveform" options={WAVEFORMS} names={WAVE_LABELS} value={patch.oscType} onChange={(oscType) => change({ oscType })} />
                <div className="synth-knobs">
                  <Param
                    label="Unison"
                    value={voices}
                    min={1}
                    max={9}
                    step={2}
                    format={(v) => `${v} voice${v === 1 ? "" : "s"}`}
                    reset={1}
                    gesture={gesture}
                    onChange={(value) =>
                      change(value <= 1 ? { detuneSpread: 0 } : { unison: value, detuneSpread: patch.detuneSpread > 0 ? patch.detuneSpread : 12 })
                    }
                  />
                  <Param label="Detune" value={patch.detuneSpread} min={0} max={60} format={cents} reset={0} gesture={gesture} onChange={(detuneSpread) => change({ detuneSpread })} />
                  <Param label="Width" value={patch.stereoSpread ?? 0.5} min={0} max={1} format={percent} reset={0.5} gesture={gesture} onChange={(stereoSpread) => change({ stereoSpread })} />
                </div>
              </Section>

              <Section title="Oscillator 2">
                <Choice label="Waveform" options={WAVEFORMS} names={WAVE_LABELS} value={osc2.type} onChange={(type) => change({ osc2: { ...osc2, type } })} />
                <div className="synth-knobs">
                  <Param label="Level" value={osc2.gain} min={0} max={1} format={percent} reset={0} gesture={gesture} onChange={(gain) => change({ osc2: { ...osc2, gain } })} />
                  <Param label="Pitch" value={osc2.semitones} min={-24} max={24} step={1} format={(v) => `${v > 0 ? "+" : ""}${v} st`} reset={0} gesture={gesture} onChange={(semitones) => change({ osc2: { ...osc2, semitones } })} />
                  <Param label="Fine" value={osc2.detune} min={-100} max={100} format={cents} reset={7} gesture={gesture} onChange={(detune) => change({ osc2: { ...osc2, detune } })} />
                </div>
              </Section>
            </>
          )}

          <Section title="Sub and noise">
            <Choice label="Sub waveform" options={["sine", "triangle", "square"] as const} names={WAVE_LABELS} value={(sub.type ?? "sine") as "sine" | "triangle" | "square"} onChange={(type) => change({ sub: { ...sub, type } })} />
            <div className="synth-knobs">
              <Param label="Sub" value={sub.gain} min={0} max={1} format={percent} reset={0} gesture={gesture} onChange={(gain) => change({ sub: { ...sub, gain } })} />
              <Param label="Noise" value={patch.noise ?? 0} min={0} max={1} format={percent} reset={0} gesture={gesture} onChange={(noise) => change({ noise })} />
              <Param label="Volume" value={patch.gain} min={0} max={1} format={percent} reset={0.4} gesture={gesture} dest="volume" onChange={(gain) => change({ gain })} />
            </div>
          </Section>

          <Section title="Filter">
            <Choice label="Filter type" options={FILTER_TYPES} names={FILTER_LABELS} value={patch.filterType as (typeof FILTER_TYPES)[number]} onChange={(filterType) => change({ filterType })} />
            <div className="synth-knobs">
              <Param label="Cutoff" value={patch.filterFreq} min={40} max={18000} curve="log" format={hertz} reset={4000} gesture={gesture} dest="cutoff" onChange={(filterFreq) => change({ filterFreq })} />
              <Param label="Resonance" value={patch.filterQ} min={0.1} max={20} curve="slow" format={(v) => v.toFixed(1)} reset={0.7} gesture={gesture} dest="resonance" onChange={(filterQ) => change({ filterQ })} />
              <Param label="Envelope" value={patch.filterEnvAmount} min={0} max={4} format={(v) => v.toFixed(2)} reset={0} gesture={gesture} onChange={(filterEnvAmount) => change({ filterEnvAmount })} />
              <Param label="Env decay" value={patch.filterDecay ?? patch.decayTime} min={0.01} max={4} curve="slow" format={seconds} reset={0.3} gesture={gesture} onChange={(filterDecay) => change({ filterDecay })} />
              <Param label="Key track" value={patch.filterKeytrack ?? 0} min={0} max={1} format={percent} reset={0} gesture={gesture} onChange={(filterKeytrack) => change({ filterKeytrack })} />
            </div>
          </Section>

          <Section title="Env 1 · volume">
            <EnvelopeGraph attack={patch.attackTime} decay={patch.decayTime} sustain={patch.sustainLevel} release={patch.releaseTime} />
            <div className="synth-knobs">
              <Param label="Attack" value={patch.attackTime} min={0.001} max={4} curve="slow" format={seconds} reset={0.01} gesture={gesture} onChange={(attackTime) => change({ attackTime })} />
              <Param label="Decay" value={patch.decayTime} min={0.005} max={4} curve="slow" format={seconds} reset={0.3} gesture={gesture} onChange={(decayTime) => change({ decayTime })} />
              <Param label="Sustain" value={patch.sustainLevel} min={0} max={1} format={percent} reset={0.7} gesture={gesture} onChange={(sustainLevel) => change({ sustainLevel })} />
              <Param label="Release" value={patch.releaseTime} min={0.01} max={6} curve="slow" format={seconds} reset={0.3} gesture={gesture} onChange={(releaseTime) => change({ releaseTime })} />
            </div>
          </Section>

          <Section title="Env 2 · modulation" aside={<SourceChip source="env2" />}>
            <EnvelopeGraph attack={mod.env2.attack} decay={mod.env2.decay} sustain={mod.env2.sustain} release={mod.env2.release} />
            <div className="synth-knobs">
              <Param label="Attack" value={mod.env2.attack} min={0.001} max={4} curve="slow" format={seconds} reset={0.005} gesture={gesture} onChange={(attack) => changeMod({ env2: { ...mod.env2, attack } })} />
              <Param label="Decay" value={mod.env2.decay} min={0.005} max={4} curve="slow" format={seconds} reset={0.45} gesture={gesture} onChange={(decay) => changeMod({ env2: { ...mod.env2, decay } })} />
              <Param label="Sustain" value={mod.env2.sustain} min={0} max={1} format={percent} reset={0.25} gesture={gesture} onChange={(sustain) => changeMod({ env2: { ...mod.env2, sustain } })} />
              <Param label="Release" value={mod.env2.release} min={0.01} max={6} curve="slow" format={seconds} reset={0.4} gesture={gesture} onChange={(release) => changeMod({ env2: { ...mod.env2, release } })} />
            </div>
          </Section>

          {(["lfo1", "lfo2"] as const).map((key) => (
            <Section key={key} title={key === "lfo1" ? "LFO 1" : "LFO 2"} aside={<SourceChip source={key} />}>
              <Choice label={`${key} shape`} options={WAVEFORMS} names={WAVE_LABELS} value={mod[key].shape as (typeof WAVEFORMS)[number]} onChange={(shape) => changeMod({ [key]: { ...mod[key], shape } })} />
              <div className="synth-knobs">
                <Param label="Rate" value={mod[key].rate} min={0.05} max={20} curve="slow" format={(v) => `${v.toFixed(2)} Hz`} reset={key === "lfo1" ? 2 : 0.5} gesture={gesture} onChange={(rate) => changeMod({ [key]: { ...mod[key], rate } })} />
              </div>
            </Section>
          ))}

          <Section title="FM">
            <div className="synth-knobs">
              <Param label="Amount" value={fm.index} min={0} max={12} curve="slow" format={(v) => v.toFixed(1)} reset={0} gesture={gesture} onChange={(index) => change({ fm: { ...fm, index } })} />
              <Param label="Ratio" value={fm.ratio} min={0.25} max={16} curve="log" format={(v) => `×${v.toFixed(2)}`} reset={2} gesture={gesture} onChange={(ratio) => change({ fm: { ...fm, ratio } })} />
              <Param label="Decay" value={fm.decay} min={0.01} max={4} curve="slow" format={seconds} reset={0.5} gesture={gesture} onChange={(decay) => change({ fm: { ...fm, decay } })} />
            </div>
          </Section>

          <Section title="Movement">
            <div className="synth-knobs">
              <Param label="Vibrato" value={vibrato.depth} min={0} max={100} format={cents} reset={0} gesture={gesture} onChange={(depth) => change({ vibrato: { ...vibrato, depth } })} />
              <Param label="Vib. speed" value={vibrato.rate} min={0.5} max={14} format={(v) => `${v.toFixed(1)} Hz`} reset={5.5} gesture={gesture} onChange={(rate) => change({ vibrato: { ...vibrato, rate } })} />
              <Param label="Tremolo" value={tremolo.depth} min={0} max={1} format={percent} reset={0} gesture={gesture} onChange={(depth) => change({ tremolo: { ...tremolo, depth } })} />
              <Param label="Trem. speed" value={tremolo.rate} min={0.05} max={20} curve="slow" format={(v) => `${v.toFixed(1)} Hz`} reset={5} gesture={gesture} onChange={(rate) => change({ tremolo: { ...tremolo, rate } })} />
              <Param label="Wobble" value={filterLfo.depth} min={0} max={4800} format={cents} reset={0} gesture={gesture} onChange={(depth) => change({ filterLfo: { ...filterLfo, depth } })} />
              <Param label="Wob. speed" value={filterLfo.rate} min={0.05} max={20} curve="slow" format={(v) => `${v.toFixed(1)} Hz`} reset={2} gesture={gesture} onChange={(rate) => change({ filterLfo: { ...filterLfo, rate } })} />
              <Param label="Pitch drop" value={pitchEnv.semitones} min={-24} max={24} format={(v) => `${v.toFixed(1)} st`} reset={0} gesture={gesture} onChange={(semitones) => change({ pitchEnv: { ...pitchEnv, semitones } })} />
              <Param label="Drop time" value={pitchEnv.time} min={0.005} max={2} curve="slow" format={seconds} reset={0.1} gesture={gesture} onChange={(time) => change({ pitchEnv: { ...pitchEnv, time } })} />
            </div>
          </Section>

          <Section
            title="Modulation"
            className="synth-matrix"
            aside={<span className="synth-count">{routes.length} of {MAX_ROUTES}</span>}
          >
            {routes.length === 0 ? (
              <p className="synth-empty">
                Nothing is linked yet. Drag <strong>Env 2</strong>, an <strong>LFO</strong>, <strong>Velocity</strong> or{" "}
                <strong>Key</strong> from the bar above onto a knob that has a small dot over it, and it will move that knob
                while you play.
              </p>
            ) : (
              <div className="mod-rows">
                {routes.map((route, index) => (
                  <MatrixRow
                    key={`${route.source}-${route.dest}`}
                    route={route}
                    dests={dests}
                    gesture={gesture}
                    onChange={(changes) => setRoute(index, changes)}
                    onRemove={() => changeMod({ routes: routes.filter((_, i) => i !== index) })}
                  />
                ))}
              </div>
            )}
          </Section>
        </div>

        <footer className="synth-editor-foot">
          Turn the knobs, then play the keyboard to hear it. Double-click a knob to reset it. Knobs with a dot can be modulated.
        </footer>
      </div>
    </ModContext.Provider>
  );
}

/** One line of the modulation matrix: where it comes from, where it goes, how much. */
function MatrixRow({
  route,
  dests,
  gesture,
  onChange,
  onRemove
}: {
  route: ModRoute;
  dests: readonly ModDest[];
  gesture: Gesture;
  onChange: (changes: Partial<ModRoute>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mod-row">
      <span className={`mod-chip static mod-${route.source}`}>{MOD_SOURCE_NAMES[route.source]}</span>
      <span aria-hidden="true">→</span>
      <select
        value={route.dest}
        aria-label={`Where ${MOD_SOURCE_NAMES[route.source]} goes`}
        onChange={(event) => onChange({ dest: event.target.value as ModDest })}
      >
        {/* A link to something this sound doesn't have (after switching back to classic) still says so. */}
        {(dests.includes(route.dest) ? dests : [...dests, route.dest]).map((dest) => (
          <option key={dest} value={dest}>
            {MOD_DEST_NAMES[dest]}
            {dests.includes(dest) ? "" : " (not in classic mode)"}
          </option>
        ))}
      </select>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={route.amount}
        aria-label={`${MOD_SOURCE_NAMES[route.source]} to ${MOD_DEST_NAMES[route.dest]} amount`}
        onPointerDown={gesture.begin}
        onPointerUp={gesture.end}
        onDoubleClick={() => onChange({ amount: 0 })}
        onChange={(event) => onChange({ amount: Number(event.target.value) })}
      />
      <output>{signedPercent(route.amount)}</output>
      <button type="button" className="mod-remove" aria-label="Remove this link" title="Remove this link" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}
