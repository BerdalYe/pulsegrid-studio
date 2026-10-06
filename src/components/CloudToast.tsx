import { useState } from "react";

import { loadNewer } from "../sync/manager";
import { useCloudStore } from "../sync/store";
import { timeAgo } from "./ProjectsPanel";

/**
 * Appears over the studio when the open project was changed on another PC, so
 * it can't be missed. Loading is always the user's choice: "Not now" just puts
 * the card away (the button in the menu bar stays), and if they edit the
 * project meanwhile, syncing keeps both versions.
 */
export function CloudToast({ onStatus }: { onStatus: (message: string) => void }) {
  const phase = useCloudStore((state) => state.phase);
  const behind = useCloudStore((state) => state.behind);

  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (phase !== "behind" || !behind) return null;

  // A newer change after dismissing brings the card back.
  const stamp = `${behind.id}:${behind.revision}`;
  if (dismissed === stamp) return null;

  const load = () => {
    setBusy(true);
    void loadNewer()
      .then(onStatus)
      .catch((error: unknown) => onStatus(error instanceof Error ? error.message : "That didn't work."))
      .finally(() => setBusy(false));
  };

  return (
    <aside className="cloud-toast" role="status" aria-live="polite">
      <span className="cloud-toast-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path
            d="M7 18h9.5a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6.4 8.6 4.8 4.8 0 0 0 7 18z"
            fill="none"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M12 9.5v5m-2.2-2.2L12 14.5l2.2-2.2" fill="none" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>

      <div className="cloud-toast-text">
        <strong>A newer version is ready</strong>
        <span>
          “{behind.name}” was changed {timeAgo(new Date(behind.updated_at).getTime())}
          {behind.device ? ` on ${behind.device}` : " on another PC"}.
        </span>
      </div>

      <div className="cloud-toast-actions">
        <button className="cloud-toast-load" disabled={busy} onClick={load}>
          {busy ? "Loading…" : "Load newer version"}
        </button>
        <button className="cloud-toast-later" onClick={() => setDismissed(stamp)}>
          Not now
        </button>
      </div>
    </aside>
  );
}
