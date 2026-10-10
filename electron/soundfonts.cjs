/**
 * SoundFonts a person has added, kept as files in the app's own data folder so
 * they are still there next time and projects can find them again. Nothing
 * here is ever sent anywhere. The page can only ask for them by id, and an id
 * is only ever the short name this file hands out.
 */
const { app, ipcMain } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** Ids the studio makes: "user-" and sixteen hex digits. Anything else is refused. */
const ID = /^user-[a-f0-9]{16}$/;
/** A SoundFont larger than this would not fit in memory next to everything else. */
const MAX_BYTES = 1024 * 1024 * 1024;

function folder() {
  return path.join(app.getPath("userData"), "soundfonts");
}

function fileFor(id) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("Not a SoundFont id.");
  return { sf2: path.join(folder(), `${id}.sf2`), info: path.join(folder(), `${id}.json`) };
}

function registerSoundFontHandlers() {
  ipcMain.handle("soundfont:list", async () => {
    try {
      const names = await fsp.readdir(folder());
      const out = [];
      for (const name of names) {
        const id = name.replace(/\.json$/, "");
        if (!name.endsWith(".json") || !ID.test(id)) continue;
        try {
          const info = JSON.parse(await fsp.readFile(path.join(folder(), name), "utf8"));
          const stat = await fsp.stat(path.join(folder(), `${id}.sf2`));
          out.push({ id, name: String(info.name || id).slice(0, 120), size: stat.size });
        } catch {
          /* half-written or damaged: leave it out */
        }
      }
      return out;
    } catch {
      return [];
    }
  });

  ipcMain.handle("soundfont:read", async (_event, id) => {
    try {
      const buffer = await fsp.readFile(fileFor(id).sf2);
      // Hand over exactly this file's bytes, not a slice of a shared pool.
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch {
      return null;
    }
  });

  ipcMain.handle("soundfont:write", async (_event, id, name, bytes) => {
    const files = fileFor(id);
    const data = Buffer.from(bytes);
    if (data.length > MAX_BYTES) throw new Error("That SoundFont is too big (over 1 GB).");
    if (data.length < 12 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "sfbk") {
      throw new Error("That isn't a SoundFont (.sf2) file.");
    }

    await fsp.mkdir(folder(), { recursive: true });
    await fsp.writeFile(files.sf2, data);
    await fsp.writeFile(files.info, JSON.stringify({ name: String(name || id).slice(0, 120) }));
  });

  ipcMain.handle("soundfont:remove", async (_event, id) => {
    const files = fileFor(id);
    await fsp.rm(files.sf2, { force: true });
    await fsp.rm(files.info, { force: true });
  });
}

module.exports = { registerSoundFontHandlers };
