import { useEffect, useRef, useState, type ReactNode } from "react";

import { getAudioInfo, playTestClick } from "../audio/engine";
import { midiManager, type MidiDevice } from "../audio/midi";
import { useMidiStore } from "../audio/midiMap";
import { chooseSaveFolder, openSaveFolder, toggleAutosave } from "../files/actions";
import { isDesktop, useFileStore } from "../files/desktop";
import { toggleUpdateChecks, useUpdateStore } from "../files/updates";
import { THEMES } from "../lib/themes";
import { SITE_URL } from "../sync/config";
import { UI_SCALE_RANGE, useAppSettings, type LatencyChoice } from "../state/appSettings";
import { useSessionStore } from "../state/sessionStore";
import { useConfirm } from "./ConfirmDialog";
import { REPO_URL } from "../lib/reportProblem";

type PageId = "general" | "interface" | "audio" | "midi" | "files" | "about";

const LATENCY_CHOICES: Array<{ id: LatencyChoice; label: string; note: string }> = [
  { id: "interactive", label: "Lowest delay", note: "Notes sound the moment you play them. Best on a fast computer." },
  { id: "balanced", label: "Balanced", note: "A little more buffering. A good middle." },
  { id: "playback", label: "Safest", note: "The most buffering. Use it if the sound crackles." }
];

/* ───────────────────────────── building blocks ───────────────────────────── */

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <strong>{label}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <label className="settings-switch">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  format,
  label,
  onChange
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="settings-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{format(value)}</output>
    </div>
  );
}

/* ───────────────────────────── the pages ───────────────────────────── */

function GeneralPage({ onStatus }: { onStatus: (message: string) => void }) {
  const settings = useAppSettings();
  const wheelZoom = useSessionStore((state) => state.wheelZoom);
  const toggleWheelZoom = useSessionStore((state) => state.toggleWheelZoom);
  const updatesConfigured = useUpdateStore((state) => state.configured);
  const updateChecksOn = useUpdateStore((state) => state.enabled);

  return (
    <>
      <Row label="Sound when you click in notes" hint="Hear a step or a piano-roll note as you place it.">
        <Switch checked={settings.audition} onChange={(audition) => settings.set({ audition })} label={settings.audition ? "On" : "Off"} />
      </Row>
      <Row label="Scroll wheel" hint="What the wheel does in the piano roll and the playlist.">
        <Switch checked={wheelZoom} onChange={toggleWheelZoom} label={wheelZoom ? "Zooms (Shift scrolls sideways)" : "Scrolls (Ctrl zooms)"} />
      </Row>
      {updatesConfigured ? (
        <Row label="Updates" hint="Look for a new version shortly after the app starts.">
          <Switch
            checked={updateChecksOn}
            onChange={() => void toggleUpdateChecks().then(onStatus)}
            label={updateChecksOn ? "Check automatically" : "Don't check"}
          />
        </Row>
      ) : null}
    </>
  );
}

function InterfacePage() {
  const settings = useAppSettings();
  const theme = useSessionStore((state) => state.theme);
  const setTheme = useSessionStore((state) => state.setTheme);
  const desktop = isDesktop();

  return (
    <>
      <Row label="Theme">
        <select value={theme} onChange={(event) => setTheme(event.target.value)} aria-label="Theme">
          {THEMES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </Row>
      <Row
        label="Interface size"
        hint={desktop ? "Make everything bigger or smaller." : "In the browser, use Ctrl + and Ctrl − to zoom the page."}
      >
        {desktop ? (
          <Slider
            value={settings.uiScale}
            min={UI_SCALE_RANGE.min}
            max={UI_SCALE_RANGE.max}
            step={UI_SCALE_RANGE.step}
            format={(value) => `${Math.round(value * 100)}%`}
            label="Interface size"
            onChange={(uiScale) => settings.set({ uiScale })}
          />
        ) : (
          <span className="settings-note">Not available here</span>
        )}
      </Row>
      <Row label="Hints" hint="Explain whatever the pointer is over, in the bar at the bottom.">
        <Switch checked={settings.showHints} onChange={(showHints) => settings.set({ showHints })} label={settings.showHints ? "Show" : "Hide"} />
      </Row>
    </>
  );
}

interface OutputChoice {
  id: string;
  label: string;
}

function AudioPage() {
  const settings = useAppSettings();
  const [outputs, setOutputs] = useState<OutputChoice[]>([]);
  const [info, setInfo] = useState(getAudioInfo);

  // The speakers and headphones this computer has, kept up to date as they are plugged in.
  useEffect(() => {
    let alive = true;
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;

    const read = () =>
      void media
        .enumerateDevices()
        .then((devices) => {
          if (!alive) return;
          let unnamed = 0;
          setOutputs(
            devices
              .filter((device) => device.kind === "audiooutput")
              .map((device) => ({ id: device.deviceId, label: device.label || (device.deviceId === "default" ? "System default" : `Output ${++unnamed}`) }))
          );
        })
        .catch(() => undefined);

    read();
    media.addEventListener?.("devicechange", read);
    return () => {
      alive = false;
      media.removeEventListener?.("devicechange", read);
    };
  }, []);

  // What the audio is running at, once it has started.
  useEffect(() => {
    const timer = window.setInterval(() => setInfo(getAudioInfo()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const known = settings.outputDeviceId === "" || outputs.some((entry) => entry.id === settings.outputDeviceId);
  const latency = LATENCY_CHOICES.find((entry) => entry.id === settings.latency) ?? LATENCY_CHOICES[0];

  return (
    <>
      <Row
        label="Output"
        hint={info && !info.canChooseOutput ? "This system plays through its default output only." : "Where the sound comes out."}
      >
        <select
          value={settings.outputDeviceId}
          disabled={info !== null && !info.canChooseOutput}
          aria-label="Audio output"
          onChange={(event) => settings.set({ outputDeviceId: event.target.value })}
        >
          <option value="">System default</option>
          {!known ? <option value={settings.outputDeviceId}>Saved device (not connected)</option> : null}
          {outputs
            .filter((entry) => entry.id !== "default")
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
        </select>
        <button type="button" onClick={playTestClick} title="Play two clicks through the chosen output">
          Test
        </button>
      </Row>

      <Row label="Latency" hint={`${latency.note} Takes effect the next time PulseGrid Studio starts.`}>
        <select value={settings.latency} aria-label="Latency" onChange={(event) => settings.set({ latency: event.target.value as LatencyChoice })}>
          {LATENCY_CHOICES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Running at" hint="What the audio is doing right now.">
        <span className="settings-note">
          {info
            ? `${info.sampleRate.toLocaleString()} Hz · about ${Math.max(1, info.baseLatencyMs + info.outputLatencyMs)} ms delay`
            : "Starts with your first sound"}
        </span>
      </Row>

      <Row label="Metronome volume">
        <Slider
          value={settings.metronomeVolume}
          min={0}
          max={1}
          step={0.05}
          format={(value) => `${Math.round(value * 100)}%`}
          label="Metronome volume"
          onChange={(metronomeVolume) => settings.set({ metronomeVolume })}
        />
      </Row>

      <Row label="Computer keyboard" hint="How hard the keys play when you use Z to M and Q to I.">
        <Slider
          value={settings.keyboardVelocity}
          min={0.1}
          max={1}
          step={0.05}
          format={(value) => `${Math.round(value * 100)}%`}
          label="Computer keyboard velocity"
          onChange={(keyboardVelocity) => settings.set({ keyboardVelocity })}
        />
      </Row>
    </>
  );
}

function MidiPage({ onStatus }: { onStatus: (message: string) => void }) {
  const padChannel = useMidiStore((state) => state.padChannel);
  const setPadChannel = useMidiStore((state) => state.setPadChannel);
  const resetMappings = useMidiStore((state) => state.resetMappings);

  const [inputs, setInputs] = useState<MidiDevice[]>([]);
  const [outputs, setOutputs] = useState<MidiDevice[]>(() => midiManager.getOutputs());
  const [ready, setReady] = useState(midiManager.isConnected);
  const [choice, setChoice] = useState(() => midiManager.getInputChoice());

  useEffect(
    () =>
      midiManager.onDevices((devices) => {
        setInputs(devices);
        setOutputs(midiManager.getOutputs());
        setReady(midiManager.isConnected);
      }),
    []
  );

  return (
    <>
      <Row label="MIDI" hint="Keyboards, pads and controllers.">
        {ready ? (
          <span className="settings-note">
            {inputs.length === 0 ? "On. No MIDI device found." : `On. ${inputs.length} input${inputs.length === 1 ? "" : "s"} found.`}
          </span>
        ) : (
          <button
            type="button"
            onClick={() =>
              void midiManager.init().then((ok) => {
                setReady(ok);
                setInputs(midiManager.getDevices());
                setOutputs(midiManager.getOutputs());
                onStatus(ok ? "MIDI is on." : "MIDI is unavailable or permission was declined.");
              })
            }
          >
            Turn on MIDI
          </button>
        )}
      </Row>

      <Row label="Listen to" hint="A keyboard like the Akai MPK mini IV has several ports. Automatic uses the ones you play on and ignores its DAW and control ports.">
        <select
          value={choice}
          disabled={!ready}
          aria-label="MIDI input to listen to"
          onChange={(event) => {
            setChoice(event.target.value);
            midiManager.setInputChoice(event.target.value);
          }}
        >
          <option value="auto">Automatic</option>
          <option value="all">Every port</option>
          {inputs.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
              {device.control ? " (control port)" : ""}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Drum pads" hint="The MIDI channel your pads send on (10 on most controllers).">
        <select value={padChannel} aria-label="Drum pad channel" onChange={(event) => setPadChannel(Number(event.target.value))}>
          {Array.from({ length: 16 }, (_, index) => index + 1).map((channel) => (
            <option key={channel} value={channel}>
              {channel}
              {channel === 10 ? " (usual)" : ""}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Outputs" hint="Where the MIDI Out plugin can send notes: a virtual cable, or a hardware synth.">
        <span className="settings-note">
          {!ready ? "Turn on MIDI to see them" : outputs.length === 0 ? "None found" : outputs.map((device) => device.name).join(", ")}
        </span>
      </Row>

      <Row label="Knob links" hint="Knobs linked to controls on screen (right-click a knob, then turn one on your controller).">
        <button
          type="button"
          onClick={() => {
            resetMappings();
            onStatus("MIDI knob mappings reset to defaults.");
          }}
        >
          Reset to defaults
        </button>
      </Row>
    </>
  );
}

function FilesPage({ onStatus }: { onStatus: (message: string) => void }) {
  const settings = useFileStore((state) => state.settings);

  const run = (action: () => Promise<string | null>) => void action().then((message) => message && onStatus(message));

  return (
    <>
      <Row label="Auto-save" hint="Save the open project to its file as you work, with backups.">
        <Switch checked={settings?.autosave !== false} onChange={() => run(toggleAutosave)} label={settings?.autosave !== false ? "On" : "Off"} />
      </Row>
      <Row label="Save folder" hint={settings?.saveFolder ?? "…"}>
        <button type="button" onClick={() => run(chooseSaveFolder)}>
          Change…
        </button>
        <button type="button" onClick={() => run(() => openSaveFolder("projects"))}>
          Open
        </button>
      </Row>
      <Row label="Exports" hint="Where WAV and MP3 files are written.">
        <button type="button" onClick={() => run(() => openSaveFolder("exports"))}>
          Open the exports folder
        </button>
      </Row>
    </>
  );
}

function AboutPage({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const settings = useAppSettings();
  const confirm = useConfirm();

  return (
    <>
      <Row
        label="PulseGrid Studio"
        hint="Copyright © 2026 Mathias Verdal and the PulseGrid Studio contributors. Free software under the GNU GPL, version 3 or later, and comes with no warranty."
      >
        <span className="settings-note">Version {__APP_VERSION__}</span>
      </Row>
      <Row label="Keyboard shortcuts" hint="Every key, in one list.">
        <button type="button" onClick={onShowShortcuts}>
          Show shortcuts
        </button>
      </Row>
      <Row label="Source code" hint="Open source under the GNU GPL, version 3: read it, change it, build it yourself, or help out.">
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Open on GitHub
        </a>
      </Row>
      <Row label="Licences of the parts it's built from" hint="React, Supabase, the MP3 encoder, the Inter font and the rest, each under its own licence.">
        <a href={`${SITE_URL}/THIRD_PARTY_LICENSES.txt`} target="_blank" rel="noopener noreferrer">
          Show the licences
        </a>
      </Row>
      <Row label="Credits and terms">
        <a href={`${SITE_URL}/legal.html`} target="_blank" rel="noopener noreferrer">
          Open the legal page
        </a>
      </Row>
      <Row label="Reset settings" hint="Put every setting in this window back the way it came. Your projects are not touched.">
        <button
          type="button"
          onClick={() =>
            void confirm("Reset all settings?", "Every setting in this window goes back to its default. Your projects stay as they are.", {
              confirmLabel: "Reset"
            }).then((ok) => {
              if (ok) settings.reset();
            })
          }
        >
          Reset all settings
        </button>
      </Row>
    </>
  );
}

/* ───────────────────────────── the window ───────────────────────────── */

interface SettingsDialogProps {
  onClose: () => void;
  onStatus: (message: string) => void;
  onShowShortcuts: () => void;
}

/**
 * Every setting in one place, as pages down the left. F10 or Options → Settings opens it. Each setting here does
 * something right away (or says when it will).
 */
export function SettingsDialog({ onClose, onStatus, onShowShortcuts }: SettingsDialogProps) {
  const desktop = isDesktop();
  const pages: Array<{ id: PageId; label: string }> = [
    { id: "general", label: "General" },
    { id: "interface", label: "Interface" },
    { id: "audio", label: "Audio" },
    { id: "midi", label: "MIDI" },
    ...(desktop ? [{ id: "files" as const, label: "Files" }] : []),
    { id: "about", label: "About" }
  ];

  const [page, setPage] = useState<PageId>(() => {
    try {
      const saved = localStorage.getItem("pulsegrid:settings-page") as PageId | null;
      return saved && pages.some((entry) => entry.id === saved) ? saved : "general";
    } catch {
      return "general";
    }
  });
  const closeButton = useRef<HTMLButtonElement | null>(null);

  const choose = (next: PageId) => {
    setPage(next);
    try {
      localStorage.setItem("pulsegrid:settings-page", next);
    } catch {
      /* the page holds until the dialog closes */
    }
  };

  useEffect(() => {
    closeButton.current?.focus();

    // The keys belong to this window while it is open: Esc closes it rather than stopping the music, and F10 puts it away.
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape" && target?.tagName === "SELECT") return;
      if (event.key !== "Escape" && event.key !== "F10") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const current = pages.find((entry) => entry.id === page) ?? pages[0];

  return (
    <div
      className="export-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-head">
          <h2 id="settings-title">Settings</h2>
          <button ref={closeButton} onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings-main">
          <nav className="settings-nav" role="tablist" aria-label="Settings pages">
            {pages.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === current.id}
                className={entry.id === current.id ? "active" : ""}
                onClick={() => choose(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          <div className="settings-page" role="tabpanel" aria-label={current.label}>
            <h3>{current.label}</h3>
            {current.id === "general" ? <GeneralPage onStatus={onStatus} /> : null}
            {current.id === "interface" ? <InterfacePage /> : null}
            {current.id === "audio" ? <AudioPage /> : null}
            {current.id === "midi" ? <MidiPage onStatus={onStatus} /> : null}
            {current.id === "files" ? <FilesPage onStatus={onStatus} /> : null}
            {current.id === "about" ? <AboutPage onShowShortcuts={onShowShortcuts} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
