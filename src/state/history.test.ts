import { beforeEach, describe, expect, it } from "vitest";

import {
  beginGroup,
  canRedo,
  canUndo,
  capture,
  clearHistory,
  endGroup,
  popRedo,
  popUndo,
  revertCapture
} from "./history";

import { createInitialProjectData } from "./initialState";
import type { ProjectData } from "../types";

function project(bpm: number): ProjectData {
  return { ...createInitialProjectData(), bpm };
}

describe("history", () => {
  beforeEach(() => clearHistory());

  it("captures the state as it was before the change", () => {
    const before = project(120);
    capture(before, "Tempo");

    const after = project(140);
    const entry = popUndo(after);

    expect(entry?.state.bpm).toBe(120);
    expect(entry?.label).toBe("Tempo");
  });

  it("round-trips through undo and redo", () => {
    const first = project(100);
    capture(first, "Tempo");

    const second = project(150);
    const undone = popUndo(second);
    expect(undone?.state.bpm).toBe(100);

    const redone = popRedo(undone!.state);
    expect(redone?.state.bpm).toBe(150);
  });

  it("folds a whole gesture into one entry", () => {
    beginGroup("Fader drag");
    capture(project(100), "Fader");
    capture(project(101), "Fader");
    capture(project(102), "Fader");
    endGroup();

    expect(popUndo(project(103))?.state.bpm).toBe(100);
    expect(canUndo()).toBe(false);
  });

  it("starts a new entry once the gesture ends", () => {
    beginGroup("drag one");
    capture(project(100));
    endGroup();

    beginGroup("drag two");
    capture(project(110));
    endGroup();

    expect(popUndo(project(120))?.state.bpm).toBe(110);
    expect(popUndo(project(110))?.state.bpm).toBe(100);
  });

  it("discards a capture for an edit that changed nothing", () => {
    capture(project(120), "Tempo");
    expect(canUndo()).toBe(true);

    revertCapture();
    expect(canUndo()).toBe(false);
  });

  it("clears the redo stack when new work happens", () => {
    capture(project(100));
    popUndo(project(110));
    expect(canRedo()).toBe(true);

    capture(project(110));
    expect(canRedo()).toBe(false);
  });

  it("reports nothing to undo on an empty stack", () => {
    expect(popUndo(project(120))).toBeNull();
    expect(popRedo(project(120))).toBeNull();
  });
});
