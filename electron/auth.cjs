/**
 * Signing in with Discord happens in the person's own browser, which then sends
 * them back to the studio through a pulsegrid://auth link. This file owns that
 * return trip: it lets Windows hand the link to the studio and passes it on to
 * the page, which finishes the sign-in.
 */
const path = require("node:path");
const { app, ipcMain, shell } = require("electron");

const SCHEME = "pulsegrid";
const RETURN_PREFIX = `${SCHEME}://auth`;

/** A return link among the launch arguments, or null. */
function authUrlFromArgs(argv) {
  return argv.slice(1).find((arg) => arg.toLowerCase().startsWith(RETURN_PREFIX)) ?? null;
}

let launchUrl = null;

function setLaunchAuthUrl(argv) {
  launchUrl = authUrlFromArgs(argv);
}

/** Let Windows open pulsegrid:// links in this app. (The installer sets this up too.) */
function registerProtocol() {
  // Tests run against a throwaway profile and must not change the real machine's settings.
  if (process.env.PULSEGRID_USER_DATA) return;

  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(SCHEME);
  }
}

function registerAuthHandlers() {
  // The studio asks for the sign-in page to open in the real browser.
  ipcMain.handle("auth:open-external", async (_event, url) => {
    // Tests run against a local stand-in for the sign-in service, which has no https.
    const testing = process.env.PULSEGRID_USER_DATA && /^http:\/\/127\.0\.0\.1[:/]/i.test(String(url));
    if (typeof url !== "string" || (!/^https:\/\//i.test(url) && !testing)) {
      throw new Error("Only secure web addresses can be opened.");
    }
    await shell.openExternal(url);
  });

  // A return link that arrived while the studio was not yet running.
  ipcMain.handle("auth:take-launch-url", () => {
    const url = launchUrl;
    launchUrl = null;
    return url;
  });
}

/** Pass a return link on to the page, if it is one of ours. */
function deliverAuthUrl(window, url) {
  if (!window || !url || !url.toLowerCase().startsWith(RETURN_PREFIX)) return;
  window.webContents.send("auth:callback", url);
}

module.exports = { authUrlFromArgs, setLaunchAuthUrl, registerProtocol, registerAuthHandlers, deliverAuthUrl };
