import {
  SCHEMA_VERSION,
  type ProjectData,
  type ProjectFile,
  type SerializedSample,
  type SessionData
} from "../types";

import { downloadBlob, sanitizeFilename } from "../lib/utils";
import {
  getAllSamples,
  getSample,
  hasSample,
  loadSampleFromFile
} from "../audio/sampleRegistry";

const DB_NAME = "pulsegrid-studio";
const DB_VERSION = 2;
const PROJECT_STORE = "projects";
const SAMPLE_STORE = "samples";

export const AUTOSAVE_SLOT = "autosave";

export interface StoredProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
}

interface StoredProject extends StoredProjectMeta {
  project: ProjectData;
  session: SessionData;
}

interface StoredSample {
  id: string;
  name: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no IndexedDB, so projects can't be saved locally."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SAMPLE_STORE)) {
        db.createObjectStore(SAMPLE_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // A version change from another tab invalidates this handle.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    const fail = (error: Error) => {
      // Never cache a rejected promise: the first failure (private browsing,
      // storage denied at startup) would otherwise poison every save and load
      // for the rest of the page session, even once conditions change.
      dbPromise = null;
      reject(error);
    };

    request.onerror = () =>
      fail(request.error ?? new Error("Could not open the project store."));

    // Fires instead of success/error when an older tab holds the database at a
    // lower version. Without this the promise would never settle at all.
    request.onblocked = () =>
      fail(
        new Error("Another PulseGrid tab is holding the project store open — close it and retry.")
      );
  });

  return dbPromise;
}

function runTransaction<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  work: (stores: IDBObjectStore[]) => T | Promise<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const tx = db.transaction(names, mode);
        let result: T;

        Promise.resolve(work(names.map((name) => tx.objectStore(name))))
          .then((value) => {
            result = value;
          })
          .catch(reject);

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? new Error("Storage request failed."));
        tx.onabort = () => reject(tx.error ?? new Error("Storage request was aborted."));
      })
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ─────────────────────────────── projects ─────────────────────────────── */

export async function saveProjectSlot(
  id: string,
  project: ProjectData,
  session: SessionData
): Promise<void> {
  const record: StoredProject = {
    id,
    name: project.projectName,
    updatedAt: Date.now(),
    project,
    session
  };

  // The project record and the sample blobs it points at go in together. Two
  // transactions meant a quota failure on the second could commit a project
  // referring to samples that were never stored — silent, permanently mute
  // channels on the next load, with the error swallowed by autosave.
  const samples = collectProjectSampleRecords(project);

  await runTransaction([PROJECT_STORE, SAMPLE_STORE], "readwrite", ([projects, sampleStore]) => {
    projects.put(record);
    for (const sample of samples) sampleStore.put(sample);
  });
}

export async function loadProjectSlot(id: string): Promise<StoredProject | null> {
  return runTransaction(PROJECT_STORE, "readonly", async ([store]) => {
    const record = await requestToPromise(store.get(id));
    return (record as StoredProject | undefined) ?? null;
  });
}

export async function listProjectSlots(): Promise<StoredProjectMeta[]> {
  return runTransaction(PROJECT_STORE, "readonly", async ([store]) => {
    const records = (await requestToPromise(store.getAll())) as StoredProject[];
    return records
      .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function deleteProjectSlot(id: string): Promise<void> {
  await runTransaction(PROJECT_STORE, "readwrite", ([store]) => {
    store.delete(id);
  });
}

/* ──────────────────────────────── samples ──────────────────────────────── */

/** Every sample id the project actually refers to. */
export function collectSampleIds(project: ProjectData): string[] {
  const ids = new Set<string>();

  for (const channel of project.channels) {
    if (channel.sampleId) ids.add(channel.sampleId);
  }

  for (const clip of project.playlist.clips) {
    if (clip.type === "audio") ids.add(clip.sampleId);
  }

  return Array.from(ids);
}

/**
 * Store the audio for any user-supplied sample the project uses, so reloading
 * doesn't leave silent channels behind.
 */
export function collectProjectSampleRecords(project: ProjectData): StoredSample[] {
  const records: StoredSample[] = [];

  for (const id of collectSampleIds(project)) {
    const sample = getSample(id);
    if (!sample || sample.builtIn || !sample.source) continue;
    records.push({ id, name: sample.name, blob: sample.source });
  }

  return records;
}

export async function persistProjectSamples(project: ProjectData): Promise<void> {
  const records = collectProjectSampleRecords(project);

  if (records.length === 0) return;

  await runTransaction(SAMPLE_STORE, "readwrite", ([store]) => {
    for (const record of records) store.put(record);
  });
}

/** Re-register stored sample audio after a reload. */
export async function restoreSamples(
  context: BaseAudioContext,
  ids?: string[]
): Promise<number> {
  let records: StoredSample[];

  try {
    records = await runTransaction(SAMPLE_STORE, "readonly", async ([store]) => {
      return (await requestToPromise(store.getAll())) as StoredSample[];
    });
  } catch {
    return 0;
  }

  const wanted = ids ? new Set(ids) : null;
  let restored = 0;

  for (const record of records) {
    if (wanted && !wanted.has(record.id)) continue;
    if (hasSample(record.id)) continue;

    try {
      await loadSampleFromFile(record.blob, record.name, context, record.id);
      restored += 1;
    } catch {
      // A sample the browser can no longer decode shouldn't stop the rest.
    }
  }

  return restored;
}

export async function pruneUnusedSamples(project: ProjectData): Promise<void> {
  const used = new Set(collectSampleIds(project));

  await runTransaction(SAMPLE_STORE, "readwrite", async ([store]) => {
    const keys = (await requestToPromise(store.getAllKeys())) as IDBValidKey[];
    for (const key of keys) {
      if (!used.has(String(key))) store.delete(key);
    }
  });
}

/* ────────────────────────── project files (.json) ────────────────────────── */

/**
 * Samples are embedded as base64 on every save. Auto-save runs every few
 * seconds, so re-encoding megabytes of unchanged audio each time would stall
 * the page — a sample's blob never changes, so its encoding is cached.
 */
const base64Cache = new WeakMap<Blob, Promise<string>>();

function blobToBase64(blob: Blob): Promise<string> {
  const cached = base64Cache.get(blob);
  if (cached) return cached;

  const encoded = encodeBase64(blob);
  base64Cache.set(blob, encoded);
  encoded.catch(() => base64Cache.delete(blob));
  return encoded;
}

function encodeBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * Build a self-contained project file. Sample audio is embedded so the file
 * can be moved between machines and still make a sound.
 */
export async function buildProjectFile(
  project: ProjectData,
  session: SessionData,
  includeAssets = true
): Promise<ProjectFile> {
  const assets: SerializedSample[] = [];

  if (includeAssets) {
    for (const id of collectSampleIds(project)) {
      const sample = getSample(id);
      if (!sample || sample.builtIn || !sample.source) continue;

      assets.push({
        id,
        name: sample.name,
        mimeType: sample.source.type || "audio/wav",
        data: await blobToBase64(sample.source)
      });
    }
  }

  return { schemaVersion: SCHEMA_VERSION, project, session, assets };
}

export async function downloadProjectFile(
  project: ProjectData,
  session: SessionData
): Promise<void> {
  const file = await buildProjectFile(project, session);
  const name = sanitizeFilename(project.projectName, "untitled-project");
  downloadBlob(
    new Blob([JSON.stringify(file)], { type: "application/json" }),
    // Same extension as the desktop app, so files move freely between the two.
    `${name}.pulsegrid`
  );
}

export async function readProjectFile(file: File): Promise<unknown> {
  const text = await file.text();

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("That file isn't valid project JSON.");
  }
}

/** Decode and register the samples embedded in a project file. */
export async function registerProjectAssets(
  assets: SerializedSample[] | undefined,
  context: BaseAudioContext
): Promise<number> {
  if (!assets?.length) return 0;

  let count = 0;

  for (const asset of assets) {
    if (hasSample(asset.id)) continue;

    try {
      const blob = base64ToBlob(asset.data, asset.mimeType);
      await loadSampleFromFile(blob, asset.name, context, asset.id);
      count += 1;
    } catch {
      // Skip assets this browser can't decode.
    }
  }

  return count;
}

/** Rough estimate of what the project weighs, for the UI. */
export function estimateProjectSize(project: ProjectData): number {
  let bytes = JSON.stringify(project).length;

  for (const sample of getAllSamples()) {
    if (sample.builtIn || !sample.source) continue;
    bytes += sample.source.size;
  }

  return bytes;
}
