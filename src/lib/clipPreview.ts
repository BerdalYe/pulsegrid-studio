import type { Channel, Pattern } from "../types";
import { isStepActive } from "./utils";

export interface PreviewShape {
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

/**
 * Lay a pattern out in a 1-step-wide, 100-high box: drum and step lanes as
 * rows of hits along the top, notes as a mini piano roll below, scaled to the
 * pitch range actually used. Velocity sets how strong each mark is.
 */
export function patternShapes(pattern: Pattern, channels: Channel[]): PreviewShape[] {
  const shapes: PreviewShape[] = [];

  const stepLanes = channels
    .map((channel) => pattern.channels[channel.id])
    .filter((lane) => lane?.steps.some((cell) => isStepActive(cell)));
  const notes = channels.flatMap((channel) => pattern.channels[channel.id]?.notes ?? []);

  if (stepLanes.length === 0 && notes.length === 0) return shapes;

  const pad = 8;
  const both = stepLanes.length > 0 && notes.length > 0;
  const stepArea = both ? { top: pad, bottom: 42 } : { top: pad, bottom: 100 - pad };
  const noteArea = both ? { top: 48, bottom: 100 - pad } : { top: pad, bottom: 100 - pad };

  if (stepLanes.length > 0) {
    const span = stepArea.bottom - stepArea.top;
    // A single lane shouldn't become one tall block; cap each row's height.
    const rowHeight = Math.min(span / stepLanes.length, both ? 12 : 20);
    const top = stepArea.top + (span - rowHeight * stepLanes.length) / 2;

    stepLanes.forEach((lane, row) => {
      lane?.steps.forEach((cell, step) => {
        if (!isStepActive(cell)) return;
        shapes.push({
          x: step + 0.14,
          y: top + row * rowHeight + rowHeight * 0.15,
          w: 0.72,
          h: rowHeight * 0.7,
          opacity: 0.45 + 0.55 * (cell as number)
        });
      });
    });
  }

  if (notes.length > 0) {
    let low = Infinity;
    let high = -Infinity;
    for (const note of notes) {
      low = Math.min(low, note.pitch);
      high = Math.max(high, note.pitch);
    }

    // At least an octave of room, so a two-note riff doesn't fill the clip.
    const pitches = Math.max(12, high - low + 1);
    const centre = (low + high) / 2;
    const top = Math.round(centre + pitches / 2);
    const rowHeight = (noteArea.bottom - noteArea.top) / pitches;

    // Thick enough to read at a normal lane height even when a wide range of
    // pitches squeezes the rows together.
    const noteHeight = Math.max(rowHeight * 0.85, 7);

    for (const note of notes) {
      const y = noteArea.top + (top - note.pitch) * rowHeight;
      shapes.push({
        x: note.start,
        y: Math.min(Math.max(y, noteArea.top), noteArea.bottom - noteHeight),
        w: Math.max(0.4, note.length - 0.12),
        h: noteHeight,
        opacity: 0.55 + 0.45 * (note.velocity / 127)
      });
    }
  }

  return shapes;
}
