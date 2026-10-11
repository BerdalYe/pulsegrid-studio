import { pack, unpack } from "./gzip";
import { findLinkByCloudId, type Link, type LocalSyncState } from "./links";
import {
  CloudError,
  MAX_PROJECT_BYTES,
  type CloudRow,
  type SyncBackend
} from "./types";

/**
 * The sync rules, with no browser, app or server baked in: everything it needs
 * comes through `backend` (the cloud) and `adapter` (the open project), so the
 * rules can be tested on their own.
 *
 * The rules, in one place:
 *
 *  - A project is uploaded as a new file first, and only then does the server
 *    move the project to it ("commit"). The server accepts the commit only if
 *    nobody else changed the project since this device last looked, so a
 *    project in the cloud always points at a complete file.
 *  - If somebody did change it — the same project edited on two PCs — nothing
 *    is overwritten blindly: the other version is first saved as its own cloud
 *    project, "<name> (other version)", and only then does this device's
 *    version take the original's place. Both are always still there.
 *  - A newer version on the server is loaded automatically only when nothing
 *    here has changed since the last sync, and only when the project is being
 *    opened; otherwise the user is told and chooses.
 */

export type Phase =
  | "idle"
  | "syncing"
  | "synced"
  | "behind"
  | "offline"
  | "error"
  | "excluded"
  | "unsaved"
  /** Kept on this device only: not chosen for the cloud (yet). */
  | "local";

export interface StatusPatch {
  phase?: Phase;
  message?: string;
  lastSyncedAt?: number | null;
  /** The newer cloud version waiting to be loaded, or null. */
  behind?: CloudRow | null;
}

/** The project that's open on this device. */
export interface ProjectAdapter {
  /** Where it lives on this device, or null if it hasn't been saved yet. */
  key(): string | null;
  path(): string | null;
  name(): string;
  /** The whole project file, as it would be saved. */
  text(): Promise<string>;
  /** Goes up on every edit. */
  revision(): number;
  /** Edited since it was last saved here. */
  isDirty(): boolean;
  /** In the middle of opening another project: nothing is safe to read. */
  busy(): boolean;
  /** Replace the open project with this file's contents and save it here, without that counting as an edit. */
  apply(text: string): Promise<void>;
}

export interface EngineOptions {
  backend: SyncBackend;
  userId: string;
  state: LocalSyncState;
  /** Called after `state` changes, to store it. */
  persist: () => void;
  adapter: ProjectAdapter;
  device: string;
  uuid?: () => string;
  now?: () => number;
  onStatus?: (patch: StatusPatch) => void;
  onNotice?: (message: string) => void;
  /**
   * Only projects the person chose for the cloud go up. Without it every saved project syncs. A project that is
   * already in the cloud (linked) keeps syncing either way.
   */
  optIn?: boolean;
}

/** Where a project on this device stands with the cloud. */
export type CloudState = "synced" | "pending" | "off" | "local";

export type SyncOutcome = "pushed" | "applied" | "behind" | "current" | "skipped" | "retry";

/** Give a project file a new name without otherwise touching it. */
export function renameProjectText(text: string, name: string): string {
  try {
    const parsed = JSON.parse(text) as { project?: { projectName?: unknown } };
    if (parsed && typeof parsed === "object" && parsed.project && typeof parsed.project === "object") {
      parsed.project.projectName = name;
      return JSON.stringify(parsed);
    }
  } catch {
    /* not JSON: leave it alone */
  }
  return text;
}

const QUOTA_TEXT =
  "Your cloud storage is full (250 MB). Remove some projects from the cloud, then try again.";

export function createSyncEngine(options: EngineOptions) {
  const { backend, userId, state, persist, adapter, device } = options;
  const optIn = options.optIn ?? false;
  // Older stored state has no list of wanted projects.
  state.wanted ??= {};
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const status = (patch: StatusPatch) => options.onStatus?.(patch);
  const notice = (message: string) => options.onNotice?.(message);

  /** Everything runs one at a time, so two uploads can never interleave. */
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  const synced = () => status({ phase: "synced", message: "", lastSyncedAt: now(), behind: null });

  function setLink(key: string, link: Link): void {
    state.links[key] = link;
    persist();
  }

  async function fetchText(row: CloudRow): Promise<string> {
    return unpack(await backend.download(row.object_path));
  }

  /** Upload `text` as a project that isn't in the cloud yet. Returns its id and revision. */
  async function createProject(name: string, text: string): Promise<{ id: string; revision: number }> {
    const id = uuid();
    const blob = await pack(text);
    if (blob.size > MAX_PROJECT_BYTES) {
      throw new CloudError("too_big", "That project is too big to keep in the cloud (over 50 MB).");
    }

    const path = `${userId}/${id}/${uuid()}.pulsegrid`;
    await backend.upload(path, blob);
    const result = await backend.commit({ id, name, base: 0, path, size: blob.size, device });

    if (!result.ok) {
      await backend.remove([path]).catch(() => undefined);
      throw new CloudError(
        result.reason === "quota" ? "quota" : result.reason === "too_many" ? "too_many" : "other",
        result.reason === "too_many"
          ? "You have 100 projects in the cloud, the most there's room for. Remove some first."
          : result.reason === "quota"
            ? QUOTA_TEXT
            : "The cloud didn't accept that project."
      );
    }
    return { id, revision: result.revision };
  }

  /**
   * Someone else changed this project in the cloud. Keep what's there as a
   * project of its own, so overwriting it loses nothing.
   */
  async function keepOtherVersion(cloudId: string): Promise<{ name: string; revision: number } | null> {
    const row = await backend.get(cloudId);
    if (!row) return null;

    const name = `${row.name} (other version)`.slice(0, 200);
    await createProject(name, renameProjectText(await fetchText(row), name));
    return { name, revision: row.revision };
  }

  /** Upload the open project. */
  async function pushNow(): Promise<SyncOutcome> {
    const key = adapter.key();
    if (!key) {
      status({ phase: "unsaved", message: "", behind: null });
      return "skipped";
    }
    if (state.excluded[key]) {
      status({ phase: "excluded", message: "", behind: null });
      return "skipped";
    }
    if (optIn && !state.links[key] && !state.wanted[key]) {
      status({ phase: "local", message: "", behind: null });
      return "skipped";
    }
    if (adapter.busy()) return "retry";

    status({ phase: "syncing", message: "" });

    let link: Link = state.links[key] ?? { cloudId: uuid(), base: 0, pending: true };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = adapter.revision();
      const name = adapter.name().trim() || "Untitled";
      const text = await adapter.text();

      // The user opened something else while this was being read: that text
      // may belong to a different project. Drop it and start over later.
      if (adapter.key() !== key || adapter.busy()) return "retry";

      const blob = await pack(text);
      if (blob.size > MAX_PROJECT_BYTES) {
        throw new CloudError("too_big", "This project is too big to keep in the cloud (over 50 MB).");
      }

      const path = `${userId}/${link.cloudId}/${uuid()}.pulsegrid`;
      await backend.upload(path, blob);

      const result = await backend.commit({
        id: link.cloudId,
        name,
        base: link.base,
        path,
        size: blob.size,
        device
      });

      if (result.ok) {
        delete state.wanted[key];
        setLink(key, {
          cloudId: link.cloudId,
          base: result.revision,
          // Edited again while uploading: the next upload picks that up.
          pending: adapter.revision() !== startedAt,
          ...(adapter.path() ? { path: adapter.path() as string } : {})
        });
        if (result.oldPath) void backend.remove([result.oldPath]).catch(() => undefined);
        synced();
        return "pushed";
      }

      // Not accepted: the new file is an orphan.
      await backend.remove([path]).catch(() => undefined);

      if (result.reason === "missing") {
        // Deleted from the cloud elsewhere. This device still has it, so it goes up again.
        link = { ...link, base: 0, pending: true };
        continue;
      }

      if (result.reason === "conflict") {
        const kept = await keepOtherVersion(link.cloudId);
        link = { ...link, base: kept?.revision ?? result.revision, pending: true };
        setLink(key, link);
        if (kept) {
          notice(
            `Edited on two PCs: the other version was kept as "${kept.name}" in your cloud projects.`
          );
        }
        continue;
      }

      throw new CloudError(
        result.reason,
        result.reason === "quota"
          ? QUOTA_TEXT
          : "You have 100 projects in the cloud, the most there's room for. Remove some first."
      );
    }

    throw new CloudError("other", "Couldn't finish syncing this project. It will try again.");
  }

  /** Syncing on or off for a project. In opt-in mode, switching it on asks for it to go up. */
  function setEnabledFor(key: string, enabled: boolean): void {
    if (enabled) {
      delete state.excluded[key];
      if (!state.links[key]) state.wanted[key] = true;
    } else {
      state.excluded[key] = true;
      delete state.wanted[key];
    }
    persist();
  }

  /** Replace the open project with the cloud's version. */
  async function applyNow(row: CloudRow): Promise<SyncOutcome> {
    const key = adapter.key();
    if (!key) return "skipped";

    const text = await fetchText(row);
    // The user may have moved on while that downloaded.
    if (adapter.key() !== key || adapter.busy()) return "retry";

    await adapter.apply(text);

    setLink(key, {
      cloudId: row.id,
      base: row.revision,
      pending: false,
      ...(adapter.path() ? { path: adapter.path() as string } : {})
    });
    synced();
    notice(`Loaded the newest version of "${row.name}" from your cloud.`);
    return "applied";
  }

  /**
   * Compare the open project with the cloud and do what's safe: upload if this
   * device has changes, load if the cloud has newer ones and this device has
   * none, say so otherwise.
   */
  async function reconcileNow(launching: boolean): Promise<SyncOutcome> {
    const key = adapter.key();
    if (!key) {
      status({ phase: "unsaved", message: "", behind: null });
      return "skipped";
    }
    if (state.excluded[key]) {
      status({ phase: "excluded", message: "", behind: null });
      return "skipped";
    }

    const link = state.links[key];
    if (!link) return pushNow();

    const changedHere = link.pending || adapter.isDirty();
    const row = await backend.get(link.cloudId);

    if (!row) {
      if (changedHere) return pushNow();

      // Removed from the cloud on another PC, and nothing new here: stop
      // syncing it, and say so rather than claiming it's in the cloud.
      delete state.links[key];
      state.excluded[key] = true;
      persist();
      status({ phase: "excluded", message: "", behind: null });
      notice(`"${adapter.name()}" was removed from your cloud on another PC, so it no longer syncs here.`);
      return "skipped";
    }

    if (row.revision === link.base) return changedHere ? pushNow() : currentOutcome();

    if (row.revision < link.base) {
      // The cloud went backwards (restored from a backup, say). Treat this device as the newer one.
      setLink(key, { ...link, base: row.revision, pending: true });
      return pushNow();
    }

    // The cloud has a newer version.
    if (changedHere) return pushNow();
    if (launching) return applyNow(row);

    status({ phase: "behind", message: "", behind: row });
    return "behind";
  }

  function currentOutcome(): SyncOutcome {
    synced();
    return "current";
  }

  return {
    /** Upload the open project now (or find out it can't be). */
    push: () => serial(pushNow),

    /** See where the open project stands, and act on it. */
    reconcile: (launching: boolean) => serial(() => reconcileNow(launching)),

    /** Load the cloud's newer version over the open project. */
    load: (row: CloudRow) => serial(() => applyNow(row)),

    fetchText,

    /** A local save happened: remember that the cloud doesn't have it yet. */
    markPending(): void {
      const key = adapter.key();
      const link = key ? state.links[key] : undefined;
      if (key && link && !link.pending) setLink(key, { ...link, pending: true });
    },

    /** Would pushing do anything? */
    needsPush(): boolean {
      const key = adapter.key();
      if (!key || state.excluded[key]) return false;
      const link = state.links[key];
      if (!link) return !optIn || Boolean(state.wanted[key]);
      return link.pending || adapter.isDirty();
    },

    /** Is everything in the open project already in the cloud? */
    isCurrentSafe(): boolean {
      const key = adapter.key();
      const link = key ? state.links[key] : undefined;
      return Boolean(link && !link.pending && !adapter.isDirty());
    },

    /** The cloud project the open project is linked to, if any. */
    currentCloudId(): string | null {
      const key = adapter.key();
      return (key && state.links[key]?.cloudId) || null;
    },

    /** The open project is one that would be lost if it were replaced. */
    wouldLoseWork(): boolean {
      const key = adapter.key();
      const link = key ? state.links[key] : undefined;
      if (adapter.isDirty()) return true;
      // Never saved anywhere: nothing has been done to it yet.
      if (!key) return false;
      return !link || link.pending;
    },

    isExcluded(): boolean {
      const key = adapter.key();
      return Boolean(key && state.excluded[key]);
    },

    findLink: (cloudId: string) => findLinkByCloudId(state, cloudId),
    setLink,

    /** Point a cloud project at this place on the device, and forget any other place it was linked to. */
    relink(key: string, link: Link): void {
      for (const [other, existing] of Object.entries(state.links)) {
        if (other !== key && existing.cloudId === link.cloudId) delete state.links[other];
      }
      delete state.excluded[key];
      delete state.wanted[key];
      setLink(key, link);
    },

    /** Turn syncing on or off for the open project. */
    setEnabled(enabled: boolean): void {
      const key = adapter.key();
      if (key) setEnabledFor(key, enabled);
    },

    /** Turn syncing on or off for any project on this device, open or not. */
    setEnabledFor,

    /** Where a project on this device stands with the cloud. */
    stateOf(key: string): CloudState {
      if (state.excluded[key]) return "off";
      const link = state.links[key];
      if (link) return link.pending ? "pending" : "synced";
      if (state.wanted[key]) return "pending";
      return optIn ? "local" : "pending";
    },

    /**
     * Put a project that isn't open into the cloud, from its file: the cloud gets it now, and it syncs from then
     * on. One that is already there just starts syncing again.
     */
    uploadFile: (key: string, path: string, name: string, text: string) =>
      serial(async (): Promise<"uploaded" | "linked"> => {
        delete state.excluded[key];
        if (state.links[key]) {
          persist();
          return "linked";
        }
        const created = await createProject(name.trim() || "Untitled", text);
        delete state.wanted[key];
        setLink(key, { cloudId: created.id, base: created.revision, pending: false, path });
        return "uploaded";
      }),

    /** Forget a project that is gone from this device (deleted). Its copy in the cloud stays. */
    forget(key: string): void {
      delete state.links[key];
      delete state.excluded[key];
      delete state.wanted[key];
      persist();
    },

    /** Delete a project from the cloud, and stop this device syncing it. */
    removeFromCloud: (cloudId: string) =>
      serial(async () => {
        const path = await backend.deleteRow(cloudId);
        if (path) await backend.remove([path]).catch(() => undefined);

        for (const [key, link] of Object.entries(state.links)) {
          if (link.cloudId !== cloudId) continue;
          delete state.links[key];
          state.excluded[key] = true;
        }
        persist();
      }),

    list: () => backend.list()
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
