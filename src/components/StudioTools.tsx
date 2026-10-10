import { useCallback, useEffect, useRef, useState } from "react";

import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { useTransportStore } from "../state/transportStore";
import { ensureAudio, previewChannel } from "../audio/engine";
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
import { ToolSection } from "./ToolSection";

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
  const addChannel = useProjectStore((state) => state.addChannel);
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

      let imported = 0;
      let lastId: string | null = null;

      for (const file of files) {
        try {
          const sample = await loadSampleFromFile(file, file.name.replace(/\.[^.]+$/, ""), context);
          lastId = addChannel("sample", sample.name, sample.id);
          imported += 1;
        } catch (error) {
          console.error(error);
        }
      }

      if (lastId) selectChannel(lastId);

      onStatus(
        imported === files.length
          ? `Imported ${imported} sample${imported === 1 ? "" : "s"}.`
          : `Imported ${imported} of ${files.length} — the rest couldn't be decoded.`
      );
    },
    [addChannel, onStatus, selectChannel]
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

        const channelId = addChannel("sample", sample.name, sample.id);
        selectChannel(channelId);
        onStatus(`Added "${sample.name}" as a sample channel.`);
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
  }, [addChannel, isRecording, onStatus, selectChannel, setIsRecording]);

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

  return (
    <aside className="studio-tools" style={{ width, flexBasis: width }} aria-label="Browser">
      <div className="tools-scroll">
        {isDesktop() ? <ProjectsPanel onStatus={onStatus} /> : null}

        <ToolSection
          id="samples"
          title="Samples"
          summary={`${samples.length}`}
          actions={
            <>
              <button type="button" className="mini-button" onClick={() => fileInput.current?.click()} title="Import audio files as sample channels">
                Import
              </button>
              <button
                type="button"
                className={`mini-button${isRecording ? " active" : ""}`}
                onClick={() => void handleRecord()}
                title={isRecording ? "Stop recording" : "Record from the microphone"}
              >
                {isRecording ? "Stop" : "Record"}
              </button>
            </>
          }
        >
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            multiple
            className="hidden-file-input"
            onChange={(event) => void handleImport(event)}
          />

          {isRecording ? (
            <div className="record-meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, recordLevel * 100)}%` }} />
            </div>
          ) : null}

          <div className="sample-list">
            {samples.map((sample) => (
              <div className="sample-item" key={sample.id}>
                <button
                  className="sample-name"
                  title="Add as a new sample channel"
                  onClick={() => {
                    const id = addChannel("sample", sample.name, sample.id);
                    selectChannel(id);
                    previewChannel(id);
                    onStatus(`Added "${sample.name}".`);
                  }}
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
        </ToolSection>

        <ToolSection
          id="midi"
          title="Keyboard & MIDI"
          defaultOpen={false}
          summary={target ? `Plays ${target.name}` : "Keys play nothing yet"}
          actions={midiReady ? <MidiActivity /> : undefined}
        >
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

              <details className="tool-details">
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
        </ToolSection>

        <CloudPanel onStatus={onStatus} />

        <ToolSection id="demos" title="Demo projects" defaultOpen={false} summary={`${presetProjects.length} to try`}>
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
        </ToolSection>
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
