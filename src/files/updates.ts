import { create } from "zustand";

import { getDesktop, type UpdateStatus } from "./desktop";
import { settleCurrentProject } from "./actions";

/**
 * Desktop updates as the studio sees them. The work happens in the main
 * process (electron/updates.cjs); this mirrors its status for the menu bar
 * and the menus. The web studio never has updates: it is always the latest.
 */
interface UpdateStore {
  status: UpdateStatus;
  /** The user's "check automatically" setting. */
  enabled: boolean;
  /** False when this build has no update address, so there's nothing to offer. */
  configured: boolean;
}

export const useUpdateStore = create<UpdateStore>(() => ({
  status: { state: "unavailable", version: null, percent: 0, message: "" },
  enabled: true,
  configured: false
}));

function apply(status: UpdateStatus): void {
  const { enabled, configured, ...rest } = status;
  useUpdateStore.setState((current) => ({
    status: rest,
    enabled: enabled ?? current.enabled,
    configured: configured ?? current.configured
  }));
}

/** Start mirroring the main process. Returns a teardown. */
export function initUpdates(): () => void {
  const desktop = getDesktop();
  if (!desktop) return () => undefined;

  void desktop.getUpdateStatus().then(apply).catch(() => undefined);
  return desktop.onUpdateStatus(apply);
}

/** Help → Check for updates. Resolves to a line for the status bar. */
export async function checkForUpdatesNow(): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return "The web studio is always the latest version.";

  const status = await desktop.checkForUpdates();
  apply(status);

  switch (status.state) {
    case "current":
      return `You have the latest version (${__APP_VERSION__}).`;
    case "downloading":
      return `Downloading PulseGrid Studio ${status.version ?? ""}…`;
    case "ready":
      return `PulseGrid Studio ${status.version ?? ""} is ready — restart to update.`;
    case "available":
      return `PulseGrid Studio ${status.version ?? ""} is available — use the Download button in the menu bar.`;
    case "unavailable":
      return "This build doesn't check for updates.";
    case "error":
      return "Couldn't check for updates. Are you online?";
    default:
      return "Checking for updates…";
  }
}

/** Options → Check for updates automatically. */
export async function toggleUpdateChecks(): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return "";

  const next = !useUpdateStore.getState().enabled;
  apply(await desktop.setCheckUpdates(next));
  return next ? "PulseGrid will check for updates." : "Automatic update checks are off.";
}

/**
 * Save (or ask about) the open project first, exactly as closing the window
 * would, then restart into the new version.
 */
export async function installUpdateNow(): Promise<string> {
  const desktop = getDesktop();
  if (!desktop) return "";

  // A manual update only opens the download page: nothing closes, so nothing needs saving.
  if (useUpdateStore.getState().status.state === "available") {
    const opened = await desktop.installUpdate();
    return opened ? "Opening the download page…" : "The download page couldn't be opened.";
  }

  if (!(await settleCurrentProject())) return "Update postponed.";
  const started = await desktop.installUpdate();
  return started ? "Installing the update…" : "The update isn't ready yet.";
}
