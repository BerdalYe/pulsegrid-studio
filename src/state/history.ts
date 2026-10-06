import type { ProjectData } from "../types";

/**
 * Undo/redo for project data.
 *
 * Snapshots are captured *before* a mutation runs, and because the store is
 * immer-backed the "snapshot" is just a reference to the current immutable
 * tree — no cloning, no JSON round-trips.
 *
 * Continuous gestures (fader drags, note drags, step painting) open a group:
 * the first mutation inside a group captures the pre-gesture state and every
 * later mutation in that group is folded into it, so one drag is one undo.
 */

const MAX_HISTORY = 200;

interface HistoryEntry {
  label: string;
  state: ProjectData;
}

let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];

let openGroup: string | null = null;

/** The entry the last `capture` pushed off the bottom, if any. */
let trimmed: HistoryEntry | null = null;
let groupCaptured = false;

let listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearHistory(): void {
  undoStack = [];
  redoStack = [];
  openGroup = null;
  groupCaptured = false;
  notify();
}

/**
 * Start folding subsequent captures into a single undo entry. Safe to call
 * when a group is already open — the outer group wins.
 */
export function beginGroup(name: string): void {
  if (openGroup !== null) return;
  openGroup = name;
  groupCaptured = false;
}

export function endGroup(): void {
  openGroup = null;
  groupCaptured = false;
}

export function isGroupOpen(): boolean {
  return openGroup !== null;
}

/**
 * Capture the pre-mutation state. Call this before applying a change.
 * Returns true when a new entry was actually pushed.
 */
export function capture(state: ProjectData, label = "Edit"): boolean {
  if (openGroup !== null) {
    if (groupCaptured) return false;
    groupCaptured = true;
  }

  undoStack.push({ label, state });

  // Remember what fell off the bottom, so reverting a no-op capture can put it
  // back. Without this, every no-op action on a full stack quietly costs the
  // user one step of real history at the far end.
  trimmed = undoStack.length > MAX_HISTORY ? undoStack.shift() ?? null : null;

  redoStack = [];
  notify();
  return true;
}

/**
 * Undo the most recent `capture`. Used when an action turned out to be a
 * no-op, so a wasted undo step doesn't pile up on the stack.
 */
export function revertCapture(): void {
  undoStack.pop();

  if (trimmed) {
    undoStack.unshift(trimmed);
    trimmed = null;
  }

  if (openGroup !== null) groupCaptured = false;
  notify();
}

export function popUndo(currentState: ProjectData): HistoryEntry | null {
  const entry = undoStack.pop();
  if (!entry) return null;

  redoStack.push({ label: entry.label, state: currentState });
  notify();
  return entry;
}

export function popRedo(currentState: ProjectData): HistoryEntry | null {
  const entry = redoStack.pop();
  if (!entry) return null;

  undoStack.push({ label: entry.label, state: currentState });
  notify();
  return entry;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

export function nextUndoLabel(): string | null {
  return undoStack[undoStack.length - 1]?.label ?? null;
}

export function nextRedoLabel(): string | null {
  return redoStack[redoStack.length - 1]?.label ?? null;
}
