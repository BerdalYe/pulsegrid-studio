/**
 * Updates for the desktop app.
 *
 * The app asks the PulseGrid website for one small file, `latest.yml`, which
 * names the newest version and the installer's checksum. If there is a newer
 * version it downloads the installer (an .msi) in the background, checks it
 * against that checksum, and offers a "Restart to update" button; that closes
 * the app and runs the installer, which replaces the old version and starts the
 * new one. Nothing about the user or their projects is sent. The check can be
 * switched off from the Options menu, and without a network it just fails
 * quietly.
 *
 * Where to look is set once, in package.json → pulsegrid.updateUrl (the
 * website's /downloads/ folder). A build without it never checks.
 */
const { app, ipcMain, net, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const pkg = require("../package.json");
const { compareVersions, isAcceptableInstallerUrl, parseFeed } = require("./updateFeed.cjs");

/** First check a little after launch, so it never competes with loading a project. */
const FIRST_CHECK_DELAY = 15_000;
/** Then again every few hours for people who leave the studio open. */
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/** Tests run against a throwaway profile and a local stand-in for the website. */
const testing = () => Boolean(process.env.PULSEGRID_USER_DATA);

/** Only Windows installs updates by itself (an .msi); elsewhere the person is pointed to the download page. */
const platform = () => (testing() && process.env.PULSEGRID_UPDATE_PLATFORM) || process.platform;

function downloadPage() {
  const site = String(pkg.pulsegrid?.siteUrl || "").replace(/\/$/, "");
  return site ? `${site}/#download` : "";
}

function feedUrl() {
  const url = process.env.PULSEGRID_UPDATE_URL || pkg.pulsegrid?.updateUrl || "";
  return url && !url.endsWith("/") ? `${url}/` : url;
}

/** Where downloaded installers wait. */
function updatesFolder() {
  return path.join(app.getPath("userData"), "updates");
}

/** SHA-512 of a file, base64 (the form the feed uses). */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("base64")));
  });
}

async function removeOldDownloads(keep) {
  try {
    for (const name of await fsp.readdir(updatesFolder())) {
      if (name !== keep) await fsp.rm(path.join(updatesFolder(), name), { force: true });
    }
  } catch {
    /* nothing downloaded yet */
  }
}

/**
 * @param {object} options
 * @param {() => Electron.BrowserWindow | null} options.getWindow
 * @param {() => { checkUpdates: boolean }} options.getSettings
 * @param {(enabled: boolean) => void} options.setCheckUpdates
 * @param {() => void} options.approveClose  lets the window close without asking again
 */
function registerUpdates({ getWindow, getSettings, setCheckUpdates, approveClose }) {
  const url = feedUrl();

  /** What the page shows; sent again whenever it changes. */
  let status = { state: url ? "idle" : "unavailable", version: null, percent: 0, message: "" };
  /** The downloaded, verified installer, once there is one. */
  let readyFile = null;

  const publish = (next) => {
    status = { ...status, ...next };
    getWindow()?.webContents.send("update:status", status);
  };

  const snapshot = () => ({ ...status, enabled: getSettings().checkUpdates, configured: Boolean(url) });

  ipcMain.handle("update:get", snapshot);

  ipcMain.handle("update:set-enabled", async (_event, enabled) => {
    setCheckUpdates(Boolean(enabled));
    if (enabled) void check();
    return snapshot();
  });

  if (!url) {
    ipcMain.handle("update:check", () => status);
    ipcMain.handle("update:install", () => false);
    return;
  }

  /** Download the installer to disk, hashing as it arrives. Rejects unless it matches the feed. */
  async function download(feed, installerUrl) {
    await fsp.mkdir(updatesFolder(), { recursive: true });
    const name = `PulseGrid-Studio-Setup-${feed.version}.msi`;
    const finalFile = path.join(updatesFolder(), name);
    const partFile = `${finalFile}.part`;

    await removeOldDownloads(name);

    // Already downloaded earlier (the app was closed before installing): check it and reuse it.
    try {
      if ((await hashFile(finalFile)) === feed.sha512) return finalFile;
      await fsp.rm(finalFile, { force: true });
    } catch {
      /* not there yet */
    }

    const response = await net.fetch(installerUrl);
    if (!response.ok || !response.body) throw new Error(`The download failed (${response.status}).`);

    const total = feed.size ?? Number(response.headers.get("content-length")) ?? 0;
    const hash = crypto.createHash("sha512");
    const out = fs.createWriteStream(partFile);
    let received = 0;
    let lastPercent = -1;

    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));

        if (total > 0) {
          const percent = Math.min(99, Math.floor((received / total) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            publish({ state: "downloading", percent });
          }
        }
      }
      await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      out.destroy();
      await fsp.rm(partFile, { force: true });
      throw error;
    }

    if (hash.digest("base64") !== feed.sha512 || (feed.size && received !== feed.size)) {
      await fsp.rm(partFile, { force: true });
      throw new Error("The downloaded update didn't match its checksum, so it was thrown away.");
    }

    await fsp.rename(partFile, finalFile);
    return finalFile;
  }

  let checking = null;

  async function runCheck() {
    publish({ state: "checking", message: "" });

    const response = await net.fetch(`${url}latest.yml`, { cache: "no-store" });
    if (!response.ok) throw new Error(`The update check failed (${response.status}).`);

    const feed = parseFeed(await response.text());
    if (!feed) throw new Error("The update information wasn't readable.");

    if (compareVersions(feed.version, app.getVersion()) <= 0) {
      publish({ state: "current", message: "" });
      return;
    }

    // Off Windows there is nothing to download here: say that a newer version exists.
    if (platform() !== "win32") {
      publish({ state: "available", version: feed.version, percent: 0, message: "" });
      return;
    }

    // The installer's address comes from the feed, so it is held to the same rules as any download.
    const installerUrl = new URL(feed.url, url).toString();
    if (!isAcceptableInstallerUrl(installerUrl, testing())) {
      throw new Error("The update wasn't a secure .msi download, so it was ignored.");
    }

    publish({ state: "downloading", version: feed.version, percent: 0 });
    readyFile = await download(feed, installerUrl);
    publish({ state: "ready", version: feed.version, percent: 100 });
  }

  async function check() {
    // Already downloaded: nothing to gain from asking again until it's installed.
    if (status.state === "ready" || status.state === "available") return status;
    if (checking) return checking;

    checking = runCheck()
      .catch((error) => {
        // Offline, site down, file missing: not worth an alarm. The page decides
        // whether to mention it (only when the user asked for the check).
        publish({ state: "error", message: error?.message ? String(error.message).split("\n")[0] : "Unknown error" });
      })
      .finally(() => {
        checking = null;
      });

    await checking;
    return status;
  }

  ipcMain.handle("update:check", () => check());

  ipcMain.handle("update:install", () => {
    // Not Windows: open the page where the new version can be downloaded.
    if (status.state === "available") {
      const page = downloadPage();
      if (!page) return false;
      if (testing() && process.env.PULSEGRID_UPDATE_DRY_RUN) {
        fs.writeFileSync(process.env.PULSEGRID_UPDATE_DRY_RUN, JSON.stringify({ open: page }));
      } else {
        void shell.openExternal(page);
      }
      return true;
    }

    if (status.state !== "ready" || !readyFile) return false;

    // The page has already saved the project before asking for this.
    approveClose();

    const args = ["/i", readyFile, "/passive", "/norestart"];

    setImmediate(() => {
      // Tests record the command instead of installing anything on the machine.
      if (testing() && process.env.PULSEGRID_UPDATE_DRY_RUN) {
        try {
          fs.writeFileSync(process.env.PULSEGRID_UPDATE_DRY_RUN, JSON.stringify({ command: "msiexec.exe", args }));
        } catch {
          /* the test will notice */
        }
        app.quit();
        return;
      }

      try {
        // Handed over to Windows, which keeps running after this app has closed.
        spawn("msiexec.exe", args, { detached: true, stdio: "ignore" }).unref();
      } catch (error) {
        console.error("PulseGrid: could not start the installer", error);
        void shell.openPath(readyFile);
      }
      app.quit();
    });
    return true;
  });

  const automatic = () => {
    if (getSettings().checkUpdates) void check();
  };
  setTimeout(automatic, FIRST_CHECK_DELAY);
  setInterval(automatic, CHECK_INTERVAL).unref?.();
}

module.exports = { registerUpdates };
