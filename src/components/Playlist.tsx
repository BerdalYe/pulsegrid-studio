import { platformText } from "../lib/hotkeys";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useProjectStore } from "../state/projectStore";
import { useWheelZoom } from "../hooks/useWheelZoom";
import { IconAddLane, IconCopy, IconEraser, IconFit, IconFlag, IconMore, IconMute, IconPencil, IconTrash } from "./icons";
import { MenuPanel, prepareItems, type MenuItem } from "./MenuPanel";
import { matchShortcut } from "../lib/hotkeys";
import { useSessionStore } from "../state/sessionStore";
import { copyClips, hasClips, pastedClips } from "../state/clipboard";
import { useTransportStore } from "../state/transportStore";
import { seekTo } from "../audio/engine";
import { useConfirm } from "./ConfirmDialog";
import { useSamples, useUnmount } from "../hooks/useStudio";
import { AutomationEditor } from "./AutomationEditor";

import {
  DEFAULT_TRACK_HEIGHT,
  STEPS_PER_BAR,
  STEPS_PER_BEAT,
  clamp,
  formatBarBeat,
  isStepActive,
  secondsPerStep,
  snapStep,
  trackColors,
  uid
} from "../lib/utils";

import { getSample, getWaveformPeaks } from "../audio/sampleRegistry";
import { patternShapes } from "../lib/clipPreview";

import type { AudioClip, AutomationClip, Channel, Pattern, PlaylistClip, PlaylistMarker } from "../types";

const HEADER_WIDTH = 178;
const ZOOM_LEVELS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 22, 28, 36];
const DEFAULT_ZOOM = 2;

const MARKER_LANE_HEIGHT = 18;
const RULER_HEIGHT = 26;
const TIMELINE_HEIGHT = MARKER_LANE_HEIGHT + RULER_HEIGHT;

/** Below this a lane can't stack a name over its buttons, so they go side by side. */
const COMPACT_TRACK_HEIGHT = 44;

type DrawTool = "pattern" | "audio" | "automation";

/** What a click on the lanes does, as in FL's playlist toolbar. */
type EditTool = "draw" | "erase" | "mute";

const EDIT_TOOLS: Array<{ id: EditTool; label: string; hint: string; icon: ReactNode }> = [
  { id: "draw", label: "Draw", hint: "Draw: click a lane to place a clip, drag along it to place a row, drag a clip to move it", icon: <IconPencil /> },
  { id: "erase", label: "Delete", hint: "Delete: click or drag over clips to remove them (right-drag does this with any tool)", icon: <IconEraser /> },
  { id: "mute", label: "Mute", hint: "Mute: click a clip to silence it, click again to bring it back", icon: <IconMute /> }
];

/** A pattern dragged from the list of patterns onto a lane. */
const PATTERN_DRAG = "application/x-pulsegrid-pattern";

interface ClipDrag {
  mode: "move" | "resize" | "paint" | "erase";
  clipId: string;
  startX: number;
  startY: number;
  originStep: number;
  originTrack: number;
  originLength: number;
  /** Last lane cell a paint stroke filled, so one cell is not doubled up. */
  lastCell?: string;
}

/** The playlist lane under a screen point, if the pointer is over one at all. */
function laneAtPoint(clientX: number, clientY: number): { index: number; rect: DOMRect } | null {
  const lane = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".playlist-lane");
  if (!lane) return null;

  const index = Number(lane.dataset.track);
  if (!Number.isInteger(index)) return null;

  return { index, rect: lane.getBoundingClientRect() };
}

export function Playlist() {
  const confirm = useConfirm();

  const tracks = useProjectStore((state) => state.playlist.tracks);
  const clips = useProjectStore((state) => state.playlist.clips);
  const markers = useProjectStore((state) => state.playlist.markers);
  const patterns = useProjectStore((state) => state.patterns);
  const channels = useProjectStore((state) => state.channels);
  const patternOrder = useProjectStore((state) => state.patternOrder);
  const songBars = useProjectStore((state) => state.songBars);

  const addPlaylistClip = useProjectStore((state) => state.addPlaylistClip);
  const removePlaylistClip = useProjectStore((state) => state.removePlaylistClip);
  const updatePlaylistClip = useProjectStore((state) => state.updatePlaylistClip);
  const duplicatePlaylistClip = useProjectStore((state) => state.duplicatePlaylistClip);
  const addPlaylistTrack = useProjectStore((state) => state.addPlaylistTrack);
  const addMarker = useProjectStore((state) => state.addMarker);
  const setSongBars = useProjectStore((state) => state.setSongBars);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const selectedPatternId = useSessionStore((state) => state.selectedPatternId);
  const selectPattern = useSessionStore((state) => state.selectPattern);
  const snapSteps = useSessionStore((state) => state.snapSteps);
  const setSnapSteps = useSessionStore((state) => state.setSnapSteps);

  const samples = useSamples();

  const [tool, setTool] = useState<DrawTool>("pattern");
  const [editTool, setEditTool] = useState<EditTool>("draw");
  const toggleClipMute = useProjectStore((state) => state.toggleClipMute);
  const [sampleId, setSampleId] = useState("");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM);
  // A size between the levels, from dragging the overview's edges (or Fit); the wheel and buttons go back to levels.
  const [freePx, setFreePx] = useState<number | null>(null);
  const pendingScroll = useRef<number | null>(null);

  const dragRef = useRef<ClipDrag | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);

  // How wide the visible part of the playlist is, so the grid can always run
  // to the right-hand edge instead of stopping short at the song length.
  const [viewWidth, setViewWidth] = useState(0);
  useEffect(() => {
    const element = laneRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewWidth(element.clientWidth));
    observer.observe(element);
    setViewWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const wheelZoom = useSessionStore((state) => state.wheelZoom);
  const zoom = useWheelZoom({
    containerRef: laneRef,
    levels: ZOOM_LEVELS,
    index: zoomIndex,
    setIndex: (next) => {
      setFreePx(null);
      setZoomIndex(next);
    },
    gutter: HEADER_WIDTH,
    pxNow: freePx ?? undefined
  });

  const pxPerStep = freePx ?? ZOOM_LEVELS[zoomIndex];

  // Any size, from the overview's edges or Fit, with the view starting at `startStep`. The level nearest to it is
  // where the wheel and the zoom buttons carry on from.
  const zoomFree = useCallback((px: number, startStep: number) => {
    const size = clamp(px, ZOOM_LEVELS[0], ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
    let nearest = 0;
    ZOOM_LEVELS.forEach((level, index) => {
      if (Math.abs(Math.log(level / size)) < Math.abs(Math.log(ZOOM_LEVELS[nearest] / size))) nearest = index;
    });
    pendingScroll.current = Math.max(0, startStep * size);
    setFreePx(size);
    setZoomIndex(nearest);
  }, []);

  // Once the lanes have their new width, scroll to where the overview asked for.
  useLayoutEffect(() => {
    const element = laneRef.current;
    if (!element || pendingScroll.current === null) return;
    element.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
  }, [pxPerStep]);
  const totalSteps = Math.max(songBars * STEPS_PER_BAR, contentEnd(clips, markers));
  const barsToFill = Math.ceil(Math.max(0, viewWidth - HEADER_WIDTH) / (STEPS_PER_BAR * pxPerStep));
  const totalBars = Math.max(Math.ceil(totalSteps / STEPS_PER_BAR), barsToFill);
  const laneWidth = totalBars * STEPS_PER_BAR * pxPerStep;

  // Lanes are individually sized, so anything that spans them — the playhead,
  // the marker lines — has to measure rather than multiply.
  const lanesHeight = useMemo(
    () => tracks.reduce((total, track) => total + track.height, 0),
    [tracks]
  );

  useEffect(() => {
    if (!sampleId && samples[0]) setSampleId(samples[0].id);
  }, [sampleId, samples]);

  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;

  /* ─────────────────────────── placing clips ─────────────────────────── */

  const placeClip = useCallback(
    (trackIndex: number, step: number) => {
      const startStep = Math.max(0, snapStep(step, snapSteps));
      const id = uid();

      if (tool === "pattern") {
        const pattern = patterns[selectedPatternId];
        if (!pattern) return;

        addPlaylistClip({
          id,
          type: "pattern",
          patternId: selectedPatternId,
          trackIndex,
          startStep,
          lengthSteps: pattern.length
        });
      } else if (tool === "audio") {
        const sample = samples.find((entry) => entry.id === sampleId);
        if (!sample) return;

        addPlaylistClip({
          id,
          type: "audio",
          trackIndex,
          startStep,
          sampleId: sample.id,
          name: sample.name,
          durationSteps: STEPS_PER_BAR,
          offsetSteps: 0,
          volume: 1,
          pitch: 0
        });
      } else {
        addPlaylistClip({
          id,
          type: "automation",
          trackIndex,
          startStep,
          name: "Master volume",
          durationSteps: STEPS_PER_BAR * 2,
          targetType: "master",
          targetId: "master",
          targetParam: "volume",
          points: [
            { id: uid(), step: 0, value: 0.8 },
            { id: uid(), step: STEPS_PER_BAR * 2, value: 0.8 }
          ]
        });
      }

      setSelectedClipId(id);
    },
    [addPlaylistClip, patterns, sampleId, samples, selectedPatternId, snapSteps, tool]
  );

  /* ──────────────────────────── clip dragging ──────────────────────────── */

  /**
   * One cell of a clip paint or erase sweep.
   *
   * Clips are read straight from the store rather than from the render scope:
   * the pointermove effect does not depend on them, so a captured copy would
   * go stale the moment the stroke placed its first clip.
   */
  const sweepAt = useCallback(
    (clientX: number, clientY: number, drag: ClipDrag) => {
      const hit = laneAtPoint(clientX, clientY);
      if (!hit) return;

      const trackIndex = hit.index;
      const rawStep = (clientX - hit.rect.left) / pxPerStep;
      if (rawStep < 0) return;

      const live = useProjectStore.getState().playlist.clips;
      const lengthOf = (clip: PlaylistClip) =>
        clip.type === "pattern" ? clip.lengthSteps : clip.durationSteps;

      if (drag.mode === "erase") {
        for (const clip of live) {
          if (clip.trackIndex !== trackIndex) continue;
          if (rawStep < clip.startStep || rawStep >= clip.startStep + lengthOf(clip)) continue;

          removePlaylistClip(clip.id);
          setSelectedClipId((current) => (current === clip.id ? null : current));
        }
        return;
      }

      const step = Math.max(0, snapStep(rawStep, snapSteps));
      const cell = `${trackIndex}:${step}`;
      if (drag.lastCell === cell) return;
      drag.lastCell = cell;

      // Never drop a clip on top of one that is already there.
      const occupied = live.some(
        (clip) =>
          clip.trackIndex === trackIndex &&
          step < clip.startStep + lengthOf(clip) &&
          step + 1 > clip.startStep
      );
      if (occupied) return;

      placeClip(trackIndex, step);
    },
    [placeClip, pxPerStep, removePlaylistClip, snapSteps]
  );

  const finishDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    endEdit();
  }, [endEdit]);

  // Close an interrupted gesture on unmount only. An inline effect cleanup
  // also fires on every dependency change, which would abort the drag the
  // moment it edited the data its own effect depends on.
  useUnmount(finishDrag);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      // The pointer was released outside the window, so no pointerup ever
      // reached us. Finish here instead of following a button that is up.
      if (event.buttons === 0) {
        finishDrag();
        return;
      }

      if (drag.mode === "paint" || drag.mode === "erase") {
        sweepAt(event.clientX, event.clientY, drag);
        return;
      }

      const stepDelta = (event.clientX - drag.startX) / pxPerStep;

      if (drag.mode === "resize") {
        updatePlaylistClip(drag.clipId, {
          lengthSteps: Math.max(
            snapSteps,
            snapStep(drag.originLength + stepDelta, snapSteps) || snapSteps
          )
        });
        return;
      }

      // Lanes have their own heights, so the target track is whichever one is
      // under the pointer rather than a fixed number of pixels away. Off the
      // lanes entirely, the clip stays on the track it started on.
      const hit = laneAtPoint(event.clientX, event.clientY);

      updatePlaylistClip(drag.clipId, {
        startStep: Math.max(0, snapStep(drag.originStep + stepDelta, snapSteps)),
        trackIndex: clamp(hit ? hit.index : drag.originTrack, 0, tracks.length - 1)
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [finishDrag, pxPerStep, snapSteps, sweepAt, tracks.length, updatePlaylistClip]);

  const startClipDrag = useCallback(
    (clip: PlaylistClip, mode: "move" | "resize", event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setSelectedClipId(clip.id);

      beginEdit(mode === "move" ? "Move clip" : "Resize clip");
      dragRef.current = {
        mode,
        clipId: clip.id,
        startX: event.clientX,
        startY: event.clientY,
        originStep: clip.startStep,
        originTrack: clip.trackIndex,
        originLength: clipLength(clip)
      };
    },
    [beginEdit]
  );

  // A double-click on a pattern clip opens that pattern in the channel rack and the piano roll.
  const openClip = useCallback(
    (clip: PlaylistClip) => {
      if (clip.type !== "pattern") return;
      selectPattern(clip.patternId);
      useSessionStore.getState().openWindow("rack");
    },
    [selectPattern]
  );

  // Zoom out (or in) until the whole song fits in the window, and go back to its start.
  const fitSong = () => {
    const element = laneRef.current;
    if (!element) return;
    const end = Math.max(songBars * STEPS_PER_BAR, contentEnd(clips, markers));
    const room = element.clientWidth - HEADER_WIDTH - 12;
    zoomFree(room / end, 0);
  };

  /* ────────────────────────────── keyboard ────────────────────────────── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // These are window-level listeners, and every editor is mounted at once.
      // Without checking which window has focus, one Delete would also delete
      // in the editor behind this one.
      if (useSessionStore.getState().view !== "playlist") return;

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
          setTool("pattern");
          return;
        case "tool2":
          event.preventDefault();
          setTool("audio");
          return;
        case "tool3":
          event.preventDefault();
          setTool("automation");
          return;
        default:
          break;
      }

      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        const live = useProjectStore.getState().playlist.clips;
        const selected = live.find((clip) => clip.id === selectedClipId) ?? null;

        if ((key === "c" || key === "x") && selected) {
          event.preventDefault();
          copyClips([selected]);

          if (key === "x") {
            removePlaylistClip(selected.id);
            setSelectedClipId(null);
          }
          return;
        }

        if (key === "v" && hasClips()) {
          event.preventDefault();
          beginEdit("Paste clips");

          let lastId: string | null = null;
          for (const clip of pastedClips()) {
            const id = uid();
            lastId = id;
            addPlaylistClip({ ...clip, id });
          }

          endEdit();
          if (lastId) setSelectedClipId(lastId);
          return;
        }

        if (key === "d" && selected) {
          event.preventDefault();
          const id = duplicatePlaylistClip(selected.id);
          if (id) setSelectedClipId(id);
          return;
        }

        return;
      }

      // M drops a marker at the playhead, the way Add Marker does in an
      // arrangement view.
      if (event.key === "m" || event.key === "M") {
        event.preventDefault();
        addMarker(playheadOrStart());
        return;
      }

      if (!selectedClipId) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removePlaylistClip(selectedClipId);
        setSelectedClipId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    addMarker,
    addPlaylistClip,
    beginEdit,
    duplicatePlaylistClip,
    endEdit,
    removePlaylistClip,
    selectedClipId,
    zoom
  ]);

  return (
    <section className="playlist">
      <div className="playlist-toolbar">
        <div className="pl-group pl-tools" role="group" aria-label="Tool">
          {EDIT_TOOLS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`pl-icon-button${editTool === option.id ? " active" : ""}`}
              aria-pressed={editTool === option.id}
              aria-label={option.label}
              title={option.hint}
              onClick={() => setEditTool(option.id)}
            >
              {option.icon}
            </button>
          ))}
        </div>

        <div className="pl-group placement-tools" role="group" aria-label="What a click places">
          {(["pattern", "audio", "automation"] as DrawTool[]).map((option) => (
            <button
              key={option}
              type="button"
              className={tool === option ? "active" : ""}
              aria-pressed={tool === option}
              title={
                option === "pattern"
                  ? "Place the pattern chosen on the left (or drag one from the list onto a lane)"
                  : option === "audio"
                    ? "Place an audio clip of the sample chosen here"
                    : "Place an automation clip for the master volume"
              }
              onClick={() => {
                setTool(option);
                setEditTool("draw");
              }}
            >
              {option === "pattern" ? "Pattern" : option === "audio" ? "Audio" : "Automation"}
            </button>
          ))}
        </div>

        {tool === "audio" ? (
          <select
            className="pl-sample-select"
            value={sampleId}
            aria-label="Sample to place"
            title="The sample an audio clip plays"
            onChange={(event) => setSampleId(event.target.value)}
          >
            {samples.map((sample) => (
              <option key={sample.id} value={sample.id}>
                {sample.name}
              </option>
            ))}
          </select>
        ) : null}

        <label className="pl-field" title="The grid clips snap to">
          <span>Snap</span>
          <select value={snapSteps} onChange={(event) => setSnapSteps(Number(event.target.value))}>
            <option value={1}>Step</option>
            <option value={4}>Beat</option>
            <option value={8}>1/2 bar</option>
            <option value={16}>Bar</option>
          </select>
        </label>

        <label className="pl-field" title="How long the song is, in bars; it grows by itself when clips go past the end">
          <span>Length</span>
          <input
            className="song-length-input"
            type="number"
            min={1}
            max={512}
            value={songBars}
            onChange={(event) => setSongBars(Number(event.target.value))}
          />
          <span className="pl-unit">bars</span>
        </label>

        <div className="pl-group zoom-controls" role="group" aria-label="Zoom">
          <button
            type="button"
            onClick={() => zoom.zoomBy(-1)}
            disabled={zoomIndex === 0}
            aria-label="Zoom out"
            title="Zoom out (the wheel, or a pinch on a touchpad, zooms too)"
          >
            −
          </button>
          <button
            type="button"
            className="pl-zoom-readout"
            onClick={() => {
              setFreePx(null);
              zoom.zoomTo(DEFAULT_ZOOM);
            }}
            title="Zoom: click for the normal size"
          >
            {Math.round((pxPerStep / ZOOM_LEVELS[DEFAULT_ZOOM]) * 100)}%
          </button>
          <button
            type="button"
            onClick={() => zoom.zoomBy(1)}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
          <button type="button" className="pl-icon-button" onClick={fitSong} aria-label="Fit the song" title="Fit the whole song in the window">
            <IconFit />
          </button>
        </div>

        <span className="fl-flex" />

        <div className="pl-group" role="group" aria-label="Add">
          <button type="button" className="pl-text-button" onClick={() => addPlaylistTrack()} title="Add a track at the bottom">
            <IconAddLane /> Track
          </button>
          <button
            type="button"
            className="pl-text-button"
            onClick={() => addMarker(playheadOrStart())}
            title="Drop a marker at the playhead (M)"
          >
            <IconFlag /> Marker
          </button>
          <button
            type="button"
            className="pl-text-button"
            disabled={!selectedClipId}
            title="Duplicate the selected clip, right after it (Ctrl+D)"
            onClick={() => {
              if (!selectedClipId) return;
              const id = duplicatePlaylistClip(selectedClipId);
              if (id) setSelectedClipId(id);
            }}
          >
            <IconCopy /> Duplicate
          </button>
        </div>
      </div>

      <div className="playlist-body">
        <PatternPicker
          patternOrder={patternOrder}
          patterns={patterns}
          selectedPatternId={selectedPatternId}
          onSelect={selectPattern}
        />

        <div className="playlist-main">
        <PlaylistOverview
          scrollRef={laneRef}
          clips={clips}
          tracks={tracks}
          steps={totalSteps}
          pxPerStep={pxPerStep}
          onZoom={zoomFree}
        />
        <div
          className={`playlist-scroll tool-${editTool}`}
          ref={laneRef}
          data-hint={
            wheelZoom
              ? "Scroll wheel zooms · Shift + wheel scrolls sideways · Alt + wheel scrolls up and down · on a touchpad, two fingers scroll and a pinch zooms"
              : platformText("Ctrl + scroll wheel zooms · Shift + wheel scrolls sideways · on a touchpad, two fingers scroll and a pinch zooms")
          }
        >
          <div className="playlist-content" style={{ width: HEADER_WIDTH + laneWidth }}>
            <div className="playlist-timeline">
              <div className="playlist-marker-row">
                <div className="ruler-corner marker-corner" style={{ width: HEADER_WIDTH }}>
                  Markers
                </div>
                <MarkerLane
                  markers={markers}
                  width={laneWidth}
                  pxPerStep={pxPerStep}
                  snapSteps={snapSteps}
                />
              </div>

              <div className="playlist-ruler-row">
                <div className="ruler-corner" style={{ width: HEADER_WIDTH }}>
                  <PositionReadout />
                </div>
                <Ruler bars={totalBars} pxPerStep={pxPerStep} snapSteps={snapSteps} />
              </div>
            </div>

            {tracks.map((track, trackIndex) => (
              <div className="playlist-row" key={track.id} style={{ height: track.height }}>
                <TrackHeader trackIndex={trackIndex} width={HEADER_WIDTH} onConfirm={confirm} />

                <div
                  className="playlist-lane"
                  data-track={trackIndex}
                  style={
                    {
                      width: laneWidth,
                      height: track.height,
                      "--track-color": track.color
                    } as React.CSSProperties
                  }
                  onDragOver={(event) => {
                    if (!Array.from(event.dataTransfer.types).includes(PATTERN_DRAG)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }}
                  onDrop={(event) => {
                    const patternId = event.dataTransfer.getData(PATTERN_DRAG);
                    const pattern = patterns[patternId];
                    if (!pattern) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    const id = uid();
                    addPlaylistClip({
                      id,
                      type: "pattern",
                      patternId,
                      trackIndex,
                      startStep: Math.max(0, snapStep((event.clientX - rect.left) / pxPerStep, snapSteps)),
                      lengthSteps: pattern.length
                    });
                    selectPattern(patternId);
                    setSelectedClipId(id);
                  }}
                  onPointerDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const step = (event.clientX - rect.left) / pxPerStep;

                    // Right-drag erases a sweep of clips, and so does the left button with the delete tool.
                    if (event.button === 2 || (event.button === 0 && editTool === "erase")) {
                      event.preventDefault();
                      beginEdit("Erase clips");
                      dragRef.current = {
                        mode: "erase",
                        clipId: "",
                        startX: event.clientX,
                        startY: event.clientY,
                        originStep: 0,
                        originTrack: trackIndex,
                        originLength: 0
                      };
                      sweepAt(event.clientX, event.clientY, dragRef.current);
                      return;
                    }

                    if (event.button !== 0 || editTool === "mute") return;

                    // Hold and drag to lay down a row of clips instead of
                    // clicking once per bar.
                    beginEdit("Place clips");
                    dragRef.current = {
                      mode: "paint",
                      clipId: "",
                      startX: event.clientX,
                      startY: event.clientY,
                      originStep: step,
                      originTrack: trackIndex,
                      originLength: 0
                    };
                    sweepAt(event.clientX, event.clientY, dragRef.current);
                  }}
                >
                  {gridLines(totalBars, pxPerStep)}

                  {clips
                    .filter((clip) => clip.trackIndex === trackIndex)
                    .map((clip) => (
                      <ClipView
                        key={clip.id}
                        clip={clip}
                        pattern={clip.type === "pattern" ? patterns[clip.patternId] : undefined}
                        channels={channels}
                        pxPerStep={pxPerStep}
                        selected={clip.id === selectedClipId}
                        editTool={editTool}
                        onSelect={() => setSelectedClipId(clip.id)}
                        onToggleMute={toggleClipMute}
                        onOpen={openClip}
                        onStartDrag={startClipDrag}
                        onRemove={() => {
                          removePlaylistClip(clip.id);
                          if (selectedClipId === clip.id) setSelectedClipId(null);
                        }}
                      />
                    ))}
                </div>
              </div>
            ))}

            <MarkerLines
              markers={markers}
              pxPerStep={pxPerStep}
              headerWidth={HEADER_WIDTH}
              top={TIMELINE_HEIGHT}
              height={lanesHeight}
            />

            <PlaylistPlayhead
              pxPerStep={pxPerStep}
              headerWidth={HEADER_WIDTH}
              height={lanesHeight + TIMELINE_HEIGHT}
            />
          </div>
        </div>
        </div>
      </div>

      {selectedClip ? (
        <ClipInspector
          clip={selectedClip}
          onClose={() => setSelectedClipId(null)}
          onRemove={() => {
            removePlaylistClip(selectedClip.id);
            setSelectedClipId(null);
          }}
        />
      ) : null}
    </section>
  );
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function clipLength(clip: PlaylistClip): number {
  return clip.type === "pattern" ? clip.lengthSteps : clip.durationSteps;
}

/** Where the timeline has to reach to show everything that is on it. */
function contentEnd(clips: PlaylistClip[], markers: PlaylistMarker[]): number {
  let end = STEPS_PER_BAR;
  for (const clip of clips) end = Math.max(end, clip.startStep + clipLength(clip));
  // A marker parked past the last clip still needs somewhere to sit.
  for (const marker of markers) end = Math.max(end, marker.step + STEPS_PER_BAR);
  return end;
}

/** Where a new marker goes: under the playhead when rolling, else the start point. */
function playheadOrStart(): number {
  const transport = useTransportStore.getState();
  return transport.playheadStep >= 0 ? transport.playheadStep : transport.startStep;
}

function gridLines(bars: number, pxPerStep: number) {
  const barWidth = STEPS_PER_BAR * pxPerStep;
  // Beat lines only earn their keep once a bar is wide enough to read.
  const showBeats = barWidth >= 48;

  return (
    <div className="lane-grid" aria-hidden="true">
      {Array.from({ length: bars }, (_, bar) => (
        <span
          key={`bar-${bar}`}
          className={bar % 4 === 0 ? "lane-line major" : "lane-line"}
          style={{ left: bar * barWidth }}
        />
      ))}

      {/* Shade alternate bars so position is readable without counting lines. */}
      {Array.from({ length: Math.ceil(bars / 2) }, (_, index) => (
        <span
          key={`shade-${index}`}
          className="lane-shade"
          style={{ left: index * 2 * barWidth, width: barWidth }}
        />
      ))}

      {showBeats
        ? Array.from({ length: bars * 4 }, (_, beat) =>
            beat % 4 === 0 ? null : (
              <span
                key={`beat-${beat}`}
                className="lane-line beat"
                style={{ left: beat * STEPS_PER_BEAT * pxPerStep }}
              />
            )
          )
        : null}
    </div>
  );
}

/* ─────────────────────────────── markers ─────────────────────────────── */

function MarkerLane({
  markers,
  width,
  pxPerStep,
  snapSteps
}: {
  markers: PlaylistMarker[];
  width: number;
  pxPerStep: number;
  snapSteps: number;
}) {
  const addMarker = useProjectStore((state) => state.addMarker);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div
      className="playlist-marker-lane"
      style={{ width, height: MARKER_LANE_HEIGHT }}
      title="Double-click to drop a marker · drag to move · right-click removes"
      onDoubleClick={(event) => {
        // Only the empty strip adds; a double-click on a flag renames it.
        if (event.target !== event.currentTarget) return;

        const rect = event.currentTarget.getBoundingClientRect();
        const step = Math.max(0, snapStep((event.clientX - rect.left) / pxPerStep, snapSteps));
        const id = addMarker(step);
        if (id) setEditingId(id);
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {markers.map((marker) => (
        <MarkerFlag
          key={marker.id}
          marker={marker}
          pxPerStep={pxPerStep}
          snapSteps={snapSteps}
          editing={marker.id === editingId}
          onEdit={() => setEditingId(marker.id)}
          onEditDone={() => setEditingId(null)}
        />
      ))}
    </div>
  );
}

function MarkerFlag({
  marker,
  pxPerStep,
  snapSteps,
  editing,
  onEdit,
  onEditDone
}: {
  marker: PlaylistMarker;
  pxPerStep: number;
  snapSteps: number;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
}) {
  const moveMarker = useProjectStore((state) => state.moveMarker);
  const removeMarker = useProjectStore((state) => state.removeMarker);
  const renameMarker = useProjectStore((state) => state.renameMarker);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  // A drag interrupted by an unmount still has to close its undo group and
  // take its window listeners with it.
  const cleanup = useRef<(() => void) | null>(null);
  useUnmount(() => cleanup.current?.());

  if (editing) {
    const commit = (value: string) => {
      renameMarker(marker.id, value);
      onEditDone();
    };

    return (
      <span className="playlist-marker editing" style={{ left: marker.step * pxPerStep }}>
        <input
          className="marker-name-input"
          autoFocus
          defaultValue={marker.name}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") onEditDone();
          }}
        />
      </span>
    );
  }

  return (
    <span
      className="playlist-marker"
      style={{ left: marker.step * pxPerStep }}
      title={`${marker.name} — ${formatBarBeat(marker.step)}`}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        removeMarker(marker.id);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();

        const lane = event.currentTarget.parentElement;
        if (!lane) return;

        const rect = lane.getBoundingClientRect();
        const startX = event.clientX;
        let moved = false;

        const onMove = (move: PointerEvent) => {
          // A few pixels of slop keeps a plain click from counting as a drag.
          if (!moved) {
            if (Math.abs(move.clientX - startX) < 3) return;
            moved = true;
            beginEdit("Move marker");
          }

          moveMarker(
            marker.id,
            Math.max(0, snapStep((move.clientX - rect.left) / pxPerStep, snapSteps))
          );
        };

        const finish = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
          cleanup.current = null;
          if (moved) endEdit();
        };

        const onUp = () => {
          const wasDrag = moved;
          finish();
          // A plain click on a marker jumps the playhead to its section.
          if (!wasDrag) seekTo(marker.step);
        };

        cleanup.current = finish;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      }}
    >
      {marker.name}
    </span>
  );
}

const MarkerLines = memo(function MarkerLines({
  markers,
  pxPerStep,
  headerWidth,
  top,
  height
}: {
  markers: PlaylistMarker[];
  pxPerStep: number;
  headerWidth: number;
  top: number;
  height: number;
}) {
  if (markers.length === 0) return null;

  return (
    <div className="marker-lines" style={{ left: headerWidth, top, height }} aria-hidden="true">
      {markers.map((marker) => (
        <span key={marker.id} className="marker-line" style={{ left: marker.step * pxPerStep }} />
      ))}
    </div>
  );
});

/* ─────────────────────────────── ruler ─────────────────────────────── */

function Ruler({
  bars,
  pxPerStep,
  snapSteps
}: {
  bars: number;
  pxPerStep: number;
  snapSteps: number;
}) {
  const barWidth = STEPS_PER_BAR * pxPerStep;
  // Thin out the numbers when zoomed out so they don't collide.
  const labelEvery = barWidth < 34 ? (barWidth < 18 ? 8 : 4) : 1;

  const loopStart = useProjectStore((state) => state.loopStart);
  const loopEnd = useProjectStore((state) => state.loopEnd);
  const setLoopRegion = useProjectStore((state) => state.setLoopRegion);

  const anchor = useRef<number | null>(null);

  return (
    <div
      className={`playlist-ruler${barWidth / 4 >= 8 ? " beats" : ""}`}
      style={{ width: bars * barWidth, height: RULER_HEIGHT, "--beat": `${barWidth / 4}px` } as React.CSSProperties}
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const step = Math.max(0, (event.clientX - rect.left) / pxPerStep);

        // Right-click clears the loop; drag with the right button, or shift-drag
        // with the left, to set one.
        if (event.button === 2) {
          event.preventDefault();
          setLoopRegion(null, null);
          return;
        }

        if (event.shiftKey) {
          event.preventDefault();
          anchor.current = Math.max(0, snapStep(step, snapSteps));

          const onMove = (move: PointerEvent) => {
            if (anchor.current === null) return;
            const to = Math.max(0, snapStep((move.clientX - rect.left) / pxPerStep, snapSteps));
            const from = anchor.current;
            if (to === from) return;
            setLoopRegion(Math.min(from, to), Math.max(from, to));
          };

          const onUp = () => {
            anchor.current = null;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
          };

          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onUp);
          return;
        }

        // Click to move the playhead there, and keep the button down to drag it along.
        seekTo(Math.max(0, Math.floor(step)));
        const onMove = (move: PointerEvent) => seekTo(Math.max(0, Math.floor((move.clientX - rect.left) / pxPerStep)));
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      }}
      onContextMenu={(event) => event.preventDefault()}
      title="Click or drag to move the playhead · shift-drag for a loop region · right-click clears it"
    >
      {loopStart !== null && loopEnd !== null ? (
        <span
          className="ruler-loop"
          style={{ left: loopStart * pxPerStep, width: (loopEnd - loopStart) * pxPerStep }}
        />
      ) : null}

      {Array.from({ length: bars }, (_, bar) => (
        <span
          key={bar}
          className={bar % 4 === 0 ? "ruler-bar major" : "ruler-bar"}
          style={{ left: bar * barWidth, width: barWidth }}
        >
          {bar % labelEvery === 0 ? bar + 1 : ""}
        </span>
      ))}
    </div>
  );
}

const PositionReadout = memo(function PositionReadout() {
  const playheadStep = useTransportStore((state) => state.playheadStep);
  const startStep = useTransportStore((state) => state.startStep);
  const step = playheadStep >= 0 ? playheadStep : startStep;

  return <span className="position-readout">{formatBarBeat(step)}</span>;
});

const PlaylistPlayhead = memo(function PlaylistPlayhead({
  pxPerStep,
  headerWidth,
  height
}: {
  pxPerStep: number;
  headerWidth: number;
  height: number;
}) {
  const playheadStep = useTransportStore((state) => state.playheadStep);
  const startStep = useTransportStore((state) => state.startStep);
  const isPlaying = useTransportStore((state) => state.isPlaying);
  const mode = useSessionStore((state) => state.mode);

  if (mode !== "song") return null;

  const step = isPlaying && playheadStep >= 0 ? playheadStep : startStep;

  return (
    <div
      className={`playlist-playhead${isPlaying ? " playing" : ""}`}
      style={{ left: headerWidth + step * pxPerStep, height }}
      aria-hidden="true"
    />
  );
});

/* ───────────────────────────── overview ───────────────────────────── */

/**
 * The whole song in a strip above the lanes, as in FL: every clip in its track's colour, the playhead, and a box
 * around the part on screen. Click or drag to scroll there.
 */
function PlaylistOverview({
  scrollRef,
  clips,
  tracks,
  steps,
  pxPerStep,
  onZoom
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  clips: PlaylistClip[];
  tracks: Array<{ color: string; mute: boolean }>;
  /** How long the song is: the strip shows this much, however far the view is zoomed out. */
  steps: number;
  pxPerStep: number;
  /** Dragging an edge of the box: this many pixels per step, with the view starting at this step. */
  onZoom: (px: number, startStep: number) => void;
}) {
  const [view, setView] = useState({ start: 0, span: 0 });
  const playheadStep = useTransportStore((state) => state.playheadStep);
  const startStep = useTransportStore((state) => state.startStep);
  const strip = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const read = () =>
      setView({ start: element.scrollLeft / pxPerStep, span: Math.max(0, element.clientWidth - HEADER_WIDTH) / pxPerStep });
    read();
    element.addEventListener("scroll", read, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", read);
      observer?.disconnect();
    };
  }, [pxPerStep, scrollRef]);

  const total = Math.max(1, steps);
  const percent = (value: number) => `${(Math.max(0, Math.min(total, value)) / total) * 100}%`;
  const rows = Math.max(1, tracks.length);
  const head = playheadStep >= 0 ? playheadStep : startStep;

  const scrollTo = (clientX: number, grab: number) => {
    const element = scrollRef.current;
    const box = strip.current?.getBoundingClientRect();
    if (!element || !box || box.width <= 0) return;
    const step = ((clientX - box.left) / box.width) * total - grab;
    element.scrollLeft = Math.max(0, step * pxPerStep);
  };

  // Dragging either edge of the box resizes it, which zooms: the other edge stays where it is, as in FL.
  const resize = (side: "left" | "right") => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = scrollRef.current;
    const box = strip.current?.getBoundingClientRect();
    if (!element || !box || box.width <= 0) return;

    const room = Math.max(1, element.clientWidth - HEADER_WIDTH);
    const fixedStart = view.start;
    const fixedEnd = view.start + Math.min(view.span, total - view.start);
    const stepAt = (clientX: number) => Math.max(0, Math.min(total, ((clientX - box.left) / box.width) * total));

    const onMove = (move: PointerEvent) => {
      if (side === "right") {
        const end = Math.max(fixedStart + 1, stepAt(move.clientX));
        onZoom(room / (end - fixedStart), fixedStart);
      } else {
        const start = Math.min(fixedEnd - 1, stepAt(move.clientX));
        onZoom(room / (fixedEnd - start), start);
      }
    };
    const onUp = () => {
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      ref={strip}
      className="playlist-overview"
      title="The whole song: click or drag to scroll there, drag the box's edges to zoom"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const box = strip.current?.getBoundingClientRect();
        if (!box) return;
        const step = ((event.clientX - box.left) / box.width) * total;
        // Dragging the box keeps hold of it where it was grabbed; elsewhere, the box centres on the click.
        const grab = step >= view.start && step <= view.start + view.span ? step - view.start : view.span / 2;
        scrollTo(event.clientX, grab);
        const onMove = (move: PointerEvent) => scrollTo(move.clientX, grab);
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      }}
    >
      {clips.map((clip) => (
        <span
          key={clip.id}
          className={`overview-clip${clip.muted || tracks[clip.trackIndex]?.mute ? " muted" : ""}`}
          style={{
            left: percent(clip.startStep),
            width: `max(2px, ${(clipLength(clip) / total) * 100}%)`,
            top: `${(clip.trackIndex / rows) * 100}%`,
            height: `${100 / rows}%`,
            background: tracks[clip.trackIndex]?.color
          }}
        />
      ))}
      <span className="overview-playhead" style={{ left: percent(head) }} />
      <span className="overview-view" style={{ left: percent(view.start), width: percent(Math.min(view.span, total - view.start)) }}>
        <span className="overview-handle left" onPointerDown={resize("left")} title="Drag to zoom" />
        <span className="overview-handle right" onPointerDown={resize("right")} title="Drag to zoom" />
      </span>
    </div>
  );
}

/* ───────────────────────────── track header ───────────────────────────── */

const TrackHeader = memo(function TrackHeader({
  trackIndex,
  width,
  onConfirm
}: {
  trackIndex: number;
  width: number;
  onConfirm: ReturnType<typeof useConfirm>;
}) {
  const track = useProjectStore((state) => state.playlist.tracks[trackIndex]);
  const trackCount = useProjectStore((state) => state.playlist.tracks.length);
  const renamePlaylistTrack = useProjectStore((state) => state.renamePlaylistTrack);
  const movePlaylistTrack = useProjectStore((state) => state.movePlaylistTrack);
  const removePlaylistTrack = useProjectStore((state) => state.removePlaylistTrack);
  const toggleTrackMute = useProjectStore((state) => state.toggleTrackMute);
  const toggleTrackSolo = useProjectStore((state) => state.toggleTrackSolo);
  const clearPlaylistTrack = useProjectStore((state) => state.clearPlaylistTrack);
  const setPlaylistTrackColor = useProjectStore((state) => state.setPlaylistTrackColor);
  const setPlaylistTrackHeight = useProjectStore((state) => state.setPlaylistTrackHeight);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const [draft, setDraft] = useState(track?.name ?? "");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => setDraft(track?.name ?? ""), [track?.name]);

  // An open palette covers the lane beneath it, so anything else the user
  // reaches for should put it away first.
  useEffect(() => {
    if (!paletteOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && headerRef.current?.contains(target)) return;
      setPaletteOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [paletteOpen]);

  // A resize interrupted by an unmount must not leave the undo group open.
  const cleanup = useRef<(() => void) | null>(null);
  useUnmount(() => cleanup.current?.());

  if (!track) return null;

  const compact = track.height < COMPACT_TRACK_HEIGHT;

  const startResize = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = track.height;
    beginEdit("Resize track");

    const onMove = (move: PointerEvent) => {
      setPlaylistTrackHeight(trackIndex, startHeight + (move.clientY - startY));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      cleanup.current = null;
      endEdit();
    };

    cleanup.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const menuItems: MenuItem[] = [
    { label: "Rename", run: () => headerRef.current?.querySelector<HTMLInputElement>(".track-name-input")?.select() },
    { label: "Colour…", run: () => setPaletteOpen(true) },
    {
      label: "Lane height",
      items: [
        { label: "Small", radio: true, checked: track.height <= 32, run: () => setPlaylistTrackHeight(trackIndex, 30) },
        { label: "Normal", radio: true, checked: track.height > 32 && track.height <= 80, run: () => setPlaylistTrackHeight(trackIndex, DEFAULT_TRACK_HEIGHT) },
        { label: "Tall", radio: true, checked: track.height > 80, run: () => setPlaylistTrackHeight(trackIndex, 120) }
      ]
    },
    { label: "", separator: true },
    { label: track.solo ? "Stop soloing" : "Solo", run: () => toggleTrackSolo(trackIndex) },
    { label: "Move up", disabled: trackIndex === 0, run: () => movePlaylistTrack(trackIndex, trackIndex - 1) },
    { label: "Move down", disabled: trackIndex === trackCount - 1, run: () => movePlaylistTrack(trackIndex, trackIndex + 1) },
    { label: "", separator: true },
    { label: "Clear its clips", run: () => clearPlaylistTrack(trackIndex) },
    {
      label: "Delete track",
      disabled: trackCount <= 1,
      run: () =>
        void onConfirm(`Delete "${track.name}"?`, "Its clips will be removed too.", {
          confirmLabel: "Delete"
        }).then((confirmed) => {
          if (confirmed) removePlaylistTrack(trackIndex);
        })
    }
  ];

  return (
    <div
      ref={headerRef}
      className={`track-header${compact ? " compact" : ""}${paletteOpen ? " palette-open" : ""}${track.mute ? " muted" : ""}`}
      style={{ width, height: track.height, "--track-color": track.color } as React.CSSProperties}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("input")) return;
        event.preventDefault();
        setMenu({ left: event.clientX, top: event.clientY });
      }}
    >
      <span className="track-stripe" aria-hidden="true" />

      <div className="track-top">
        <button
          className="track-swatch"
          aria-label={`${track.name} colour`}
          aria-expanded={paletteOpen}
          title="Lane colour"
          onClick={() => setPaletteOpen((open) => !open)}
        />

        <input
          className="track-name-input"
          value={draft}
          aria-label={`${track.name} name`}
          title="Track name: click to rename"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => renamePlaylistTrack(trackIndex, draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />

        <button
          className={`track-solo${track.solo ? " active" : ""}`}
          aria-pressed={track.solo}
          onClick={() => toggleTrackSolo(trackIndex)}
          title="Solo: hear only this track (and other soloed ones)"
        >
          S
        </button>

        {/* The light is on while the track plays, as in FL: click it to mute. */}
        <button
          className={`track-led${track.mute ? "" : " on"}`}
          aria-pressed={track.mute}
          aria-label="Mute track"
          onClick={() => toggleTrackMute(trackIndex)}
          title={track.mute ? "Muted: click to hear this track again" : "Playing: click to mute this track"}
        />

        <button
          ref={moreRef}
          className="track-more"
          aria-label="Track options"
          aria-expanded={menu !== null}
          title="Track options: colour, height, move, clear, delete (or right-click the track)"
          onClick={() => {
            if (menu) {
              setMenu(null);
              return;
            }
            const box = moreRef.current?.getBoundingClientRect();
            if (box) setMenu({ left: box.left, top: box.bottom + 2 });
          }}
        >
          <IconMore />
        </button>
      </div>

      {paletteOpen ? (
        <div className="track-palette" role="group" aria-label="Lane colour">
          {trackColors.map((color) => (
            <button
              key={color}
              className={color === track.color ? "selected" : ""}
              style={{ background: color }}
              aria-label={color}
              onClick={() => {
                setPlaylistTrackColor(trackIndex, color);
                setPaletteOpen(false);
              }}
            />
          ))}
        </div>
      ) : null}

      <span
        className="track-resize"
        title="Drag to resize the lane · double-click resets it"
        onPointerDown={startResize}
        onDoubleClick={() => setPlaylistTrackHeight(trackIndex, DEFAULT_TRACK_HEIGHT)}
      />

      {menu
        ? createPortal(
            <MenuPanel items={prepareItems(menuItems)} left={menu.left} top={menu.top} anchor={moreRef.current} onClose={() => setMenu(null)} />,
            document.body
          )
        : null}
    </div>
  );
});

/* ─────────────────────────────── clips ─────────────────────────────── */

interface ClipViewProps {
  clip: PlaylistClip;
  pattern: Pattern | undefined;
  channels: Channel[];
  pxPerStep: number;
  selected: boolean;
  editTool: EditTool;
  onSelect: () => void;
  onToggleMute: (clipId: string) => void;
  onOpen: (clip: PlaylistClip) => void;
  onStartDrag: (clip: PlaylistClip, mode: "move" | "resize", event: React.PointerEvent) => void;
  onRemove: () => void;
}

/**
 * A clip on the playlist: a strip in the lane's colour with its name, over a
 * dark body that shows what is actually in it — the pattern's hits and notes,
 * the audio's waveform, or the automation curve.
 */
const ClipView = memo(function ClipView({
  clip,
  pattern,
  channels,
  pxPerStep,
  selected,
  editTool,
  onSelect,
  onToggleMute,
  onOpen,
  onStartDrag,
  onRemove
}: ClipViewProps) {
  const length = clipLength(clip);
  const width = Math.max(12, length * pxPerStep);

  const label = clip.type === "pattern" ? pattern?.name ?? "Missing pattern" : clip.name;

  return (
    <div
      className={`playlist-clip clip-${clip.type}${selected ? " selected" : ""}${clip.muted ? " muted" : ""}`}
      style={{ left: clip.startStep * pxPerStep, width }}
      title={`${label}${clip.muted ? " (muted)" : ""} — bar ${Math.floor(clip.startStep / STEPS_PER_BAR) + 1}${clip.type === "pattern" ? " · double-click to open the pattern" : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // The delete tool's press goes on to the lane, which erases whatever the drag passes over.
        if (editTool === "erase") return;
        if (editTool === "mute") {
          event.stopPropagation();
          onToggleMute(clip.id);
          return;
        }
        onSelect();
        onStartDrag(clip, "move", event);
      }}
      onDoubleClick={() => {
        if (editTool === "draw") onOpen(clip);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRemove();
      }}
    >
      <div className="clip-header">
        <span className="clip-label">{label}</span>
      </div>

      <div className="clip-body">
        {clip.type === "pattern" && pattern ? (
          <PatternClipPreview pattern={pattern} channels={channels} lengthSteps={length} />
        ) : null}
        {clip.type === "audio" ? <AudioClipPreview clip={clip} /> : null}
        {clip.type === "automation" ? <AutomationPreview clip={clip} /> : null}
      </div>

      <span
        className="clip-resize"
        title="Drag to resize"
        onPointerDown={(event) => {
          if (event.button !== 0 || editTool !== "draw") return;
          onStartDrag(clip, "resize", event);
        }}
      />
    </div>
  );
});

function PatternClipPreview({
  pattern,
  channels,
  lengthSteps
}: {
  pattern: Pattern;
  channels: Channel[];
  lengthSteps: number;
}) {
  const shapes = useMemo(() => patternShapes(pattern, channels), [pattern, channels]);
  const loopLength = Math.max(1, pattern.length);
  const repeats = Math.ceil(lengthSteps / loopLength);

  return (
    <svg
      className="clip-preview"
      viewBox={`0 0 ${lengthSteps} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {Array.from({ length: repeats }, (_, repeat) => {
        const offset = repeat * loopLength;
        return (
          <g key={repeat}>
            {repeat > 0 ? <line className="clip-loop-line" x1={offset} x2={offset} y1={0} y2={100} /> : null}
            {shapes.map((shape, index) =>
              shape.x + offset < lengthSteps ? (
                <rect
                  key={index}
                  x={shape.x + offset}
                  y={shape.y}
                  width={shape.w}
                  height={shape.h}
                  opacity={shape.opacity}
                />
              ) : null
            )}
          </g>
        );
      })}
    </svg>
  );
}

const AUDIO_PEAKS = 400;

/** The part of the sample the clip plays, drawn as a waveform. */
function AudioClipPreview({ clip }: { clip: AudioClip }) {
  const bpm = useProjectStore((state) => state.bpm);
  // Redraw once the sample has finished decoding.
  const samples = useSamples();

  const points = useMemo(() => {
    const sample = getSample(clip.sampleId);
    if (!sample || sample.duration <= 0) return null;

    const peaks = getWaveformPeaks(clip.sampleId, AUDIO_PEAKS);
    const stepSeconds = secondsPerStep(bpm);
    const columns = Math.max(8, Math.min(240, Math.round(clip.durationSteps * 6)));
    const gain = clamp(clip.volume, 0, 1.5);

    const top: string[] = [];
    const bottom: string[] = [];

    for (let i = 0; i <= columns; i++) {
      const step = (i / columns) * clip.durationSteps;
      const at = ((clip.offsetSteps + step) * stepSeconds) / sample.duration;
      const peak = at >= 1 ? 0 : peaks[Math.min(AUDIO_PEAKS - 1, Math.floor(at * AUDIO_PEAKS))] * gain;
      const reach = Math.min(46, Math.max(0.6, peak * 46));
      top.push(`${step.toFixed(3)},${(50 - reach).toFixed(2)}`);
      bottom.unshift(`${step.toFixed(3)},${(50 + reach).toFixed(2)}`);
    }

    return [...top, ...bottom].join(" ");
    // `samples` is here to recompute when the registry changes.
  }, [bpm, clip.durationSteps, clip.offsetSteps, clip.sampleId, clip.volume, samples]);

  if (!points) return null;

  return (
    <svg
      className="clip-preview"
      viewBox={`0 0 ${clip.durationSteps} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon points={points} />
    </svg>
  );
}
function PatternPreview({ pattern, lengthSteps }: { pattern: Pattern; lengthSteps: number }) {
  const cells = useMemo(() => {
    const columns = Math.min(64, lengthSteps);
    return Array.from({ length: columns }, (_, index) => {
      const step = Math.floor((index / columns) * lengthSteps) % pattern.length;
      return Object.values(pattern.channels).some(
        (channel) =>
          isStepActive(channel.steps[step]) ||
          channel.notes.some((note) => note.start === step)
      );
    });
  }, [lengthSteps, pattern]);

  return (
    <span className="pattern-preview" aria-hidden="true">
      {cells.map((active, index) => (
        <i key={index} className={active ? "active" : ""} />
      ))}
    </span>
  );
}

function AutomationPreview({ clip }: { clip: AutomationClip }) {
  const points = clip.points;
  if (points.length < 2) return null;

  const path = points
    .map((point) => {
      const x = (point.step / Math.max(1, clip.durationSteps)) * 100;
      const y = (1 - point.value) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg className="automation-preview" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={path} />
    </svg>
  );
}

/* ──────────────────────────── clip inspector ──────────────────────────── */

function ClipInspector({
  clip,
  onClose,
  onRemove
}: {
  clip: PlaylistClip;
  onClose: () => void;
  onRemove: () => void;
}) {
  const updatePlaylistClip = useProjectStore((state) => state.updatePlaylistClip);

  return (
    <div className="clip-inspector">
      <div className="inspector-head">
        <strong>
          {clip.type === "pattern" ? "Pattern clip" : clip.type === "audio" ? "Audio clip" : "Automation clip"}
        </strong>
        <span className="small-note">Bar {Math.floor(clip.startStep / STEPS_PER_BAR) + 1}</span>
        <span className="menu-spacer" />
        <button onClick={onRemove}>Delete</button>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="inspector-body">
        <label>
          Start (steps)
          <input
            type="number"
            min={0}
            value={clip.startStep}
            onChange={(event) =>
              updatePlaylistClip(clip.id, { startStep: Number(event.target.value) })
            }
          />
        </label>

        <label>
          Length (steps)
          <input
            type="number"
            min={1}
            value={clipLength(clip)}
            onChange={(event) =>
              updatePlaylistClip(clip.id, { lengthSteps: Number(event.target.value) })
            }
          />
        </label>

        {clip.type === "automation" ? <AutomationEditor clip={clip} /> : null}
      </div>
    </div>
  );
}

/* ──────────────────────────── pattern picker ──────────────────────────── */

function PatternPicker({
  patternOrder,
  patterns,
  selectedPatternId,
  onSelect
}: {
  patternOrder: string[];
  patterns: Record<string, Pattern>;
  selectedPatternId: string;
  onSelect: (id: string) => void;
}) {
  const confirm = useConfirm();
  const addPattern = useProjectStore((state) => state.addPattern);
  const duplicatePattern = useProjectStore((state) => state.duplicatePattern);
  const removePattern = useProjectStore((state) => state.removePattern);

  return (
    <aside className="pattern-picker">
      <div className="picker-title">
        Patterns
        <button onClick={() => onSelect(addPattern())} title="New pattern">
          +
        </button>
      </div>

      <div className="picker-list">
        {patternOrder.map((patternId, index) => {
          const pattern = patterns[patternId];
          if (!pattern) return null;

          const selected = patternId === selectedPatternId;

          return (
            <div
              key={patternId}
              className={`pattern-picker-item${selected ? " selected" : ""}`}
              title={`${pattern.name}: click to place it with the draw tool, or drag it onto a lane`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(PATTERN_DRAG, patternId);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onSelect(patternId)}
            >
              <span className="picker-index">{index + 1}</span>
              <span className="picker-info">
                <strong>{pattern.name}</strong>
                <PatternPreview pattern={pattern} lengthSteps={pattern.length} />
              </span>

              <span className="picker-actions">
                <button
                  title="Duplicate pattern"
                  aria-label="Duplicate pattern"
                  onClick={(event) => {
                    event.stopPropagation();
                    const id = duplicatePattern(patternId);
                    if (id) onSelect(id);
                  }}
                >
                  <IconCopy />
                </button>
                <button
                  title="Delete pattern"
                  aria-label="Delete pattern"
                  disabled={patternOrder.length <= 1}
                  onClick={(event) => {
                    event.stopPropagation();
                    void confirm(
                      `Delete "${pattern.name}"?`,
                      "Clips using this pattern will be removed from the arrangement.",
                      { confirmLabel: "Delete" }
                    ).then((confirmed) => {
                      if (confirmed) removePattern(patternId);
                    });
                  }}
                >
                  <IconTrash />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
