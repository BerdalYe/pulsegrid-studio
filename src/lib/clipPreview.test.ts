import { describe, expect, it } from "vitest";

import { patternShapes } from "./clipPreview";
import type { Channel, Pattern } from "../types";

const channel = (id: string, type: Channel["type"]): Channel => ({
  id,
  name: id,
  type,
  color: "#fff",
  mute: false,
  solo: false,
  volume: 1,
  pan: 0,
  mixerTrackId: 1
});

const empty = (length = 16) => Array<number | null>(length).fill(null);

describe("playlist clip previews", () => {
  it("draws nothing for an empty pattern", () => {
    const pattern: Pattern = { id: "p", name: "P", length: 16, channels: { k: { steps: empty(), notes: [] } } };
    expect(patternShapes(pattern, [channel("k", "kick")])).toEqual([]);
  });

  it("puts each drum lane on its own row, one mark per hit", () => {
    const kick = empty();
    kick[0] = 1;
    kick[8] = 1;
    const hat = empty();
    hat[2] = 0.5;

    const pattern: Pattern = {
      id: "p",
      name: "Drums",
      length: 16,
      channels: { k: { steps: kick, notes: [] }, h: { steps: hat, notes: [] } }
    };

    const shapes = patternShapes(pattern, [channel("k", "kick"), channel("h", "hat")]);
    expect(shapes).toHaveLength(3);

    const kickRow = shapes.filter((shape) => shape.x < 1 || (shape.x > 8 && shape.x < 9));
    const hatHit = shapes.find((shape) => shape.x > 2 && shape.x < 3);
    // Different rows, and the quieter hit is drawn fainter.
    expect(hatHit?.y).toBeGreaterThan(kickRow[0].y);
    expect(hatHit?.opacity).toBeLessThan(kickRow[0].opacity);
  });

  it("draws notes by pitch, higher notes nearer the top, inside the clip", () => {
    const pattern: Pattern = {
      id: "p",
      name: "Melody",
      length: 16,
      channels: {
        s: {
          steps: empty(),
          notes: [
            { id: "a", pitch: 60, start: 0, length: 4, velocity: 100 },
            { id: "b", pitch: 72, start: 4, length: 2, velocity: 100 }
          ]
        }
      }
    };

    const [low, high] = patternShapes(pattern, [channel("s", "synth")]);
    expect(high.y).toBeLessThan(low.y);
    expect(low.w).toBeCloseTo(3.88, 2);

    for (const shape of [low, high]) {
      expect(shape.y).toBeGreaterThanOrEqual(0);
      expect(shape.y + shape.h).toBeLessThanOrEqual(100);
    }
  });

  it("keeps drums above notes when a pattern has both", () => {
    const kick = empty();
    kick[0] = 1;
    const pattern: Pattern = {
      id: "p",
      name: "Both",
      length: 16,
      channels: {
        k: { steps: kick, notes: [] },
        s: { steps: empty(), notes: [{ id: "n", pitch: 64, start: 0, length: 1, velocity: 90 }] }
      }
    };

    const [hit, note] = patternShapes(pattern, [channel("k", "kick"), channel("s", "synth")]);
    expect(hit.y + hit.h).toBeLessThan(note.y);
  });
});
