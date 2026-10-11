import { useMemo, useState, type FormEvent } from "react";

import { isDesktop } from "../files/desktop";
import {
  clearAuthNotice,
  sendPasswordReset,
  signIn,
  signInWithDiscord,
  signOut,
  signUp,
  useAuthStore
} from "../sync/auth";
import { SITE_URL, syncConfigured } from "../sync/config";
import {
  flushSync,
  loadNewer,
  openFromCloud,
  removeFromCloud,
  setSyncEnabled,
  wouldLoseWork
} from "../sync/manager";
import { MAX_PROJECTS, QUOTA_BYTES, cloudUsage, formatBytes } from "../sync/limits";
import { useCloudStore } from "../sync/store";
import type { CloudRow } from "../sync/types";
import { filterByName } from "../lib/search";
import { useConfirm } from "./ConfirmDialog";
import { ListSearch } from "./ListSearch";
import { timeAgo } from "./ProjectsPanel";

type Mode = "signIn" | "signUp" | "reset";

/**
 * The optional account: sign in to keep projects on every PC you use. Signed
 * out, the studio works exactly as before and never contacts the cloud.
 */
export function CloudPanel({ onStatus }: { onStatus: (message: string) => void }) {
  const status = useAuthStore((state) => state.status);
  if (!syncConfigured || status === "unknown") return null;

  return (
      <div className="cloud-panel">
        {status === "signedIn" ? <SignedIn onStatus={onStatus} /> : <SignedOut onStatus={onStatus} />}
      </div>
  );
}

/* ─────────────────────────────── signed out ─────────────────────────────── */

function SignedOut({ onStatus }: { onStatus: (message: string) => void }) {
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const notice = useAuthStore((state) => state.notice);

  const switchTo = (next: Mode) => {
    setMode(next);
    setError("");
    setInfo("");
    clearAuthNotice();
  };

  const continueWithDiscord = async () => {
    if (busy) return;
    setError("");
    setInfo("");
    setBusy(true);
    try {
      await signInWithDiscord();
      // In the Windows app the sign-in opens in the browser; the web studio leaves this page instead.
      if (isDesktop()) setInfo("Finish signing in with Discord in your browser, then come back here.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;

    setError("");
    setInfo("");

    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }
    if (mode !== "reset" && password.length < 8) {
      setError(
        mode === "signUp" ? "Choose a password of at least 8 characters." : "Enter your password."
      );
      return;
    }

    setBusy(true);
    try {
      if (mode === "signIn") {
        await signIn(email, password);
        setPassword("");
        onStatus("Signed in. Your projects will sync.");
      } else if (mode === "signUp") {
        const result = await signUp(email, password);
        setPassword("");
        if (result === "signedIn") onStatus("Account created. Your projects will sync.");
        else {
          setMode("signIn");
          setInfo("Almost there: open the confirmation link we emailed you, then sign in here.");
        }
      } else {
        await sendPasswordReset(email);
        setMode("signIn");
        setInfo("If there's an account for that address, a reset link is on its way.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="cloud-form" onSubmit={(event) => void submit(event)} noValidate>
      <p className="small-note">
        {mode === "signUp"
          ? "Create a free account to keep your projects on every PC."
          : mode === "reset"
            ? "We'll email you a link to choose a new password."
            : "Sign in to keep your projects on every PC. Optional, and free."}
      </p>

      <input
        type="email"
        value={email}
        placeholder="Email"
        autoComplete="email"
        aria-label="Email"
        onChange={(event) => setEmail(event.target.value)}
      />

      {mode !== "reset" ? (
        <input
          type="password"
          value={password}
          placeholder={mode === "signUp" ? "Password (8+ characters)" : "Password"}
          autoComplete={mode === "signUp" ? "new-password" : "current-password"}
          aria-label="Password"
          onChange={(event) => setPassword(event.target.value)}
        />
      ) : null}

      {error || notice ? (
        <span className="cloud-message cloud-error" role="alert">
          {error || notice}
        </span>
      ) : null}
      {info && !error && !notice ? (
        <span className="cloud-message" role="status">
          {info}
        </span>
      ) : null}

      <button type="submit" className="cloud-submit" disabled={busy}>
        {busy
          ? "One moment…"
          : mode === "signIn"
            ? "Sign in"
            : mode === "signUp"
              ? "Create account"
              : "Send reset link"}
      </button>

      {mode !== "reset" ? (
        <>
          <span className="cloud-or">or</span>
          <button type="button" className="cloud-discord" disabled={busy} onClick={() => void continueWithDiscord()}>
            Continue with Discord
          </button>
        </>
      ) : null}

      <div className="cloud-links">
        {mode === "signIn" ? (
          <>
            <button type="button" className="link-button" onClick={() => switchTo("signUp")}>
              Create an account
            </button>
            <button type="button" className="link-button" onClick={() => switchTo("reset")}>
              Forgot password?
            </button>
          </>
        ) : (
          <button type="button" className="link-button" onClick={() => switchTo("signIn")}>
            Back to sign in
          </button>
        )}
      </div>

      <span className="small-note">
        Synced projects are stored with Supabase.{" "}
        <a href={`${SITE_URL}/legal.html#privacy`} target="_blank" rel="noopener">
          Privacy
        </a>
      </span>
    </form>
  );
}

/* ─────────────────────────────── signed in ─────────────────────────────── */

function statusLine(phase: string, message: string, lastSyncedAt: number | null): string {
  switch (phase) {
    case "syncing":
      return "Syncing…";
    case "synced":
      return lastSyncedAt ? `Synced ${timeAgo(lastSyncedAt)}` : "Synced";
    case "behind":
      return "Newer version available";
    case "offline":
      return "Offline. Changes sync when you're back.";
    case "error":
      return message || "Couldn't sync";
    case "excluded":
    case "local":
      return "This project is only on this PC";
    case "unsaved":
      return "Syncs after your first edit";
    default:
      return "Checking…";
  }
}

function SignedIn({ onStatus }: { onStatus: (message: string) => void }) {
  const confirm = useConfirm();
  const email = useAuthStore((state) => state.email);

  const phase = useCloudStore((state) => state.phase);
  const message = useCloudStore((state) => state.message);
  const lastSyncedAt = useCloudStore((state) => state.lastSyncedAt);
  const projects = useCloudStore((state) => state.projects);
  const loaded = useCloudStore((state) => state.projectsLoaded);
  const currentId = useCloudStore((state) => state.currentId);
  const usage = cloudUsage(projects);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterByName(projects, query, (row) => row.name), [projects, query]);

  const run = (action: () => Promise<string>) => {
    void action()
      .then(onStatus)
      .catch((error: unknown) => onStatus(error instanceof Error ? error.message : "That didn't work."));
  };

  const open = async (row: CloudRow) => {
    // The desktop app keeps every project as a file; the browser has one working copy.
    if (!isDesktop() && wouldLoseWork()) {
      const ok = await confirm(
        "Replace the project in this browser?",
        "It isn't in your cloud, so opening another project would lose it. Download it first from File → Download project (.pulsegrid).",
        { confirmLabel: "Replace it" }
      );
      if (!ok) return;
    }
    run(() => openFromCloud(row));
  };

  const remove = async (row: CloudRow) => {
    const ok = await confirm(
      `Remove "${row.name}" from your cloud?`,
      "It's deleted from the cloud for good. Copies on your PCs are kept, and stop syncing.",
      { confirmLabel: "Remove" }
    );
    if (ok) run(() => removeFromCloud(row));
  };

  const leave = () =>
    run(async () => {
      await flushSync(5000);
      await signOut();
      return "Signed out. Projects stay on this PC and stop syncing.";
    });

  return (
    <>
      <div className="cloud-account">
        <span className="cloud-email" title={email ?? undefined}>
          {email}
        </span>
        <button onClick={leave}>Sign out</button>
      </div>

      <div className={`save-status cloud-${phase}`} title={message || undefined}>
        <span className="save-dot" aria-hidden="true" />
        {statusLine(phase, message, lastSyncedAt)}
        {phase === "behind" ? (
          <button className="cloud-load" onClick={() => run(loadNewer)}>
            Load it
          </button>
        ) : null}
      </div>

      {phase !== "unsaved" ? (
        <label className="autosave-toggle" title="Keep the open project in your cloud and in step with your other computers">
          <input
            type="checkbox"
            checked={phase !== "excluded" && phase !== "local"}
            onChange={(event) => setSyncEnabled(event.target.checked)}
          />
          Keep this project in the cloud
        </label>
      ) : null}
      <p className="small-note">
        Only the projects you choose go to the cloud. In the Projects tab, the cloud button beside a project saves it there.
      </p>

      <ListSearch
        query={query}
        onChange={setQuery}
        total={projects.length}
        shown={visible.length}
        label="Search your cloud projects"
      />

      <div className="cloud-list">
        {!loaded ? (
          <span className="small-note">Loading your projects…</span>
        ) : projects.length === 0 ? (
          <span className="small-note">No projects in your cloud yet.</span>
        ) : visible.length === 0 ? (
          <span className="small-note">No cloud project matches “{query.trim()}”.</span>
        ) : (
          visible.map((row) => {
            const current = row.id === currentId;
            return (
              <div key={row.id} className={`cloud-item${current ? " current" : ""}`}>
                <div className="cloud-item-text">
                  <span className="cloud-item-name">{row.name}</span>
                  <em title={current ? "Open on this PC" : undefined}>
                    {timeAgo(new Date(row.updated_at).getTime())} · {formatBytes(row.size_bytes)}
                    {row.device ? ` · ${row.device}` : ""}
                  </em>
                </div>
                <button
                  disabled={current}
                  title={current ? "This is the open project" : "Open this project on this PC"}
                  onClick={() => void open(row)}
                >
                  Open
                </button>
                <button title="Remove from the cloud" aria-label={`Remove ${row.name}`} onClick={() => void remove(row)}>
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      {loaded ? (
        <div
          className={`cloud-usage${usage.atLimit ? " full" : usage.nearLimit ? " near" : ""}`}
          title={`Each account can keep up to ${MAX_PROJECTS} projects and ${formatBytes(QUOTA_BYTES)} in the cloud, and no single project over 50 MB.`}
        >
          <span>
            {usage.count} of {MAX_PROJECTS} projects
          </span>
          <span>
            {formatBytes(usage.bytes)} of {formatBytes(QUOTA_BYTES)}
          </span>
          {usage.nearLimit ? (
            <em>{usage.atLimit ? "Full: remove a project to sync more." : "Nearly full."}</em>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
