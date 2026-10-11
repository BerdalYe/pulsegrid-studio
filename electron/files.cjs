/**
 * Project files on disk: the save folder, recent files, auto-save writes,
 * backups and audio exports.
 *
 * Layout inside the save folder (default Documents\PulseGrid Studio):
 *
 *   My Song.pulsegrid          projects, one self-contained JSON file each
 *   Exports\My Song.wav        rendered audio
 *   Backups\My Song\…          rolling copies, newest ten kept per project
 */
const { app, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const EXTENSION = ".pulsegrid";
const MAX_RECENT = 10;
const BACKUPS_KEPT = 10;
/** A backup at most this often per project, however often it auto-saves. */
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;

/* ─────────────────────────────── settings ─────────────────────────────── */

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function defaultSaveFolder() {
  return process.env.PULSEGRID_SAVE_DIR || path.join(app.getPath("documents"), "PulseGrid Studio");
}

let settings = null;

function loadSettings() {
  if (settings) return settings;

  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    /* first run, or unreadable — start from defaults */
  }

  settings = {
    saveFolder: typeof stored.saveFolder === "string" && stored.saveFolder ? stored.saveFolder : defaultSaveFolder(),
    autosave: stored.autosave !== false,
    checkUpdates: stored.checkUpdates !== false,
    recent: Array.isArray(stored.recent) ? stored.recent.filter((entry) => typeof entry === "string") : [],
    lastProject: typeof stored.lastProject === "string" ? stored.lastProject : null
  };

  return settings;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error("PulseGrid: could not store settings", error);
  }
}

function exportsFolder() {
  return path.join(loadSettings().saveFolder, "Exports");
}

function ensureFolders() {
  fs.mkdirSync(loadSettings().saveFolder, { recursive: true });
  fs.mkdirSync(exportsFolder(), { recursive: true });
}

function remember(file) {
  const current = loadSettings();
  current.recent = [file, ...current.recent.filter((entry) => entry.toLowerCase() !== file.toLowerCase())].slice(
    0,
    MAX_RECENT
  );
  current.lastProject = file;
  saveSettings();
}

function publicSettings() {
  const current = loadSettings();
  return {
    saveFolder: current.saveFolder,
    exportsFolder: exportsFolder(),
    autosave: current.autosave,
    checkUpdates: current.checkUpdates,
    recent: current.recent
      .filter((file) => fs.existsSync(file))
      .map((file) => ({ path: file, name: path.basename(file, EXTENSION) })),
    lastProject: current.lastProject && fs.existsSync(current.lastProject) ? current.lastProject : null
  };
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

/** Characters Windows won't allow in a file name, plus trailing dots and spaces. */
function safeName(name, fallback = "Untitled Project") {
  const cleaned = String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function uniquePath(folder, base, extension) {
  let candidate = path.join(folder, `${base}${extension}`);
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = path.join(folder, `${base} (${n})${extension}`);
  }
  return candidate;
}

/** Only ever touch project files — never an arbitrary path the page names. */
function assertProjectPath(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Not a project path.");
  const extension = path.extname(file).toLowerCase();
  if (extension !== EXTENSION && extension !== ".json") throw new Error("Not a PulseGrid project file.");
  return path.normalize(file);
}

/**
 * Write via a temporary file and a rename, so a crash or power cut mid-save
 * leaves the previous version intact instead of a half-written project.
 */
async function writeAtomic(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, contents, "utf8");
  try {
    await fsp.rename(temporary, file);
  } catch {
    // Windows refuses to rename over a file another program has open (an
    // antivirus scan, a sync client). Fall back to a direct write.
    await fsp.writeFile(file, contents, "utf8");
    await fsp.rm(temporary, { force: true });
  }
}

async function readProjectFile(file) {
  const target = assertProjectPath(file);
  const [contents, stat] = await Promise.all([fsp.readFile(target, "utf8"), fsp.stat(target)]);
  remember(target);
  return { path: target, name: path.basename(target, path.extname(target)), contents, modified: stat.mtimeMs };
}

const lastBackup = new Map();

async function backupProject(file, contents) {
  const target = assertProjectPath(file);
  const now = Date.now();
  if (now - (lastBackup.get(target) ?? 0) < BACKUP_INTERVAL_MS) return false;
  lastBackup.set(target, now);

  const base = path.basename(target, path.extname(target));
  const folder = path.join(loadSettings().saveFolder, "Backups", safeName(base));
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);

  await writeAtomic(path.join(folder, `${base} ${stamp}${EXTENSION}`), contents);

  // Keep the newest few; older ones only take up space.
  const existing = (await fsp.readdir(folder)).filter((entry) => entry.endsWith(EXTENSION)).sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - BACKUPS_KEPT))) {
    await fsp.rm(path.join(folder, old), { force: true });
  }

  return true;
}

/* ───────────────────────────── launch file ───────────────────────────── */

/** A project path handed to us on the command line (double-click in Explorer). */
function projectFromArgs(argv) {
  return (
    argv.slice(1).find((arg) => !arg.startsWith("-") && path.extname(arg).toLowerCase() === EXTENSION && fs.existsSync(arg)) ??
    null
  );
}

let launchFile = null;

function setLaunchFile(argv) {
  launchFile = projectFromArgs(argv);
}

/* ─────────────────────────────── IPC ─────────────────────────────── */

function registerFileHandlers(getWindow) {
  ensureFolders();

  ipcMain.handle("settings:get", () => publicSettings());

  ipcMain.handle("settings:autosave", (_event, enabled) => {
    loadSettings().autosave = Boolean(enabled);
    saveSettings();
    return publicSettings();
  });

  ipcMain.handle("settings:choose-folder", async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: "Choose where PulseGrid saves your projects",
      defaultPath: loadSettings().saveFolder,
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;

    loadSettings().saveFolder = result.filePaths[0];
    saveSettings();
    ensureFolders();
    return publicSettings();
  });

  ipcMain.handle("folder:open", async (_event, which) => {
    ensureFolders();
    const folder = which === "exports" ? exportsFolder() : loadSettings().saveFolder;
    const error = await shell.openPath(folder);
    return error || null;
  });

  ipcMain.handle("project:list", async () => {
    ensureFolders();
    const folder = loadSettings().saveFolder;
    const entries = await fsp.readdir(folder, { withFileTypes: true });

    const projects = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== EXTENSION) continue;
      const file = path.join(folder, entry.name);
      const stat = await fsp.stat(file);
      projects.push({ path: file, name: path.basename(entry.name, EXTENSION), modified: stat.mtimeMs, size: stat.size });
    }

    return projects.sort((a, b) => b.modified - a.modified);
  });

  ipcMain.handle("project:new-path", (_event, name) => {
    ensureFolders();
    return uniquePath(loadSettings().saveFolder, safeName(name), EXTENSION);
  });

  ipcMain.handle("project:write", async (_event, file, contents) => {
    const target = assertProjectPath(file);
    await writeAtomic(target, String(contents));
    remember(target);
    return { path: target, name: path.basename(target, path.extname(target)), savedAt: Date.now() };
  });

  ipcMain.handle("project:save-as", async (_event, suggestedName, contents) => {
    ensureFolders();
    const result = await dialog.showSaveDialog(getWindow(), {
      title: "Save project as",
      defaultPath: path.join(loadSettings().saveFolder, `${safeName(suggestedName)}${EXTENSION}`),
      filters: [{ name: "PulseGrid project", extensions: ["pulsegrid"] }]
    });
    if (result.canceled || !result.filePath) return null;

    const target = result.filePath.toLowerCase().endsWith(EXTENSION) ? result.filePath : `${result.filePath}${EXTENSION}`;
    await writeAtomic(target, String(contents));
    remember(target);
    return { path: target, name: path.basename(target, EXTENSION), savedAt: Date.now() };
  });

  ipcMain.handle("project:open-dialog", async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: "Open project",
      defaultPath: loadSettings().saveFolder,
      properties: ["openFile"],
      filters: [{ name: "PulseGrid project", extensions: ["pulsegrid", "json"] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readProjectFile(result.filePaths[0]);
  });

  ipcMain.handle("project:read", (_event, file) => readProjectFile(file));

  ipcMain.handle("project:backup", (_event, file, contents) => backupProject(file, String(contents)));

  // Delete a project from the save folder: it goes to the Recycle Bin (or the Mac's Bin), so it can be got back.
  // Only .pulsegrid files inside the save folder, the ones the studio lists.
  ipcMain.handle("project:delete", async (_event, file) => {
    const target = assertProjectPath(file);
    if (path.extname(target).toLowerCase() !== EXTENSION) throw new Error("Only PulseGrid projects can be deleted here.");
    const folder = path.resolve(loadSettings().saveFolder).toLowerCase();
    const parent = path.dirname(path.resolve(target)).toLowerCase();
    if (parent !== folder) throw new Error("Only projects in the save folder can be deleted here.");
    if (!fs.existsSync(target)) return false;

    await shell.trashItem(target);

    const current = loadSettings();
    current.recent = current.recent.filter((entry) => entry.toLowerCase() !== target.toLowerCase());
    if (current.lastProject && current.lastProject.toLowerCase() === target.toLowerCase()) current.lastProject = null;
    saveSettings();
    return true;
  });

  ipcMain.handle("project:reveal", (_event, file) => {
    shell.showItemInFolder(assertProjectPath(file));
  });

  ipcMain.handle("project:take-launch-file", async () => {
    const file = launchFile;
    launchFile = null;
    return file ? readProjectFile(file) : null;
  });

  ipcMain.handle("export:save", async (_event, filename, bytes) => {
    ensureFolders();
    const extension = path.extname(String(filename)).toLowerCase();
    if (![".wav", ".mp3"].includes(extension)) throw new Error("Only WAV and MP3 exports can be saved.");

    const base = safeName(path.basename(String(filename), extension), "Export");
    const target = uniquePath(exportsFolder(), base, extension);
    await fsp.writeFile(target, Buffer.from(bytes));
    shell.showItemInFolder(target);
    return target;
  });
}

function setCheckUpdates(enabled) {
  loadSettings().checkUpdates = enabled;
  saveSettings();
}

module.exports = {
  registerFileHandlers,
  setLaunchFile,
  projectFromArgs,
  readProjectFile,
  loadSettings,
  setCheckUpdates,
  EXTENSION
};
