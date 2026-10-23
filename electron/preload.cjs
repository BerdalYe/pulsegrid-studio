/**
 * The only door between the studio page and the computer. The page runs
 * sandboxed with no Node access; everything it may do on disk is one of the
 * named calls below, each handled (and checked) in the main process.
 */
const { contextBridge, ipcRenderer, webFrame } = require("electron");

const listen = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

ipcRenderer.on("plugins:ports", (event) => {
  // To this same window only; the page checks the message came from itself.
  window.postMessage("pulsegrid:plugin-ports", "*", event.ports);
});

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
  deleteProject: (path) => ipcRenderer.invoke("project:delete", path),
  takeLaunchFile: () => ipcRenderer.invoke("project:take-launch-file"),

  openExternal: (url) => ipcRenderer.invoke("auth:open-external", url),
  takeAuthUrl: () => ipcRenderer.invoke("auth:take-launch-url"),

  saveExport: (filename, bytes) => ipcRenderer.invoke("export:save", filename, bytes),

  soundfonts: {
    list: () => ipcRenderer.invoke("soundfont:list"),
    read: (id) => ipcRenderer.invoke("soundfont:read", id),
    write: (id, name, bytes) => ipcRenderer.invoke("soundfont:write", id, name, bytes),
    remove: (id) => ipcRenderer.invoke("soundfont:remove", id)
  },

  // The size of the whole interface, from the settings (1 is normal).
  setZoom: (factor) => {
    if (typeof factor === "number" && Number.isFinite(factor)) webFrame.setZoomFactor(Math.min(2, Math.max(0.5, factor)));
  },

  getMetrics: () => ipcRenderer.invoke("app:metrics"),

  // VST3 plugins (Windows): whether the plugin host is there, and a request for two ports to it. The ports arrive as
  // a window message, "pulsegrid:plugin-ports", since they can't cross into the page any other way.
  pluginsAvailable: () => ipcRenderer.invoke("plugins:available"),
  connectPlugins: () => ipcRenderer.send("plugins:connect"),
  choosePluginFolder: () => ipcRenderer.invoke("plugins:choose-folder"),

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
