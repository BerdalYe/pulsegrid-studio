import { getDesktop } from "../../files/desktop";

/**
 * Where SoundFonts a person has added are kept on this computer, so they are
 * still there next time and a project can find them again. The desktop app
 * keeps them as files in its own data folder; the web studio keeps them in the
 * browser's database. They are never uploaded anywhere.
 */
export interface SavedFont {
  id: string;
  name: string;
  size: number;
}

export interface FontStorage {
  list(): Promise<SavedFont[]>;
  read(id: string): Promise<ArrayBuffer | null>;
  write(id: string, name: string, bytes: ArrayBuffer): Promise<void>;
  remove(id: string): Promise<void>;
}

/* ─────────────────────────────── the browser's database ─────────────────────────────── */

const DATABASE = "pulsegrid-soundfonts";
const STORE = "fonts";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The browser's storage is unavailable."));
  });
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const action = run(db.transaction(STORE, mode).objectStore(STORE));
        action.onsuccess = () => resolve(action.result);
        action.onerror = () => reject(action.error ?? new Error("The browser's storage failed."));
      })
  );
}

const browserStorage: FontStorage = {
  async list() {
    const all = await request<Array<{ id: string; name: string; bytes: ArrayBuffer }>>("readonly", (store) => store.getAll());
    return all.map((entry) => ({ id: entry.id, name: entry.name, size: entry.bytes.byteLength }));
  },
  async read(id) {
    const entry = await request<{ bytes: ArrayBuffer } | undefined>("readonly", (store) => store.get(id));
    return entry?.bytes ?? null;
  },
  async write(id, name, bytes) {
    await request("readwrite", (store) => store.put({ id, name, bytes }));
  },
  async remove(id) {
    await request("readwrite", (store) => store.delete(id));
  }
};

/* ─────────────────────────────── the desktop app's folder ─────────────────────────────── */

function desktopStorage(): FontStorage | null {
  const bridge = getDesktop()?.soundfonts;
  if (!bridge) return null;

  return {
    list: () => bridge.list(),
    async read(id) {
      const bytes = await bridge.read(id);
      if (!bytes) return null;
      // Copy into a buffer of its own, so the whole thing can be read in place.
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      return copy;
    },
    write: (id, name, bytes) => bridge.write(id, name, bytes),
    remove: (id) => bridge.remove(id)
  };
}

/** The storage for this system: the desktop app's folder, or the browser's database. */
export function fontStorage(): FontStorage | null {
  const desktop = desktopStorage();
  if (desktop) return desktop;
  return typeof indexedDB !== "undefined" ? browserStorage : null;
}
