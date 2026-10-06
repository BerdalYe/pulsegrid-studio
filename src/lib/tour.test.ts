import { describe, expect, it } from "vitest";

import { TOUR_STEPS, placeCard } from "./tour";

const viewport = { width: 1200, height: 800 };
const card = { width: 300, height: 150 };

describe("placeCard", () => {
  it("centres the card when there is nothing to point at", () => {
    expect(placeCard(null, card, viewport)).toEqual({ top: 325, left: 450 });
  });

  it("goes below a target near the top, centred under it", () => {
    const place = placeCard({ top: 10, left: 500, width: 200, height: 40 }, card, viewport);
    expect(place).toEqual({ top: 62, left: 450 });
  });

  it("goes above a target near the bottom", () => {
    const place = placeCard({ top: 770, left: 0, width: 1200, height: 24 }, card, viewport);
    expect(place.top).toBe(770 - 12 - 150);
  });

  it("never leaves the screen at the edges", () => {
    const place = placeCard({ top: 10, left: 1150, width: 40, height: 30 }, card, viewport);
    expect(place.left).toBe(1200 - 300 - 8);
  });

  it("sits inside a target that fills the screen", () => {
    const place = placeCard({ top: 0, left: 0, width: 1200, height: 800 }, card, viewport);
    expect(place.top).toBeGreaterThanOrEqual(8);
    expect(place.left + card.width).toBeLessThanOrEqual(1200 - 8);
  });
});

describe("TOUR_STEPS", () => {
  it("opens with a welcome that points at nothing", () => {
    expect(TOUR_STEPS[0].target).toBeUndefined();
  });

  it("keeps every step short enough to read at a glance", () => {
    for (const step of TOUR_STEPS) expect(step.text.length).toBeLessThan(200);
  });
});
