import { platformText } from "../lib/hotkeys";
import { memo, useEffect, useState, type ReactNode } from "react";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore, type WindowId } from "../state/sessionStore";
import { useTransportStore } from "../state/transportStore";
import { seekTo, startTransport, stopTransport, toggleTransport } from "../audio/engine";
import { saveProject } from "../files/actions";
import { useMidiStore } from "../audio/midiMap";
import { isDesktop, useFileStore } from "../files/desktop";
import { installUpdateNow, useUpdateStore } from "../files/updates";
import { shortcutLabel } from "../lib/hotkeys";
import { useAuthStore } from "../sync/auth";
import { loadNewer } from "../sync/manager";
import { useCloudStore } from "../sync/store";
import {
  useHistoryStatus,
  useSamples,
  useSelectedChannel,
  useSelectedPattern
} from "../hooks/useStudio";
import { Knob } from "./controls";
import { IconBrowser, IconMixer, IconPiano, IconPlaylist, IconRack } from "./icons";
import { useConfirm } from "./ConfirmDialog";

import { MAX_BPM, MIN_BPM, STEPS_PER_BAR, STEPS_PER_BEAT, clamp } from "../lib/utils";

/** The transport clock reads BAR:STEP:TICK, zero-padded, the way FL shows it. */
function formatClock(step: number): string {
  if (step < 0) return "1:01:00";

  const bar = Math.floor(step / STEPS_PER_BAR) + 1;
  const beat = Math.floor((step % STEPS_PER_BAR) / STEPS_PER_BEAT) + 1;
  const tick = (step % STEPS_PER_BEAT) * 24;

  return `${bar}:${String(beat).padStart(2, "0")}:${String(tick).padStart(2, "0")}`;
}

const WINDOW_BUTTONS: Array<{
  id: WindowId;
  label: string;
  /** The short name shown beside the icon on wide screens. */
  short: string;
  shortcut: string;
  icon: ReactNode;
}> = [
  { id: "playlist", label: "Playlist", short: "Playlist", shortcut: "F5", icon: <IconPlaylist /> },
  { id: "rack", label: "Channel rack", short: "Rack", shortcut: "F6", icon: <IconRack /> },
  { id: "piano", label: "Piano roll", short: "Piano", shortcut: "F7", icon: <IconPiano /> },
  { id: "mixer", label: "Mixer", short: "Mixer", shortcut: "F9", icon: <IconMixer /> }
];

interface TopBarProps {
  showBrowser: boolean;
  onToggleBrowser: () => void;
}

/**
 * The transport row, grouped left to right by what a producer reaches for:
 * play controls and time, then the pattern being edited, then the master
 * section and the windows.
 */
export function TopBar({ showBrowser, onToggleBrowser }: TopBarProps) {
  const bpm = useProjectStore((state) => state.bpm);
  const swing = useProjectStore((state) => state.swing);
  const masterVolume = useProjectStore((state) => state.masterVolume);
  const patterns = useProjectStore((state) => state.patterns);
  const patternOrder = useProjectStore((state) => state.patternOrder);

  const setBpm = useProjectStore((state) => state.setBpm);
  const setSwing = useProjectStore((state) => state.setSwing);
  const setMasterVolume = useProjectStore((state) => state.setMasterVolume);
  const setPatternLength = useProjectStore((state) => state.setPatternLength);
  const renamePattern = useProjectStore((state) => state.renamePattern);
  const addPattern = useProjectStore((state) => state.addPattern);
  const duplicatePattern = useProjectStore((state) => state.duplicatePattern);
  const removePattern = useProjectStore((state) => state.removePattern);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const mode = useSessionStore((state) => state.mode);
  const setMode = useSessionStore((state) => state.setMode);
  const selectPattern = useSessionStore((state) => state.selectPattern);
  const metronome = useSessionStore((state) => state.metronome);
  const countIn = useSessionStore((state) => state.countIn);
  const loopPlayback = useSessionStore((state) => state.loopPlayback);
  const toggleMetronome = useSessionStore((state) => state.toggleMetronome);
  const toggleCountIn = useSessionStore((state) => state.toggleCountIn);
  const toggleLoopPlayback = useSessionStore((state) => state.toggleLoopPlayback);
  const windows = useSessionStore((state) => state.windows);
  const view = useSessionStore((state) => state.view);
  const toggleWindow = useSessionStore((state) => state.toggleWindow);

  const confirm = useConfirm();
  const { pattern, patternId } = useSelectedPattern();

  // Renaming swaps the pattern picker for a text field in the same spot, so
  // the bar never shows the same name twice.
  const [renaming, setRenaming] = useState(false);
  const [patternDraft, setPatternDraft] = useState(pattern?.name ?? "");

  // Both numeric fields are edited as drafts and only committed on blur or
  // Enter. Committing per keystroke is destructive here: typing "150" over 140
  // would clamp the intermediate "1" up to MIN_BPM, and typing "32" into Steps
  // would first resize the pattern to 3 and delete every note past step 3.
  const [bpmDraft, setBpmDraft] = useState(String(Math.round(bpm)));
  const [lengthDraft, setLengthDraft] = useState(String(pattern?.length ?? 16));

  useEffect(() => setPatternDraft(pattern?.name ?? ""), [pattern?.name, patternId]);
  useEffect(() => setBpmDraft(String(Math.round(bpm))), [bpm]);
  useEffect(() => setLengthDraft(String(pattern?.length ?? 16)), [pattern?.length, patternId]);
  useEffect(() => setRenaming(false), [patternId]);

  const commitBpm = () => {
    const value = Number(bpmDraft);
    const next =
      bpmDraft.trim() !== "" && Number.isFinite(value) ? clamp(value, MIN_BPM, MAX_BPM) : bpm;

    setBpm(next);
    setBpmDraft(String(Math.round(next)));
  };

  const commitPatternLength = () => {
    const current = pattern?.length ?? 16;
    const value = Number(lengthDraft);
    const next =
      lengthDraft.trim() !== "" && Number.isFinite(value)
        ? clamp(Math.round(value), 1, 512)
        : current;

    if (next !== current) setPatternLength(patternId, next);
    setLengthDraft(String(next));
  };

  const commitRename = () => {
    const name = patternDraft.trim();
    if (name && name !== pattern?.name) renamePattern(patternId, name);
    else setPatternDraft(pattern?.name ?? "");
    setRenaming(false);
  };

  return (
    <div className="fl-toolbar-row">
      {/* ── play ── */}
      <div className="fl-panel fl-panel-mode" role="group" aria-label="Playback mode">
        <button
          className={`fl-mode-half${mode === "pattern" ? " active" : ""}`}
          aria-pressed={mode === "pattern"}
          onClick={() => setMode("pattern")}
          title="Pattern mode: loop the selected pattern"
        >
          PAT
        </button>
        <button
          className={`fl-mode-half${mode === "song" ? " active" : ""}`}
          aria-pressed={mode === "song"}
          onClick={() => setMode("song")}
          title="Song mode: play the arrangement"
        >
          SONG
        </button>
      </div>

      <TransportControls />

      <div className="fl-panel fl-panel-tempo" title="Tempo in beats per minute">
        <input
          className="fl-tempo-input"
          type="number"
          min={MIN_BPM}
          max={MAX_BPM}
          value={bpmDraft}
          aria-label="Tempo in BPM"
          onChange={(event) => setBpmDraft(event.target.value)}
          onBlur={commitBpm}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span className="fl-tempo-unit">BPM</span>
      </div>

      <div className="fl-panel fl-panel-toggles">
        <button
          className={`fl-icon-button${metronome ? " on" : ""}`}
          aria-pressed={metronome}
          onClick={toggleMetronome}
          title="Metronome: click on every beat"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M6.1 1.9h3.8l2.6 12.2H3.5z"
              fill="none"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path d="M4.3 10.4h7.4" fill="none" strokeWidth="1.3" />
            <path d="M10.6 3.4 5.6 11.6" fill="none" strokeWidth="1.4" />
          </svg>
        </button>

        <button
          className={`fl-icon-button${countIn ? " on" : ""}`}
          aria-pressed={countIn}
          onClick={toggleCountIn}
          title="Count-in: one bar of clicks before playback"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.4" />
            <path d="M8 4.4V8l2.5 1.7" fill="none" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        <button
          className={`fl-icon-button${loopPlayback ? " on" : ""}`}
          aria-pressed={loopPlayback}
          onClick={toggleLoopPlayback}
          title={loopPlayback ? "Looping: click to play once" : "Play once: click to loop"}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4.2 5.2h6a2.8 2.8 0 0 1 0 5.6H5.8"
              fill="none"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path d="M6.4 3 4.2 5.2 6.4 7.4" fill="none" strokeWidth="1.5" strokeLinecap="round" />
            <path
              d="M9.6 13 11.8 10.8 9.6 8.6"
              fill="none"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <PositionClock />

      <span className="fl-group-gap" />

      {/* ── the pattern being edited ── */}
      <div className="fl-panel fl-panel-pattern">
        <span className="fl-caption">Pattern</span>

        {renaming ? (
          <input
            className="fl-pattern-field"
            value={patternDraft}
            aria-label="Pattern name"
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setPatternDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setPatternDraft(pattern?.name ?? "");
                setRenaming(false);
              }
            }}
          />
        ) : (
          <select
            className="fl-pattern-field fl-pattern-select"
            value={patternId}
            aria-label="Selected pattern"
            title="Pattern shown in the channel rack and piano roll"
            onChange={(event) => selectPattern(event.target.value)}
          >
            {patternOrder.map((id) => (
              <option key={id} value={id}>
                {patterns[id]?.name ?? id}
              </option>
            ))}
          </select>
        )}

        <button
          className="fl-icon-button"
          onClick={() => setRenaming(true)}
          title="Rename pattern"
          aria-label="Rename pattern"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M10.6 2.6 13.4 5.4 5.6 13.2H2.8v-2.8z"
              fill="none"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <label className="fl-steps-field" title="Length of the pattern in steps">
          <input
            className="fl-steps-input"
            type="number"
            min={1}
            max={512}
            value={lengthDraft}
            aria-label="Steps in the selected pattern"
            onChange={(event) => setLengthDraft(event.target.value)}
            onBlur={commitPatternLength}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span>steps</span>
        </label>

        <span className="fl-divider" />

        <button
          className="fl-icon-button"
          onClick={() => selectPattern(addPattern())}
          title="New pattern"
          aria-label="New pattern"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>

        <button
          className="fl-icon-button fl-pattern-extra"
          onClick={() => {
            const id = duplicatePattern(patternId);
            if (id) selectPattern(id);
          }}
          title="Duplicate pattern"
          aria-label="Duplicate pattern"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2.2" y="2.2" width="8" height="8" rx="1" fill="none" strokeWidth="1.4" />
            <rect x="5.8" y="5.8" width="8" height="8" rx="1" fill="none" strokeWidth="1.4" />
          </svg>
        </button>

        <button
          className="fl-icon-button fl-pattern-extra"
          disabled={patternOrder.length <= 1}
          aria-label="Delete pattern"
          onClick={() => {
            void confirm("Delete this pattern?", "Clips using it are removed too.", {
              confirmLabel: "Delete"
            }).then((ok) => {
              if (ok) removePattern(patternId);
            });
          }}
          title={patternOrder.length <= 1 ? "The last pattern can't be deleted" : "Delete pattern"}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.4 4.6h9.2M6.4 4.6V3h3.2v1.6" fill="none" strokeWidth="1.4" />
            <path
              d="M4.6 4.6 5.3 13.4h5.4l0.7-8.8"
              fill="none"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <span className="fl-flex" />

      {/* ── master section and windows ── */}
      <div className="fl-panel fl-panel-knobs">
        <Knob
          label="Master"
          size={26}
          value={masterVolume}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.9}
          display={`${Math.round(masterVolume * 100)}%`}
          learnId="master:volume"
          onChange={setMasterVolume}
          onCommitStart={() => beginEdit("Master volume")}
          onCommitEnd={endEdit}
        />
        <Knob
          label="Swing"
          size={26}
          value={swing}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0}
          display={`${Math.round(swing * 100)}%`}
          learnId="swing"
          onChange={setSwing}
          onCommitStart={() => beginEdit("Swing")}
          onCommitEnd={endEdit}
        />
      </div>

      <div className="fl-panel fl-panel-windows" role="group" aria-label="Windows">
        <button
          className={`fl-window-button${showBrowser ? " on" : ""}`}
          aria-pressed={showBrowser}
          title={`Browser: projects, cloud, samples and MIDI (${shortcutLabel("toggleBrowser")})`}
          onClick={onToggleBrowser}
        >
          <IconBrowser />
        </button>

        <span className="fl-divider" />

        {WINDOW_BUTTONS.map((entry) => {
          const open = windows[entry.id].open;
          return (
            <button
              key={entry.id}
              className={`fl-window-button${open ? " on" : ""}${open && view === entry.id ? " front" : ""}`}
              aria-pressed={open}
              title={`${entry.label} (${entry.shortcut})`}
              onClick={() => toggleWindow(entry.id)}
            >
              {entry.icon}
              <span className="fl-window-label">{entry.short}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The project's name, centered in the menu bar, with its save state beside it. */
export function ProjectTitle({ onStatus }: { onStatus: (message: string) => void }) {
  const projectName = useProjectStore((state) => state.projectName);
  const setProjectName = useProjectStore((state) => state.setProjectName);
  const [nameDraft, setNameDraft] = useState(projectName);

  useEffect(() => setNameDraft(projectName), [projectName]);

  return (
    <div className="fl-project-title">
      <input
        className="fl-project-name"
        aria-label="Project name"
        title="Project name: click to rename"
        value={nameDraft}
        size={Math.max(8, Math.min(40, nameDraft.length + 1))}
        onChange={(event) => setNameDraft(event.target.value)}
        onBlur={() => setProjectName(nameDraft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setNameDraft(projectName);
            event.currentTarget.blur();
          }
        }}
      />
      <SaveBadge />
      <CloudBadge onStatus={onStatus} />
    </div>
  );
}

/** Signed in only: whether the open project is in step with the cloud. */
function CloudBadge({ onStatus }: { onStatus: (message: string) => void }) {
  const signedIn = useAuthStore((state) => state.status === "signedIn");
  const phase = useCloudStore((state) => state.phase);
  const message = useCloudStore((state) => state.message);
  const lastSyncedAt = useCloudStore((state) => state.lastSyncedAt);

  if (!signedIn) return null;

  const icon = (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.6 12.4h6.1a2.8 2.8 0 0 0 .5-5.55A3.7 3.7 0 0 0 4.2 6.2a3.1 3.1 0 0 0 .4 6.2z"
        fill="none"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );

  if (phase === "behind") {
    return (
      <button
        className="fl-cloud-button"
        title="This project was changed on another PC. Click to load that version."
        onClick={() => {
          void loadNewer()
            .then(onStatus)
            .catch((error: unknown) => onStatus(error instanceof Error ? error.message : "That didn't work."));
        }}
      >
        {icon}
        Load newer version
      </button>
    );
  }

  const label =
    phase === "syncing"
      ? "Syncing"
      : phase === "synced"
        ? "In cloud"
        : phase === "offline"
          ? "Offline"
          : phase === "error"
            ? "Sync problem"
            : phase === "excluded"
              ? "Not synced"
              : null;
  if (!label) return null;

  const title =
    phase === "synced" && lastSyncedAt
      ? `In sync with your cloud since ${new Date(lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : message || label;

  return (
    <span className={`fl-cloud-badge cloud-${phase}`} title={title}>
      {icon}
      {label}
    </span>
  );
}

interface HeaderActionsProps {
  onStatus: (message: string) => void;
  onExport: () => void;
}

/** Undo, redo, save and export, at the right-hand end of the menu bar. */
export function HeaderActions({ onStatus, onExport }: HeaderActionsProps) {
  const undo = useProjectStore((state) => state.undo);
  const redo = useProjectStore((state) => state.redo);
  const { canUndo, canRedo, undoLabel, redoLabel } = useHistoryStatus();

  return (
    <div className="fl-header-actions">
      <UpdateBadge onStatus={onStatus} />

      <button
        className="fl-icon-button"
        disabled={!canUndo}
        onClick={undo}
        aria-label="Undo"
        title={canUndo ? platformText(`Undo ${undoLabel ?? ""} (Ctrl+Z)`) : "Nothing to undo"}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3.4 7.6h6.2a3.4 3.4 0 0 1 0 6.8H6.2"
            fill="none"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path d="M6 4.2 2.8 7.6 6 11" fill="none" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>

      <button
        className="fl-icon-button"
        disabled={!canRedo}
        onClick={redo}
        aria-label="Redo"
        title={canRedo ? platformText(`Redo ${redoLabel ?? ""} (Ctrl+Y)`) : "Nothing to redo"}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M12.6 7.6H6.4a3.4 3.4 0 0 0 0 6.8h3.4"
            fill="none"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path d="M10 4.2 13.2 7.6 10 11" fill="none" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </button>

      <span className="fl-divider" />

      <button
        className="fl-icon-button"
        aria-label="Save"
        onClick={() => {
          void saveProject()
            .then(onStatus)
            .catch((error: unknown) =>
              onStatus(error instanceof Error ? error.message : "The project could not be saved.")
            );
        }}
        title={isDesktop() ? "Save (Ctrl+S)" : "Save to browser (Ctrl+S)"}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2.4 2.4h8.4l2.8 2.8v8.4H2.4z"
            fill="none"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M5 2.4v4h5v-4M4.6 13.6V9.4h6.8v4.2" fill="none" strokeWidth="1.4" />
        </svg>
      </button>

      <button className="fl-export-button" onClick={onExport} title="Export to WAV or MP3">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.8v8" fill="none" strokeWidth="1.6" />
          <path d="M4.8 6.6 8 9.8l3.2-3.2" fill="none" strokeWidth="1.6" />
          <path d="M2.6 11.4v2.4h10.8v-2.4" fill="none" strokeWidth="1.6" />
        </svg>
        Export
      </button>
    </div>
  );
}

/**
 * Desktop only: a quiet note while an update downloads, then a button to
 * restart into it. Nothing shows while the app is up to date.
 */
function UpdateBadge({ onStatus }: { onStatus: (message: string) => void }) {
  const status = useUpdateStore((state) => state.status);

  if (status.state === "downloading") {
    return (
      <span className="fl-update-note" title="A new version is downloading in the background">
        Downloading update {status.percent > 0 ? `${status.percent}%` : "…"}
      </span>
    );
  }

  if (status.state === "available") {
    return (
      <button
        className="fl-update-button"
        title={`PulseGrid Studio ${status.version ?? ""} is available. This opens the download page.`}
        onClick={() => {
          void installUpdateNow()
            .then(onStatus)
            .catch(() => onStatus("The download page couldn't be opened."));
        }}
      >
        <span className="fl-update-dot" aria-hidden="true" />
        Version {status.version} is available · Download
      </button>
    );
  }

  if (status.state !== "ready") return null;

  return (
    <button
      className="fl-update-button"
      title={`PulseGrid Studio ${status.version ?? ""} is downloaded. Your project is saved first, then the studio restarts. If you'd rather wait, it installs the next time you close the app.`}
      onClick={() => {
        void installUpdateNow()
          .then(onStatus)
          .catch((error: unknown) =>
            onStatus(error instanceof Error ? error.message : "The update couldn't be installed.")
          );
      }}
    >
      <span className="fl-update-dot" aria-hidden="true" />
      Restart to update to {status.version}
    </button>
  );
}

/** Right-hand side of the status bar: what the keys play, and what's loaded. */
export function StatusInfo() {
  const channel = useSelectedChannel();
  const samples = useSamples();

  return (
    <div className="status-info">
      <span title="The computer keyboard, MIDI keys and piano roll play this channel">
        <span className="status-caption">Keys</span> {channel?.name ?? "none"}
      </span>
      <span title="Samples loaded in the browser">
        {samples.length} {samples.length === 1 ? "sample" : "samples"}
      </span>
      <span className="status-version">PulseGrid Studio {__APP_VERSION__}</span>
    </div>
  );
}

/** Desktop only: a one-word save state beside the project name. */
function SaveBadge() {
  const saveState = useFileStore((state) => state.saveState);
  const hasFile = useFileStore((state) => state.path !== null);
  const autosave = useFileStore((state) => state.settings?.autosave !== false);

  if (!isDesktop()) return null;

  const label =
    saveState === "saving"
      ? "saving…"
      : saveState === "error"
        ? "save failed"
        : saveState === "unsaved"
          ? autosave
            ? "auto-saving…"
            : "unsaved"
          : hasFile
            ? "saved"
            : "new";

  return <span className={`fl-save-badge save-${saveState}`}>{label}</span>;
}

/** Isolated so the ticking clock doesn't re-render the whole bar. */
const PositionClock = memo(function PositionClock() {
  const isPlaying = useTransportStore((state) => state.isPlaying);
  const playheadStep = useTransportStore((state) => state.playheadStep);
  const startStep = useTransportStore((state) => state.startStep);

  const position = isPlaying && playheadStep >= 0 ? playheadStep : startStep;

  return (
    <div className="fl-panel fl-panel-clock" title="Playback position — bar : step : tick">
      <span className="fl-clock-caption">BAR:STEP:TICK</span>
      <span className="fl-clock-value">{formatClock(position)}</span>
    </div>
  );
});

/** Isolated for the same reason — play state flips on every transport hit. */
const TransportControls = memo(function TransportControls() {
  const isPlaying = useTransportStore((state) => state.isPlaying);
  const recordArmed = useMidiStore((state) => state.recordArmed);
  const setRecordArmed = useMidiStore((state) => state.setRecordArmed);

  return (
    <div className="fl-panel fl-panel-transport">
      <button
        className={`fl-transport-button record${recordArmed ? " armed" : ""}`}
        aria-pressed={recordArmed}
        onClick={() => setRecordArmed(!recordArmed)}
        title={
          recordArmed
            ? "Recording armed: play MIDI keys to record"
            : "Arm recording from your MIDI keyboard"
        }
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="4.6" />
        </svg>
      </button>

      <button
        className={`fl-transport-button play${isPlaying ? " playing" : ""}`}
        onClick={() => void toggleTransport()}
        title="Play / pause (Space)"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 2.5 13 8l-9 5.5z" />
        </svg>
      </button>

      <button
        className="fl-transport-button"
        onClick={() => {
          stopTransport();
          seekTo(0);
        }}
        title="Stop and return to the start"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" rx="0.8" />
        </svg>
      </button>

      <button
        className="fl-transport-button"
        onClick={() => void startTransport(0)}
        title="Play from the beginning"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 2.5 10 8l-7 5.5z" />
          <rect x="11" y="2.5" width="2.2" height="11" rx="0.6" />
        </svg>
      </button>
    </div>
  );
});
