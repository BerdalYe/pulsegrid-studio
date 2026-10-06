import { useCallback, useEffect, useRef } from "react";

import { useProjectStore } from "../state/projectStore";
import { useUnmount } from "../hooks/useStudio";
import { useSessionStore } from "../state/sessionStore";
import { clamp } from "../lib/utils";
import type { AutomationClip, AutomationParam, AutomationTargetType } from "../types";

const HEIGHT = 120;
const HIT_RADIUS = 8;

/**
 * Curve editor for an automation clip: drag points, click empty space to add
 * one, right-click to remove.
 */
export function AutomationEditor({ clip }: { clip: AutomationClip }) {
  // The canvas reads its colours from CSS variables at draw time, so the
  // theme has to be a dependency — otherwise switching themes recolours the
  // HTML chrome and leaves this painted in the old palette.
  const theme = useSessionStore((state) => state.theme);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<string | null>(null);

  const channels = useProjectStore((state) => state.channels);
  const mixerTracks = useProjectStore((state) => state.mixer.tracks);

  const addAutomationPoint = useProjectStore((state) => state.addAutomationPoint);
  const updateAutomationPoint = useProjectStore((state) => state.updateAutomationPoint);
  const removeAutomationPoint = useProjectStore((state) => state.removeAutomationPoint);
  const setAutomationTarget = useProjectStore((state) => state.setAutomationTarget);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const width = 420;

  const toCanvas = useCallback(
    (step: number, value: number) => ({
      x: (step / Math.max(1, clip.durationSteps)) * (width - 16) + 8,
      y: (1 - value) * (HEIGHT - 16) + 8
    }),
    [clip.durationSteps]
  );

  const fromCanvas = useCallback(
    (x: number, y: number) => ({
      step: clamp(
        Math.round(((x - 8) / (width - 16)) * clip.durationSteps),
        0,
        clip.durationSteps
      ),
      value: clamp(1 - (y - 8) / (HEIGHT - 16), 0, 1)
    }),
    [clip.durationSteps]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const styles = getComputedStyle(canvas);
    const panel = styles.getPropertyValue("--panel").trim() || "#2b2b2b";
    const line = styles.getPropertyValue("--line-soft").trim() || "#353535";
    const accent = styles.getPropertyValue("--accent").trim() || "#f28c18";

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    context.fillStyle = panel;
    context.fillRect(0, 0, width, HEIGHT);

    context.strokeStyle = line;
    context.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = 8 + ((HEIGHT - 16) * i) / 4;
      context.beginPath();
      context.moveTo(8, y);
      context.lineTo(width - 8, y);
      context.stroke();
    }

    if (clip.points.length > 0) {
      context.strokeStyle = accent;
      context.lineWidth = 2;
      context.beginPath();

      clip.points.forEach((point, index) => {
        const { x, y } = toCanvas(point.step, point.value);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });

      context.stroke();

      context.fillStyle = accent;
      for (const point of clip.points) {
        const { x, y } = toCanvas(point.step, point.value);
        context.beginPath();
        context.arc(x, y, 4, 0, Math.PI * 2);
        context.fill();
      }
    }
  }, [clip.points, theme, toCanvas]);

  const pointAt = (x: number, y: number): string | null => {
    for (const point of clip.points) {
      const position = toCanvas(point.step, point.value);
      if (Math.hypot(position.x - x, position.y - y) <= HIT_RADIUS) return point.id;
    }
    return null;
  };

  const onUp = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    endEdit();
  }, [endEdit]);

  // Close an interrupted gesture on unmount only — see useUnmount.
  useUnmount(onUp);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pointId = dragRef.current;
      const canvas = canvasRef.current;
      if (!pointId || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const { step, value } = fromCanvas(event.clientX - rect.left, event.clientY - rect.top);
      updateAutomationPoint(clip.id, pointId, value, step);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [clip.id, endEdit, fromCanvas, updateAutomationPoint]);

  const targetValue =
    clip.targetType === "master" ? "master" : `${clip.targetType}:${clip.targetId}`;

  return (
    <div className="automation-editor">
      <div className="automation-target">
        <label>
          Target
          <select
            value={targetValue}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === "master") {
                setAutomationTarget(clip.id, "master", "master", clip.targetParam);
                return;
              }

              const [type, id] = raw.split(":");
              setAutomationTarget(
                clip.id,
                type as AutomationTargetType,
                id,
                clip.targetParam
              );
            }}
          >
            <option value="master">Master</option>
            <optgroup label="Channels">
              {channels.map((channel) => (
                <option key={channel.id} value={`channel:${channel.id}`}>
                  {channel.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Mixer inserts">
              {mixerTracks.map((track) => (
                <option key={track.id} value={`mixer:${track.id}`}>
                  {track.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <label>
          Parameter
          <select
            value={clip.targetParam}
            onChange={(event) =>
              setAutomationTarget(
                clip.id,
                clip.targetType,
                clip.targetId,
                event.target.value as AutomationParam
              )
            }
          >
            <option value="volume">Volume</option>
            <option value="pan" disabled={clip.targetType === "master"}>
              Pan
            </option>
          </select>
        </label>
      </div>

      <canvas
        ref={canvasRef}
        className="automation-canvas"
        onContextMenu={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const pointId = pointAt(event.clientX - rect.left, event.clientY - rect.top);
          if (pointId) removeAutomationPoint(clip.id, pointId);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;

          const existing = pointAt(x, y);

          if (existing) {
            beginEdit("Move automation point");
            dragRef.current = existing;
            return;
          }

          const { step, value } = fromCanvas(x, y);
          addAutomationPoint(clip.id, step, value);
        }}
      />

      <span className="small-note">
        Click to add a point · drag to shape · right-click removes
      </span>
    </div>
  );
}
