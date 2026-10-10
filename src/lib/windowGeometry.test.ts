import { describe, expect, it } from "vitest";

import { clampRect, moveRect, resizeRect, scaleRect, type Edge, type Rect } from "./windowGeometry";

const area = { width: 1000, height: 600 };
const inside = (rect: Rect) =>
  rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= area.width && rect.y + rect.height <= area.height;

describe("keeping a window inside the area", () => {
  it("pulls a window that hangs off the right and bottom back in, keeping its size", () => {
    const r = clampRect({ x: 900, y: 500, width: 400, height: 300 }, area);
    expect(r).toEqual({ x: 600, y: 300, width: 400, height: 300 });
  });

  it("shrinks a window that is bigger than the area", () => {
    const r = clampRect({ x: -50, y: -20, width: 3000, height: 2000 }, area);
    expect(r).toEqual({ x: 0, y: 0, width: 1000, height: 600 });
  });

  it("lifts a window above the minimum size", () => {
    const r = clampRect({ x: 10, y: 10, width: 50, height: 20 }, area);
    expect(r.width).toBe(320);
    expect(r.height).toBe(160);
  });

  it("does not demand more than a tiny area has", () => {
    const r = clampRect({ x: 0, y: 0, width: 500, height: 500 }, { width: 200, height: 100 });
    expect(r).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it("leaves a window alone while the area is not known yet", () => {
    const rect = { x: 5000, y: 5000, width: 400, height: 300 };
    expect(clampRect(rect, { width: 0, height: 0 })).toBe(rect);
  });
});

describe("moving", () => {
  const start = { x: 100, y: 100, width: 400, height: 300 };

  it("follows the pointer", () => {
    expect(moveRect(start, 50, 40, area, 0)).toEqual({ x: 150, y: 140, width: 400, height: 300 });
  });

  it("stops at every edge of the area, whatever the pointer does", () => {
    for (const [dx, dy] of [[-9999, 0], [9999, 0], [0, -9999], [0, 9999], [9999, 9999], [-9999, -9999]]) {
      expect(inside(moveRect(start, dx, dy, area))).toBe(true);
    }
  });

  it("draws to an edge when it comes close", () => {
    expect(moveRect(start, -92, 0, area).x).toBe(0);
    expect(moveRect(start, 495, 0, area).x).toBe(600);
    expect(moveRect(start, 0, 195, area).y).toBe(300);
    expect(moveRect(start, 30, 30, area).x).toBe(130);
  });
});

describe("resizing from any side", () => {
  const start = { x: 200, y: 150, width: 400, height: 300 };

  it("moves only the edge that is dragged", () => {
    expect(resizeRect(start, "e", 50, 99, area)).toEqual({ x: 200, y: 150, width: 450, height: 300 });
    expect(resizeRect(start, "s", 99, 40, area)).toEqual({ x: 200, y: 150, width: 400, height: 340 });
    expect(resizeRect(start, "w", -60, 99, area)).toEqual({ x: 140, y: 150, width: 460, height: 300 });
    expect(resizeRect(start, "n", 99, -30, area)).toEqual({ x: 200, y: 120, width: 400, height: 330 });
  });

  it("moves two edges at a corner", () => {
    expect(resizeRect(start, "se", 10, 20, area)).toEqual({ x: 200, y: 150, width: 410, height: 320 });
    expect(resizeRect(start, "nw", -10, -20, area)).toEqual({ x: 190, y: 130, width: 410, height: 320 });
    expect(resizeRect(start, "ne", 10, -20, area)).toEqual({ x: 200, y: 130, width: 410, height: 320 });
    expect(resizeRect(start, "sw", -10, 20, area)).toEqual({ x: 190, y: 150, width: 410, height: 320 });
  });

  it("keeps the opposite side where it is when it reaches the minimum size", () => {
    const r = resizeRect(start, "w", 9999, 0, area);
    expect(r.width).toBe(320);
    expect(r.x + r.width).toBe(600);
    const t = resizeRect(start, "n", 0, 9999, area);
    expect(t.height).toBe(160);
    expect(t.y + t.height).toBe(450);
    const e = resizeRect(start, "e", -9999, 0, area);
    expect(e.x).toBe(200);
    expect(e.width).toBe(320);
  });

  it("never grows past the area, from any edge", () => {
    const edges: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
    for (const edge of edges) {
      for (const [dx, dy] of [[9999, 9999], [-9999, -9999], [9999, -9999], [-9999, 9999]]) {
        expect(inside(resizeRect(start, edge, dx, dy, area)), `${edge} ${dx},${dy}`).toBe(true);
      }
    }
  });
});

describe("when the area changes size", () => {
  it("carries a window along as the same share of the area", () => {
    const r = scaleRect({ x: 100, y: 50, width: 500, height: 300 }, { width: 1000, height: 500 }, { width: 2000, height: 1000 });
    expect(r).toEqual({ x: 200, y: 100, width: 1000, height: 600 });
  });

  it("shrinks it with the area and keeps it inside", () => {
    const r = scaleRect({ x: 600, y: 300, width: 400, height: 300 }, { width: 1000, height: 600 }, { width: 500, height: 300 });
    expect(r.width).toBe(320); // not below the minimum
    expect(r.x + r.width).toBeLessThanOrEqual(500);
    expect(r.y + r.height).toBeLessThanOrEqual(300);
  });

  it("only fits the window when the old size is unknown", () => {
    const r = scaleRect({ x: 2000, y: 0, width: 400, height: 300 }, { width: 0, height: 0 }, area);
    expect(inside(r)).toBe(true);
  });
});
