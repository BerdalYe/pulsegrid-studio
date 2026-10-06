import { useCallback, useEffect, useRef, type RefObject } from "react";

import {
  clampIndex,
  scrollToKeep,
  unitUnderPointer,
  wheelIntent,
  wheelPixels,
  zoomSteps
} from "../lib/wheelZoom";
import { useSessionStore } from "../state/sessionStore";

interface WheelZoomOptions {
  /** The scrolling area that holds the timeline. */
  containerRef: RefObject<HTMLElement | null>;
  /** Pixels per step at each zoom level, smallest first. */
  levels: readonly number[];
  index: number;
  setIndex: (next: number) => void;
  /** The fixed strip at the left of the area (track headers, piano keys) that doesn't zoom. */
  gutter: number;
  /** False while the area isn't on screen yet. */
  active?: boolean;
}

/**
 * Zoom a timeline with the mouse wheel, keeping whatever is under the pointer
 * where it is, the way a map zooms. Also gives the keyboard the same zoom, anchored on
 * the middle of the view. What the wheel does is decided by wheelIntent().
 */
export function useWheelZoom({
  containerRef,
  levels,
  index,
  setIndex,
  gutter,
  active = true
}: WheelZoomOptions): { zoomBy: (steps: number) => void; zoomTo: (level: number) => void } {
  // The wheel handler lives as long as the element does, so it reads the
  // current values from here rather than from the render it was made in.
  const live = useRef({ index, levels, gutter, setIndex });
  live.current = { index, levels, gutter, setIndex };

  const carried = useRef(0);
  const anchor = useRef<{ unit: number; pointerX: number } | null>(null);

  const zoomTo = useCallback(
    (next: number, pointerX: number | null) => {
      const { index: current, levels: table, gutter: strip, setIndex: change } = live.current;
      const target = clampIndex(next, table.length);
      if (target === current) return;

      const element = containerRef.current;
      if (element) {
        const x = pointerX ?? strip + (element.clientWidth - strip) / 2;
        anchor.current = {
          unit: unitUnderPointer(element.scrollLeft, x, strip, table[current]),
          pointerX: x
        };
      }

      // Several wheel events can arrive before the next render.
      live.current.index = target;
      change(target);
    },
    [containerRef]
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !active) return;

    const onWheel = (event: WheelEvent) => {
      const intent = wheelIntent(event, useSessionStore.getState().wheelZoom);
      if (intent === "native") return;

      // Stop the page itself from zooming or scrolling as well.
      event.preventDefault();

      const pixels = wheelPixels(event.deltaY || event.deltaX, event.deltaMode);

      if (intent === "scrollX") {
        element.scrollLeft += pixels;
        return;
      }
      if (intent === "scrollY") {
        element.scrollTop += pixels;
        return;
      }

      const { steps, carried: rest } = zoomSteps(pixels, carried.current);
      carried.current = rest;
      if (steps === 0) return;

      zoomTo(live.current.index + steps, event.clientX - element.getBoundingClientRect().left);
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [active, containerRef, zoomTo]);

  // After the zoom has changed the width, put the anchored spot back under the pointer.
  useEffect(() => {
    const target = anchor.current;
    const element = containerRef.current;
    if (!target || !element) return;
    anchor.current = null;

    const place = () => {
      element.scrollLeft = scrollToKeep(target.unit, levels[index], gutter, target.pointerX);
    };

    place();
    // The piano roll resizes its canvas a moment after React has rendered.
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [containerRef, gutter, index, levels]);

  return {
    zoomBy: useCallback((steps: number) => zoomTo(live.current.index + steps, null), [zoomTo]),
    zoomTo: useCallback((level: number) => zoomTo(level, null), [zoomTo])
  };
}
