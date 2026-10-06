import { useEffect, useRef } from "react";

import { getSample, getWaveformPeaks } from "../audio/sampleRegistry";
import { useSamples } from "../hooks/useStudio";
import { useSessionStore } from "../state/sessionStore";

interface WaveformProps {
  sampleId: string;
  width?: number;
  height?: number;
  color?: string;
  /** Normalised 0..1 trim handles, drawn as a highlighted region. */
  trimStart?: number;
  trimEnd?: number;
  onScrub?: (position: number) => void;
}

export function Waveform({
  sampleId,
  width = 210,
  height = 54,
  color = "var(--accent)",
  trimStart = 0,
  trimEnd = 1,
  onScrub
}: WaveformProps) {
  // The canvas reads its colours from CSS variables at draw time, so the
  // theme has to be a dependency — otherwise switching themes recolours the
  // HTML chrome and leaves this painted in the old palette.
  const theme = useSessionStore((state) => state.theme);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Re-draw when the registry changes (e.g. the sample finished decoding).
  const samples = useSamples();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Resolve CSS variables to real colours — canvas can't use them directly.
    const styles = getComputedStyle(canvas);
    const resolve = (value: string): string => {
      const match = value.match(/var\((--[^)]+)\)/);
      return match ? styles.getPropertyValue(match[1]).trim() || "#888" : value;
    };

    const waveColor = resolve(color);
    const muted = styles.getPropertyValue("--muted").trim() || "#888";
    const line = styles.getPropertyValue("--line-soft").trim() || "#333";

    context.clearRect(0, 0, width, height);

    const sample = getSample(sampleId);

    if (!sample) {
      context.fillStyle = muted;
      context.font = "11px system-ui, sans-serif";
      context.fillText("No sample loaded", 6, height / 2 + 4);
      return;
    }

    const numPeaks = Math.max(40, Math.min(Math.floor(width), 240));
    const peaks = getWaveformPeaks(sampleId, numPeaks);
    const barWidth = width / numPeaks;
    const centre = height / 2;

    // Dim the trimmed-away regions so the playable range reads at a glance.
    context.fillStyle = line;
    context.fillRect(0, 0, width * trimStart, height);
    context.fillRect(width * trimEnd, 0, width * (1 - trimEnd), height);

    for (let i = 0; i < numPeaks; i++) {
      const position = i / numPeaks;
      const inRange = position >= trimStart && position < trimEnd;
      const barHeight = Math.max(1, peaks[i] * (height - 6));

      context.fillStyle = inRange ? waveColor : muted;
      context.globalAlpha = inRange ? 1 : 0.3;
      context.fillRect(
        i * barWidth + 0.5,
        centre - barHeight / 2,
        Math.max(1, barWidth - 1),
        barHeight
      );
    }

    context.globalAlpha = 1;
    context.strokeStyle = line;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, centre + 0.5);
    context.lineTo(width, centre + 0.5);
    context.stroke();
  }, [sampleId, width, height, color, trimStart, trimEnd, samples, theme]);

  return (
    <canvas
      ref={canvasRef}
      className="waveform-canvas"
      onPointerDown={
        onScrub
          ? (event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onScrub(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
            }
          : undefined
      }
    />
  );
}
