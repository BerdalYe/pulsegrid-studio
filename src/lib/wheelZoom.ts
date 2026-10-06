/**
 * The maths behind zooming the piano roll and playlist with the mouse wheel,
 * kept apart from the components so it can be tested.
 */

export type WheelIntent = "zoom" | "scrollX" | "scrollY" | "native";

/**
 * What should this wheel turn do?
 *
 *  - Ctrl (or Cmd) + wheel always zooms. A trackpad pinch arrives as exactly this.
 *  - With "scroll wheel zooms" on, the plain wheel zooms too, Shift scrolls
 *    sideways and Alt scrolls up and down.
 *  - With it off the plain wheel is left to the browser, which scrolls.
 */
export function wheelIntent(
  event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  wheelZooms: boolean
): WheelIntent {
  if (event.ctrlKey || event.metaKey) return "zoom";
  if (!wheelZooms) return "native";
  if (event.shiftKey) return "scrollX";
  if (event.altKey) return "scrollY";
  return "zoom";
}

/** One notch of a typical mouse wheel is about this many pixels. */
const NOTCH = 100;
/** How far to turn before the zoom moves a level: exactly one notch of a mouse wheel. */
const THRESHOLD = NOTCH;

/** A wheel event's movement in pixels, whatever unit the browser reports it in. */
export function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16; // lines
  if (deltaMode === 2) return delta * NOTCH * 4; // pages
  return delta;
}

/**
 * Turn wheel movement into zoom levels. Scrolling up zooms in (positive).
 * Small movements, like a trackpad's, add up until they are worth a level, and
 * the remainder is carried to the next event.
 */
export function zoomSteps(pixels: number, carried: number): { steps: number; carried: number } {
  const total = carried + pixels;
  const whole = Math.trunc(total / THRESHOLD);
  return { steps: -whole, carried: total - whole * THRESHOLD };
}

/** The point on the timeline (in steps) that is under the pointer. */
export function unitUnderPointer(
  scrollLeft: number,
  pointerX: number,
  gutter: number,
  pxPerUnit: number
): number {
  return (scrollLeft + Math.max(pointerX, gutter) - gutter) / pxPerUnit;
}

/** Where to scroll so that `unit` stays under the pointer after the zoom changed. */
export function scrollToKeep(unit: number, pxPerUnit: number, gutter: number, pointerX: number): number {
  return Math.max(0, Math.round(unit * pxPerUnit + gutter - Math.max(pointerX, gutter)));
}

export function clampIndex(index: number, count: number): number {
  return Math.min(count - 1, Math.max(0, index));
}
