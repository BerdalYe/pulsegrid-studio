import { memo, useCallback, useEffect, useRef, useState } from "react";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { useTransportStore } from "../state/transportStore";
import { useConfirm } from "./ConfirmDialog";
import { Knob } from "./controls";
import { Waveform } from "./Waveform";
import { useSamples, useSelectedPattern, useUnmount } from "../hooks/useStudio";
import { previewChannel } from "../audio/engine";
import { INSTRUMENT_GROUPS, availableInstruments, synthPresets } from "../presets/presets";
import { addInstrument } from "../lib/addInstrument";
import { useSoundFontStore } from "../audio/soundfont/registry";
import { IconSynth } from "./icons";
import { useSynthEditor } from "./SynthEditor";

/** The picker entry shown while a channel plays a sound its owner built. */
const CUSTOM_SOUND = "__custom";

import {
  DEFAULT_STEP_VELOCITY,
  STEPS_PER_BEAT,
  clamp,
  isPitchedChannel,
  isSampleChannel,
  isStepActive
} from "../lib/utils";

import type { Channel, ChannelType, Pattern, StepCell } from "../types";

const STEP_SIZE = 22;
const STEP_GAP = 2;
const STEP_PITCH = STEP_SIZE + STEP_GAP;
/** Width of the fixed channel header column; the playhead lines up against it. */
const HEAD_WIDTH = 392;



export function ChannelRack() {
  const confirm = useConfirm();
  const channels = useProjectStore((state) => state.channels);
  const addChannel = useProjectStore((state) => state.addChannel);
  const selectChannel = useSessionStore((state) => state.selectChannel);
  const mixerTracks = useProjectStore((state) => state.mixer.tracks);

  const { pattern, patternId } = useSelectedPattern();
  // Indexes INSTRUMENT_MENU rather than holding a bare ChannelType, so the
  // rack can offer the same named instruments the ADD menu does.
  const [newIndex, setNewIndex] = useState(0);
  const instruments = availableInstruments(useSoundFontStore((state) => state.builtinAvailable));
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!pattern) return <div className="empty-note">No pattern selected.</div>;

  return (
    <section className="channel-rack">
      <div className="toolbar">
        <label>
          Add
          <select
            className="rack-add-select"
            value={newIndex}
            title="Instrument to add"
            onChange={(event) => setNewIndex(Number(event.target.value))}
          >
            {INSTRUMENT_GROUPS.map((group) =>
              instruments.some((entry) => entry.group === group) ? (
                <optgroup key={group} label={group}>
                  {instruments.map((entry, index) =>
                    entry.group === group ? (
                      <option key={entry.label} value={index}>
                        {entry.label}
                      </option>
                    ) : null
                  )}
                </optgroup>
              ) : null
            )}
          </select>
        </label>

        <button
          className="secondary-action"
          title="Add the selected instrument as a new channel"
          onClick={() => {
            addInstrument(instruments[newIndex] ?? instruments[0]);
          }}
        >
          + Channel
        </button>

        <span className="rack-pattern">
          {pattern.name} · {pattern.length} steps
        </span>

        <span className="small-note">
          Click or drag to paint · right-drag a step for velocity
        </span>
      </div>

      <div className="rack-scroll">
        <div className="rack-body" style={{ minWidth: HEAD_WIDTH + pattern.length * STEP_PITCH }}>
          <RackPlayhead patternLength={pattern.length} />

          {channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              pattern={pattern}
              patternId={patternId}
              mixerTrackCount={mixerTracks.length}
              expanded={expandedId === channel.id}
              onToggleExpanded={() =>
                setExpandedId((current) => (current === channel.id ? null : channel.id))
              }
              onConfirmDelete={confirm}
            />
          ))}

          {channels.length === 0 ? (
            <div className="empty-note">Add a channel to start building a pattern.</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The playhead is its own subscriber so a moving playhead re-renders one
 * absolutely-positioned strip instead of every step button in the rack.
 */
const RackPlayhead = memo(function RackPlayhead({ patternLength }: { patternLength: number }) {
  const playheadStep = useTransportStore((state) => state.playheadStep);
  const mode = useSessionStore((state) => state.mode);

  // In song mode the rack shows the selected pattern, which may be playing at
  // a different offset — only show a playhead when it's meaningful.
  if (playheadStep < 0 || mode !== "pattern") return null;

  const step = playheadStep % patternLength;

  return (
    <div
      className="rack-playhead"
      style={{ left: HEAD_WIDTH + step * STEP_PITCH, width: STEP_SIZE }}
      aria-hidden="true"
    />
  );
});

interface ChannelRowProps {
  channel: Channel;
  pattern: Pattern;
  patternId: string;
  mixerTrackCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onConfirmDelete: ReturnType<typeof useConfirm>;
}

const ChannelRow = memo(function ChannelRow({
  channel,
  pattern,
  patternId,
  mixerTrackCount,
  expanded,
  onToggleExpanded,
  onConfirmDelete
}: ChannelRowProps) {
  const setStep = useProjectStore((state) => state.setStep);
  const toggleStep = useProjectStore((state) => state.toggleStep);
  const removeChannel = useProjectStore((state) => state.removeChannel);
  const duplicateChannel = useProjectStore((state) => state.duplicateChannel);
  const updateChannelName = useProjectStore((state) => state.updateChannelName);
  const toggleChannelMute = useProjectStore((state) => state.toggleChannelMute);
  const toggleChannelSolo = useProjectStore((state) => state.toggleChannelSolo);
  const setChannelVolume = useProjectStore((state) => state.setChannelVolume);
  const setChannelPan = useProjectStore((state) => state.setChannelPan);
  const setChannelMixerTrack = useProjectStore((state) => state.setChannelMixerTrack);
  const clearChannelSteps = useProjectStore((state) => state.clearChannelSteps);
  const shiftChannelSteps = useProjectStore((state) => state.shiftChannelSteps);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const selectedChannelId = useSessionStore((state) => state.selectedChannelId);
  const selectChannel = useSessionStore((state) => state.selectChannel);
  const focusWindow = useSessionStore((state) => state.focusWindow);
  const selectMixerTrack = useSessionStore((state) => state.selectMixerTrack);
  /** This channel's sound editor is the one open. */
  const editingSound = useSynthEditor((state) => state.channelId === channel.id);

  const [draftName, setDraftName] = useState(channel.name);
  useEffect(() => setDraftName(channel.name), [channel.name]);

  const patternChannel = pattern.channels[channel.id];
  const steps = patternChannel?.steps ?? [];
  const noteCount = patternChannel?.notes.length ?? 0;
  const selected = selectedChannelId === channel.id;

  /** Paint / velocity drag state shared across the row's step buttons. */
  const gesture = useRef<
    | { kind: "paint"; value: StepCell }
    | { kind: "velocity"; index: number; startY: number; startValue: number }
    | null
  >(null);

  const endGesture = useCallback(() => {
    if (!gesture.current) return;
    gesture.current = null;
    endEdit();
  }, [endEdit]);

  // Close an interrupted gesture on unmount only. An inline effect cleanup
  // also fires on every dependency change, which would abort the drag the
  // moment it edited the data its own effect depends on.
  useUnmount(endGesture);

  useEffect(() => {
    window.addEventListener("pointerup", endGesture);
    window.addEventListener("pointercancel", endGesture);
    return () => {
      window.removeEventListener("pointerup", endGesture);
      window.removeEventListener("pointercancel", endGesture);
    };
  }, [endGesture]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const active = gesture.current;
      if (active?.kind !== "velocity") return;

      // The pointer was released outside the window, so no pointerup ever
      // reached us. Finish here instead of following a button that is up.
      if (event.buttons === 0) {
        endGesture();
        return;
      }


      const delta = (active.startY - event.clientY) / 120;
      const next = clamp(active.startValue + delta, 0.05, 1);
      setStep(patternId, channel.id, active.index, Number(next.toFixed(3)));
    };

    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [channel.id, patternId, setStep]);

  const handleStepDown = (index: number, event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    selectChannel(channel.id);

    const current = steps[index];

    if (event.button === 2) {
      // Right-drag adjusts velocity without toggling the step.
      if (!isStepActive(current)) return;
      beginEdit("Step velocity");
      gesture.current = {
        kind: "velocity",
        index,
        startY: event.clientY,
        startValue: current as number
      };
      return;
    }

    if (event.button !== 0) return;

    const nextValue: StepCell = isStepActive(current) ? null : DEFAULT_STEP_VELOCITY;

    beginEdit("Paint steps");
    gesture.current = { kind: "paint", value: nextValue };
    setStep(patternId, channel.id, index, nextValue);

    if (nextValue !== null && !useTransportStore.getState().isPlaying) {
      previewChannel(channel.id, 60, nextValue);
    }
  };

  const handleStepEnter = (index: number) => {
    const active = gesture.current;
    if (active?.kind !== "paint") return;
    setStep(patternId, channel.id, index, active.value);
  };

  // Every channel gets a step grid and a piano roll. Splitting them by type
  // meant a melodic part could never be dotted in on the grid, and a drum could
  // never be placed off it.
  const showSteps = true;

  return (
    <div className={`channel${selected ? " selected" : ""}${channel.mute ? " muted" : ""}`}>
      <div className="channel-main">
      <div
        className="channel-head"
        style={{ width: HEAD_WIDTH, flexBasis: HEAD_WIDTH }}
        onPointerDown={() => selectChannel(channel.id)}
      >
        <button
          className="color-chip"
          style={{ background: channel.color }}
          title="Channel settings"
          onClick={onToggleExpanded}
        />

        <input
          className="channel-name"
          value={draftName}
          aria-label={`${channel.name} name`}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => updateChannelName(channel.id, draftName)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraftName(channel.name);
              event.currentTarget.blur();
            }
          }}
        />

        <div className="channel-controls">
          <button
            className={channel.mute ? "active" : ""}
            aria-pressed={channel.mute}
            onClick={() => toggleChannelMute(channel.id)}
            title="Mute"
          >
            M
          </button>

          <button
            className={channel.solo ? "active" : ""}
            aria-pressed={channel.solo}
            onClick={() => toggleChannelSolo(channel.id)}
            title="Solo"
          >
            S
          </button>

          <Knob
            label="Vol"
            size={24}
            value={channel.volume}
            min={0}
            max={1}
            step={0.01}
            defaultValue={0.85}
            color={channel.color}
            display={`${Math.round(channel.volume * 100)}%`}
            learnId={`channel:${channel.id}:volume`}
            onChange={(value) => setChannelVolume(channel.id, value)}
            onCommitStart={() => beginEdit("Channel volume")}
            onCommitEnd={endEdit}
          />

          <Knob
            label="Pan"
            size={24}
            value={channel.pan}
            min={-1}
            max={1}
            step={0.01}
            defaultValue={0}
            color={channel.color}
            display={panLabel(channel.pan)}
            learnId={`channel:${channel.id}:pan`}
            onChange={(value) => setChannelPan(channel.id, value)}
            onCommitStart={() => beginEdit("Channel pan")}
            onCommitEnd={endEdit}
          />

          <button
            className="insert-button"
            title="Mixer insert — click to open the mixer"
            onClick={() => {
              selectMixerTrack(channel.mixerTrackId);
              focusWindow("mixer");
            }}
          >
            {channel.mixerTrackId}
          </button>

          <button
            className="piano-button"
            onClick={() => {
              selectChannel(channel.id);
              focusWindow("piano");
            }}
            title="Open the piano roll"
          >
            Piano{noteCount > 0 ? ` (${noteCount})` : ""}
          </button>

          {channel.type === "synth" ? (
            <button
              className={`synth-button${editingSound ? " active" : ""}`}
              aria-pressed={editingSound}
              onClick={() => {
                selectChannel(channel.id);
                if (editingSound) useSynthEditor.getState().close();
                else useSynthEditor.getState().open(channel.id);
              }}
              title={`Open ${channel.midiOut ? "the MIDI out settings" : channel.soundfont ? "the instrument picker" : channel.synthPatch?.wt ? "the Wavetable Synth" : "the sound editor"} for this channel (F8)`}
            >
              <IconSynth />
            </button>
          ) : (
            // keeps every row's buttons in the same columns
            <span className="synth-button-slot" aria-hidden="true" />
          )}

        </div>
      </div>

      {showSteps ? (
        <div
          className="steps"
          style={{ gridTemplateColumns: `repeat(${pattern.length}, ${STEP_SIZE}px)`, gap: STEP_GAP }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {steps.map((cell, index) => {
            const active = isStepActive(cell);
            return (
              <button
                key={index}
                className={[
                  "step",
                  active ? "active" : "",
                  index % STEPS_PER_BEAT === 0 ? "beat" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={
                  active
                    ? {
                        background: channel.color,
                        opacity: 0.35 + (cell as number) * 0.65
                      }
                    : undefined
                }
                title={
                  active
                    ? `Step ${index + 1} · velocity ${Math.round((cell as number) * 100)}%`
                    : `Step ${index + 1}`
                }
                aria-pressed={active}
                aria-label={`${channel.name} step ${index + 1}`}
                onPointerDown={(event) => handleStepDown(index, event)}
                onPointerEnter={() => handleStepEnter(index)}
                // Pointer handling is done above; this is the keyboard path, so
                // Enter and Space work on a focused step. Without it the core
                // interaction of the app is mouse-only.
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  toggleStep(patternId, channel.id, index);
                }}
              />
            );
          })}
        </div>
      ) : (
        <div className="piano-hint-row">
          <span className="small-note">
            {noteCount > 0 ? `${noteCount} notes in this pattern` : "No notes yet"} — edit in the
            piano roll
          </span>
        </div>
      )}
      </div>

      {expanded ? (
        <ChannelSettings
          channel={channel}
          patternId={patternId}
          mixerTrackCount={mixerTrackCount}
          onRoute={(trackId) => setChannelMixerTrack(channel.id, trackId)}
          onDuplicate={() => duplicateChannel(channel.id)}
          onClearSteps={() => clearChannelSteps(patternId, channel.id)}
          onShift={(offset) => shiftChannelSteps(patternId, channel.id, offset)}
          onDelete={() =>
            void onConfirmDelete(`Delete "${channel.name}"?`, "Its steps and notes go with it.", {
              confirmLabel: "Delete"
            }).then((confirmed) => {
              if (confirmed) removeChannel(channel.id);
            })
          }
        />
      ) : null}
    </div>
  );
});

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.005) return "C";
  return `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`;
}

interface ChannelSettingsProps {
  channel: Channel;
  patternId: string;
  mixerTrackCount: number;
  onRoute: (trackId: number) => void;
  onDuplicate: () => void;
  onClearSteps: () => void;
  onShift: (offset: number) => void;
  onDelete: () => void;
}

function ChannelSettings({
  channel,
  mixerTrackCount,
  onRoute,
  onDuplicate,
  onClearSteps,
  onShift,
  onDelete
}: ChannelSettingsProps) {
  const updateChannelSample = useProjectStore((state) => state.updateChannelSample);
  const updateChannelSynthPreset = useProjectStore((state) => state.updateChannelSynthPreset);
  const setChannelColor = useProjectStore((state) => state.setChannelColor);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);
  const samples = useSamples();

  return (
    <div className="channel-settings">
      <div className="settings-row">
        <label>
          Insert
          <select
            value={channel.mixerTrackId}
            onChange={(event) => onRoute(Number(event.target.value))}
          >
            {Array.from({ length: mixerTrackCount }, (_, index) => (
              <option key={index + 1} value={index + 1}>
                Insert {index + 1}
              </option>
            ))}
          </select>
        </label>

        <label>
          Colour
          <input
            type="color"
            value={channel.color}
            onChange={(event) => setChannelColor(channel.id, event.target.value)}
          />
        </label>

        <button onClick={onDuplicate}>Duplicate</button>
        <button onClick={() => onShift(-1)} title="Shift steps left">
          ◀ Shift
        </button>
        <button onClick={() => onShift(1)} title="Shift steps right">
          Shift ▶
        </button>
        <button onClick={onClearSteps}>Clear</button>

        <span className="menu-spacer" />
        <button className="danger-text" onClick={onDelete} title="Delete this channel">
          Delete channel
        </button>
      </div>

      {channel.type === "synth" ? (
        <div className="settings-row">
          <label>
            Preset
            <select
              value={channel.synthPatch ? CUSTOM_SOUND : (channel.synthPreset ?? "")}
              onChange={(event) => {
                if (event.target.value !== CUSTOM_SOUND) updateChannelSynthPreset(channel.id, event.target.value);
              }}
            >
              {channel.synthPatch ? <option value={CUSTOM_SOUND}>{channel.synthPatch.name} (yours)</option> : null}
              <option value="">Default</option>
              {synthPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => useSynthEditor.getState().open(channel.id)} title="Design your own sound for this channel">
            Edit sound…
          </button>
        </div>
      ) : null}

      {isSampleChannel(channel.type) ? (
        <div className="settings-row sample-settings">
          <div className="sample-column">
            <label>
              Sample
              <select
                value={channel.sampleId ?? ""}
                onChange={(event) =>
                  updateChannelSample(channel.id, { sampleId: event.target.value })
                }
              >
                <option value="">Choose a sample…</option>
                {samples.map((sample) => (
                  <option key={sample.id} value={sample.id}>
                    {sample.name}
                  </option>
                ))}
              </select>
            </label>

            <Waveform
              sampleId={channel.sampleId ?? ""}
              color={channel.color}
              trimStart={channel.trimStart ?? 0}
              trimEnd={channel.trimEnd ?? 1}
            />
          </div>

          <div className="sample-knobs">
            <Knob
              label="Pitch"
              value={channel.pitchOffset ?? 0}
              min={-24}
              max={24}
              step={1}
              defaultValue={0}
              display={`${(channel.pitchOffset ?? 0) > 0 ? "+" : ""}${channel.pitchOffset ?? 0} st`}
              onChange={(value) => updateChannelSample(channel.id, { pitchOffset: value })}
              onCommitStart={() => beginEdit("Sample pitch")}
              onCommitEnd={endEdit}
            />
            <Knob
              label="Start"
              value={channel.trimStart ?? 0}
              min={0}
              max={0.99}
              step={0.01}
              defaultValue={0}
              display={`${Math.round((channel.trimStart ?? 0) * 100)}%`}
              onChange={(value) => updateChannelSample(channel.id, { trimStart: value })}
              onCommitStart={() => beginEdit("Sample trim")}
              onCommitEnd={endEdit}
            />
            <Knob
              label="End"
              value={channel.trimEnd ?? 1}
              min={0.01}
              max={1}
              step={0.01}
              defaultValue={1}
              display={`${Math.round((channel.trimEnd ?? 1) * 100)}%`}
              onChange={(value) => updateChannelSample(channel.id, { trimEnd: value })}
              onCommitStart={() => beginEdit("Sample trim")}
              onCommitEnd={endEdit}
            />

            <div className="sample-toggles">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(channel.reverse)}
                  onChange={(event) =>
                    updateChannelSample(channel.id, { reverse: event.target.checked })
                  }
                />
                Reverse
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(channel.loop)}
                  onChange={(event) =>
                    updateChannelSample(channel.id, { loop: event.target.checked })
                  }
                />
                Loop
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
