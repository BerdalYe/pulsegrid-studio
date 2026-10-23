/**
 * VST3 plugins (Windows): starts the plugin bridge (pluginBridge.cjs) in a utility process of its own the first time
 * the studio asks for it, and hands the studio page two ports straight to it: one for requests and notes, one for its
 * audio thread. Nothing here is on the sound's path.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, utilityProcess } = require("electron");

let bridge = null;

/** The plugin host program: packed next to the app, or freshly built during development. */
function hostPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "plugin-host", "pulsegrid-plugin-host.exe")
    : path.join(__dirname, "..", "native", "plugin-host", "bin", "pulsegrid-plugin-host.exe");
}

function pluginsAvailable() {
  return process.platform === "win32" && fs.existsSync(hostPath());
}

function startBridge() {
  if (bridge) return bridge;
  bridge = utilityProcess.fork(path.join(__dirname, "pluginBridge.cjs"), [], { serviceName: "PulseGrid plugins" });
  // Only for testing: extra folders to look for plugins in (development builds read it; it is never set otherwise).
  const extraFolders = (process.env.PULSEGRID_PLUGIN_FOLDERS || "").split(";").map((folder) => folder.trim()).filter(Boolean);
  bridge.postMessage({ type: "init", exePath: hostPath(), cacheFile: path.join(app.getPath("userData"), "plugins.json"), extraFolders });
  bridge.on("exit", () => {
    bridge = null;
  });
  return bridge;
}

function registerPluginHandlers() {
  ipcMain.handle("plugins:available", () => pluginsAvailable());

  ipcMain.handle("plugins:choose-folder", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, { title: "A folder with VST3 plugins", properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.on("plugins:connect", (event) => {
    if (!pluginsAvailable()) return;
    const studio = new MessageChannelMain();
    const audio = new MessageChannelMain();
    // The studio's window, so plugin windows can keep to it (above it while it's in use, hidden while it's minimised).
    const handle = BrowserWindow.fromWebContents(event.sender)?.getNativeWindowHandle();
    const studioWindow = handle && handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : "";
    startBridge().postMessage({ type: "ports", studioWindow }, [studio.port1, audio.port1]);
    event.sender.postMessage("plugins:ports", null, [studio.port2, audio.port2]);
  });

  app.on("will-quit", () => {
    bridge?.kill();
    bridge = null;
  });
}

module.exports = { registerPluginHandlers };
