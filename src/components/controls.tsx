import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { clamp } from "../lib/utils";
import { controllerFor, registerControl, useMidiStore } from "../audio/midiMap";

/**
 * MIDI learn for a knob or fader. With a `learnId`, the control can be moved
 * from a hardware knob: right-click it, then turn the knob on the controller.
 * Right-click again while waiting to cancel; a learned control shows its CC.
 */
function useMidiLearn(
  learnId: string | undefined,
  label: string,
  range: { value: number; min: number; max: number; step: number; onChange: (value: number) => void }
) {
  const latest = useRef(range);
  latest.current = range;

  const learning = useMidiStore((state) => learnId !== undefined && state.learningId === learnId);
  const controller = useMidiStore((state) => (learnId ? controllerFor(state.mappings, learnId) : null));
  const startLearning = useMidiStore((state) => state.startLearning);

  const { min, max, step } = range;

  useEffect(() => {
    if (!learnId) return;
    return registerControl(learnId, {
      label,
      min,
      max,
      step,
      get: () => latest.current.value,
      set: (value) => latest.current.onChange(value)
    });
  }, [label, learnId, max, min, step]);

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!learnId) return;
      event.preventDefault();
      startLearning(learning ? null : learnId);
    },
    [learnId, learning, startLearning]
  );

  const className = learning ? " midi-learning" : controller !== null ? " midi-mapped" : "";
  const hint = !learnId
    ? ""
    : learning
      ? " · turn a knob on your MIDI controller (right-click to cancel)"
      : controller !== null
        ? ` · MIDI CC ${controller} (right-click to relearn)`
        : " · right-click to link a MIDI knob";

  return { onContextMenu, className, hint };
}

interface DragNumberOptions {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Pixels of travel needed to sweep the full range. */
  travel?: number;
  onChange: (value: number) => void;
  onCommitStart?: () => void;
  onCommitEnd?: () => void;
}

/**
 * Shared vertical-drag behaviour for knobs and faders: drag up to increase,
 * hold Shift for fine control, and the pointer is captured so the gesture
 * survives leaving the element.
 */
function useVerticalDrag({
  value,
  min,
  max,
  step,
  travel = 160,
  onChange,
  onCommitStart,
  onCommitEnd
}: DragNumberOptions) {
  const start = useRef({ y: 0, value: 0 });

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      start.current = { y: event.clientY, value };
      onCommitStart?.();
    },
    [value, onCommitStart]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

      const sensitivity = event.shiftKey ? 4 : 1;
      const delta = (start.current.y - event.clientY) / (travel * sensitivity);
      const raw = start.current.value + delta * (max - min);
      const snapped = Math.round(raw / step) * step;

      onChange(clamp(Number(snapped.toFixed(6)), min, max));
    },
    [max, min, onChange, step, travel]
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onCommitEnd?.();
    },
    [onCommitEnd]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const nudge = event.shiftKey ? step : step * 10;
      let next: number | null = null;

      if (event.key === "ArrowUp" || event.key === "ArrowRight") next = value + nudge;
      if (event.key === "ArrowDown" || event.key === "ArrowLeft") next = value - nudge;
      if (event.key === "Home") next = min;
      if (event.key === "End") next = max;

      if (next === null) return;
      event.preventDefault();
      onCommitStart?.();
      onChange(clamp(Number(next.toFixed(6)), min, max));
      onCommitEnd?.();
    },
    [max, min, onChange, onCommitEnd, onCommitStart, step, value]
  );

  // A touch or pen gesture interrupted by the OS fires `pointercancel` and
  // never `pointerup`, which would leave the undo group this drag opened
  // hanging open. Same teardown either way.
  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onKeyDown
  };
}

export interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display?: string;
  /** The text under the knob, when it should differ from `display` (which the tooltip and screen readers get). */
  readout?: string;
  /** False leaves out the caption under the knob, where the strip makes it obvious. */
  showLabel?: boolean;
  defaultValue?: number;
  size?: number;
  color?: string;
  onChange: (value: number) => void;
  onCommitStart?: () => void;
  onCommitEnd?: () => void;
  /** Stable id that makes the knob MIDI-learnable, e.g. "channel:abc:volume". */
  learnId?: string;
}

export function Knob({
  label,
  value,
  min,
  max,
  step,
  display,
  readout,
  showLabel = true,
  defaultValue,
  size = 34,
  color,
  onChange,
  onCommitStart,
  onCommitEnd,
  learnId
}: KnobProps) {
  const learn = useMidiLearn(learnId, label, { value, min, max, step, onChange });
  const handlers = useVerticalDrag({
    value,
    min,
    max,
    step,
    onChange,
    onCommitStart,
    onCommitEnd
  });

  const ratio = max === min ? 0 : (value - min) / (max - min);
  const sweep = 270;
  const angle = -135 + ratio * sweep;

  const radius = size / 2 - 3;
  const centre = size / 2;
  const arcLength = (2 * Math.PI * radius * sweep) / 360;

  return (
    <div className={`knob${learn.className}`} style={{ width: size + 8 }} onContextMenu={learn.onContextMenu}>
      <div
        className="knob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={display}
        title={`${label}: ${display ?? value}${learn.hint}`}
        onDoubleClick={() => {
          if (defaultValue === undefined) return;
          onCommitStart?.();
          onChange(defaultValue);
          onCommitEnd?.();
        }}
        {...handlers}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            className="knob-track"
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeDasharray={`${arcLength} ${2 * Math.PI * radius}`}
            transform={`rotate(135 ${centre} ${centre})`}
          />
          <circle
            className="knob-value"
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            stroke={color}
            strokeDasharray={`${arcLength * ratio} ${2 * Math.PI * radius}`}
            transform={`rotate(135 ${centre} ${centre})`}
          />
          <line
            className="knob-pointer"
            x1={centre}
            y1={centre}
            x2={centre}
            y2={centre - radius + 3}
            transform={`rotate(${angle} ${centre} ${centre})`}
          />
        </svg>
      </div>
      {showLabel ? <span className="knob-label">{label}</span> : null}
      <span className="knob-readout">{(readout ?? display ?? String(value)) || " "}</span>
    </div>
  );
}

export interface FaderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  height?: number;
  display?: string;
  defaultValue?: number;
  onChange: (value: number) => void;
  onCommitStart?: () => void;
  onCommitEnd?: () => void;
  learnId?: string;
}

export function Fader({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  height = 120,
  display,
  defaultValue,
  onChange,
  onCommitStart,
  onCommitEnd,
  learnId
}: FaderProps) {
  const learn = useMidiLearn(learnId, label, { value, min, max, step, onChange });
  const handlers = useVerticalDrag({
    value,
    min,
    max,
    step,
    travel: height,
    onChange,
    onCommitStart,
    onCommitEnd
  });

  const ratio = max === min ? 0 : (value - min) / (max - min);

  return (
    <div
      className={`fader${learn.className}`}
      style={{ height }}
      onContextMenu={learn.onContextMenu}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={display}
      title={`${label}: ${display ?? value.toFixed(2)}${learn.hint}`}
      onDoubleClick={() => {
        if (defaultValue === undefined) return;
        onCommitStart?.();
        onChange(defaultValue);
        onCommitEnd?.();
      }}
      {...handlers}
    >
      <div className="fader-track">
        <div className="fader-fill" style={{ height: `${ratio * 100}%` }} />
        <div className="fader-cap" style={{ bottom: `calc(${ratio * 100}% - 6px)` }} />
      </div>
    </div>
  );
}

/**
 * Thin vertical LED meter.
 *
 * Pass `read` and the meter polls it itself, writing the fill height straight
 * to the DOM. Metering at 60fps through React state instead would re-render
 * the whole mixer strip — fader, knob and effect rack included — on every
 * frame that any level moved.
 */
/** Meter scale: −60 dBFS at the bottom, +6 at the top. */
const METER_FLOOR_DB = -60;
const METER_CEILING_DB = 6;

function meterPosition(amplitude: number): number {
  if (amplitude <= 0.001) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
}

/** Where 0 dBFS sits on the meter, for the tick. */
const ZERO_DB_POSITION = meterPosition(1);

/**
 * A peak meter on a decibel scale, with a falling peak-hold line and a clip
 * light that stays on for a moment after anything reaches 0 dBFS.
 */
export function LevelMeter({
  level = 0,
  read,
  height = 120
}: {
  level?: number;
  read?: () => number;
  height?: number;
}) {
  const fill = useRef<HTMLDivElement | null>(null);
  const hold = useRef<HTMLDivElement | null>(null);
  const clip = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!read) return;

    let frame = 0;
    let shown = -1;
    let held = 0;
    let heldAt = 0;
    let clippedAt = -Infinity;
    let last = performance.now();

    const tick = (now: number) => {
      const elapsed = Math.max(0, (now - last) / 1000);
      last = now;

      const amplitude = read();
      const position = meterPosition(amplitude);

      // Fast attack, ~24 dB/s fall, so the bar is readable rather than flickering.
      const fallen = Math.max(0, shown - elapsed * (24 / (METER_CEILING_DB - METER_FLOOR_DB)));
      const next = Math.max(position, fallen);

      if (Math.abs(next - shown) > 0.003 && fill.current) {
        shown = next;
        fill.current.style.height = `${next * 100}%`;
      }

      // Peak hold: sits for a second, then drops.
      if (position >= held) {
        held = position;
        heldAt = now;
      } else if (now - heldAt > 1000) {
        held = Math.max(0, held - elapsed * 0.5);
      }
      if (hold.current) hold.current.style.bottom = `${held * 100}%`;

      if (amplitude >= 1) clippedAt = now;
      clip.current?.classList.toggle("on", now - clippedAt < 1500);

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [read]);

  return (
    <div className="level-meter-wrap" aria-hidden="true">
      <div ref={clip} className="level-meter-clip" title="Clipped" />
      <div
        className="level-meter"
        style={{ height, "--meter-height": `${height}px` } as React.CSSProperties}
      >
        <div
          ref={fill}
          className="level-meter-fill"
          style={{ height: `${meterPosition(level) * 100}%` }}
        />
        <div ref={hold} className="level-meter-hold" />
        <div className="level-meter-zero" style={{ bottom: `${ZERO_DB_POSITION * 100}%` }} />
      </div>
    </div>
  );
}