import { describe, expect, it } from "vitest";

import {
  clampIndex,
  scrollToKeep,
  unitUnderPointer,
  wheelIntent,
  wheelPixels,
  zoomSteps
} from "./wheelZoom";

const keys = (init: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init
});

describe("wheelIntent", () => {
  it("zooms on a plain turn when the wheel is set to zoom", () => {
    expect(wheelIntent(keys(), true)).toBe("zoom");
  });

  it("leaves the plain wheel to the browser when it is set to scroll", () => {
    expect(wheelIntent(keys(), false)).toBe("native");
    expect(wheelIntent(keys({ shiftKey: true }), false)).toBe("native");
  });

  it("always zooms with Ctrl or Cmd, which is also how a trackpad pinch arrives", () => {
    expect(wheelIntent(keys({ ctrlKey: true }), false)).toBe("zoom");
    expect(wheelIntent(keys({ metaKey: true }), false)).toBe("zoom");
    expect(wheelIntent(keys({ ctrlKey: true }), true)).toBe("zoom");
  });

  it("scrolls sideways with Shift and up and down with Alt when the wheel zooms", () => {
    expect(wheelIntent(keys({ shiftKey: true }), true)).toBe("scrollX");
    expect(wheelIntent(keys({ altKey: true }), true)).toBe("scrollY");
  });
});

describe("zoomSteps", () => {
  it("zooms in when scrolling up and out when scrolling down, a level per notch", () => {
    expect(zoomSteps(-100, 0).steps).toBe(1);
    expect(zoomSteps(100, 0).steps).toBe(-1);
  });

  it("moves exactly one level for every notch of a mouse wheel, however many in a row", () => {
    let carried = 0;
    let total = 0;
    for (let i = 0; i < 10; i += 1) {
      const result = zoomSteps(-100, carried);
      carried = result.carried;
      total += result.steps;
    }
    expect(total).toBe(10);
  });

  it("adds up the small movements of a trackpad", () => {
    let carried = 0;
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      const result = zoomSteps(-12, carried);
      carried = result.carried;
      total += result.steps;
    }
    // 240 pixels of movement is two levels, not twenty and not none.
    expect(total).toBe(2);
  });

  it("waits for enough movement before changing a level", () => {
    const first = zoomSteps(-40, 0);
    expect(first.steps).toBe(0);
    const second = zoomSteps(-40, first.carried);
    expect(second.steps).toBe(0);
    expect(zoomSteps(-40, second.carried).steps).toBe(1);
  });

  it("can take a big movement as several levels", () => {
    expect(zoomSteps(-250, 0).steps).toBe(2);
    expect(zoomSteps(350, 0).steps).toBe(-3);
  });
});

describe("wheelPixels", () => {
  it("understands lines and pages as well as pixels", () => {
    expect(wheelPixels(120, 0)).toBe(120);
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(1, 2)).toBe(400);
  });
});

describe("keeping the spot under the pointer", () => {
  it("stays put on screen when zooming in and out", () => {
    const gutter = 178;
    const scrollLeft = 400;
    const pointerX = 520;
    const before = 4;
    const after = 9;

    const unit = unitUnderPointer(scrollLeft, pointerX, gutter, before);
    const nextScroll = scrollToKeep(unit, after, gutter, pointerX);

    // The same step is under the pointer before and after.
    expect(unitUnderPointer(nextScroll, pointerX, gutter, after)).toBeCloseTo(unit, 0);
    expect(nextScroll).toBeGreaterThan(scrollLeft);
  });

  it("never scrolls before the start", () => {
    expect(scrollToKeep(0, 4, 56, 56)).toBe(0);
    expect(scrollToKeep(1, 2, 56, 400)).toBe(0);
  });

  it("treats a pointer over the fixed header as the left edge of the grid", () => {
    const gutter = 178;
    expect(unitUnderPointer(0, 10, gutter, 4)).toBe(0);
    expect(scrollToKeep(0, 8, gutter, 10)).toBe(0);
  });
});

describe("clampIndex", () => {
  it("stays within the zoom levels", () => {
    expect(clampIndex(-3, 7)).toBe(0);
    expect(clampIndex(3, 7)).toBe(3);
    expect(clampIndex(99, 7)).toBe(6);
  });
});
