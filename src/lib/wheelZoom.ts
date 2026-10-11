/**
 * The maths behind zooming the piano roll and playlist with the mouse wheel,
 * kept apart from the components so it can be tested.
 */

export type WheelIntent = "zoom" | "scrollX" | "scrollY" | "native";

/**
 * What should this wheel turn do?
 *
 *  - Ctrl (or Cmd) + wheel always zooms. A touchpad pinch arrives as exactly this.
 *  - A touchpad's two-finger drag scrolls, in both directions, as anywhere else:
 *    it has no notches to count, so zooming on it would be impossible to control.
 *  - With "scroll wheel zooms" on, a mouse wheel zooms, Shift scrolls sideways
 *    and Alt scrolls up and down.
 *  - With it off the mouse wheel is left to the browser, which scrolls.
 */
export function wheelIntent(
  event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  wheelZooms: boolean,
  touchpad = false
): WheelIntent {
  if (event.ctrlKey || event.metaKey) return "zoom";
  if (touchpad || !wheelZooms) return "native";
  if (event.shiftKey) return "scrollX";
  if (event.altKey) return "scrollY";
  return "zoom";
}

/**
 * Did this wheel event come from a touchpad rather than a mouse wheel? A mouse wheel moves in whole
 * notches: a line or page at a time, or 120 units of the old wheelDelta per notch, and only up and
 * down. A touchpad sends a stream of small, uneven movements, often sideways too, and so does a pinch.
 */
export function looksLikeTouchpad(event: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey?: boolean;
  wheelDeltaX?: number;
  wheelDeltaY?: number;
}): boolean {
  if (event.deltaMode !== 0) return false;
  // Shift turns a mouse wheel sideways, so a sideways movement only gives a touchpad away without it.
  if (event.deltaX !== 0 && event.deltaY !== 0) return true;
  if (event.deltaX !== 0 && !event.shiftKey) return true;
  // A fraction of a pixel, or a movement much smaller than a notch, is a touchpad (the old wheelDelta can't be
  // trusted for these: Chromium rounds some of them up to a whole notch of 120).
  const delta = Math.abs(event.deltaY || event.deltaX);
  if (!Number.isInteger(delta) || delta < 50) return true;
  // A big whole movement: a notch, unless the old wheelDelta says it isn't one.
  const legacy = event.wheelDeltaY || event.wheelDeltaX;
  return legacy !== undefined && legacy !== 0 && legacy % 120 !== 0;
}

/** How far a pinch has to close or open before the zoom moves a level: about one level's change in size. */
export const PINCH_THRESHOLD = 18;

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
export function zoomSteps(
  pixels: number,
  carried: number,
  threshold = THRESHOLD
): { steps: number; carried: number } {
  const total = carried + pixels;
  const whole = Math.trunc(total / threshold);
  return { steps: -whole, carried: total - whole * threshold };
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
