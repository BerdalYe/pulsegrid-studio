import { create } from "zustand";

import { downloadBlob } from "../lib/utils";

/**
 * The desktop app's file system, exposed by `electron/preload.cjs`. Absent in
 * the browser, where projects live in IndexedDB instead.
 */
export interface DesktopProjectRef {
  path: string;
  name: string;
}

export interface DesktopProjectFile extends DesktopProjectRef {
  contents: string;
  /** Last modified, epoch ms. */
  modified?: number;
}

export interface DesktopProjectEntry extends DesktopProjectRef {
  modified: number;
  size: number;
}

export interface DesktopSettings {
  saveFolder: string;
  exportsFolder: string;
  autosave: boolean;
  checkUpdates: boolean;
  recent: DesktopProjectRef[];
  lastProject: string | null;
}

export type UpdateState =
  | "unavailable"
  | "idle"
  | "checking"
  | "current"
  | "downloading"
  | "ready"
  /** A newer version exists, but this system installs updates by hand (a Mac). */
  | "available"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** The newer version, once one is found. */
  version: string | null;
  percent: number;
  message: string;
  /** Only on get / set-enabled: the user's setting, and whether this build has an update address. */
  enabled?: boolean;
  configured?: boolean;
}

export interface DesktopBridge {
  platform: string;
  getSettings(): Promise<DesktopSettings>;
  setAutosave(enabled: boolean): Promise<DesktopSettings>;
  chooseSaveFolder(): Promise<DesktopSettings | null>;
  openSaveFolder(which: "projects" | "exports"): Promise<string | null>;
  listProjects(): Promise<DesktopProjectEntry[]>;
  newProjectPath(name: string): Promise<string>;
  writeProject(path: string, contents: string): Promise<DesktopProjectRef & { savedAt: number }>;
  saveProjectAs(
    suggestedName: string,
    contents: string
  ): Promise<(DesktopProjectRef & { savedAt: number }) | null>;
  openProjectDialog(): Promise<DesktopProjectFile | null>;
  readProject(path: string): Promise<DesktopProjectFile>;
  backupProject(path: string, contents: string): Promise<boolean>;
  revealProject(path: string): Promise<void>;
  takeLaunchFile(): Promise<DesktopProjectFile | null>;
  /** Open a secure web address (the Discord sign-in page) in the person's own browser. */
  openExternal(url: string): Promise<void>;
  /** A pulsegrid://auth link that started the app, if there was one. */
  takeAuthUrl(): Promise<string | null>;
  saveExport(filename: string, bytes: ArrayBuffer): Promise<string>;
  setTitle(title: string): void;
  askSaveChanges(name: string): Promise<"save" | "discard" | "cancel">;
  closeNow(): void;
  getUpdateStatus(): Promise<UpdateStatus>;
  setCheckUpdates(enabled: boolean): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<boolean>;
  onOpenFile(callback: (file: DesktopProjectFile) => void): () => void;
  onAuthCallback(callback: (url: string) => void): () => void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  onCloseRequested(callback: () => void): () => void;
}

declare global {
  interface Window {
    pulsegridDesktop?: DesktopBridge;
  }
}

export function getDesktop(): DesktopBridge | null {
  return typeof window !== "undefined" ? window.pulsegridDesktop ?? null : null;
}

export function isDesktop(): boolean {
  return getDesktop() !== null;
}

/* ─────────────────────────── open-file state ─────────────────────────── */

export type SaveState = "saved" | "unsaved" | "saving" | "error";

interface FileState {
  /** The project file on disk, or null for one that has never been saved. */
  path: string | null;
  fileName: string | null;
  saveState: SaveState;
  lastSavedAt: number | null;
  /** Mirrors the desktop settings, so menus and panels can render them. */
  settings: DesktopSettings | null;
  /** Bumped whenever the save folder's contents may have changed. */
  folderVersion: number;

  setFile(path: string | null, fileName: string | null): void;
  setSaveState(state: SaveState, savedAt?: number): void;
  setSettings(settings: DesktopSettings): void;
  touchFolder(): void;
}

export const useFileStore = create<FileState>()((set) => ({
  path: null,
  fileName: null,
  saveState: "saved",
  lastSavedAt: null,
  settings: null,
  folderVersion: 0,

  setFile: (path, fileName) => set({ path, fileName }),
  setSaveState: (saveState, savedAt) =>
    set((state) => ({ saveState, lastSavedAt: savedAt ?? state.lastSavedAt })),
  setSettings: (settings) => set({ settings }),
  touchFolder: () => set((state) => ({ folderVersion: state.folderVersion + 1 }))
}));

/* ─────────────────────────────── exports ─────────────────────────────── */

/**
 * Hand a rendered file to the user: straight into the Exports folder on the
 * desktop, a normal download in the browser. Returns where it went, if known.
 */
export async function deliverExport(blob: Blob, filename: string): Promise<string | null> {
  const desktop = getDesktop();
  if (!desktop) {
    downloadBlob(blob, filename);
    return null;
  }

  return desktop.saveExport(filename, await blob.arrayBuffer());
}
