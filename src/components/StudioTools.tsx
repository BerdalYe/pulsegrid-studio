import { useCallback, useEffect, useRef, useState } from "react";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { useTransportStore } from "../state/transportStore";
import { ensureAudio } from "../audio/engine";
import { previewSample } from "../audio/preview";
import { DRAG_TYPE, encodeDragItem } from "../lib/dragData";
import { audioRecorder } from "../audio/recorder";
import { loadSampleFromFile, removeSample } from "../audio/sampleRegistry";
import { midiManager, type MidiDevice } from "../audio/midi";
import { useMidiStore } from "../audio/midiMap";
import { MidiActivity } from "./MidiActivity";
import { presetProjects } from "../presets/presets";
import { useSamples } from "../hooks/useStudio";
import { Waveform } from "./Waveform";
import { loadPreset, settleCurrentProject } from "../files/actions";
import { isDesktop } from "../files/desktop";
import { ProjectsPanel } from "./ProjectsPanel";
import { CloudPanel } from "./CloudPanel";
import { useConfirm } from "./ConfirmDialog";
import { InstrumentTree } from "./InstrumentTree";
import { IconCloud, IconFolder, IconKeys, IconMidi, IconStar, IconWave } from "./icons";
import { syncConfigured } from "../sync/config";
import type { ReactNode } from "react";

type TabId = "projects" | "samples" | "instruments" | "midi" | "cloud" | "demos";

const TAB_KEY = "pulsegrid:browser-tab";

function readTab(): TabId {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved === "projects" || saved === "samples" || saved === "instruments" || saved === "midi" || saved === "cloud" || saved === "demos") {
      return saved;
    }
  } catch {
    /* the first tab is fine */
  }
  return "instruments";
}

const WIDTH_KEY = "pulsegrid:browser-width";
const MIN_WIDTH = 220;
const MAX_WIDTH = 440;
const DEFAULT_WIDTH = 270;

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, saved)) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

interface StudioToolsProps {
  onStatus: (message: string) => void;
}

export function StudioTools({ onStatus }: StudioToolsProps) {
  const confirm = useConfirm();

  const selectedChannelId = useSessionStore((state) => state.selectedChannelId);
  const selectChannel = useSessionStore((state) => state.selectChannel);

  const channels = useProjectStore((state) => state.channels);
  const updateChannelSample = useProjectStore((state) => state.updateChannelSample);

  const isRecording = useTransportStore((state) => state.isRecording);
  const setIsRecording = useTransportStore((state) => state.setIsRecording);
  const recordLevel = useTransportStore((state) => state.recordLevel);
  const setRecordLevel = useTransportStore((state) => state.setRecordLevel);

  const samples = useSamples();

  const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([]);
  const [selectedMidi, setSelectedMidi] = useState<string>(() => midiManager.getInputChoice());
  const [midiReady, setMidiReady] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // The browser's sections, as a row of icons across the top: the saved projects (desktop), the samples, the
  // instrument library, MIDI, the account (when sync is set up) and the demo projects.
  const desktop = isDesktop();
  const tabs: Array<{ id: TabId; label: string; icon: ReactNode }> = [
    ...(desktop ? [{ id: "projects" as const, label: "Projects", icon: <IconFolder /> }] : []),
    { id: "instruments", label: "Instruments", icon: <IconKeys /> },
    { id: "samples", label: "Samples", icon: <IconWave /> },
    { id: "midi", label: "Keyboard & MIDI", icon: <IconMidi /> },
    ...(syncConfigured ? [{ id: "cloud" as const, label: "Cloud sync", icon: <IconCloud /> }] : []),
    { id: "demos", label: "Demo projects", icon: <IconStar /> }
  ];
  const [tab, setTab] = useState<TabId>(readTab);
  const chooseTab = (next: TabId) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* the tab holds until the app closes */
    }
  };

  // The panel's width is yours to set: drag its right edge.
  const [width, setWidth] = useState(readWidth);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = { pointerX: event.clientX, width };
    let latest = width;

    const move = (pointer: PointerEvent) => {
      latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, start.width + pointer.clientX - start.pointerX));
      setWidth(latest);
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      document.body.style.cursor = "";
      try {
        localStorage.setItem(WIDTH_KEY, String(latest));
      } catch {
        /* the width holds until the app closes */
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
    document.body.style.cursor = "ew-resize";
  };

  // Playing is handled app-wide by the MIDI controller (see App); this panel
  // only shows and chooses devices.
  useEffect(
    () =>
      midiManager.onDevices((devices) => {
        setMidiDevices(devices);
        if (midiManager.isConnected) setMidiReady(true);
      }),
    []
  );

  const resetMappings = useMidiStore((state) => state.resetMappings);
  const padChannel = useMidiStore((state) => state.padChannel);
  const setPadChannel = useMidiStore((state) => state.setPadChannel);
  const monitor = useMidiStore((state) => state.recent);
  const clearMonitor = useMidiStore((state) => state.clearMonitor);

  useEffect(() => audioRecorder.onLevel(setRecordLevel), [setRecordLevel]);

  const handleImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) return;

      const context = ensureAudio();
      if (!context) {
        onStatus("Audio isn't available in this browser.");
        return;
      }

      // Imported sounds go into the browser; dragging one onto the channel rack puts it to use.
      let imported = 0;

      for (const file of files) {
        try {
          await loadSampleFromFile(file, file.name.replace(/\.[^.]+$/, ""), context);
          imported += 1;
        } catch (error) {
          console.error(error);
        }
      }

      onStatus(
        imported === files.length
          ? `Imported ${imported} sample${imported === 1 ? "" : "s"}. Drag one onto the channel rack to use it.`
          : `Imported ${imported} of ${files.length} — the rest couldn't be decoded.`
      );
    },
    [onStatus]
  );

  const handleRecord = useCallback(async () => {
    const context = ensureAudio();
    if (!context) {
      onStatus("Audio isn't available in this browser.");
      return;
    }

    try {
      if (isRecording) {
        const sample = await audioRecorder.stop(context);
        setIsRecording(false);

        if (!sample) {
          onStatus("Nothing was recorded.");
          return;
        }

        onStatus(`Recorded "${sample.name}". It is in the sample list: drag it onto the channel rack to use it.`);
      } else {
        await audioRecorder.start(context);
        setIsRecording(true);
        onStatus("Recording — press again to stop.");
      }
    } catch (error) {
      console.error(error);
      setIsRecording(false);
      onStatus(
        error instanceof Error ? error.message : "The microphone couldn't be started."
      );
    }
  }, [isRecording, onStatus, setIsRecording]);

  const enableMidi = useCallback(async () => {
    const ready = await midiManager.init();
    setMidiReady(ready);
    setMidiDevices(midiManager.getDevices());
    onStatus(
      ready
        ? `MIDI ready — ${midiManager.getDevices().length} input(s).`
        : "MIDI is unavailable or permission was declined."
    );
  }, [onStatus]);

  const target = channels.find((channel) => channel.id === selectedChannelId);
  const current = tabs.find((entry) => entry.id === tab) ?? tabs[0];

  return (
    <aside className="studio-tools" style={{ width, flexBasis: width }} aria-label="Browser">
      <header className="tools-head">
        <strong>Browser</strong>
        <span className="tools-crumb">{current.label}</span>
        {midiReady ? <MidiActivity /> : null}
      </header>

      <nav className="tools-tabs" role="tablist" aria-label="Browser sections">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === current.id}
            className={`tools-tab${entry.id === current.id ? " active" : ""}`}
            title={entry.label}
            aria-label={entry.label}
            onClick={() => chooseTab(entry.id)}
          >
            {entry.icon}
          </button>
        ))}
      </nav>

      <div className="tools-scroll" role="tabpanel">
        {current.id === "projects" ? <ProjectsPanel onStatus={onStatus} /> : null}

        {current.id === "samples" ? (
          <div className="tools-pane">
            <div className="tools-actions">
              <button type="button" onClick={() => fileInput.current?.click()} title="Import audio files as sample channels">
                Import audio…
              </button>
              <button
                type="button"
                className={isRecording ? "active" : ""}
                onClick={() => void handleRecord()}
                title={isRecording ? "Stop recording" : "Record from the microphone"}
              >
                {isRecording ? "Stop recording" : "Record mic"}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="audio/*"
                multiple
                className="hidden-file-input"
                onChange={(event) => void handleImport(event)}
              />
            </div>

            {isRecording ? (
              <div className="record-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, recordLevel * 100)}%` }} />
              </div>
            ) : null}

            <div className="tools-caption">
              {samples.length} sample{samples.length === 1 ? "" : "s"} · click to hear, drag onto the channel rack to add
            </div>

            <div className="sample-list">
              {samples.map((sample) => (
                <div className="sample-item" key={sample.id}>
                  <button
                    className="sample-name"
                    title={`${sample.name}: click to hear it, drag it onto the channel rack to add it`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, encodeDragItem({ kind: "sample", id: sample.id, name: sample.name }));
                      event.dataTransfer.setData("text/plain", sample.name);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => previewSample(sample.id)}
                  >
                    {sample.name}
                    <em>{sample.duration.toFixed(2)}s</em>
                  </button>

                  <Waveform sampleId={sample.id} width={132} height={22} />

                  <span className="sample-buttons">
                    {selectedChannelId ? (
                      <button
                        title="Load into the selected channel"
                        onClick={() => updateChannelSample(selectedChannelId, { sampleId: sample.id })}
                      >
                        ↳
                      </button>
                    ) : null}

                    {!sample.builtIn ? (
                      <button
                        title="Remove from the browser"
                        onClick={() => {
                          removeSample(sample.id);
                          onStatus(`Removed "${sample.name}" from the browser.`);
                        }}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {current.id === "instruments" ? (
          <div className="tools-pane">
            <div className="tools-caption">Click to hear · drag onto the channel rack to add</div>
            <InstrumentTree onStatus={onStatus} />
          </div>
        ) : null}

        {current.id === "midi" ? (
          <div className="tools-pane">
            <label className="tool-field">
              Keys play
              <select
                value={selectedChannelId ?? ""}
                onChange={(event) => selectChannel(event.target.value || null)}
                title="The channel that receives MIDI and computer-keyboard notes. Play with Z–M and Q–U, and [ and ] for the octave."
              >
                <option value="">None</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </label>
            {target ? null : <p className="small-note">Pick a channel, or select one in the rack, and your keys will play it.</p>}

            {midiReady ? (
              <>
                <p className="tool-line" title={midiDevices.map((device) => device.name).join(", ")}>
                  {midiDevices.length === 0 ? "No MIDI device. Plug one in." : midiDevices.map((device) => device.name).join(", ")}
                </p>

                <label className="tool-field">
                  Listen to
                  <select
                    value={selectedMidi}
                    aria-label="MIDI input to listen to"
                    title="Which MIDI port to listen to. Automatic listens to the ports you play on and ignores a keyboard's DAW and control ports."
                    onChange={(event) => {
                      setSelectedMidi(event.target.value);
                      midiManager.setInputChoice(event.target.value);
                    }}
                  >
                    <option value="auto">Automatic</option>
                    <option value="all">Every port</option>
                    {midiDevices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                        {device.control ? " (control port)" : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="tool-field">
                  Drum pads on channel
                  <select
                    value={padChannel}
                    onChange={(event) => setPadChannel(Number(event.target.value))}
                    title="The MIDI channel your drum pads send on (10 on most controllers)"
                  >
                    {Array.from({ length: 16 }, (_, index) => index + 1).map((channel) => (
                      <option key={channel} value={channel}>
                        {channel}
                        {channel === 10 ? " (usual)" : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <details className="tool-details" open>
                  <summary>MIDI monitor</summary>
                  <div className="midi-monitor" aria-label="MIDI monitor">
                    <div className="midi-monitor-head">
                      <span>Last messages</span>
                      <button type="button" className="link-button" onClick={clearMonitor} disabled={monitor.length === 0}>
                        Clear
                      </button>
                    </div>
                    {monitor.length === 0 ? (
                      <span className="small-note">Press a key, pad or knob and what it sends shows up here.</span>
                    ) : (
                      monitor.map((line) => (
                        <div key={line.id} className="midi-monitor-line" title={line.device}>
                          {line.text}
                          {line.hint ? <em>{line.hint}</em> : null}
                        </div>
                      ))
                    )}
                  </div>
                </details>

                <details className="tool-details">
                  <summary>How the controls work</summary>
                  <p className="small-note">
                    Keys play the channel above. Pads (MIDI channel {padChannel}) hit your drum channels. Knobs 1–7 control
                    volume, pan, insert, master, swing and tempo; right-click any knob on screen, then turn one on your
                    controller, to link them. A keyboard with several ports, like the Akai MPK mini IV, is listened to on the
                    port you play on; its DAW, plugin and control ports are ignored.
                  </p>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      resetMappings();
                      onStatus("MIDI knob mappings reset to defaults.");
                    }}
                  >
                    Reset knob mappings
                  </button>
                </details>
              </>
            ) : (
              <button onClick={() => void enableMidi()}>Turn on MIDI</button>
            )}
          </div>
        ) : null}

        {current.id === "cloud" ? <CloudPanel onStatus={onStatus} /> : null}

        {current.id === "demos" ? (
          <div className="tools-pane">
            <div className="tools-caption">Open one to see how a track is put together</div>
            <div className="demo-list">
              {presetProjects.map((preset) => (
                <button
                  key={preset.id}
                  title={preset.description}
                  onClick={() => {
                    // On the desktop the open project is saved (or you are asked)
                    // first, and the demo opens as a new, separate project.
                    if (isDesktop()) {
                      void settleCurrentProject().then((ok) => {
                        if (ok) onStatus(loadPreset(preset.id));
                      });
                      return;
                    }

                    // Loading a demo replaces the project *and* clears the undo
                    // stack, so a mis-click here is unrecoverable. File → New asks
                    // first for a strictly less destructive action.
                    void confirm(`Load "${preset.name}"?`, "This replaces the current project — anything unsaved will be lost.", {
                      confirmLabel: "Load"
                    }).then((ok) => {
                      if (ok) onStatus(loadPreset(preset.id));
                    });
                  }}
                >
                  {preset.name}
                  <em>{preset.description}</em>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div
        className="tools-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the browser"
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          try {
            localStorage.removeItem(WIDTH_KEY);
          } catch {
            /* ignore */
          }
        }}
      />
    </aside>
  );
}
