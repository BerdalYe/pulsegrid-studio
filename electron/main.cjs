/**
 * PulseGrid Studio as a desktop app.
 *
 * The studio is the same web build that runs in the browser. It is served from
 * a private `app://` scheme rather than `file://`, because under `file://`
 * every page has an opaque origin: module Web Workers (the scheduler clock and
 * the MP3 encoder) refuse to load, and browser storage is not reliably kept
 * between launches. Projects themselves are real files: see files.cjs.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  loadSettings,
  projectFromArgs,
  readProjectFile,
  registerFileHandlers,
  setCheckUpdates,
  setLaunchFile
} = require("./files.cjs");
const { registerUpdates } = require("./updates.cjs");
const { registerSoundFontHandlers } = require("./soundfonts.cjs");
const { authUrlFromArgs, deliverAuthUrl, registerAuthHandlers, registerProtocol, setLaunchAuthUrl } = require("./auth.cjs");

// A MIDI keyboard should make sound the moment it's played, before any click
// in the window — which the browser autoplay rule would otherwise require.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Tests and screenshots run against a throwaway profile, never your own.
if (process.env.PULSEGRID_USER_DATA) app.setPath("userData", process.env.PULSEGRID_USER_DATA);

const SCHEME = "app";
const HOST = "pulsegrid";
const DIST = path.join(__dirname, "..", "dist");
/** Files that ship with the app but are too big to belong in the website's build (the built-in SoundFont). */
const ASSETS = path.join(__dirname, "..", "assets");

/** Set by `npm run app:dev` to load the Vite dev server instead of the build. */
const DEV_URL = process.env.PULSEGRID_DEV_URL;

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
  }
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm"
};

function serveBuild() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let relative = decodeURIComponent(url.pathname);
    if (relative === "/" || relative === "") relative = "/index.html";

    // The built-in instruments: /soundfonts/<name>.sf2, from the app's own assets folder.
    const soundfont = /^\/soundfonts\/([A-Za-z0-9._-]+\.sf2)$/.exec(relative);
    if (soundfont) {
      const sf2 = path.join(ASSETS, "soundfonts", soundfont[1]);
      if (!fs.existsSync(sf2)) return new Response("Not found", { status: 404 });
      const stream = await net.fetch(pathToFileURL(sf2).toString());
      return new Response(stream.body, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }

    const file = path.normalize(path.join(DIST, relative));

    // Never serve anything outside the build folder.
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file)) {
      return new Response("Not found", { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(file).toString());
    const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

    // Module workers are refused unless they arrive with a JavaScript type.
    return new Response(response.body, { status: 200, headers: { "content-type": type } });
  });
}

/** Microphone recording and MIDI keyboards need these; nothing else is granted. */
const ALLOWED_PERMISSIONS = new Set(["media", "midi", "midiSysex", "clipboard-sanitized-write", "fullscreen"]);

function grantStudioPermissions() {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );

  // Anything still downloaded the web way (a sample, an old code path): ask
  // where to save it rather than dropping it in Downloads unannounced.
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({
      title: "Save",
      defaultPath: path.join(app.getPath("documents"), item.getFilename())
    });
  });
}

/* ─────────────────────────── closing the window ─────────────────────────── */

/**
 * Closing asks the page first, so it can write a final auto-save or offer to
 * save. The page answers with `closeNow`, which destroys the window without
 * running `beforeunload` a second time.
 */
let closeApproved = false;

function guardClose(window) {
  window.on("close", (event) => {
    if (closeApproved) return;

    const contents = window.webContents;
    // A crashed or still-loading page can't answer; don't trap the user.
    if (contents.isCrashed() || contents.isLoading()) return;

    event.preventDefault();
    contents.send("window:close-requested");
  });
}

ipcMain.on("window:close-now", () => {
  closeApproved = true;
  mainWindow?.destroy();
});

ipcMain.on("window:title", (_event, title) => {
  if (typeof title === "string") mainWindow?.setTitle(title.slice(0, 200));
});

// What the app is using of the computer, for the performance readout in the top bar: CPU as a share of one
// core (100 = one core fully busy, the way most music software counts it), and memory in megabytes, summed
// over every process the app runs.
ipcMain.handle("app:metrics", () => {
  const metrics = app.getAppMetrics();
  const cores = Math.max(1, require("node:os").cpus().length);
  let cpu = 0;
  let memoryKB = 0;
  for (const entry of metrics) {
    cpu += entry.cpu?.percentCPUUsage ?? 0;
    memoryKB += entry.memory?.workingSetSize ?? 0;
  }
  return { cpu: Math.min(cores * 100, cpu), memoryMB: Math.round(memoryKB / 1024), cores };
});

ipcMain.handle("window:ask-save", async (_event, name) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "PulseGrid Studio",
    message: `Save changes to "${String(name ?? "Untitled Project")}" before closing?`,
    detail: "If you don't save, your changes since the last save will be lost.",
    buttons: ["Save", "Don't save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  return ["save", "discard", "cancel"][response] ?? "cancel";
});

let mainWindow = null;

function createWindow() {
  // Open at the full working area straight away, rather than at a fixed size
  // and maximising later: the studio sizes its windows to the space it first
  // gets, and a later jump would leave them short of the edges.
  const { workArea } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 1024,
    minHeight: 640,
    title: "PulseGrid Studio",
    backgroundColor: "#16161c",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep audio scheduling at full speed when the window is in the background.
      backgroundThrottling: false,
      // The spellchecker downloads dictionaries in the background; a music
      // studio has no use for it, and the app goes online only for the update
      // check (updates.cjs), which the user can switch off.
      spellcheck: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // Links open in the real browser; the studio window never navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith(`${SCHEME}://${HOST}/`);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  guardClose(mainWindow);

  // index.html is the website; the desktop app opens straight into the studio.
  void mainWindow.loadURL(DEV_URL ? new URL("studio.html", DEV_URL).toString() : `${SCHEME}://${HOST}/studio.html`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// One studio at a time: a second launch brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A double-clicked .pulsegrid file while the studio is already open.
  app.on("second-instance", (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();

    // A pulsegrid://auth link: the browser sending someone back after signing in with Discord.
    deliverAuthUrl(mainWindow, authUrlFromArgs(argv));

    const file = projectFromArgs(argv);
    if (file) {
      void readProjectFile(file)
        .then((project) => mainWindow?.webContents.send("project:open-file", project))
        .catch((error) => console.error("PulseGrid: could not open", file, error));
    }
  });

  setLaunchFile(process.argv);
  setLaunchAuthUrl(process.argv);
  registerProtocol();

  // macOS hands over a double-clicked project and the sign-in link as events,
  // not as launch arguments, and they can arrive before the window exists.
  app.on("open-file", (event, file) => {
    event.preventDefault();
    if (!mainWindow) {
      setLaunchFile(["", file]);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    void readProjectFile(file)
      .then((project) => mainWindow?.webContents.send("project:open-file", project))
      .catch((error) => console.error("PulseGrid: could not open", file, error));
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (!mainWindow) {
      setLaunchAuthUrl(["", url]);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    deliverAuthUrl(mainWindow, url);
  });

  app.whenReady().then(() => {
    // The studio has its own menu bar, so Electron's default one only gets in the
    // way. A Mac still needs a minimal one: it carries Quit (⌘Q) and the edit
    // commands (⌘C, ⌘V) that make text fields work.
    Menu.setApplicationMenu(
      process.platform === "darwin"
        ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
        : null
    );
    serveBuild();
    grantStudioPermissions();
    registerFileHandlers(() => mainWindow);
    registerAuthHandlers();
    registerSoundFontHandlers();
    registerUpdates({
      getWindow: () => mainWindow,
      getSettings: loadSettings,
      setCheckUpdates,
      approveClose: () => {
        closeApproved = true;
      }
    });
    createWindow();
  });

  // The page keeps the cloud login in its storage, which is normally written out
  // a moment after each change. Make sure the latest of it is on disk before quitting.
  app.on("before-quit", () => {
    try {
      session.defaultSession.flushStorageData();
    } catch {
      /* nothing to flush */
    }
  });

  app.on("window-all-closed", () => app.quit());
}
