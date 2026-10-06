import type { KeyValueStore } from "./links";

/**
 * The web studio keeps one working copy, so "which project is this?" needs an
 * answer that changes whenever the copy is replaced: a new project, a demo, an
 * opened file. Without it, a new project would be uploaded over the previous
 * project's cloud copy.
 *
 * Every replacement gets a fresh id. And the copy only has a sync key once it
 * has actually been saved in this browser, so a demo being looked at, or an
 * empty new project, is never uploaded.
 */
const STORAGE_KEY = "pulsegrid:web-project";

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function createWebIdentity(
  storage: KeyValueStore | null = browserStorage(),
  makeId: () => string = () => crypto.randomUUID()
) {
  let id: string | null = null;
  let saved = false;

  const remember = () => {
    try {
      if (id) storage?.setItem(STORAGE_KEY, id);
    } catch {
      /* blocked storage: the id lasts for this visit */
    }
  };

  const current = (): string => {
    if (id) return id;

    try {
      id = storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      /* see above */
    }

    if (!id) {
      id = makeId();
      remember();
    }
    return id;
  };

  return {
    /** What syncing calls this project, or null while it hasn't been saved here. */
    key: (): string | null => (saved ? `browser:${current()}` : null),

    /** The working copy was just stored in this browser. */
    markSaved(): void {
      saved = true;
    },

    /** The working copy was replaced by a different project. Returns its new key. */
    replace(isSaved: boolean): string {
      id = makeId();
      saved = isSaved;
      remember();
      return `browser:${id}`;
    }
  };
}
