import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";

import { useProjectStore } from "./state/projectStore";
import { currentSettings, useAppSettings } from "./state/appSettings";
import { THEMES } from "./lib/themes";
import { SettingsDialog } from "./components/SettingsDialog";
import { useSessionStore, type WindowId } from "./state/sessionStore";

import { useTransportStore } from "./state/transportStore";
import { useHoverHint } from "./hooks/useStudio";

import { HeaderActions, ProjectTitle, StatusInfo, TopBar } from "./components/TopBar";
import { HeaderMonitor } from "./components/HeaderMonitor";
import { ChannelRack } from "./components/ChannelRack";
import { PianoRoll } from "./components/PianoRoll";
import { Playlist } from "./components/Playlist";
import { Mixer } from "./components/Mixer";
import { StudioTools } from "./components/StudioTools";
import { ConfirmProvider, useConfirm } from "./components/ConfirmDialog";
import { ExportDialog } from "./components/ExportDialog";
import { UserAgreement } from "./components/UserAgreement";
import { GuidedTour } from "./components/GuidedTour";
import { CloudToast } from "./components/CloudToast";
import { IconClose, IconMaximise, IconMinimise, IconRestore } from "./components/icons";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { SynthEditor, useSynthEditor } from "./components/SynthEditor";
import { SoundFontEditor } from "./components/SoundFontEditor";
import { MenuPanel, prepareItems, type MenuItem } from "./components/MenuPanel";
import { isFullKit } from "./lib/drumKits";
import { WindowMenuButton } from "./components/WindowMenu";
import { EDGE_CURSOR, moveRect, resizeRect, type Edge, type Rect } from "./lib/windowGeometry";
import { MidiOutEditor } from "./components/MidiOutEditor";
import { matchShortcut, platformText, shortcutLabel, type ShortcutId } from "./lib/hotkeys";
import { PIANO_KEYS } from "./lib/pianoKeys";
import { markTourSeen, tourSeen } from "./lib/tour";
import { reportProblemUrl } from "./lib/reportProblem";
import { readAcceptance, type AgreementAcceptance } from "./agreement";
import { initDefaultSamples } from "./audio/sampleRegistry";
import { availableInstruments, type InstrumentMenuEntry } from "./presets/presets";
import { instrumentLibrary, type InstrumentFolder } from "./lib/instrumentLibrary";
import { addInstrument } from "./lib/addInstrument";
import { probeBuiltinSoundFont, refreshSavedFonts, useSoundFontStore, watchProjectFonts } from "./audio/soundfont/registry";
import { getDesktop, isDesktop, useFileStore } from "./files/desktop";
import { startMidi } from "./audio/midiController";
import { useMidiStore } from "./audio/midiMap";
import { checkForUpdatesNow, initUpdates, toggleUpdateChecks, useUpdateStore } from "./files/updates";
import { flushSync, startSync } from "./sync/manager";
import { useCloudStore } from "./sync/store";

import {
  ensureAudio,
  noteOff,
  noteOn,
  panic,
  seekTo,
  startTransport,
  stopTransport,
  toggleTransport
} from "./audio/engine";

import {
  initAutosave,
  chooseSaveFolder,
  loadFromBrowser,
  newProject,
  openProjectAt,
  openProjectFromDisk,
  openProjectFromFile,
  openSaveFolder,
  revealCurrentProject,
  saveProject,
  saveProjectAs,
  settleCurrentProject,
  toggleAutosave,
  restoreAutosave,
  saveProjectToFile,
  saveToBrowser
} from "./files/actions";

const windowTitles: Record<WindowId, string> = {
  playlist: "Playlist",
  rack: "Channel Rack",
  piano: "Piano Roll",
  mixer: "Mixer"
};

const windowShortcut: Record<WindowId, ShortcutId> = {
  playlist: "windowPlaylist",
  rack: "windowRack",
  piano: "windowPiano",
  mixer: "windowMixer"
};


const NO_RECENT: Array<{ path: string; name: string }> = [];

export default function App() {
  return (
    <ConfirmProvider>
      <Studio />
    </ConfirmProvider>
  );
}

function Studio() {
  const confirm = useConfirm();

  const theme = useSessionStore((state) => state.theme);
  const setTheme = useSessionStore((state) => state.setTheme);
  const windows = useSessionStore((state) => state.windows);
  const focusWindow = useSessionStore((state) => state.focusWindow);
  const closeWindow = useSessionStore((state) => state.closeWindow);
  const toggleWindow = useSessionStore((state) => state.toggleWindow);
  const openAllWindows = useSessionStore((state) => state.openAllWindows);
  const resetLayout = useSessionStore((state) => state.resetLayout);

  const undo = useProjectStore((state) => state.undo);
  const redo = useProjectStore((state) => state.redo);
  const addChannel = useProjectStore((state) => state.addChannel);
  const addPattern = useProjectStore((state) => state.addPattern);
  const duplicatePattern = useProjectStore((state) => state.duplicatePattern);
  const clearPattern = useProjectStore((state) => state.clearPattern);
  const removePattern = useProjectStore((state) => state.removePattern);

  const selectChannel = useSessionStore((state) => state.selectChannel);
  const selectPattern = useSessionStore((state) => state.selectPattern);
  const selectedPatternId = useSessionStore((state) => state.selectedPatternId);

  const hint = useHoverHint();

  const [showTools, setShowTools] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showHints = useAppSettings((state) => state.showHints);
  const uiScale = useAppSettings((state) => state.uiScale);
  const wheelZoom = useSessionStore((state) => state.wheelZoom);
  const toggleWheelZoom = useSessionStore((state) => state.toggleWheelZoom);
  const [agreement, setAgreement] = useState<AgreementAcceptance | null>(() => readAcceptance());
  const [agreementOpen, setAgreementOpen] = useState(false);
  const recent = useFileStore((state) => state.settings?.recent ?? NO_RECENT);
  const autosaveOn = useFileStore((state) => state.settings?.autosave !== false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [menuPlace, setMenuPlace] = useState({ left: 6, top: 30 });
  const [status, setStatus] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const windowArea = useRef<HTMLDivElement | null>(null);

  // Size the windows to this screen the first time (and after View → Reset
  // window layout). After that the user's own arrangement is left alone.
  const layoutFitted = useSessionStore((state) => state.layoutFitted);
  useLayoutEffect(() => {
    if (layoutFitted) return;
    const area = windowArea.current;
    if (!area || area.clientWidth === 0 || area.clientHeight === 0) return;
    useSessionStore.getState().fitLayoutToArea(area.clientWidth, area.clientHeight);
  }, [layoutFitted]);

  // The windows follow the work area: they keep their share of it as the app window is resized, and never leave it.
  useLayoutEffect(() => {
    const area = windowArea.current;
    if (!area) return;
    const apply = () => useSessionStore.getState().setArea(area.clientWidth, area.clientHeight);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const showStatus = useCallback((message: string) => setStatus(message), []);

  // The size of the interface, from the settings (the desktop app; the web studio uses the browser's zoom).
  useEffect(() => {
    getDesktop()?.setZoom?.(uiScale);
  }, [uiScale]);

  // Clear the status line after a while so it doesn't linger forever.
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(""), 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Generate the built-in samples up front so the browser isn't empty before
  // the user's first click unlocks a real AudioContext.
  useEffect(() => {
    try {
      initDefaultSamples(
        new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 })
      );
    } catch {
      /* Web Audio unavailable — the browser panel just stays empty. */
    }
  }, []);

  // Restore the last session and start autosaving.
  useEffect(() => {
    let cancelled = false;

    void restoreAutosave().then((name) => {
      if (!cancelled && name) setStatus(`Restored "${name}".`);
    });

    const teardown = initAutosave();

    return () => {
      cancelled = true;
      teardown();
    };
  }, []);

  useEffect(() => () => stopTransport(), []);

  // The first-run tour: once, after the agreement is accepted, with the
  // windows it points at open. Help → Take the tour shows it again.
  const [tourOpen, setTourOpen] = useState(false);
  const startTour = useCallback(() => {
    const session = useSessionStore.getState();
    if (!session.windows.playlist.open) session.focusWindow("playlist");
    if (!session.windows.rack.open) session.focusWindow("rack");
    setOpenMenu(null);
    setTourOpen(true);
  }, []);
  const closeTour = useCallback(() => {
    markTourSeen();
    setTourOpen(false);
  }, []);
  useEffect(() => {
    if (agreement === null || tourSeen()) return;
    const timer = window.setTimeout(startTour, 900);
    return () => window.clearTimeout(timer);
  }, [agreement, startTour]);

  // Cloud sync: does nothing, and contacts nothing, until someone signs in.
  useEffect(() => startSync(), []);
  const cloudNotice = useCloudStore((state) => state.notice);
  useEffect(() => {
    if (!cloudNotice) return;
    setStatus(cloudNotice);
    useCloudStore.getState().setNotice("");
  }, [cloudNotice]);

  // Desktop only: mirror the background update check.
  useEffect(() => initUpdates(), []);

  // Recorded instruments: is the built-in set here, which SoundFonts has this person added, and
  // read whatever the open project needs as soon as it is open.
  const builtinSounds = useSoundFontStore((state) => state.builtinAvailable);
  useEffect(() => {
    void probeBuiltinSoundFont();
    void refreshSavedFonts();
    return watchProjectFonts(
      () => useProjectStore.getState().channels,
      (listener) => useProjectStore.subscribe((state, previous) => (state.channels !== previous.channels ? listener() : undefined))
    );
  }, []);
  const updatesConfigured = useUpdateStore((state) => state.configured);
  const updateChecksOn = useUpdateStore((state) => state.enabled);

  // MIDI keyboards, pads and knobs, connected for the whole session — not
  // tied to any panel being open.
  useEffect(() => startMidi(showStatus), [showStatus]);

  // Safety net for undo grouping.
  //
  // Every drag in the app opens an undo group on pointerdown and closes it on
  // release. If the editor unmounts mid-drag — closing its window with F5–F9,
  // switching pattern, a `pointercancel` on a touch device — its own handler
  // never runs, and a group left open makes `capture()` refuse every later
  // edit: the app keeps working, but nothing new is recorded and the next
  // Ctrl+Z throws away everything since the drag. Closing on any pointer
  // release makes that unrecoverable state impossible whoever opened it.
  //
  // Deferred by a tick so the owning component's own pointerup handler — which
  // may still commit the final value of the gesture — runs first.
  useEffect(() => {
    const close = () => {
      window.setTimeout(() => useProjectStore.getState().endEdit(), 0);
    };

    window.addEventListener("pointerup", close);
    window.addEventListener("pointercancel", close);

    return () => {
      window.removeEventListener("pointerup", close);
      window.removeEventListener("pointercancel", close);
    };
  }, []);

  const runFileAction = useCallback(
    (action: () => Promise<string> | string) => {
      void Promise.resolve()
        .then(action)
        .then(setStatus)
        .catch((error: unknown) => {
          console.error(error);
          setStatus(error instanceof Error ? error.message : "That didn't work.");
        });
    },
    []
  );

  /* ───────────────────────── global shortcuts ───────────────────────── */

  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      return (
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable
      );
    };

    /** Keys that make sense to hold down: undo, stepping through patterns and channels. */
    const repeats = new Set(["undo", "redo", "nextPattern", "previousPattern", "nextChannel", "previousChannel"]);

    const announce = (message: string) => setStatus(message);

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;

      const id = matchShortcut(event);
      if (!id) return;

      // A held key would otherwise flip a toggle on and off again and again.
      if (event.repeat && !repeats.has(id)) {
        if (id === "play" || id === "playFromStart") event.preventDefault();
        return;
      }

      const session = useSessionStore.getState();
      const project = useProjectStore.getState();

      switch (id) {
        case "undo":
          event.preventDefault();
          undo();
          return;

        case "redo":
          event.preventDefault();
          redo();
          return;

        case "save":
          event.preventDefault();
          runFileAction(saveProject);
          return;

        case "saveAs":
          event.preventDefault();
          runFileAction(saveProjectAs);
          return;

        case "open":
          event.preventDefault();
          if (isDesktop()) runFileAction(openProjectFromDisk);
          else fileInput.current?.click();
          return;

        case "newProject":
          // In a browser Ctrl+N belongs to the browser.
          if (!isDesktop()) return;
          event.preventDefault();
          runFileAction(async () => ((await settleCurrentProject()) ? newProject() : "Cancelled."));
          return;

        case "exportAudio":
          event.preventDefault();
          setExportOpen(true);
          return;

        case "play":
          event.preventDefault();
          void toggleTransport();
          return;

        case "playFromStart": {
          // Enter on a focused button presses it; leave that alone.
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (target?.closest("button, a, summary, [role='button']")) return;
          event.preventDefault();
          void startTransport(0);
          return;
        }

        case "toStart":
          event.preventDefault();
          stopTransport();
          seekTo(0);
          return;

        case "stopAll":
          event.preventDefault();
          stopTransport();
          panic();
          setOpenMenu(null);
          useMidiStore.getState().startLearning(null);
          return;

        case "toggleLoop":
          event.preventDefault();
          session.toggleLoopPlayback();
          announce(useSessionStore.getState().loopPlayback ? "Looping." : "Playing once.");
          return;

        case "toggleMetronome":
          event.preventDefault();
          session.toggleMetronome();
          announce(useSessionStore.getState().metronome ? "Metronome on." : "Metronome off.");
          return;

        case "toggleCountIn":
          event.preventDefault();
          session.toggleCountIn();
          announce(useSessionStore.getState().countIn ? "Count-in on." : "Count-in off.");
          return;

        case "toggleSongMode":
          event.preventDefault();
          session.setMode(session.mode === "song" ? "pattern" : "song");
          announce(useSessionStore.getState().mode === "song" ? "Song mode." : "Pattern mode.");
          return;

        case "windowPlaylist":
          event.preventDefault();
          toggleWindow("playlist");
          return;
        case "windowRack":
          event.preventDefault();
          toggleWindow("rack");
          return;
        case "windowPiano":
          event.preventDefault();
          toggleWindow("piano");
          return;
        case "windowMixer":
          event.preventDefault();
          toggleWindow("mixer");
          return;
        case "windowSynth": {
          event.preventDefault();
          const channel = project.channels.find((entry) => entry.id === session.selectedChannelId);
          const editor = useSynthEditor.getState();
          if (channel?.type !== "synth") {
            announce("Select a synth channel first, then press F8 to open its sound editor.");
          } else if (editor.channelId === channel.id) {
            editor.close();
          } else {
            editor.open(channel.id);
          }
          return;
        }

        case "toggleBrowser":
          event.preventDefault();
          setShowTools((value) => !value);
          return;

        case "showShortcuts":
          event.preventDefault();
          setShortcutsOpen(true);
          return;

        case "openSettings":
          event.preventDefault();
          setSettingsOpen((open) => !open);
          return;

        case "nextPattern":
        case "previousPattern": {
          event.preventDefault();
          const order = project.patternOrder;
          if (order.length === 0) return;
          const at = Math.max(0, order.indexOf(session.selectedPatternId));
          const next = order[(at + (id === "nextPattern" ? 1 : -1) + order.length) % order.length];
          session.selectPattern(next);
          announce(`Pattern: ${project.patterns[next]?.name ?? next}`);
          return;
        }

        case "newPattern":
          event.preventDefault();
          session.selectPattern(project.addPattern());
          announce("New pattern.");
          return;

        case "nextChannel":
        case "previousChannel": {
          event.preventDefault();
          const channels = project.channels;
          if (channels.length === 0) return;
          const at = Math.max(0, channels.findIndex((channel) => channel.id === session.selectedChannelId));
          const next = channels[(at + (id === "nextChannel" ? 1 : -1) + channels.length) % channels.length];
          session.selectChannel(next.id);
          announce(`Keys now play ${next.name}.`);
          return;
        }

        case "muteChannel":
        case "soloChannel": {
          event.preventDefault();
          const channel = project.channels.find((entry) => entry.id === session.selectedChannelId);
          if (!channel) return;
          if (id === "muteChannel") project.toggleChannelMute(channel.id);
          else project.toggleChannelSolo(channel.id);
          const now = useProjectStore.getState().channels.find((entry) => entry.id === channel.id);
          announce(
            id === "muteChannel"
              ? `${channel.name} ${now?.mute ? "muted" : "unmuted"}.`
              : `${channel.name} ${now?.solo ? "solo" : "no longer solo"}.`
          );
          return;
        }

        // Zoom, tools and the piano roll's own shortcuts belong to the editor in front.
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, runFileAction, toggleWindow, undo]);

  useComputerKeyboard();

  /* ─────────────────────────────── menus ─────────────────────────────── */

  useEffect(() => {
    if (!openMenu) return;

    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".fl-menu-bar") && !target.closest(".menu-panel")) setOpenMenu(null);
    };

    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [openMenu]);

  const desktop = isDesktop();

  const menus: Record<string, MenuItem[]> = {
    File: desktop
      ? [
          {
            label: "New project   Ctrl+N",
            run: () =>
              runFileAction(async () => ((await settleCurrentProject()) ? newProject() : "Cancelled."))
          },
          { label: "Open…   Ctrl+O", run: () => runFileAction(openProjectFromDisk) },
          ...(recent.length > 0
            ? [
                { label: "Recent", run: () => undefined, heading: true },
                ...recent.slice(0, 6).map((entry) => ({
                  label: entry.name,
                  run: () => runFileAction(() => openProjectAt(entry.path))
                }))
              ]
            : []),
          { label: "", separator: true },
          { label: "Save   Ctrl+S", run: () => runFileAction(saveProject) },
          { label: "Save as…   Ctrl+Shift+S", run: () => runFileAction(saveProjectAs) },
          { label: "Auto-save", checked: autosaveOn, run: () => runFileAction(toggleAutosave) },
          { label: "Show in File Explorer", run: () => runFileAction(revealCurrentProject) },
          { label: "", separator: true },
          { label: "Open save folder", run: () => runFileAction(() => openSaveFolder("projects")) },
          { label: "Open exports folder", run: () => runFileAction(() => openSaveFolder("exports")) },
          { label: "Change save folder…", run: () => runFileAction(chooseSaveFolder) },
          { label: "", separator: true },
          { label: `Export audio…   ${shortcutLabel("exportAudio")}`, run: () => setExportOpen(true) }
        ]
      : [
          {
            label: "New project",
            run: () =>
              void confirm("Start a new project?", "Anything unsaved will be replaced.", {
                confirmLabel: "New project"
              }).then(async (ok) => {
                if (!ok) return;
                // Replacing the web studio's one project: let the cloud have its last changes first.
                await flushSync();
                setStatus(newProject());
              })
          },
          { label: "Save to browser   Ctrl+S", run: () => runFileAction(saveToBrowser) },
          { label: "Load from browser", run: () => runFileAction(loadFromBrowser) },
          { label: "Download project (.pulsegrid)…", run: () => runFileAction(saveProjectToFile) },
          { label: "Open project file…   Ctrl+O", run: () => fileInput.current?.click() },
          { label: "Export audio…", run: () => setExportOpen(true) },
          {
            label: "Get the desktop app…",
            run: () => window.open("./#download", "_blank", "noopener")
          }
        ],
    Edit: [
      { label: `Undo   ${shortcutLabel("undo")}`, run: undo },
      { label: `Redo   ${shortcutLabel("redo")}`, run: redo }
    ],
    // The plugins first, then the instruments in flyouts, as in FL's own menus.
    Add: (() => {
      const library = instrumentLibrary(availableInstruments(builtinSounds));
      const entryItem = (entry: InstrumentMenuEntry): MenuItem => ({
        label: entry.label,
        run: () => {
          addInstrument(entry);
          setStatus(`Added ${entry.label}.`);
        }
      });
      const folderItem = (folder: InstrumentFolder): MenuItem => ({
        label: folder.label,
        items: [...(folder.entries ?? []).map(entryItem), ...(folder.folders ?? []).map(folderItem)]
      });
      return [...library.plugins.map(entryItem), { label: "", separator: true }, ...library.folders.map(folderItem)];
    })(),
    Patterns: [
      { label: "New pattern", run: () => selectPattern(addPattern()) },
      {
        label: "Duplicate pattern",
        run: () => {
          const id = duplicatePattern(selectedPatternId);
          if (id) selectPattern(id);
        }
      },
      {
        label: "Clear pattern",
        run: () =>
          void confirm("Clear this pattern?", "Every step and note in it is removed.", {
            confirmLabel: "Clear"
          }).then((ok) => {
            if (ok) clearPattern(selectedPatternId);
          })
      },
      {
        label: "Delete pattern",
        run: () =>
          void confirm("Delete this pattern?", "Clips using it are removed too.", {
            confirmLabel: "Delete"
          }).then((ok) => {
            if (ok) removePattern(selectedPatternId);
          })
      }
    ],
    View: [
      { label: "Open all windows", run: openAllWindows },
      { label: "Reset window layout", run: resetLayout },
      { label: showTools ? "Hide browser" : "Show browser", run: () => setShowTools((v) => !v) },
      { label: "", separator: true },
      ...(Object.keys(windowTitles) as WindowId[]).map((id) => ({
        label: `${windowTitles[id]}   ${shortcutLabel(windowShortcut[id])}`,
        run: () => focusWindow(id)
      }))
    ],
    Options: [
      { label: `Settings…   ${shortcutLabel("openSettings")}`, run: () => setSettingsOpen(true) },
      { label: "", separator: true },
      ...THEMES.map((entry) => ({
        label: entry.name,
        checked: theme === entry.id,
        radio: true,
        run: () => setTheme(entry.id)
      })),
      { label: "", separator: true },
      { label: "Browser panel   Ctrl+B", checked: showTools, run: () => setShowTools((value) => !value) },
      {
        label: "Scroll wheel zooms the piano roll and playlist",
        checked: wheelZoom,
        run: () => {
          toggleWheelZoom();
          setStatus(
            useSessionStore.getState().wheelZoom
              ? "The scroll wheel zooms. Shift scrolls sideways, Alt scrolls up and down."
              : platformText("The scroll wheel scrolls. Ctrl + scroll zooms.")
          );
        }
      },
      ...(updatesConfigured
        ? [
            {
              label: "Check for updates automatically",
              checked: updateChecksOn,
              run: () => runFileAction(toggleUpdateChecks)
            }
          ]
        : [])
    ],
    Tools: [
      { label: "Stop all sound   Esc", run: () => { stopTransport(); panic(); } },
      { label: `Export audio…   ${shortcutLabel("exportAudio")}`, run: () => setExportOpen(true) }
    ],
    Help: [
      { label: `PulseGrid Studio ${__APP_VERSION__}`, run: () => undefined, heading: true },
      ...(updatesConfigured
        ? [{ label: "Check for updates…", run: () => runFileAction(checkForUpdatesNow) }]
        : []),
      { label: "Take the tour", run: startTour },
      {
        label: "Report a problem…",
        run: () =>
          window.open(
            reportProblemUrl({ version: __APP_VERSION__, desktop, userAgent: navigator.userAgent }),
            "_blank",
            "noopener"
          )
      },
      { label: "User agreement…", run: () => setAgreementOpen(true) },
      { label: `Keyboard shortcuts…   ${shortcutLabel("showShortcuts")}`, run: () => setShortcutsOpen(true) }
    ]
  };

  return (
    <>
      <header className="fl-header">
        <div className="fl-menu-bar">
          <nav className="fl-menus" aria-label="Menu">
            <img className="fl-app-mark" src={`${import.meta.env.BASE_URL}icon.png`} alt="" />
            {Object.keys(menus).map((label) => (
              <button
                key={label}
                className={openMenu === label ? "active" : ""}
                aria-expanded={openMenu === label}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenuPlace({ left: box.left, top: box.bottom + 1 });
                  setOpenMenu((current) => (current === label ? null : label));
                }}
                onPointerEnter={(event) => {
                  // Once a menu is open, sliding along the bar switches menus.
                  if (!openMenu || openMenu === label) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenuPlace({ left: box.left, top: box.bottom + 1 });
                  setOpenMenu(label);
                }}
              >
                {label}
              </button>
            ))}
          </nav>

          {/* Row 1, as in FL Studio: the menus, then play controls, tempo and time, then the master monitor. */}
          <TopBar part="transport" showBrowser={showTools} onToggleBrowser={() => setShowTools((value) => !value)} />

          <span className="fl-flex" />

          <HeaderMonitor />

          <HeaderActions onStatus={showStatus} onExport={() => setExportOpen(true)} />
        </div>

        {/* Row 2: the hint panel with the project's name, the windows, snap, the pattern and the master knobs. */}
        <div className="fl-toolbar-row">
          <div className="fl-panel fl-hint-panel" role="group" aria-label="Project and hints">
            <div className="fl-hint-top">
              <ProjectTitle onStatus={showStatus} />
            </div>
            <div className="fl-hint-line">
              <span className={`fl-hint-icon${status ? " fl-hint-icon-status" : ""}`} aria-hidden="true">
                {status ? "" : "i"}
              </span>
              <span className={`fl-hint-text${status || (showHints && hint) ? "" : " fl-hint-idle"}`} role="status">
                {status || (showHints ? hint || platformText("Point at anything for a hint · Space plays · Ctrl+S saves") : "")}
              </span>
              <StatusInfo />
            </div>
          </div>

          <TopBar part="tools" showBrowser={showTools} onToggleBrowser={() => setShowTools((value) => !value)} />
        </div>
      </header>

      {exportOpen ? (
        <ExportDialog onClose={() => setExportOpen(false)} onStatus={showStatus} />
      ) : null}

      <SynthEditor />
      <SoundFontEditor />
      <MidiOutEditor />
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      {settingsOpen ? (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onStatus={showStatus}
          onShowShortcuts={() => {
            setSettingsOpen(false);
            setShortcutsOpen(true);
          }}
        />
      ) : null}

      {openMenu ? (
        <MenuPanel
          items={prepareItems(menus[openMenu])}
          // Hangs from the bottom of its button: the menu bar is taller than the buttons now that it holds the transport.
          left={menuPlace.left}
          top={menuPlace.top}
          onClose={() => setOpenMenu(null)}
          onSwitch={(direction) => {
            const names = Object.keys(menus);
            const next = names[(names.indexOf(openMenu) + direction + names.length) % names.length];
            const button = [...document.querySelectorAll<HTMLElement>(".fl-menus button")].find((entry) => entry.textContent === next);
            if (button) {
              const box = button.getBoundingClientRect();
              setMenuPlace({ left: box.left, top: box.bottom + 1 });
            }
            setOpenMenu(next);
          }}
        />
      ) : null}

      <main className="floating-studio">
        {showTools ? <StudioTools onStatus={showStatus} /> : null}

        <div className="window-area" ref={windowArea}>
          {(Object.keys(windowTitles) as WindowId[]).map((id) =>
            windows[id].open ? (
              <StudioWindow
                key={id}
                id={id}
                title={windowTitles[id]}
                onFocus={() => focusWindow(id)}
                onClose={() => closeWindow(id)}
                onStatus={showStatus}
              >
                {id === "playlist" ? <Playlist /> : null}
                {id === "rack" ? <ChannelRack /> : null}
                {id === "piano" ? <PianoRoll /> : null}
                {id === "mixer" ? <Mixer /> : null}
              </StudioWindow>
            ) : null
          )}

          {!Object.values(windows).some((layout) => layout.open) ? (
            <div className="no-windows">
              Every window is closed — press <kbd>F5</kbd> for the playlist, or use the window buttons in the top bar.
            </div>
          ) : null}
        </div>
      </main>


      <CloudToast onStatus={showStatus} />

      {tourOpen && agreement !== null ? <GuidedTour onClose={closeTour} /> : null}

      {/* Until it is accepted the agreement covers the whole studio; after
          that it can be read again from the Help menu. */}
      {agreement === null ? (
        <UserAgreement accepted={null} onAccept={setAgreement} />
      ) : agreementOpen ? (
        <UserAgreement accepted={agreement} onClose={() => setAgreementOpen(false)} />
      ) : null}

      <input
        ref={fileInput}
        type="file"
        // .pulsegrid from either app; .json for files saved by older versions.
        accept=".pulsegrid,.json,application/json"
        className="hidden-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) runFileAction(() => openProjectFromFile(file));
        }}
      />
    </>
  );
}

/* ───────────────────────── computer-keyboard piano ───────────────────────── */

/** Play the selected channel from the computer keyboard, FL "typing keyboard" style. */
function useComputerKeyboard(): void {
  const [octave, setOctave] = useState(4);

  // Remember what each key actually sounded, not just that it is down. The
  // note-off has to reach the same pitch on the same channel — recomputing it
  // means changing octave (or the keyboard target) mid-note releases something
  // that was never played and leaves the real voice ringing.
  const held = useRef(new Map<string, { pitch: number; channelId: string }>());

  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      return (
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.code === "BracketLeft") {
        setOctave((value) => Math.max(0, value - 1));
        return;
      }

      if (event.code === "BracketRight") {
        setOctave((value) => Math.min(8, value + 1));
        return;
      }

      const offset = PIANO_KEYS[event.code];
      if (offset === undefined || event.repeat) return;

      const channelId = useSessionStore.getState().selectedChannelId;
      if (!channelId) return;

      event.preventDefault();
      ensureAudio();

      // A whole drum kit sits two octaves lower, so Z is the kick and the keys above it are the rest of the kit.
      const kit = isFullKit(useProjectStore.getState().channels.find((entry) => entry.id === channelId));
      const pitch = Math.max(0, Math.min(127, (octave + (kit ? -1 : 1)) * 12 + offset));
      held.current.set(event.code, { pitch, channelId });
      useTransportStore.getState().noteOn(pitch);
      noteOn(channelId, pitch, currentSettings().keyboardVelocity);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const sounding = held.current.get(event.code);
      if (!sounding) return;

      held.current.delete(event.code);

      useTransportStore.getState().noteOff(sounding.pitch);
      noteOff(sounding.channelId, sounding.pitch);
    };

    // Releasing focus mid-chord would otherwise leave notes ringing.
    const onBlur = () => {
      held.current.clear();
      useTransportStore.getState().clearNotes();
      panic();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [octave]);
}

/* ─────────────────────────────── windows ─────────────────────────────── */

interface StudioWindowProps {
  id: WindowId;
  title: string;
  onFocus: () => void;
  onClose: () => void;
  onStatus: (message: string) => void;
  children: ReactNode;
}

const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function StudioWindow({ id, title, onFocus, onClose, onStatus, children }: StudioWindowProps) {
  const layout = useSessionStore((state) => state.windows[id]);
  const active = useSessionStore((state) => state.view === id);
  const setWindowRect = useSessionStore((state) => state.setWindowRect);
  const setWindowFlag = useSessionStore((state) => state.setWindowFlag);

  // One gesture at a time: moving by the title bar, or resizing by an edge or corner. While it lasts the
  // window listens to the pointer everywhere, so the drag keeps working when it leaves the window.
  const gesture = useRef<{ kind: "move" | Edge; pointerX: number; pointerY: number; rect: Rect } | null>(null);
  const stopListening = useRef<(() => void) | null>(null);

  useEffect(() => () => stopListening.current?.(), []);

  const begin = (kind: "move" | Edge) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || layout.maximized) return;

    event.preventDefault();
    onFocus();
    stopListening.current?.();

    gesture.current = {
      kind,
      pointerX: event.clientX,
      pointerY: event.clientY,
      rect: { x: layout.x, y: layout.y, width: layout.width, height: layout.height }
    };

    const track = (move: PointerEvent) => {
      const current = gesture.current;
      if (!current) return;

      const area = useSessionStore.getState().area;
      const dx = move.clientX - current.pointerX;
      const dy = move.clientY - current.pointerY;

      // A window can be left partly out of view; it draws to the edges when it comes close to them.
      setWindowRect(
        id,
        current.kind === "move" ? moveRect(current.rect, dx, dy, area) : resizeRect(current.rect, current.kind, dx, dy, area)
      );
    };

    const finish = () => {
      gesture.current = null;
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      document.body.style.cursor = "";
      stopListening.current = null;
    };

    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    // The pointer keeps the shape of the handle being dragged, even when it strays off it.
    document.body.style.cursor = kind === "move" ? "move" : EDGE_CURSOR[kind];
    stopListening.current = finish;
  };

  const toggleMaximised = () => {
    setWindowFlag(id, "maximized", !layout.maximized);
    setWindowFlag(id, "minimized", false);
  };

  return (
    <section
      className={[
        "studio-window",
        `studio-window-${id}`,
        layout.minimized ? "minimized" : "",
        layout.maximized ? "maximized" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: layout.maximized ? 0 : layout.x,
        top: layout.maximized ? 0 : layout.y,
        width: layout.maximized ? "100%" : layout.width,
        height: layout.minimized ? 26 : layout.maximized ? "100%" : layout.height,
        // A maximized window is the backdrop: floating windows always stay in
        // front of it, so clicking the full-screen playlist can't bury the rack.
        zIndex: layout.maximized ? layout.z : layout.z + 10
      }}
      onPointerDown={onFocus}
    >
      <div
        className="window-titlebar"
        onPointerDown={begin("move")}
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) toggleMaximised();
        }}
        title="Drag to move · double-click to maximise"
      >
        <span className={`window-led${active ? " active" : ""}`} />
        <WindowMenuButton id={id} title={title} onStatus={onStatus} />
        <span className="window-title">{title}</span>
        <span className="window-spacer" />

        <button
          className="window-button"
          title={layout.minimized ? "Restore" : "Minimise"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setWindowFlag(id, "minimized", !layout.minimized)}
        >
          {layout.minimized ? <IconRestore /> : <IconMinimise />}
        </button>

        <button
          className="window-button"
          title={layout.maximized ? "Restore" : "Maximise"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleMaximised}
        >
          {layout.maximized ? <IconRestore /> : <IconMaximise />}
        </button>

        <button
          className="window-button window-close"
          title="Close"
          aria-label="Close"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      {layout.minimized ? null : <div className="window-body">{children}</div>}

      {layout.minimized || layout.maximized
        ? null
        : EDGES.map((edge) => (
            <span
              key={edge}
              className={`window-edge edge-${edge}`}
              onPointerDown={begin(edge)}
            />
          ))}
    </section>
  );
}
