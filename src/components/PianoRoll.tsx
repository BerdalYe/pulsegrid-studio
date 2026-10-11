import { platformText } from "../lib/hotkeys";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import { useProjectStore } from "../state/projectStore";
import { useWheelZoom } from "../hooks/useWheelZoom";
import { IconBrush, IconEraser, IconPencil, IconSelect } from "./icons";
import { matchShortcut } from "../lib/hotkeys";
import { useSessionStore } from "../state/sessionStore";
import { copyNotes, hasNotes, notesSpan, pastedNotes } from "../state/clipboard";
import { useTransportStore } from "../state/transportStore";
import { VelocityEditor } from "./VelocityEditor";
import { useSelectedChannel, useSelectedPattern, useUnmount } from "../hooks/useStudio";
import { auditionChannel, ensureAudio, noteOff, noteOn } from "../audio/engine";
import { drumName, isFullKit, stepPitchOf } from "../lib/drumKits";

import {
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  clamp,
  isBlackPitch,
  isPitchedChannel,
  isStepActive,
  pitchName,
  snapStep,
  uid
} from "../lib/utils";

import type { Channel, NoteData, Pattern } from "../types";

const MIN_PITCH = 24;
const MAX_PITCH = 108;
const ROW_COUNT = MAX_PITCH - MIN_PITCH + 1;
const ROW_HEIGHT = 15;
const KEYBOARD_WIDTH = 56;
/** Wide enough for a drum's name beside each key, for a whole drum kit. */
const DRUM_KEYBOARD_WIDTH = 108;

const ZOOM_LEVELS = [10, 12, 14, 16, 19, 22, 26, 30, 36, 42, 50, 60, 72, 84, 100];
const DEFAULT_ZOOM = 7;

/** Semitone offsets from the root, for the scale highlighting. */
const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10]
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const SCALE_LABELS: Record<string, string> = {
  major: "Major",
  minor: "Minor",
  harmonicMinor: "Harmonic minor",
  dorian: "Dorian",
  mixolydian: "Mixolydian",
  pentatonic: "Pentatonic",
  blues: "Blues"
};

type DragMode = "move" | "resize" | "select" | "paint" | "erase";

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  originals: Map<string, NoteData>;
  anchorId: string | null;
  /** Last cell a paint stroke wrote to, so one cell is not filled twice. */
  lastCell?: string;
}

/** The tools in the piano roll toolbar, mirroring FL's. */
export type PianoTool = "draw" | "paint" | "erase" | "select";

const PIANO_TOOLS: Array<{ id: PianoTool; hint: string; icon: ReactNode }> = [
  { id: "draw", hint: "Draw: click to place, drag the right edge to resize (Alt+1)", icon: <IconPencil /> },
  { id: "paint", hint: "Paint: drag to fill a run of notes (Alt+2)", icon: <IconBrush /> },
  { id: "erase", hint: "Erase: drag over notes to remove them (Alt+3)", icon: <IconEraser /> },
  { id: "select", hint: "Select: drag a box around notes (Alt+4)", icon: <IconSelect /> }
];

interface Theme {
  panel: string;
  panelAlt: string;
  line: string;
  lineSoft: string;
  text: string;
  muted: string;
  accent: string;
}

function readTheme(element: HTMLElement): Theme {
  const styles = getComputedStyle(element);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;

  return {
    panel: read("--panel", "#2b2b2b"),
    panelAlt: read("--panel-2", "#383838"),
    line: read("--line", "#4d4d4d"),
    lineSoft: read("--line-soft", "#353535"),
    text: read("--text", "#e9e9e9"),
    muted: read("--muted", "#a2a2a2"),
    accent: read("--accent", "#f28c18")
  };
}

export function PianoRoll() {
  const { pattern, patternId } = useSelectedPattern();
  const channel = useSelectedChannel();

  const addNote = useProjectStore((state) => state.addNote);
  const removeNote = useProjectStore((state) => state.removeNote);
  const updateNote = useProjectStore((state) => state.updateNote);
  const transposeNotes = useProjectStore((state) => state.transposeNotes);
  const clearNotes = useProjectStore((state) => state.clearNotes);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  // The piano roll has its own snap: the playlist snaps to bars, which would
  // collapse every note onto step 0 here.
  // The grid canvas resolves its colours from CSS variables as it paints, so
  // the theme is a real dependency of the drawing.
  const theme = useSessionStore((state) => state.theme);
  const snapSteps = useSessionStore((state) => state.pianoSnapSteps);
  const ghostNotes = useSessionStore((state) => state.ghostNotes);
  const toggleGhostNotes = useSessionStore((state) => state.toggleGhostNotes);
  const scaleRoot = useSessionStore((state) => state.scaleRoot);
  const scaleMode = useSessionStore((state) => state.scaleMode);
  const setScale = useSessionStore((state) => state.setScale);
  const setSnapSteps = useSessionStore((state) => state.setPianoSnapSteps);
  const channels = useProjectStore((state) => state.channels);
  const selectChannel = useSessionStore((state) => state.selectChannel);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLCanvasElement | null>(null);
  const keysRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const centredForChannel = useRef<string | null>(null);

  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [lastLength, setLastLength] = useState(1);
  const [tool, setTool] = useState<PianoTool>("draw");
  const [showVelocity, setShowVelocity] = useState(true);

  const scaleSet = useMemo(
    () => (scaleRoot < 0 ? null : new Set(SCALES[scaleMode] ?? SCALES.major)),
    [scaleMode, scaleRoot]
  );

  const noteWidth = ZOOM_LEVELS[zoomIndex];
  // A whole drum kit has a different drum on every key, so the keys carry the drums' names.
  const drumMap = isFullKit(channel);
  const keyboardWidth = drumMap ? DRUM_KEYBOARD_WIDTH : KEYBOARD_WIDTH;
  const [hoverPitch, setHoverPitch] = useState<number | null>(null);
  const [pressedPitch, setPressedPitch] = useState<number | null>(null);
  const wheelZoom = useSessionStore((state) => state.wheelZoom);
  const notes = useMemo<NoteData[]>(
    () => (pattern && channel ? pattern.channels[channel.id]?.notes ?? [] : []),
    [pattern, channel]
  );

  const gridWidth = (pattern?.length ?? STEPS_PER_BAR) * noteWidth;
  const gridHeight = ROW_COUNT * ROW_HEIGHT;

  /* ───────────────────────────── drawing ───────────────────────────── */

  const draw = useCallback(() => {
    const grid = gridRef.current;
    const keys = keysRef.current;
    if (!grid || !keys || !pattern || !channel) return;

    const theme = readTheme(grid);
    const dpr = window.devicePixelRatio || 1;

    const setup = (canvas: HTMLCanvasElement, width: number, height: number) => {
      const backingWidth = Math.round(width * dpr);
      const backingHeight = Math.round(height * dpr);

      // Only resize when the size actually changed. Assigning `canvas.width`
      // reallocates the whole backing store — at max zoom on a long pattern
      // that is tens of megabytes, and this runs on every pointermove of a
      // note drag.
      if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth;
        canvas.height = backingHeight;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      const context = canvas.getContext("2d");
      context?.setTransform(dpr, 0, 0, dpr, 0, 0);
      return context;
    };

    const gridContext = setup(grid, gridWidth, gridHeight);
    const keysContext = setup(keys, keyboardWidth, gridHeight);
    if (!gridContext || !keysContext) return;

    // Keyboard.
    keysContext.clearRect(0, 0, keyboardWidth, gridHeight);
    for (let row = 0; row < ROW_COUNT; row++) {
      const pitch = MAX_PITCH - row;
      const y = row * ROW_HEIGHT;
      const black = isBlackPitch(pitch);

      if (drumMap) {
        // A drum kit: a named drum on each key that has one, the rest dark and empty.
        const name = drumName(pitch);
        keysContext.fillStyle = name ? (black ? "#cfcfd6" : "#e6e6e6") : "#26262c";
        keysContext.fillRect(0, y, keyboardWidth, ROW_HEIGHT);
        keysContext.strokeStyle = theme.lineSoft;
        keysContext.strokeRect(0.5, y + 0.5, keyboardWidth - 1, ROW_HEIGHT - 1);
        if (name) {
          keysContext.fillStyle = "#1c1c22";
          keysContext.font = "600 9.5px system-ui, sans-serif";
          keysContext.fillText(name, 5, y + ROW_HEIGHT - 4, keyboardWidth - 30);
        }
        keysContext.fillStyle = name ? "#6b6b76" : "#55555e";
        keysContext.font = "8px system-ui, sans-serif";
        keysContext.textAlign = "right";
        keysContext.fillText(pitchName(pitch), keyboardWidth - 4, y + ROW_HEIGHT - 4);
        keysContext.textAlign = "left";
        continue;
      }

      keysContext.fillStyle = black ? "#141414" : "#e6e6e6";
      keysContext.fillRect(0, y, keyboardWidth, ROW_HEIGHT);
      keysContext.strokeStyle = theme.lineSoft;
      keysContext.strokeRect(0.5, y + 0.5, keyboardWidth - 1, ROW_HEIGHT - 1);

      if (pitch % 12 === 0) {
        keysContext.fillStyle = "#333";
        keysContext.font = "9px system-ui, sans-serif";
        keysContext.fillText(pitchName(pitch), 4, y + ROW_HEIGHT - 4);
      }
    }

    // Grid rows.
    gridContext.clearRect(0, 0, gridWidth, gridHeight);
    for (let row = 0; row < ROW_COUNT; row++) {
      const pitch = MAX_PITCH - row;
      gridContext.fillStyle = isBlackPitch(pitch) ? theme.panel : theme.panelAlt;
      gridContext.fillRect(0, row * ROW_HEIGHT, gridWidth, ROW_HEIGHT);

      // Dim the rows outside the chosen key so the ones in it stand out; for a drum kit, the keys with no drum.
      if (drumMap ? !drumName(pitch) : scaleSet && !scaleSet.has(((pitch - scaleRoot) % 12 + 12) % 12)) {
        gridContext.fillStyle = "rgba(0,0,0,0.34)";
        gridContext.fillRect(0, row * ROW_HEIGHT, gridWidth, ROW_HEIGHT);
      }

      if (pitch % 12 === 0) {
        gridContext.fillStyle = theme.line;
        gridContext.fillRect(0, row * ROW_HEIGHT + ROW_HEIGHT - 1, gridWidth, 1);
      }
    }

    // Shade alternate bars so you can read the position at a glance instead of
    // counting grid lines.
    for (let bar = 0; bar * STEPS_PER_BAR < pattern.length; bar += 2) {
      const x = bar * STEPS_PER_BAR * noteWidth;
      const width = Math.min(STEPS_PER_BAR * noteWidth, gridWidth - x);
      if (width <= 0) continue;

      gridContext.fillStyle = "rgba(255,255,255,0.028)";
      gridContext.fillRect(x, 0, width, gridHeight);
    }

    // Vertical step lines: bars strongest, then beats, then steps.
    for (let step = 0; step <= pattern.length; step++) {
      const x = Math.round(step * noteWidth) + 0.5;
      const isBar = step % STEPS_PER_BAR === 0;
      const isBeat = step % STEPS_PER_BEAT === 0;

      // Sub-step lines are noise at small zoom levels.
      if (!isBeat && noteWidth < 14) continue;

      gridContext.strokeStyle = isBar ? theme.line : isBeat ? theme.lineSoft : "rgba(0,0,0,0.22)";
      gridContext.lineWidth = isBar ? 1.4 : 1;
      gridContext.beginPath();
      gridContext.moveTo(x, 0);
      gridContext.lineTo(x, gridHeight);
      gridContext.stroke();
    }

    // Ghost notes: what the other channels are playing, so you can write
    // against the bassline without flipping back and forth.
    if (ghostNotes && pattern) {
      for (const other of channels) {
        if (other.id === channel.id) continue;

        for (const note of pattern.channels[other.id]?.notes ?? []) {
          if (note.pitch < MIN_PITCH || note.pitch > MAX_PITCH) continue;

          const x = note.start * noteWidth;
          const y = (MAX_PITCH - note.pitch) * ROW_HEIGHT;

          gridContext.globalAlpha = 0.22;
          gridContext.fillStyle = other.color;
          gridContext.fillRect(
            x + 1,
            y + 1,
            Math.max(6, note.length * noteWidth - 2),
            ROW_HEIGHT - 2
          );
          gridContext.globalAlpha = 1;
        }
      }
    }

    // Notes.
    for (const note of notes) {
      if (note.pitch < MIN_PITCH || note.pitch > MAX_PITCH) continue;

      const x = note.start * noteWidth;
      const y = (MAX_PITCH - note.pitch) * ROW_HEIGHT;
      const width = Math.max(6, note.length * noteWidth - 2);
      const height = ROW_HEIGHT - 2;
      const isSelected = selected.has(note.id);

      const radius = Math.min(3, height / 2, width / 2);

      // Velocity reads as brightness, so a part's dynamics are visible.
      gridContext.globalAlpha = 0.45 + (note.velocity / 127) * 0.55;
      gridContext.fillStyle = channel.color;
      gridContext.beginPath();
      gridContext.roundRect(x + 1, y + 1, width, height, radius);
      gridContext.fill();
      gridContext.globalAlpha = 1;

      // A lighter top edge gives the block a little relief.
      gridContext.fillStyle = "rgba(255,255,255,0.22)";
      gridContext.fillRect(x + 2, y + 2, width - 2, 1);

      gridContext.strokeStyle = isSelected ? theme.text : "rgba(0,0,0,0.6)";
      gridContext.lineWidth = isSelected ? 2 : 1;
      gridContext.beginPath();
      gridContext.roundRect(x + 1.5, y + 1.5, width - 1, height - 1, radius);
      gridContext.stroke();

      // Resize grip on the right edge.
      gridContext.fillStyle = "rgba(255,255,255,0.5)";
      gridContext.fillRect(x + width - 3, y + 3, 2, height - 4);
    }
  }, [
    channel,
    channels,
    drumMap,
    keyboardWidth,
    ghostNotes,
    gridHeight,
    gridWidth,
    noteWidth,
    notes,
    pattern,
    scaleRoot,
    scaleSet,
    selected,
    theme
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  // Centre on the notes that are actually there, each time the channel changes.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !channel) return;
    if (centredForChannel.current === channel.id) return;

    const average =
      notes.length > 0
        ? notes.reduce((sum, note) => sum + note.pitch, 0) / notes.length
        : 60;

    container.scrollTop = clamp(
      (MAX_PITCH - average) * ROW_HEIGHT - container.clientHeight / 2,
      0,
      gridHeight
    );

    centredForChannel.current = channel.id;
  }, [channel, gridHeight, notes]);

  // Keep the velocity lane lined up with the grid when scrolling sideways.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const sync = () => {
      const lane = container.parentElement?.querySelector(".velocity-scroll");
      if (lane) lane.scrollLeft = container.scrollLeft;
    };

    container.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => container.removeEventListener("scroll", sync);
  }, [showVelocity, noteWidth]);

  /* ──────────────────────────── interaction ──────────────────────────── */

  const toGrid = (event: { clientX: number; clientY: number }) => {
    const canvas = gridRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const noteAt = (x: number, y: number): { note: NoteData; onHandle: boolean } | null => {
    const pitch = MAX_PITCH - Math.floor(y / ROW_HEIGHT);
    const step = x / noteWidth;

    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i];
      if (note.pitch !== pitch) continue;
      if (step < note.start || step >= note.start + note.length) continue;

      const endPx = (note.start + note.length) * noteWidth;
      return { note, onHandle: x > endPx - 7 };
    }

    return null;
  };

  /**
   * One cell of a paint or erase stroke. Paint skips a cell it has already
   * written on this stroke, so sweeping back and forth does not stack notes.
   */
  const paintAt = useCallback(
    (point: { x: number; y: number }, drag: DragState) => {
      if (!pattern || !channel) return;

      const pitch = MAX_PITCH - Math.floor(point.y / ROW_HEIGHT);
      if (pitch < MIN_PITCH || pitch > MAX_PITCH) return;

      if (drag.mode === "erase") {
        const hit = noteAt(point.x, point.y);
        if (!hit) return;

        const id = hit.note.id;
        removeNote(patternId, channel.id, id);
        setSelected((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        return;
      }

      const step = clamp(snapStep(point.x / noteWidth, snapSteps), 0, pattern.length - 1);
      const cell = `${pitch}:${step}`;
      if (drag.lastCell === cell) return;
      drag.lastCell = cell;

      // Never stack a note on one that is already sounding there.
      if (noteAt(step * noteWidth + 1, point.y)) return;

      // A painted run tiles at the snap size. Using the draw tool's default
      // length instead would make every note overlap the next cell, and the
      // no-stacking rule above would then skip every other one.
      const note: NoteData = {
        id: uid(),
        pitch,
        start: step,
        length: clamp(snapSteps, 1, pattern.length - step),
        velocity: 100
      };

      addNote(patternId, channel.id, note);
      auditionChannel(channel.id, pitch, note.velocity / 127, 0.15);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- noteAt reads `notes`
    [addNote, channel, noteWidth, notes, pattern, patternId, removeNote, snapSteps]
  );

  /** Snap every selected note onto the current grid, as one undo step. */
  const quantiseSelection = useCallback(() => {
    if (!pattern || !channel || selected.size === 0) return;

    beginEdit("Quantise");

    for (const note of notes) {
      if (!selected.has(note.id)) continue;

      const start = clamp(snapStep(note.start, snapSteps), 0, pattern.length - 1);
      if (start === note.start) continue;

      updateNote(patternId, channel.id, note.id, {
        start,
        length: clamp(note.length, 1, pattern.length - start)
      });
    }

    endEdit();
  }, [beginEdit, channel, endEdit, notes, pattern, patternId, selected, snapSteps, updateNote]);

  const finishDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setMarquee(null);
    endEdit();
  }, [endEdit]);

  // Close an interrupted gesture on unmount only. An inline effect cleanup
  // also fires on every dependency change, which would abort the drag the
  // moment it edited the data its own effect depends on.
  useUnmount(finishDrag);

  useEffect(() => {
    if (!pattern || !channel) return;

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      // The pointer was released outside the window, so no pointerup ever
      // reached us. Finish here instead of following a button that is up.
      if (event.buttons === 0) {
        finishDrag();
        return;
      }


      const point = toGrid(event);
      if (!point) return;

      if (drag.mode === "paint" || drag.mode === "erase") {
        paintAt(point, drag);
        return;
      }

      if (drag.mode === "select") {
        setMarquee({
          x: Math.min(drag.startX, point.x),
          y: Math.min(drag.startY, point.y),
          w: Math.abs(point.x - drag.startX),
          h: Math.abs(point.y - drag.startY)
        });

        const minStep = Math.min(drag.startX, point.x) / noteWidth;
        const maxStep = Math.max(drag.startX, point.x) / noteWidth;
        const minPitch = MAX_PITCH - Math.floor(Math.max(drag.startY, point.y) / ROW_HEIGHT);
        const maxPitch = MAX_PITCH - Math.floor(Math.min(drag.startY, point.y) / ROW_HEIGHT);

        setSelected(
          new Set(
            notes
              .filter(
                (note) =>
                  note.pitch >= minPitch &&
                  note.pitch <= maxPitch &&
                  note.start + note.length > minStep &&
                  note.start < maxStep
              )
              .map((note) => note.id)
          )
        );
        return;
      }

      const stepDelta = Math.round((point.x - drag.startX) / noteWidth);
      const pitchDelta = -Math.round((point.y - drag.startY) / ROW_HEIGHT);

      for (const [noteId, original] of drag.originals) {
        if (drag.mode === "move") {
          const rawStart = original.start + stepDelta;
          updateNote(patternId, channel.id, noteId, {
            start: clamp(snapStep(rawStart, snapSteps), 0, pattern.length - 1),
            pitch: clamp(original.pitch + pitchDelta, MIN_PITCH, MAX_PITCH)
          });
        } else {
          updateNote(patternId, channel.id, noteId, {
            length: Math.max(1, snapStep(original.length + stepDelta, snapSteps) || 1)
          });
        }
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [channel, finishDrag, noteWidth, notes, paintAt, pattern, patternId, snapSteps, updateNote]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pattern || !channel) return;

    const point = toGrid(event);
    if (!point) return;

    const hit = noteAt(point.x, point.y);

    // Right-drag erases a sweep, in any tool. FL erases everything you drag
    // over; deleting only the note under the initial click was the odd one out.
    if (event.button === 2) {
      event.preventDefault();
      beginEdit("Erase notes");
      dragRef.current = {
        mode: "erase",
        startX: point.x,
        startY: point.y,
        originals: new Map(),
        anchorId: null
      };
      paintAt(point, dragRef.current);
      return;
    }

    if (event.button !== 0) return;
    event.preventDefault();

    // Tools take priority over what is under the cursor, except that Draw
    // still behaves like the old click-to-place / grab-to-move.
    if (tool === "erase") {
      beginEdit("Erase notes");
      dragRef.current = {
        mode: "erase",
        startX: point.x,
        startY: point.y,
        originals: new Map(),
        anchorId: null
      };
      paintAt(point, dragRef.current);
      return;
    }

    if (tool === "paint" && !hit) {
      beginEdit("Paint notes");
      dragRef.current = {
        mode: "paint",
        startX: point.x,
        startY: point.y,
        originals: new Map(),
        anchorId: null
      };
      paintAt(point, dragRef.current);
      return;
    }

    if (tool === "select" && !hit) {
      dragRef.current = {
        mode: "select",
        startX: point.x,
        startY: point.y,
        originals: new Map(),
        anchorId: null
      };
      setSelected(new Set());
      return;
    }

    if (hit) {
      const nextSelected = new Set(selected);

      if (event.shiftKey) {
        if (nextSelected.has(hit.note.id)) nextSelected.delete(hit.note.id);
        else nextSelected.add(hit.note.id);
      } else if (!nextSelected.has(hit.note.id)) {
        nextSelected.clear();
        nextSelected.add(hit.note.id);
      }

      setSelected(nextSelected);

      const originals = new Map<string, NoteData>();
      for (const note of notes) {
        if (nextSelected.has(note.id)) originals.set(note.id, { ...note });
      }
      // Resizing only ever applies to the note actually grabbed.
      if (hit.onHandle) {
        originals.clear();
        originals.set(hit.note.id, { ...hit.note });
      }

      beginEdit(hit.onHandle ? "Resize note" : "Move note");
      dragRef.current = {
        mode: hit.onHandle ? "resize" : "move",
        startX: point.x,
        startY: point.y,
        originals,
        anchorId: hit.note.id
      };

      if (!hit.onHandle) auditionChannel(channel.id, hit.note.pitch, hit.note.velocity / 127, 0.25);
      return;
    }

    if (event.shiftKey) {
      dragRef.current = {
        mode: "select",
        startX: point.x,
        startY: point.y,
        originals: new Map(),
        anchorId: null
      };
      setSelected(new Set());
      return;
    }

    const step = clamp(snapStep(point.x / noteWidth, snapSteps), 0, pattern.length - 1);
    const pitch = MAX_PITCH - Math.floor(point.y / ROW_HEIGHT);
    if (pitch < MIN_PITCH || pitch > MAX_PITCH) return;

    const note: NoteData = {
      id: uid(),
      pitch,
      start: step,
      length: clamp(lastLength, 1, pattern.length - step),
      velocity: 100
    };

    beginEdit("Add note");
    addNote(patternId, channel.id, note);
    setSelected(new Set([note.id]));
    auditionChannel(channel.id, pitch, note.velocity / 127, 0.3);

    // Keep hold of the new note so dragging right sizes it straight away.
    dragRef.current = {
      mode: "resize",
      startX: point.x,
      startY: point.y,
      originals: new Map([[note.id, note]]),
      anchorId: note.id
    };
  };

  // Wheel and keyboard zoom, anchored on the pointer. Kept after the drawing
  // effects so the scroll position is put back once the canvas has resized.
  const zoom = useWheelZoom({
    containerRef: scrollRef,
    levels: ZOOM_LEVELS,
    index: zoomIndex,
    setIndex: setZoomIndex,
    gutter: keyboardWidth,
    active: Boolean(pattern && channel)
  });

  /* ───────────────────────────── keyboard ───────────────────────────── */

  useEffect(() => {
    if (!pattern || !channel) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // These are window-level listeners, and every editor is mounted at once.
      // Without checking which window has focus, one Delete would also delete
      // in the editor behind this one.
      if (useSessionStore.getState().view !== "piano") return;

      // `event.target` is not always an element (a window-dispatched event has
      // no `closest`), so narrow before reaching for DOM methods.
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      // Knobs and faders are focusable divs with a slider role — arrow keys and
      // Delete belong to whichever one the user is actually on.
      if (target?.closest('[role="slider"]')) return;

      switch (matchShortcut(event)) {
        case "zoomIn":
          event.preventDefault();
          zoom.zoomBy(1);
          return;
        case "zoomOut":
          event.preventDefault();
          zoom.zoomBy(-1);
          return;
        case "zoomReset":
          event.preventDefault();
          zoom.zoomTo(DEFAULT_ZOOM);
          return;
        case "tool1":
          event.preventDefault();
          setTool("draw");
          return;
        case "tool2":
          event.preventDefault();
          setTool("paint");
          return;
        case "tool3":
          event.preventDefault();
          setTool("erase");
          return;
        case "tool4":
          event.preventDefault();
          setTool("select");
          return;
        case "quantise":
          event.preventDefault();
          if (selected.size > 0) quantiseSelection();
          return;
        case "toggleGhost":
          event.preventDefault();
          toggleGhostNotes();
          return;
        case "toggleVelocity":
          event.preventDefault();
          setShowVelocity((value) => !value);
          return;
        default:
          break;
      }

      // Clipboard and select-all work with nothing selected, so they come
      // before the early return below.
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();

        if (key === "a") {
          event.preventDefault();
          setSelected(new Set(notes.map((note) => note.id)));
          return;
        }

        if ((key === "c" || key === "x") && selected.size > 0) {
          event.preventDefault();
          const picked = notes.filter((note) => selected.has(note.id));
          copyNotes(picked);

          if (key === "x") {
            beginEdit("Cut notes");
            for (const note of picked) removeNote(patternId, channel.id, note.id);
            endEdit();
            setSelected(new Set());
          }
          return;
        }

        if (key === "v" && hasNotes()) {
          event.preventDefault();
          const incoming = pastedNotes();

          beginEdit("Paste notes");
          const ids = new Set<string>();

          for (const note of incoming) {
            if (note.start >= pattern.length) continue;
            const id = uid();
            ids.add(id);
            addNote(patternId, channel.id, {
              ...note,
              id,
              length: clamp(note.length, 1, pattern.length - note.start)
            });
          }

          endEdit();
          setSelected(ids);
          return;
        }

        if (key === "d" && selected.size > 0) {
          event.preventDefault();
          const picked = notes.filter((note) => selected.has(note.id));
          const span = notesSpan(picked);

          beginEdit("Duplicate notes");
          const ids = new Set<string>();

          for (const note of picked) {
            const start = note.start + span;
            if (start >= pattern.length) continue;

            const id = uid();
            ids.add(id);
            addNote(patternId, channel.id, {
              ...note,
              id,
              start,
              length: clamp(note.length, 1, pattern.length - start)
            });
          }

          endEdit();
          if (ids.size > 0) setSelected(ids);
          return;
        }

        return;
      }

      if (selected.size === 0) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        beginEdit("Delete notes");
        for (const id of selected) removeNote(patternId, channel.id, id);
        endEdit();
        setSelected(new Set());
        return;
      }

      const shift =
        event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;

      if (shift !== 0) {
        event.preventDefault();
        const amount = event.shiftKey ? 12 : 1;
        beginEdit("Transpose");
        for (const id of selected) {
          const note = notes.find((entry) => entry.id === id);
          if (note) {
            updateNote(patternId, channel.id, id, {
              pitch: clamp(note.pitch + shift * amount, MIN_PITCH, MAX_PITCH)
            });
          }
        }
        endEdit();
        return;
      }

      const nudge = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

      if (nudge !== 0) {
        event.preventDefault();
        beginEdit("Nudge notes");
        for (const id of selected) {
          const note = notes.find((entry) => entry.id === id);
          if (note) {
            updateNote(patternId, channel.id, id, {
              start: clamp(note.start + nudge * snapSteps, 0, pattern.length - 1)
            });
          }
        }
        endEdit();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    beginEdit,
    channel,
    endEdit,
    notes,
    pattern,
    patternId,
    quantiseSelection,
    removeNote,
    selected,
    snapSteps,
    toggleGhostNotes,
    updateNote,
    zoom
  ]);

  // Remember the length of the note the user last touched, so new notes match.
  useEffect(() => {
    if (selected.size !== 1) return;
    const [id] = Array.from(selected);
    const note = notes.find((entry) => entry.id === id);
    if (note) setLastLength(note.length);
  }, [notes, selected]);

  // Changing the snap sets the default length for the next note, like FL does.
  useEffect(() => {
    setLastLength(snapSteps);
  }, [snapSteps]);

  // Every channel can be written in the piano roll now, drums included — an
  // off-grid or pitched kick is normal in FL and was impossible here.
  if (!pattern || !channel) {
    return (
      <div className="empty-note piano-empty">
        <p>No channel selected.</p>

        {channels.length > 0 ? (
          <>
            <p>Pick a channel to write into:</p>
            <div className="piano-empty-actions">
              {channels.map((entry) => (
                <button key={entry.id} onClick={() => selectChannel(entry.id)}>
                  {entry.name}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p>Add a channel in the Channel Rack to get started.</p>
        )}
      </div>
    );
  }

  return (
    <section className="piano-roll">
      <div className="piano-toolbar">
        <div className="tool-group" role="group" aria-label="Editing tool">
          {PIANO_TOOLS.map((entry) => (
            <button
              key={entry.id}
              className={`tool-button${tool === entry.id ? " active" : ""}`}
              aria-pressed={tool === entry.id}
              title={entry.hint}
              onClick={() => setTool(entry.id)}
            >
              {entry.icon}
            </button>
          ))}
        </div>

        <label className="piano-channel">
          Channel
          <select
            value={channel.id}
            onChange={(event) => selectChannel(event.target.value)}
            title="Channel being edited"
          >
            {channels.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <span className="piano-hint">{pattern.name}</span>

        <label>
          Snap
          <select value={snapSteps} onChange={(event) => setSnapSteps(Number(event.target.value))}>
            <option value={1}>1/16</option>
            <option value={2}>1/8</option>
            <option value={4}>1/4</option>
            <option value={8}>1/2</option>
            <option value={16}>Bar</option>
          </select>
        </label>

        <div className="zoom-controls">
          <button
            onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
            disabled={zoomIndex === 0}
            title={platformText("Zoom out (− key, or Ctrl + scroll)")}
          >
            −
          </button>
          <span>{Math.round((noteWidth / ZOOM_LEVELS[DEFAULT_ZOOM]) * 100)}%</span>
          <button
            onClick={() => setZoomIndex((index) => Math.min(ZOOM_LEVELS.length - 1, index + 1))}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            title={platformText("Zoom in (+ key, or Ctrl + scroll)")}
          >
            +
          </button>
        </div>

        <button onClick={() => transposeNotes(patternId, channel.id, 12)} title="Up an octave">
          Oct <span aria-hidden="true">▲</span>
        </button>
        <button onClick={() => transposeNotes(patternId, channel.id, -12)} title="Down an octave">
          Oct ▼
        </button>
        <button
          className={showVelocity ? "active" : ""}
          onClick={() => setShowVelocity((value) => !value)}
        >
          Velocity
        </button>
        <button
          className={ghostNotes ? "active" : ""}
          aria-pressed={ghostNotes}
          onClick={toggleGhostNotes}
          title="Ghost notes — show the other channels faintly behind the grid"
        >
          Ghost
        </button>

        <label className="piano-scale" title="Dim the notes outside this key">
          Key
          <select
            value={scaleRoot}
            onChange={(event) => setScale(Number(event.target.value), scaleMode)}
          >
            <option value={-1}>Off</option>
            {NOTE_NAMES.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={scaleMode}
            disabled={scaleRoot < 0}
            onChange={(event) => setScale(scaleRoot, event.target.value)}
          >
            {Object.keys(SCALES).map((mode) => (
              <option key={mode} value={mode}>
                {SCALE_LABELS[mode] ?? mode}
              </option>
            ))}
          </select>
        </label>

        <button
          disabled={selected.size === 0}
          onClick={quantiseSelection}
          title="Quantise — snap the selected notes to the grid"
        >
          Quantise
        </button>

        <button onClick={() => clearNotes(patternId, channel.id)}>Clear</button>

        <span className="small-note">
          Click to add · drag to move · right edge resizes · right-click deletes · shift-drag selects
        </span>
      </div>

      <div
        className="piano-scroll"
        ref={scrollRef}
        data-hint={
          wheelZoom
            ? "Scroll wheel zooms · Shift + wheel scrolls sideways · Alt + wheel scrolls up and down · on a touchpad, two fingers scroll and a pinch zooms"
            : platformText("Ctrl + scroll wheel zooms · Shift + wheel scrolls sideways · on a touchpad, two fingers scroll and a pinch zooms")
        }
      >
        <div className="piano-inner" style={{ height: gridHeight }}>
          <div className="piano-keys-col" style={{ width: keyboardWidth, height: gridHeight }}>
            <canvas
              ref={keysRef}
              className="piano-keys"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                // Held for as long as the button is, and sliding along the keys plays each one, like a real keyboard.
                const rect = event.currentTarget.getBoundingClientRect();
                const pitchAt = (clientY: number) => clamp(MAX_PITCH - Math.floor((clientY - rect.top) / ROW_HEIGHT), MIN_PITCH, MAX_PITCH);
                let current = pitchAt(event.clientY);
                ensureAudio();
                noteOn(channel.id, current, 0.85);
                setPressedPitch(current);

                const onMove = (move: PointerEvent) => {
                  const next = pitchAt(move.clientY);
                  if (next === current) return;
                  noteOff(channel.id, current);
                  current = next;
                  noteOn(channel.id, current, 0.85);
                  setPressedPitch(current);
                };
                const onUp = () => {
                  noteOff(channel.id, current);
                  setPressedPitch(null);
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  window.removeEventListener("pointercancel", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
                window.addEventListener("pointercancel", onUp);
              }}
              onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const pitch = MAX_PITCH - Math.floor((event.clientY - rect.top) / ROW_HEIGHT);
                if (pitch !== hoverPitch) setHoverPitch(pitch);
              }}
              onPointerLeave={() => setHoverPitch(null)}
            />
            <KeyLights
              pattern={pattern}
              channel={channel}
              notes={notes}
              width={keyboardWidth}
              hoverPitch={hoverPitch}
              pressedPitch={pressedPitch}
            />
          </div>

          <div className="piano-grid-wrap">
            <canvas
              ref={gridRef}
              className="piano-grid"
              onPointerDown={handlePointerDown}
              onPointerMove={(event) => {
                // The row under the pointer lights its key, so it is easy to see which note a click would write.
                const rect = event.currentTarget.getBoundingClientRect();
                const pitch = MAX_PITCH - Math.floor((event.clientY - rect.top) / ROW_HEIGHT);
                if (pitch !== hoverPitch) setHoverPitch(pitch);
              }}
              onPointerLeave={() => setHoverPitch(null)}
              onContextMenu={(event) => event.preventDefault()}
            />
            {hoverPitch !== null && hoverPitch >= MIN_PITCH && hoverPitch <= MAX_PITCH ? (
              <div
                className="piano-row-hover"
                style={{ top: (MAX_PITCH - hoverPitch) * ROW_HEIGHT, height: ROW_HEIGHT, width: gridWidth }}
                aria-hidden="true"
              />
            ) : null}
            <PlayingNotes pattern={pattern} channel={channel} notes={notes} noteWidth={noteWidth} />
            {marquee ? (
              <div
                className="piano-marquee"
                style={{
                  left: marquee.x,
                  top: marquee.y,
                  width: marquee.w,
                  height: marquee.h
                }}
              />
            ) : null}
            <PianoPlayhead patternLength={pattern.length} noteWidth={noteWidth} height={gridHeight} />
          </div>
        </div>
      </div>

      {showVelocity ? (
        <VelocityEditor
          patternId={patternId}
          channelId={channel.id}
          patternLength={pattern.length}
          noteWidth={noteWidth}
          color={channel.color}
          selected={selected}
          offsetLeft={keyboardWidth}
        />
      ) : null}
    </section>
  );
}

/** The pattern's steps that are playing now: one per clip of it under the playhead in song mode. */
function usePlayingSteps(pattern: Pattern): number[] {
  const playheadStep = useTransportStore((state) => state.playheadStep);
  const isPlaying = useTransportStore((state) => state.isPlaying);
  const mode = useSessionStore((state) => state.mode);
  const clips = useProjectStore((state) => state.playlist.clips);

  return useMemo(() => {
    if (!isPlaying || playheadStep < 0 || pattern.length <= 0) return [];
    if (mode === "pattern") return [playheadStep % pattern.length];
    return clips.flatMap((clip) =>
      clip.type === "pattern" &&
      clip.patternId === pattern.id &&
      playheadStep >= clip.startStep &&
      playheadStep < clip.startStep + clip.lengthSteps
        ? [(playheadStep - clip.startStep) % pattern.length]
        : []
    );
  }, [clips, isPlaying, mode, pattern.id, pattern.length, playheadStep]);
}

/** Which notes of the channel are sounding at those steps. */
function soundingNotes(notes: NoteData[], steps: number[]): NoteData[] {
  if (steps.length === 0) return [];
  return notes.filter((note) => steps.some((step) => note.start <= step + 0.001 && step < note.start + note.length - 0.001));
}

/**
 * Lights on the keys: the notes the pattern is playing, what is being played on the keyboard (computer, MIDI or a
 * click on these keys), and the key of the row under the pointer.
 */
function KeyLights({
  pattern,
  channel,
  notes,
  width,
  hoverPitch,
  pressedPitch
}: {
  pattern: Pattern;
  channel: Channel;
  notes: NoteData[];
  width: number;
  hoverPitch: number | null;
  pressedPitch: number | null;
}) {
  const steps = usePlayingSteps(pattern);
  const live = useTransportStore((state) => state.activeMidiNotes);
  const cells = pattern.channels[channel.id]?.steps;

  const lit = new Set<number>(live);
  if (pressedPitch !== null) lit.add(pressedPitch);
  for (const note of soundingNotes(notes, steps)) lit.add(note.pitch);
  // Steps play too: the kick for a whole kit, middle C for the rest.
  if (cells && steps.some((step) => isStepActive(cells[step]))) lit.add(stepPitchOf(channel));

  return (
    <div className="piano-key-lights" aria-hidden="true">
      {hoverPitch !== null && hoverPitch >= MIN_PITCH && hoverPitch <= MAX_PITCH && !lit.has(hoverPitch) ? (
        <span className="piano-key-hover" style={{ top: (MAX_PITCH - hoverPitch) * ROW_HEIGHT, height: ROW_HEIGHT, width }} />
      ) : null}
      {[...lit]
        .filter((pitch) => pitch >= MIN_PITCH && pitch <= MAX_PITCH)
        .map((pitch) => (
          <span
            key={pitch}
            className="piano-key-lit"
            style={{ top: (MAX_PITCH - pitch) * ROW_HEIGHT, height: ROW_HEIGHT, width, "--lit-color": channel.color } as React.CSSProperties}
          />
        ))}
    </div>
  );
}

/** A glow over each note while the playhead is on it. */
function PlayingNotes({
  pattern,
  channel,
  notes,
  noteWidth
}: {
  pattern: Pattern;
  channel: Channel;
  notes: NoteData[];
  noteWidth: number;
}) {
  const steps = usePlayingSteps(pattern);
  return (
    <>
      {soundingNotes(notes, steps)
        .filter((note) => note.pitch >= MIN_PITCH && note.pitch <= MAX_PITCH)
        .map((note) => (
          <span
            key={note.id}
            className="piano-note-playing"
            style={
              {
                left: note.start * noteWidth + 1,
                top: (MAX_PITCH - note.pitch) * ROW_HEIGHT + 1,
                width: Math.max(6, note.length * noteWidth - 2),
                height: ROW_HEIGHT - 2,
                "--lit-color": channel.color
              } as React.CSSProperties
            }
            aria-hidden="true"
          />
        ))}
    </>
  );
}

function PianoPlayhead({
  patternLength,
  noteWidth,
  height
}: {
  patternLength: number;
  noteWidth: number;
  height: number;
}) {
  const playheadStep = useTransportStore((state) => state.playheadStep);
  const mode = useSessionStore((state) => state.mode);

  if (playheadStep < 0 || mode !== "pattern") return null;

  return (
    <div
      className="piano-playhead"
      style={{ left: (playheadStep % patternLength) * noteWidth, height }}
      aria-hidden="true"
    />
  );
}
