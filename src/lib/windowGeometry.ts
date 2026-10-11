/**
 * Where a floating window may be, and how it moves and resizes. Pure sums, so the
 * rules (a window never leaves the work area, any edge or corner resizes it, the
 * opposite side stays put) can be checked without a screen.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_WINDOW: Size = { width: 320, height: 160 };

/** Which edge or corner is being dragged. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const between = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The smallest a window can be: the usual minimum, or the whole area when that is smaller still. */
function minimum(area: Size, min: Size): Size {
  return { width: Math.min(min.width, area.width), height: Math.min(min.height, area.height) };
}

/** Make a window fit: no bigger than the area, and wholly inside it. An unknown (zero) area leaves it alone. */
export function clampRect(rect: Rect, area: Size, min: Size = MIN_WINDOW): Rect {
  if (area.width <= 0 || area.height <= 0) return rect;
  const least = minimum(area, min);
  const width = Math.round(between(rect.width, least.width, area.width));
  const height = Math.round(between(rect.height, least.height, area.height));
  return {
    width,
    height,
    x: Math.round(between(rect.x, 0, area.width - width)),
    y: Math.round(between(rect.y, 0, area.height - height))
  };
}

/**
 * Where a window may be placed: no bigger than the area, and free to sit partly out of view, but with a strip
 * of it always showing (and its title bar never above the area) so it can be grabbed again.
 */
export function looseRect(rect: Rect, area: Size, min: Size = MIN_WINDOW, keep = 150, bar = 26): Rect {
  if (area.width <= 0 || area.height <= 0) return rect;
  const least = minimum(area, min);
  const width = Math.round(between(rect.width, least.width, area.width));
  const height = Math.round(between(rect.height, least.height, area.height));
  const showing = Math.min(keep, width);
  return {
    width,
    height,
    x: Math.round(between(rect.x, showing - width, area.width - showing)),
    y: Math.round(between(rect.y, 0, area.height - Math.min(bar, height)))
  };
}

/**
 * A window dragged by its title bar. It can be carried partly out of view and left there, and it draws to the
 * edges of the area (and to flush against the far edges) when it comes close.
 */
export function moveRect(start: Rect, dx: number, dy: number, area: Size, snap = 10): Rect {
  const moved = looseRect({ ...start, x: start.x + dx, y: start.y + dy }, area);
  if (area.width <= 0 || area.height <= 0 || snap <= 0) return moved;

  const pull = (position: number, size: number, extent: number) => {
    if (Math.abs(position) <= snap) return 0;
    if (Math.abs(extent - (position + size)) <= snap) return extent - size;
    return position;
  };
  return { ...moved, x: pull(moved.x, moved.width, area.width), y: pull(moved.y, moved.height, area.height) };
}

/**
 * A window resized from one edge or corner. The side opposite the one dragged stays
 * where it is, the window cannot go below its minimum size or past the area.
 */
export function resizeRect(start: Rect, edge: Edge, dx: number, dy: number, area: Size, min: Size = MIN_WINDOW): Rect {
  const known = area.width > 0 && area.height > 0;
  const least = known ? minimum(area, min) : min;

  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (edge.includes("w")) left = start.x + dx;
  if (edge.includes("e")) right = start.x + start.width + dx;
  if (edge.includes("n")) top = start.y + dy;
  if (edge.includes("s")) bottom = start.y + start.height + dy;

  if (known) {
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(area.width, right);
    bottom = Math.min(area.height, bottom);
  }

  // Not smaller than the minimum: the dragged side stops, the other keeps its place.
  if (right - left < least.width) {
    if (edge.includes("w")) left = right - least.width;
    else right = left + least.width;
  }
  if (bottom - top < least.height) {
    if (edge.includes("n")) top = bottom - least.height;
    else bottom = top + least.height;
  }

  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

/** A window carried along when the area changes size: the same share of it, then made to fit. */
export function scaleRect(rect: Rect, from: Size, to: Size, min: Size = MIN_WINDOW): Rect {
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return looseRect(rect, to, min);
  const fx = to.width / from.width;
  const fy = to.height / from.height;
  return looseRect(
    { x: rect.x * fx, y: rect.y * fy, width: rect.width * fx, height: rect.height * fy },
    to,
    min
  );
}

/** The mouse pointer to show over each handle. */
export const EDGE_CURSOR: Record<Edge, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize"
};
