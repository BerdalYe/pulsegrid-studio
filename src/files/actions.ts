import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { getProjectData } from "../state/serialize";
import { migrateProject } from "./migrations";

import {
  AUTOSAVE_SLOT,
  buildProjectFile,
  downloadProjectFile,
  loadProjectSlot,
  readProjectFile,
  registerProjectAssets,
  restoreSamples,
  saveProjectSlot
} from "./storage";

import { getDesktop, useFileStore, type DesktopProjectFile } from "./desktop";

import { ensureAudio, getAudioContext, stopTransport } from "../audio/engine";
import { exportProject, type ExportOptions, type ExportProgressCallback } from "../audio/exportWav";
import { presetProjects } from "../presets/presets";
import { flushSync, notifySaved, notifySwitched, setStudioAdapter } from "../sync/manager";
import { createWebIdentity } from "../sync/webIdentity";

/*
 * Two homes for a project:
 *
 *  - the desktop app keeps each project as a `.pulsegrid` file in the save
 *    folder, auto-saved straight to that file a few seconds after each edit;
 *  - the browser keeps one working copy in IndexedDB, and project files move
 *    in and out as downloads.
 *
 * Every action below picks the right one, so the menus don't have to.
 */

function snapshot() {
  return {
    project: getProjectData(useProjectStore.getState()),
    session: useSessionStore.getState().toSessionData()
  };
}

/**
 * A silent context used only to decode stored samples before the user has
 * interacted with the page (a live AudioContext would be suspended anyway).
 */
function decodingContext(): BaseAudioContext {
  const live = getAudioContext();
  if (live) return live;
  return new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 44100 });
}

async function projectFileText(): Promise<string> {
  const { project, session } = snapshot();
  return JSON.stringify(await buildProjectFile(project, session));
}

/** Parse, upgrade and load a project file's text, samples included. */
async function loadProjectText(text: string): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error("That file isn't a readable PulseGrid project.");
  }

  const { project, session, assets } = migrateProject(raw);

  await registerProjectAssets(assets, decodingContext());
  await restoreSamples(decodingContext());

  useProjectStore.getState().hydrate(project);
  useSessionStore.getState().applySession(session);
  markSaved();

  return project.projectName;
}

/* ─────────────────────────────── desktop ─────────────────────────────── */

/** Saves run one at a time, so an auto-save can never interleave with Ctrl+S. */
let saveChain: Promise<unknown> = Promise.resolve();

function queueSave<T>(work: () => Promise<T>): Promise<T> {
  const next = saveChain.then(work, work);
  saveChain = next.catch(() => undefined);
  return next;
}

/** Write the open project to its file, creating one in the save folder if it has none. */
function writeToDisk(quiet = false): Promise<string> {
  return queueSave(async () => {
    const desktop = getDesktop();
    if (!desktop) throw new Error("Saving to disk needs the desktop app.");

    const files = useFileStore.getState();
    const saved = currentRevision();
    const text = await projectFileText();

    files.setSaveState("saving");

    try {
      const target =
        files.path ?? (await desktop.newProjectPath(useProjectStore.getState().projectName));
      const result = await desktop.writeProject(target, text);

      files.setFile(result.path, result.name);
      markSaved(saved);
      files.setSaveState(dirty ? "unsaved" : "saved", result.savedAt);
      files.touchFolder();
      updateTitle();
      // Cloud sync hears about every save except the one that stores what it just downloaded.
      if (!quiet) notifySaved();

      // A rolling copy every ten minutes or so, in Backups\.
      void desktop.backupProject(result.path, text).catch(() => undefined);

      return `Saved ${result.name}.pulsegrid`;
    } catch (error) {
      files.setSaveState("error");
      updateTitle();
      throw error instanceof Error ? error : new Error("The project could not be saved.");
    }
  });
}

async function openDesktopFile(file: DesktopProjectFile): Promise<string> {
  const name = await whileSwitching(async () => {
    stopTransport();
    const loaded = await loadProjectText(file.contents);

    const files = useFileStore.getState();
    files.setFile(file.path, file.name);
    // "Saved 3 hours ago" means the file on disk, not the moment it was opened.
    files.setSaveState("saved", file.modified ?? Date.now());
    files.touchFolder();
    updateTitle();
    return loaded;
  });

  notifySwitched();
  return `Opened "${name}".`;
}

/**
 * Before replacing the open project: save it if auto-save is on, otherwise
 * ask. Resolves false if the user cancelled.
 */
export async function settleCurrentProject(): Promise<boolean> {
  if (!(await settleLocally())) return false;
  // Whatever happens next replaces or closes the project: make sure the cloud
  // has its last changes first (a few seconds at most; offline it moves on).
  await flushSync();
  return true;
}

async function settleLocally(): Promise<boolean> {
  const desktop = getDesktop();
  if (!desktop || !dirty) return true;

  const autosave = useFileStore.getState().settings?.autosave ?? true;

  if (autosave) {
    try {
      await writeToDisk();
      return true;
    } catch {
      // Fall through and let the user decide rather than silently losing it.
    }
  }

  const choice = await desktop.askSaveChanges(
    useFileStore.getState().fileName ?? useProjectStore.getState().projectName
  );
  if (choice === "cancel") return false;
  if (choice === "save") {
    try {
      await writeToDisk();
    } catch {
      return false;
    }
  }
  return true;
}

function updateTitle(): void {
  const desktop = getDesktop();
  const name = useFileStore.getState().fileName ?? useProjectStore.getState().projectName;
  const marker = dirty ? "• " : "";
  const app = `PulseGrid Studio ${__APP_VERSION__}`;

  if (desktop) desktop.setTitle(`${marker}${name} — ${app}`);
  else document.title = `${name} — ${app}`;
}

export async function refreshDesktopSettings(): Promise<void> {
  const desktop = getDesktop();
  if (!desktop) return;
  useFileStore.getState().setSettings(await desktop.getSettings());
}

export async function toggleAutosave(): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return "Auto-save is always on in the browser.";

  const enabled = !(useFileStore.getState().settings?.autosave ?? true);
  useFileStore.getState().setSettings(await desktop.setAutosave(enabled));

  if (enabled && dirty) void writeToDisk().catch(() => undefined);
  return enabled ? "Auto-save is on." : "Auto-save is off — save with Ctrl+S.";
}

export async function chooseSaveFolder(): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return "The save folder is a desktop app setting.";

  const settings = await desktop.chooseSaveFolder();
  if (!settings) return "Save folder unchanged.";

  useFileStore.getState().setSettings(settings);
  useFileStore.getState().touchFolder();
  return `New projects are saved in ${settings.saveFolder}.`;
}

export async function openSaveFolder(which: "projects" | "exports" = "projects"): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return "Folders are a desktop app feature.";
  const error = await desktop.openSaveFolder(which);
  return error ?? "Opened the folder.";
}

export async function revealCurrentProject(): Promise<string> {
  const desktop = getDesktop();
  const path = useFileStore.getState().path;
  if (!desktop || !path) return "This project hasn't been saved to a file yet.";
  await desktop.revealProject(path);
  return "Shown in File Explorer.";
}

/* ───────────────────────────── the actions ───────────────────────────── */

/** Ctrl+S: to its file on the desktop, to IndexedDB in the browser. */
export async function saveProject(): Promise<string> {
  if (getDesktop()) return writeToDisk();
  return saveToBrowser();
}

/** Save under a new name/location (desktop) or download a copy (browser). */
export async function saveProjectAs(): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return saveProjectToFile();

  return queueSave(async () => {
    const saved = currentRevision();
    const text = await projectFileText();
    const result = await desktop.saveProjectAs(useProjectStore.getState().projectName, text);
    if (!result) return "Save cancelled.";

    const files = useFileStore.getState();
    files.setFile(result.path, result.name);
    markSaved(saved);
    files.setSaveState(dirty ? "unsaved" : "saved", result.savedAt);
    files.touchFolder();
    updateTitle();
    await refreshDesktopSettings();

    return `Saved as ${result.name}.pulsegrid`;
  });
}

/** Desktop only: the Open dialog. */
export async function openProjectFromDisk(): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return "Use File → Open project file… in the browser.";
  if (!(await settleCurrentProject())) return "Open cancelled.";

  const file = await desktop.openProjectDialog();
  if (!file) return "Open cancelled.";

  const message = await openDesktopFile(file);
  await refreshDesktopSettings();
  return message;
}

/** Desktop only: a project from the save folder or the recent list. */
export async function openProjectAt(path: string): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return "Opening files by path needs the desktop app.";
  if (path === useFileStore.getState().path) return "That project is already open.";
  if (!(await settleCurrentProject())) return "Open cancelled.";

  const message = await openDesktopFile(await desktop.readProject(path));
  await refreshDesktopSettings();
  return message;
}

export async function saveToBrowser(quiet = false): Promise<string> {
  // An explicit save is the user saying this is the project they want kept.
  autosaveAllowed = true;
  const saved = currentRevision();
  const { project, session } = snapshot();
  await saveProjectSlot(AUTOSAVE_SLOT, project, session);
  markSaved(saved);
  webProject.markSaved();
  if (quiet !== true) notifySaved();
  return `Saved "${project.projectName}".`;
}

export async function loadFromBrowser(): Promise<string> {
  stopTransport();

  const record = await loadProjectSlot(AUTOSAVE_SLOT);
  if (!record) return "No saved project found in this browser.";

  const { project, session } = migrateProject({
    project: record.project,
    session: record.session,
    schemaVersion: record.project.schemaVersion
  });

  await whileSwitching(async () => {
    await restoreSamples(decodingContext());

    useProjectStore.getState().hydrate(project);
    useSessionStore.getState().applySession(session);
    markSaved();
    webProject.markSaved();
  });

  notifySwitched();
  return `Loaded "${project.projectName}".`;
}

/** Start fresh. On the desktop the new project gets its own file on first save. */
export function newProject(): string {
  stopTransport();
  useProjectStore.getState().reset();

  const project = getProjectData(useProjectStore.getState());
  useSessionStore.getState().applySession({
    selectedPatternId: project.patternOrder[0],
    selectedChannelId: project.channels[0]?.id ?? null,
    mode: "song"
  });

  useFileStore.getState().setFile(null, null);
  useFileStore.getState().setSaveState("saved");
  markSaved();
  if (!getDesktop()) webProject.replace(false);
  updateTitle();
  notifySwitched();
  return "Started a new project.";
}

export async function saveProjectToFile(): Promise<string> {
  const saved = currentRevision();
  const { project, session } = snapshot();
  await downloadProjectFile(project, session);
  markSaved(saved);
  return "Project downloaded as a .pulsegrid file — it opens in the web studio and the desktop app.";
}

export async function openProjectFromFile(file: File): Promise<string> {
  stopTransport();

  const raw = await readProjectFile(file);
  const { project, session, assets } = migrateProject(raw);

  await whileSwitching(async () => {
    await registerProjectAssets(assets, decodingContext());
    await restoreSamples(decodingContext());

    useProjectStore.getState().hydrate(project);
    useSessionStore.getState().applySession(session);
    useFileStore.getState().setFile(null, null);
    markSaved();
    if (!getDesktop()) webProject.replace(false);
    updateTitle();
  });

  notifySwitched();
  return `Opened ${file.name}.`;
}

/** A demo is always a new, unsaved project — it never overwrites a file. */
export function loadPreset(presetId: string): string {
  stopTransport();

  const loaded = useProjectStore.getState().loadPresetProject(presetId);
  if (!loaded) return "That preset is unavailable.";

  const project = getProjectData(useProjectStore.getState());
  const preset = presetProjects.find((entry) => entry.id === presetId);

  useSessionStore.getState().applySession({
    selectedPatternId: project.patternOrder[0],
    selectedChannelId: project.channels[0]?.id ?? null,
    mode: "song"
  });

  useFileStore.getState().setFile(null, null);
  useFileStore.getState().setSaveState("saved");
  markSaved();
  if (!getDesktop()) webProject.replace(false);
  updateTitle();
  notifySwitched();
  return `Loaded "${preset?.name ?? presetId}".`;
}

export async function renderAudio(
  options: Partial<ExportOptions>,
  onProgress?: ExportProgressCallback
): Promise<string> {
  ensureAudio();

  const project = getProjectData(useProjectStore.getState());
  const session = useSessionStore.getState();

  const savedTo = await exportProject(
    project,
    { selectedPatternId: session.selectedPatternId, ...options },
    onProgress
  );

  return savedTo
    ? `Exported to ${savedTo}`
    : `Exported ${options.filename ?? "pulsegrid"}.${options.format ?? "wav"}`;
}

/* ─────────────────────────── autosave + dirty flag ─────────────────────────── */

let dirty = false;
let autosaveTimer: number | null = null;
let teardown: (() => void) | null = null;

/**
 * Bumped by every project edit. A save captures the revision it is writing and
 * only clears the dirty flag if nothing has changed since — otherwise an edit
 * made *during* an in-flight save would be marked clean, and closing within
 * the autosave interval would lose it with no warning.
 */
let revision = 0;

export function isDirty(): boolean {
  return dirty;
}

function currentRevision(): number {
  return revision;
}

function markSaved(savedRevision: number = revision): void {
  if (savedRevision !== revision) return;
  dirty = false;
}

/**
 * Save shortly after edits stop, and make sure nothing is lost on close.
 *
 * Desktop: writes the project's own file (or creates one in the save folder),
 * and intercepts closing the window to write a last save — or, with auto-save
 * off, to ask. Browser: writes the IndexedDB working copy and warns before
 * leaving the page with unsaved work.
 */
export function initAutosave(intervalMs = 3000): () => void {
  if (teardown) return teardown;

  const desktop = getDesktop();

  const unsubscribe = useProjectStore.subscribe((state, previous) => {
    dirty = true;
    revision += 1;

    if (desktop) {
      useFileStore.getState().setSaveState("unsaved");
      if (state.projectName !== previous.projectName || revision === 1) updateTitle();
    }

    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);

    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      // Loading a project also touches the store; that alone is not an edit.
      if (!dirty) return;
      // Never clobber a project we failed to read back.
      if (!autosaveAllowed) return;

      if (desktop) {
        updateTitle();
        if (useFileStore.getState().settings?.autosave === false) return;
        void writeToDisk().catch((error: unknown) => console.error("PulseGrid: auto-save failed", error));
        return;
      }

      void saveToBrowser().catch(() => {
        // Storage can be unavailable (private mode, quota). The beforeunload
        // guard still protects the user in that case.
      });
    }, intervalMs);
  });

  const cleanups: Array<() => void> = [unsubscribe];

  if (desktop) {
    cleanups.push(
      desktop.onCloseRequested(() => {
        if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
        void settleCurrentProject().then((proceed) => {
          if (proceed) desktop.closeNow();
        });
      }),
      desktop.onOpenFile((file) => {
        void settleCurrentProject()
          .then((proceed) => (proceed ? openDesktopFile(file) : null))
          .then(() => refreshDesktopSettings())
          .catch((error: unknown) => console.error("PulseGrid: could not open file", error));
      })
    );
  } else {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    cleanups.push(() => window.removeEventListener("beforeunload", onBeforeUnload));
  }

  teardown = () => {
    for (const cleanup of cleanups) cleanup();
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
    teardown = null;
  };

  return teardown;
}

/**
 * True once we know it is safe to write over the autosave slot.
 *
 * If restoring throws — a corrupt record, storage briefly unavailable — the app
 * comes up holding a *default* project. Autosaving that four seconds later
 * would destroy the user's real work with no way back, so a failed restore
 * disables autosave until they save deliberately.
 */
let autosaveAllowed = false;

export function isAutosaveAllowed(): boolean {
  return autosaveAllowed;
}

/**
 * Bring back where the user left off.
 *
 * Desktop: a project double-clicked in Explorer, else the last project that
 * was open, else (first launch after the browser-storage versions) whatever
 * was in the old IndexedDB working copy. A failed read leaves a new project
 * with no file, so auto-save creates a fresh file rather than overwriting.
 */
export async function restoreAutosave(): Promise<string | null> {
  const desktop = getDesktop();

  if (desktop) {
    autosaveAllowed = true;
    await refreshDesktopSettings();
    updateTitle();

    try {
      const launch = await desktop.takeLaunchFile();
      if (launch) {
        await openDesktopFile(launch);
        return launch.name;
      }

      const last = useFileStore.getState().settings?.lastProject;
      if (last) {
        const file = await desktop.readProject(last);
        await openDesktopFile(file);
        return file.name;
      }
    } catch (error) {
      console.error("PulseGrid: could not reopen the last project", error);
      return null;
    }

    return restoreBrowserSlot(true);
  }

  return restoreBrowserSlot(false);
}

function hasContent(project: ReturnType<typeof getProjectData>): boolean {
  if (project.playlist.clips.length > 0) return true;
  return Object.values(project.patterns).some((pattern) =>
    Object.values(pattern.channels).some(
      (lane) => lane.notes.length > 0 || lane.steps.some((cell) => cell !== null)
    )
  );
}

async function restoreBrowserSlot(adoptIntoDesktop: boolean): Promise<string | null> {
  try {
    const record = await loadProjectSlot(AUTOSAVE_SLOT);

    if (!record) {
      // Nothing stored yet: a brand new project is safe to autosave.
      autosaveAllowed = true;
      return null;
    }

    const { project, session } = migrateProject({
      project: record.project,
      session: record.session
    });

    await whileSwitching(async () => {
      await restoreSamples(decodingContext());

      useProjectStore.getState().hydrate(project);
      useSessionStore.getState().applySession(session);
      markSaved();
      webProject.markSaved();
    });

    autosaveAllowed = true;
    notifySwitched();

    // Work from before the desktop app kept files: give it a file right away.
    // An empty leftover is not worth a file in the save folder.
    if (adoptIntoDesktop && hasContent(project)) void writeToDisk().catch(() => undefined);

    updateTitle();
    return project.projectName;
  } catch (error) {
    console.error("PulseGrid: could not restore the autosave", error);
    return null;
  }
}

/* ───────────────────────────── cloud sync hooks ───────────────────────────── */

/** >0 while a project is being opened: nothing read from the editor then is safe to upload. */
let switching = 0;

async function whileSwitching<T>(work: () => Promise<T>): Promise<T> {
  switching += 1;
  try {
    return await work();
  } finally {
    switching -= 1;
  }
}

/** Which project the web studio's single working copy is; see sync/webIdentity.ts. */
const webProject = createWebIdentity();

/** Replace the open project with a file the cloud just handed over, and keep it on this device. */
async function applyCloudText(text: string): Promise<void> {
  await whileSwitching(async () => {
    stopTransport();
    await loadProjectText(text);
    updateTitle();

    // Stored here without that counting as an edit to upload again.
    if (getDesktop()) await writeToDisk(true);
    else await saveToBrowser(true);
  });
}

setStudioAdapter({
  key: () => {
    if (getDesktop()) return useFileStore.getState().path?.toLowerCase() ?? null;
    return webProject.key();
  },
  path: () => (getDesktop() ? useFileStore.getState().path : null),
  name: () => useProjectStore.getState().projectName,
  text: projectFileText,
  revision: currentRevision,
  isDirty: () => dirty,
  busy: () => switching > 0,
  apply: applyCloudText,
  openPath: getDesktop() ? (path) => openProjectAt(path) : null,

  async importCloud(text, name, linkTo) {
    const desktop = getDesktop();

    if (desktop) {
      const target = await desktop.newProjectPath(name);
      const written = await desktop.writeProject(target, text);
      linkTo(written.path.toLowerCase(), written.path);
      return openProjectAt(written.path);
    }

    await whileSwitching(async () => {
      stopTransport();
      linkTo(webProject.replace(true), null);
      await loadProjectText(text);
      useFileStore.getState().setFile(null, null);
      updateTitle();
      await saveToBrowser(true);
    });

    notifySwitched();
    return `Opened "${name}" from your cloud.`;
  }
});
