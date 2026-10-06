/**
 * The only door between the studio page and the computer. The page runs
 * sandboxed with no Node access; everything it may do on disk is one of the
 * named calls below, each handled (and checked) in the main process.
 */
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("pulsegridDesktop", {
  platform: process.platform,

  getSettings: () => ipcRenderer.invoke("settings:get"),
  setAutosave: (enabled) => ipcRenderer.invoke("settings:autosave", enabled),
  chooseSaveFolder: () => ipcRenderer.invoke("settings:choose-folder"),
  openSaveFolder: (which) => ipcRenderer.invoke("folder:open", which),

  listProjects: () => ipcRenderer.invoke("project:list"),
  newProjectPath: (name) => ipcRenderer.invoke("project:new-path", name),
  writeProject: (path, contents) => ipcRenderer.invoke("project:write", path, contents),
  saveProjectAs: (suggestedName, contents) => ipcRenderer.invoke("project:save-as", suggestedName, contents),
  openProjectDialog: () => ipcRenderer.invoke("project:open-dialog"),
  readProject: (path) => ipcRenderer.invoke("project:read", path),
  backupProject: (path, contents) => ipcRenderer.invoke("project:backup", path, contents),
  revealProject: (path) => ipcRenderer.invoke("project:reveal", path),
  takeLaunchFile: () => ipcRenderer.invoke("project:take-launch-file"),

  openExternal: (url) => ipcRenderer.invoke("auth:open-external", url),
  takeAuthUrl: () => ipcRenderer.invoke("auth:take-launch-url"),

  saveExport: (filename, bytes) => ipcRenderer.invoke("export:save", filename, bytes),

  setTitle: (title) => ipcRenderer.send("window:title", title),
  askSaveChanges: (name) => ipcRenderer.invoke("window:ask-save", name),
  closeNow: () => ipcRenderer.send("window:close-now"),

  getUpdateStatus: () => ipcRenderer.invoke("update:get"),
  setCheckUpdates: (enabled) => ipcRenderer.invoke("update:set-enabled", enabled),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),

  onOpenFile: (callback) => listen("project:open-file", callback),
  onAuthCallback: (callback) => listen("auth:callback", callback),
  onUpdateStatus: (callback) => listen("update:status", callback),
  onCloseRequested: (callback) => listen("window:close-requested", callback)
});
