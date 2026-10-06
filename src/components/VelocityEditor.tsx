import { useCallback, useEffect, useMemo, useRef } from "react";

import { useProjectStore } from "../state/projectStore";
import { useUnmount } from "../hooks/useStudio";
import { useSessionStore } from "../state/sessionStore";
import { clamp, STEPS_PER_BAR, STEPS_PER_BEAT } from "../lib/utils";
import type { NoteData } from "../types";

interface VelocityEditorProps {
  patternId: string;
  channelId: string;
  patternLength: number;
  noteWidth: number;
  color: string;
  selected: Set<string>;
  offsetLeft: number;
}

const HEIGHT = 78;
const MAX_VELOCITY = 127;

/** Bar-graph editor for note velocities, aligned with the piano roll grid. */
export function VelocityEditor({
  patternId,
  channelId,
  patternLength,
  noteWidth,
  color,
  selected,
  offsetLeft
}: VelocityEditorProps) {
  // The canvas reads its colours from CSS variables at draw time, so the
  // theme has to be a dependency — otherwise switching themes recolours the
  // HTML chrome and leaves this painted in the old palette.
  const theme = useSessionStore((state) => state.theme);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);

  const patterns = useProjectStore((state) => state.patterns);
  const setNoteVelocity = useProjectStore((state) => state.setNoteVelocity);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const notes = useMemo<NoteData[]>(
    () => patterns[patternId]?.channels[channelId]?.notes ?? [],
    [patterns, patternId, channelId]
  );

  const width = patternLength * noteWidth;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const styles = getComputedStyle(canvas);
    const panel = styles.getPropertyValue("--panel").trim() || "#2b2b2b";
    const line = styles.getPropertyValue("--line").trim() || "#4d4d4d";
    const lineSoft = styles.getPropertyValue("--line-soft").trim() || "#353535";
    const text = styles.getPropertyValue("--text").trim() || "#e9e9e9";

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    context.fillStyle = panel;
    context.fillRect(0, 0, width, HEIGHT);

    for (let step = 0; step <= patternLength; step++) {
      const x = Math.round(step * noteWidth) + 0.5;
      context.strokeStyle =
        step % STEPS_PER_BAR === 0 ? line : step % STEPS_PER_BEAT === 0 ? lineSoft : "rgba(0,0,0,0.2)";
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, HEIGHT);
      context.stroke();
    }

    // Reference lines at 50% and 100%.
    context.strokeStyle = lineSoft;
    context.setLineDash([3, 3]);
    for (const ratio of [0.5, 1]) {
      const y = HEIGHT - ratio * (HEIGHT - 6) - 3;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.setLineDash([]);

    const barWidth = Math.max(4, Math.min(noteWidth - 4, 18));

    for (const note of notes) {
      const ratio = clamp(note.velocity, 1, MAX_VELOCITY) / MAX_VELOCITY;
      const barHeight = ratio * (HEIGHT - 6);
      const x = note.start * noteWidth + 2;
      const y = HEIGHT - barHeight - 3;
      const isSelected = selected.has(note.id);

      context.globalAlpha = isSelected ? 1 : 0.65;
      context.fillStyle = color;
      context.fillRect(x, y, barWidth, barHeight);
      context.globalAlpha = 1;

      context.fillStyle = isSelected ? text : "rgba(255,255,255,0.5)";
      context.fillRect(x, y, barWidth, 2);

      if (barWidth >= 16) {
        context.fillStyle = text;
        context.font = "9px system-ui, sans-serif";
        context.textAlign = "center";
        context.fillText(String(note.velocity), x + barWidth / 2, Math.max(10, y - 3));
        context.textAlign = "start";
      }
    }
  }, [color, noteWidth, notes, patternLength, selected, theme, width]);

  const applyAt = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      const step = Math.floor(x / noteWidth);
      const velocity = Math.round(
        clamp(((HEIGHT - y) / (HEIGHT - 6)) * MAX_VELOCITY, 1, MAX_VELOCITY)
      );

      // If there's a selection, drag the whole selection together.
      const targets =
        selected.size > 0
          ? notes.filter((note) => selected.has(note.id) && note.start === step)
          : notes.filter((note) => note.start === step);

      const fallback =
        targets.length === 0 ? notes.filter((note) => note.start === step) : targets;

      for (const note of fallback) {
        setNoteVelocity(patternId, channelId, note.id, velocity);
      }
    },
    [channelId, noteWidth, notes, patternId, selected, setNoteVelocity]
  );

  const onUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    endEdit();
  }, [endEdit]);

  // Close an interrupted gesture on unmount only — see useUnmount.
  useUnmount(onUp);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;

      // The pointer was released outside the window, so no pointerup ever
      // reached us. Finish here instead of following a button that is up.
      if (event.buttons === 0) {
        onUp();
        return;
      }

      applyAt(event.clientX, event.clientY);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [applyAt, endEdit]);

  return (
    <div className="velocity-editor">
      <div className="velocity-label" style={{ width: offsetLeft }}>
        Vel
      </div>
      <div className="velocity-scroll">
        <canvas
          ref={canvasRef}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            draggingRef.current = true;
            beginEdit("Note velocity");
            applyAt(event.clientX, event.clientY);
          }}
        />
      </div>
    </div>
  );
}
