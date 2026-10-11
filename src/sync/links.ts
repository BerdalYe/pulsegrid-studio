/**
 * What this device knows about its projects' place in the cloud. Kept per
 * account in this browser's own storage; the project files themselves are
 * never changed by syncing.
 *
 * A project is identified here by where it lives on this device: its file
 * (lower-cased, Windows paths are case-insensitive) in the desktop app, or the
 * browser's working copy in the web studio.
 */
export interface Link {
  cloudId: string;
  /** The cloud revision this device last uploaded or downloaded. */
  base: number;
  /** Saved here since the last upload. */
  pending: boolean;
  /** The file's real path (desktop), so it can be reopened later. */
  path?: string;
}

export interface LocalSyncState {
  links: Record<string, Link>;
  /** Projects the user switched syncing off for. */
  excluded: Record<string, true>;
  /** Projects the user chose to keep in the cloud, that haven't gone up yet. */
  wanted: Record<string, true>;
}

export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

const keyFor = (userId: string) => `pulsegrid:sync:${userId}`;

export function emptyState(): LocalSyncState {
  return { links: {}, excluded: {}, wanted: {} };
}

export function loadSyncState(userId: string, storage: KeyValueStore | null): LocalSyncState {
  try {
    const raw = storage?.getItem(keyFor(userId));
    if (!raw) return emptyState();

    const parsed = JSON.parse(raw) as Partial<LocalSyncState>;
    const links: Record<string, Link> = {};

    for (const [key, link] of Object.entries(parsed.links ?? {})) {
      if (
        link &&
        typeof link.cloudId === "string" &&
        Number.isInteger(link.base) &&
        typeof link.pending === "boolean"
      ) {
        links[key] = {
          cloudId: link.cloudId,
          base: link.base,
          pending: link.pending,
          ...(typeof link.path === "string" ? { path: link.path } : {})
        };
      }
    }

    const excluded: Record<string, true> = {};
    for (const key of Object.keys(parsed.excluded ?? {})) excluded[key] = true;
    const wanted: Record<string, true> = {};
    for (const key of Object.keys(parsed.wanted ?? {})) wanted[key] = true;

    return { links, excluded, wanted };
  } catch {
    return emptyState();
  }
}

export function saveSyncState(
  userId: string,
  state: LocalSyncState,
  storage: KeyValueStore | null
): void {
  try {
    storage?.setItem(keyFor(userId), JSON.stringify(state));
  } catch {
    /* storage full or blocked: syncing still works this session */
  }
}

export function findLinkByCloudId(
  state: LocalSyncState,
  cloudId: string
): { key: string; link: Link } | null {
  for (const [key, link] of Object.entries(state.links)) {
    if (link.cloudId === cloudId) return { key, link };
  }
  return null;
}
