import { describe, expect, it } from "vitest";

import { createWebIdentity } from "./webIdentity";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  };
}

function ids() {
  let next = 0;
  return () => `id-${++next}`;
}

describe("the web studio's project identity", () => {
  it("has no sync key until the working copy has been saved in this browser", () => {
    const identity = createWebIdentity(memoryStorage(), ids());
    expect(identity.key()).toBeNull();

    identity.markSaved();
    expect(identity.key()).toMatch(/^browser:/);
  });

  it("gives a replaced project a new key, so it can't take over the old one's cloud copy", () => {
    const identity = createWebIdentity(memoryStorage(), ids());
    identity.markSaved();
    const first = identity.key();

    // "New project", a demo or an opened file replaces the working copy.
    const second = identity.replace(false);

    expect(second).not.toBe(first);
    // Until it is saved it has no key at all, so nothing is uploaded for it.
    expect(identity.key()).toBeNull();

    identity.markSaved();
    expect(identity.key()).toBe(second);
    expect(identity.key()).not.toBe(first);
  });

  it("starts a project that came from the cloud as already saved", () => {
    const identity = createWebIdentity(memoryStorage(), ids());
    const key = identity.replace(true);
    expect(identity.key()).toBe(key);
  });

  it("keeps the same project after a reload", () => {
    const storage = memoryStorage();

    const before = createWebIdentity(storage, ids());
    before.markSaved();
    const key = before.key();

    // A new page load: the restored working copy counts as saved again.
    const after = createWebIdentity(storage, () => "something-else");
    after.markSaved();
    expect(after.key()).toBe(key);
  });

  it("still works for this visit when browser storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    };

    const identity = createWebIdentity(blocked, ids());
    identity.markSaved();
    const first = identity.key();
    expect(first).toMatch(/^browser:/);
    expect(identity.replace(false)).not.toBe(first);

    expect(createWebIdentity(null, ids()).key()).toBeNull();
  });
});
