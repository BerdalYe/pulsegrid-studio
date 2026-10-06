import { platformText } from "../lib/hotkeys";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useProjectStore } from "../state/projectStore";
import { useWheelZoom } from "../hooks/useWheelZoom";
import { IconBroom, IconChevronDown, IconChevronUp, IconCopy, IconTrash } from "./icons";
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
  const [sampleId, setSampleId] = useState("");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM);

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
    setIndex: setZoomIndex,
    gutter: HEADER_WIDTH
  });

  const pxPerStep = ZOOM_LEVELS[zoomIndex];
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
        <span className="toolbar-caption">Place</span>
        <div className="placement-tools" role="group" aria-label="Draw tool">
          {(["pattern", "audio", "automation"] as DrawTool[]).map((option) => (
            <button
              key={option}
              className={tool === option ? "active" : ""}
              onClick={() => setTool(option)}
            >
              {option === "pattern" ? "Pattern" : option === "audio" ? "Audio" : "Automation"}
            </button>
          ))}
        </div>

        {tool === "audio" ? (
          <label>
            Sample
            <select value={sampleId} onChange={(event) => setSampleId(event.target.value)}>
              {samples.map((sample) => (
                <option key={sample.id} value={sample.id}>
                  {sample.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label>
          Snap
          <select value={snapSteps} onChange={(event) => setSnapSteps(Number(event.target.value))}>
            <option value={1}>Step</option>
            <option value={4}>Beat</option>
            <option value={8}>1/2 bar</option>
            <option value={16}>Bar</option>
          </select>
        </label>

        <label>
          Bars
          <input
            className="song-length-input"
            type="number"
            min={1}
            max={512}
            value={songBars}
            onChange={(event) => setSongBars(Number(event.target.value))}
          />
        </label>

        <div className="zoom-controls">
          <button onClick={() => setZoomIndex((i) => Math.max(0, i - 1))} disabled={zoomIndex === 0}>
            −
          </button>
          <span>Zoom</span>
          <button
            onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          >
            +
          </button>
        </div>

        <button className="secondary-action" onClick={() => addPlaylistTrack()}>
          + Track
        </button>

        <button
          className="secondary-action"
          onClick={() => addMarker(playheadOrStart())}
          title="Drop a marker at the playhead (M)"
        >
          + Marker
        </button>

        <button
          disabled={!selectedClipId}
          onClick={() => {
            if (!selectedClipId) return;
            const id = duplicatePlaylistClip(selectedClipId);
            if (id) setSelectedClipId(id);
          }}
        >
          Duplicate
        </button>

        <span className="small-note">
          Click a lane to place · drag to move · right edge resizes · right-click removes
        </span>
      </div>

      <div className="playlist-body">
        <PatternPicker
          patternOrder={patternOrder}
          patterns={patterns}
          selectedPatternId={selectedPatternId}
          onSelect={selectPattern}
        />

        <div
          className="playlist-scroll"
          ref={laneRef}
          data-hint={
            wheelZoom
              ? "Scroll wheel zooms · Shift + wheel scrolls sideways · Alt + wheel scrolls up and down"
              : platformText("Ctrl + scroll wheel zooms · Shift + wheel scrolls sideways")
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
                  onPointerDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const step = (event.clientX - rect.left) / pxPerStep;

                    // Right-drag erases a sweep of clips.
                    if (event.button === 2) {
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

                    if (event.button !== 0) return;

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
                        onSelect={() => setSelectedClipId(clip.id)}
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
      className="playlist-ruler"
      style={{ width: bars * barWidth, height: RULER_HEIGHT }}
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

        seekTo(Math.max(0, Math.floor(step)));
      }}
      onContextMenu={(event) => event.preventDefault()}
      title="Click to set the playback start · shift-drag for a loop region · right-click clears it"
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
  const headerRef = useRef<HTMLDivElement | null>(null);
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

  return (
    <div
      ref={headerRef}
      className={`track-header${compact ? " compact" : ""}${paletteOpen ? " palette-open" : ""}`}
      style={{ width, height: track.height, "--track-color": track.color } as React.CSSProperties}
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
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => renamePlaylistTrack(trackIndex, draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
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

      <div className="track-buttons">
        <button
          className={track.mute ? "active" : ""}
          aria-pressed={track.mute}
          onClick={() => toggleTrackMute(trackIndex)}
          title="Mute track"
        >
          M
        </button>
        <button
          className={track.solo ? "active" : ""}
          aria-pressed={track.solo}
          onClick={() => toggleTrackSolo(trackIndex)}
          title="Solo track"
        >
          S
        </button>
        <button
          className="track-extra"
          onClick={() => movePlaylistTrack(trackIndex, trackIndex - 1)}
          disabled={trackIndex === 0}
          title="Move up"
          aria-label="Move up"
        >
          <IconChevronUp />
        </button>
        <button
          className="track-extra"
          onClick={() => movePlaylistTrack(trackIndex, trackIndex + 1)}
          disabled={trackIndex === trackCount - 1}
          title="Move down"
          aria-label="Move down"
        >
          <IconChevronDown />
        </button>
        <button
          className="track-extra"
          onClick={() => clearPlaylistTrack(trackIndex)}
          title="Clear clips"
          aria-label="Clear clips"
        >
          <IconBroom />
        </button>
        <button
          className="track-extra track-delete"
          disabled={trackCount <= 1}
          title="Delete track"
          aria-label="Delete track"
          onClick={() =>
            void onConfirm(`Delete "${track.name}"?`, "Its clips will be removed too.", {
              confirmLabel: "Delete"
            }).then((confirmed) => {
              if (confirmed) removePlaylistTrack(trackIndex);
            })
          }
        >
          <IconTrash />
        </button>
      </div>

      <span
        className="track-resize"
        title="Drag to resize the lane · double-click resets it"
        onPointerDown={startResize}
        onDoubleClick={() => setPlaylistTrackHeight(trackIndex, DEFAULT_TRACK_HEIGHT)}
      />
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
  onSelect: () => void;
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
  onSelect,
  onStartDrag,
  onRemove
}: ClipViewProps) {
  const length = clipLength(clip);
  const width = Math.max(12, length * pxPerStep);

  const label = clip.type === "pattern" ? pattern?.name ?? "Missing pattern" : clip.name;

  return (
    <div
      className={`playlist-clip clip-${clip.type}${selected ? " selected" : ""}`}
      style={{ left: clip.startStep * pxPerStep, width }}
      title={`${label} — bar ${Math.floor(clip.startStep / STEPS_PER_BAR) + 1}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        onSelect();
        onStartDrag(clip, "move", event);
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
          if (event.button !== 0) return;
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
