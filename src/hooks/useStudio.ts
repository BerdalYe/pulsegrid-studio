import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  canRedo,
  canUndo,
  nextRedoLabel,
  nextUndoLabel,
  subscribeHistory
} from "../state/history";

import {
  getAllSamples,
  getSamplesVersion,
  subscribeSamples,
  type RegisteredSample
} from "../audio/sampleRegistry";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";

/** Undo/redo availability, sourced from the history module rather than state. */
export function useHistoryStatus(): {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
} {
  const undoable = useSyncExternalStore(subscribeHistory, canUndo, () => false);
  const redoable = useSyncExternalStore(subscribeHistory, canRedo, () => false);
  const undoLabel = useSyncExternalStore(subscribeHistory, nextUndoLabel, () => null);
  const redoLabel = useSyncExternalStore(subscribeHistory, nextRedoLabel, () => null);

  return { canUndo: undoable, canRedo: redoable, undoLabel, redoLabel };
}

export function useSamples(): RegisteredSample[] {
  const version = useSyncExternalStore(subscribeSamples, getSamplesVersion, () => 0);
  return useMemo(() => getAllSamples(), [version]);
}

export function useSample(sampleId: string | undefined): RegisteredSample | undefined {
  const samples = useSamples();
  return useMemo(
    () => samples.find((sample) => sample.id === sampleId),
    [samples, sampleId]
  );
}

/** The pattern the user is currently editing, kept in sync with the session. */
export function useSelectedPattern() {
  const selectedPatternId = useSessionStore((state) => state.selectedPatternId);
  const patterns = useProjectStore((state) => state.patterns);
  const patternOrder = useProjectStore((state) => state.patternOrder);
  const selectPattern = useSessionStore((state) => state.selectPattern);

  const pattern = patterns[selectedPatternId];

  // If the selected pattern was deleted (or a project was just loaded), fall
  // back to the first one rather than rendering an empty editor.
  useEffect(() => {
    if (!pattern && patternOrder.length > 0) selectPattern(patternOrder[0]);
  }, [pattern, patternOrder, selectPattern]);

  return { pattern, patternId: pattern ? selectedPatternId : patternOrder[0] ?? "" };
}

export function useSelectedChannel() {
  const selectedChannelId = useSessionStore((state) => state.selectedChannelId);
  const channels = useProjectStore((state) => state.channels);
  const selectChannel = useSessionStore((state) => state.selectChannel);

  const channel = channels.find((entry) => entry.id === selectedChannelId);

  useEffect(() => {
    if (!channel && channels.length > 0) selectChannel(channels[0].id);
  }, [channel, channels, selectChannel]);

  return channel;
}

/**
 * Poll a value on every animation frame. Used for meters and the playhead,
 * where React state churn would be far more expensive than a direct read.
 */
export function useAnimationValue(read: () => number, active = true): number {
  const [value, setValue] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (!active) {
      setValue(0);
      return;
    }

    let frame = 0;
    let last = -1;

    const tick = () => {
      const next = readRef.current();
      // Only re-render on a visible change.
      if (Math.abs(next - last) > 0.008) {
        last = next;
        setValue(next);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return value;
}

/**
 * Wrap a continuous gesture so the whole drag collapses into one undo step.
 */
export function useGesture(label: string): {
  begin: () => void;
  end: () => void;
} {
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);
  const activeRef = useRef(false);

  const end = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    endEdit();
  }, [endEdit]);

  const begin = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    beginEdit(label);
  }, [beginEdit, label]);

  // A gesture must never be left open — a pointer released outside the window
  // still has to close it.
  useEffect(() => {
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      end();
    };
  }, [end]);

  return { begin, end };
}

/**
 * FL's hint bar: whatever the pointer is over describes itself in one line.
 *
 * Reads the nearest `data-hint`, `title` or `aria-label` from the hovered
 * element, so controls get a hint for free from the labels they already carry.
 */
export function useHoverHint(): string {
  const [hint, setHint] = useState("");

  useEffect(() => {
    const onOver = (event: PointerEvent) => {
      const element = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-hint], [title], [aria-label]"
      );

      if (!element) {
        setHint("");
        return;
      }

      setHint(
        element.dataset.hint ??
          element.getAttribute("title") ??
          element.getAttribute("aria-label") ??
          ""
      );
    };

    const onLeave = () => setHint("");

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerleave", onLeave);

    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return hint;
}

/**
 * Run `fn` when the component unmounts — and only then.
 *
 * An inline effect cleanup also runs on every dependency change. For a drag
 * handler whose effect depends on the data it edits, that means the gesture is
 * torn down the instant it makes its first change: a note drag would move one
 * step and stop, and a paint stroke would place one note.
 */
export function useUnmount(fn: () => void): void {
  const latest = useRef(fn);

  useEffect(() => {
    latest.current = fn;
  }, [fn]);

  useEffect(() => () => latest.current(), []);
}
