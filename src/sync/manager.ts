import { browserName } from "../lib/reportProblem";
import { initAuth, useAuthStore } from "./auth";
import { getClient } from "./client";
import { createSyncEngine, type ProjectAdapter, type SyncEngine } from "./engine";
import { loadSyncState, saveSyncState, type KeyValueStore } from "./links";
import { createSupabaseBackend, toCloudError } from "./supabase";
import { useCloudStore } from "./store";
import type { CloudRow } from "./types";

/**
 * Connects the sync engine to the running studio: it starts when someone is
 * signed in, watches for the moments worth syncing (a save, opening a project,
 * coming back to the window, getting back online), and gives the interface a
 * few simple actions. The rules themselves live in engine.ts.
 */

/** What the studio provides on top of the engine's own view of the open project. */
export interface StudioAdapter extends ProjectAdapter {
  /** Desktop: open a project file that's already on this PC. */
  openPath: ((path: string) => Promise<string>) | null;
  /**
   * Make a new local project from a cloud file and open it. `linkTo` is told
   * where it will live, before it opens, so syncing recognises it.
   */
  importCloud(
    text: string,
    name: string,
    linkTo: (key: string, path: string | null) => void
  ): Promise<string>;
}

let host: StudioAdapter | null = null;
let engine: SyncEngine | null = null;
let pushTimer: number | null = null;

export function setStudioAdapter(adapter: StudioAdapter): void {
  host = adapter;
}

/** The engine's view of the open project: always whatever is open right now. */
const liveProject: ProjectAdapter = {
  key: () => host?.key() ?? null,
  path: () => host?.path() ?? null,
  name: () => host?.name() ?? "",
  text: () => (host ? host.text() : Promise.reject(new Error("No project is open."))),
  revision: () => host?.revision() ?? 0,
  isDirty: () => host?.isDirty() ?? false,
  busy: () => host?.busy() ?? true,
  apply: (text) => (host ? host.apply(text) : Promise.reject(new Error("No project is open.")))
};

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function deviceLabel(): string {
  if (window.pulsegridDesktop) return "Windows app";
  const browser = browserName(navigator.userAgent);
  return browser ? `Web studio (${browser})` : "Web studio";
}

function report(error: unknown): void {
  const failure = toCloudError(error);
  useCloudStore.getState().patch({
    phase: failure.kind === "offline" ? "offline" : "error",
    message: failure.message
  });
}

async function guarded<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    report(error);
    return undefined;
  }
}

function syncLinked(): void {
  useCloudStore.getState().setCurrentId(engine?.currentCloudId() ?? null);
}

/* ─────────────────────────────── starting up ─────────────────────────────── */

async function startEngine(userId: string): Promise<void> {
  const client = await getClient();
  const state = loadSyncState(userId, storage());

  const created = createSyncEngine({
    backend: createSupabaseBackend(client),
    userId,
    state,
    persist: () => saveSyncState(userId, state, storage()),
    adapter: liveProject,
    device: deviceLabel(),
    onStatus: (patch) => {
      useCloudStore.getState().patch(patch);
      if (engine === created) syncLinked();
    },
    onNotice: (message) => useCloudStore.getState().setNotice(message)
  });

  engine = created;
  useCloudStore.getState().reset();

  await guarded(() => created.reconcile(true));
  syncLinked();
  await refreshList();
}

function stopEngine(): void {
  engine = null;
  if (pushTimer !== null) window.clearTimeout(pushTimer);
  pushTimer = null;
  useCloudStore.getState().reset();
}

/**
 * Begin following the account. Call once when the studio starts; the returned
 * function undoes it.
 */
export function startSync(): () => void {
  void initAuth();

  let handled: string | null = null;
  const onAuth = () => {
    const { status, userId } = useAuthStore.getState();
    const next = status === "signedIn" ? userId : null;
    if (next === handled) return;
    handled = next;

    if (next) void startEngine(next).catch(report);
    else stopEngine();
  };

  const unsubscribe = useAuthStore.subscribe(() => window.setTimeout(onAuth, 0));

  const recheck = () => {
    if (document.visibilityState !== "hidden") void reconcile(false);
  };
  window.addEventListener("focus", recheck);
  window.addEventListener("online", recheck);
  const interval = window.setInterval(recheck, 120_000);

  return () => {
    unsubscribe();
    window.removeEventListener("focus", recheck);
    window.removeEventListener("online", recheck);
    window.clearInterval(interval);
    stopEngine();
  };
}

/* ──────────────────────────── what the studio reports ──────────────────────────── */

/** The open project was just saved on this device. */
export function notifySaved(): void {
  if (!engine) return;
  engine.markPending();
  syncLinked();
  schedulePush();
}

/** Another project was just opened (or the open one was replaced). */
export function notifySwitched(): void {
  if (!engine) return;
  useCloudStore.getState().patch({ phase: "idle", message: "", behind: null });
  syncLinked();
  void reconcile(true);
}

function schedulePush(delay = 4000): void {
  if (pushTimer !== null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    const current = engine;
    if (!current || !current.needsPush()) return;

    void guarded(async () => {
      const outcome = await current.push();
      if (outcome === "retry") schedulePush(1500);
      syncLinked();
      await refreshList();
    });
  }, delay);
}

async function reconcile(launching: boolean): Promise<void> {
  const current = engine;
  if (!current) return;

  const outcome = await guarded(() => current.reconcile(launching));
  if (outcome === "retry") schedulePush(1500);
  syncLinked();
  await refreshList();
}

/**
 * Upload anything not yet uploaded, waiting at most `timeoutMs`: before
 * switching projects, signing out, or closing the window. Offline it returns
 * at once; the change is kept and goes up later.
 */
export async function flushSync(timeoutMs = 8000): Promise<void> {
  const current = engine;
  if (!current || !current.needsPush()) return;

  if (pushTimer !== null) window.clearTimeout(pushTimer);
  pushTimer = null;

  await Promise.race([
    guarded(() => current.push()),
    new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs))
  ]);
  syncLinked();
}

/* ─────────────────────────────── for the panels ─────────────────────────────── */

export async function refreshList(): Promise<void> {
  const current = engine;
  if (!current) return;
  try {
    useCloudStore.getState().setProjects(await current.list());
  } catch (error) {
    // Listing failing (offline) isn't news; a failed sync already says so.
    if (toCloudError(error).kind !== "offline") report(error);
  }
}

/**
 * Would opening a different project in the web studio throw away work that
 * isn't kept anywhere else? (The desktop app keeps every project as a file.)
 */
export function wouldLoseWork(): boolean {
  return engine?.wouldLoseWork() ?? false;
}

export async function openFromCloud(row: CloudRow): Promise<string> {
  const current = engine;
  if (!current || !host) throw new Error("Sign in to open cloud projects.");

  await flushSync();

  // Already on this PC: open that file, then catch it up.
  const known = current.findLink(row.id);
  if (known?.link.path && host.openPath) {
    try {
      const message = await host.openPath(known.link.path);
      await guarded(() => current.reconcile(true));
      syncLinked();
      return message;
    } catch {
      /* the file is gone: fall through and download it again */
    }
  }

  const text = await current.fetchText(row);
  const message = await host.importCloud(text, row.name, (key, path) =>
    current.relink(key, {
      cloudId: row.id,
      base: row.revision,
      pending: false,
      ...(path ? { path } : {})
    })
  );

  await guarded(() => current.reconcile(true));
  syncLinked();
  await refreshList();
  return message;
}

/** Load the newer cloud version of the open project, when it's safe to. */
export async function loadNewer(): Promise<string> {
  const current = engine;
  const row = useCloudStore.getState().behind;
  if (!current || !row) return "This project is already up to date.";

  // Edited since the banner appeared: loading would throw that work away.
  // Syncing keeps both versions instead.
  if (!current.isCurrentSafe()) {
    await guarded(() => current.reconcile(false));
    syncLinked();
    return "You've edited this project since. Both versions are kept in your cloud.";
  }

  const outcome = await current.load(row);
  syncLinked();
  await refreshList();
  return outcome === "applied"
    ? `Loaded "${row.name}" from your cloud.`
    : "Couldn't load it just now. Try again in a moment.";
}

export async function removeFromCloud(row: CloudRow): Promise<string> {
  const current = engine;
  if (!current) throw new Error("Sign in first.");

  await current.removeFromCloud(row.id);
  useCloudStore.getState().patch({ phase: current.isExcluded() ? "excluded" : "idle", behind: null });
  syncLinked();
  await refreshList();
  return `Removed "${row.name}" from your cloud. The copy on this PC is untouched.`;
}

export function setSyncEnabled(enabled: boolean): void {
  const current = engine;
  if (!current) return;

  current.setEnabled(enabled);
  useCloudStore.getState().patch({ phase: enabled ? "idle" : "excluded", message: "", behind: null });
  if (enabled) void reconcile(true);
}
