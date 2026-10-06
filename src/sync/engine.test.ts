import { describe, expect, it, vi } from "vitest";

import { createSyncEngine, renameProjectText, type ProjectAdapter, type StatusPatch } from "./engine";
import { pack, unpack } from "./gzip";
import { emptyState, loadSyncState, saveSyncState } from "./links";
import {
  CloudError,
  type CloudRow,
  type CommitArgs,
  type CommitResult,
  type SyncBackend
} from "./types";

const USER = "11111111-1111-4111-8111-111111111111";

/** The server, in memory, following the same rules as supabase/schema.sql. */
class FakeCloud implements SyncBackend {
  rows = new Map<string, CloudRow>();
  objects = new Map<string, Blob>();
  quotaBytes = Number.POSITIVE_INFINITY;
  offline = false;
  commits = 0;

  private guard() {
    if (this.offline) throw new CloudError("offline", "offline");
  }

  async list() {
    this.guard();
    return [...this.rows.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async get(id: string) {
    this.guard();
    return this.rows.get(id) ?? null;
  }

  async upload(path: string, data: Blob) {
    this.guard();
    if (!path.startsWith(`${USER}/`)) throw new Error("not your folder");
    this.objects.set(path, data);
  }

  async download(path: string) {
    this.guard();
    const blob = this.objects.get(path);
    if (!blob) throw new Error(`no file at ${path}`);
    return blob;
  }

  async remove(paths: string[]) {
    this.guard();
    for (const path of paths) this.objects.delete(path);
  }

  async deleteRow(id: string) {
    this.guard();
    const row = this.rows.get(id);
    this.rows.delete(id);
    return row?.object_path ?? null;
  }

  async commit(args: CommitArgs): Promise<CommitResult> {
    this.guard();
    this.commits += 1;
    const current = this.rows.get(args.id);
    const used = [...this.rows.values()]
      .filter((row) => row.id !== args.id)
      .reduce((sum, row) => sum + row.size_bytes, 0);

    if (used + args.size > this.quotaBytes) return { ok: false, reason: "quota" };

    const stamp = new Date(2026, 0, 1, 0, 0, this.commits).toISOString();

    if (!current) {
      if (args.base !== 0) return { ok: false, reason: "missing" };
      this.rows.set(args.id, {
        id: args.id,
        name: args.name,
        revision: 1,
        object_path: args.path,
        size_bytes: args.size,
        device: args.device,
        updated_at: stamp
      });
      return { ok: true, revision: 1, oldPath: null };
    }

    if (current.revision !== args.base) {
      return { ok: false, reason: "conflict", revision: current.revision };
    }

    this.rows.set(args.id, {
      ...current,
      name: args.name,
      revision: current.revision + 1,
      object_path: args.path,
      size_bytes: args.size,
      device: args.device,
      updated_at: stamp
    });
    return { ok: true, revision: current.revision + 1, oldPath: current.object_path };
  }
}

let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const fileText = (content: string, name = "Song") =>
  JSON.stringify({ schemaVersion: 1, project: { projectName: name }, content });

const contentOf = (text: string) => (JSON.parse(text) as { content: string }).content;

/** One PC with one open project. */
const last = <T,>(items: T[]): T | undefined => items[items.length - 1];

function device(cloud: FakeCloud, label: string, key: string | null = "song") {
  const project = {
    key,
    name: "Song",
    content: "start",
    revision: 0,
    dirty: false,
    busy: false,
    applied: [] as string[]
  };

  const adapter: ProjectAdapter = {
    key: () => project.key,
    path: () => project.key,
    name: () => project.name,
    text: async () => fileText(project.content, project.name),
    revision: () => project.revision,
    isDirty: () => project.dirty,
    busy: () => project.busy,
    apply: async (text) => {
      project.content = contentOf(text);
      project.applied.push(project.content);
      project.dirty = false;
    }
  };

  const state = emptyState();
  const statuses: StatusPatch[] = [];
  const notices: string[] = [];

  const engine = createSyncEngine({
    backend: cloud,
    userId: USER,
    state,
    persist: () => undefined,
    adapter,
    device: label,
    uuid: nextId,
    onStatus: (patch) => statuses.push(patch),
    onNotice: (message) => notices.push(message)
  });

  return {
    project,
    state,
    engine,
    statuses,
    notices,
    /** Edit and save, the way auto-save does. */
    save(content: string) {
      project.content = content;
      project.revision += 1;
      project.dirty = false;
      engine.markPending();
    },
    edit(content: string) {
      project.content = content;
      project.revision += 1;
      project.dirty = true;
    },
    lastPhase: () => last(statuses.filter((patch) => patch.phase))?.phase
  };
}

async function cloudContent(cloud: FakeCloud, id: string): Promise<string> {
  const row = cloud.rows.get(id);
  if (!row) throw new Error("no such project");
  return contentOf(await unpack(cloud.objects.get(row.object_path) as Blob));
}

describe("uploading", () => {
  it("puts a new project in the cloud and remembers where it is", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");

    expect(await pc.engine.push()).toBe("pushed");

    const [row] = await cloud.list();
    expect(row.name).toBe("Song");
    expect(row.revision).toBe(1);
    expect(row.object_path.startsWith(`${USER}/${row.id}/`)).toBe(true);
    expect(await cloudContent(cloud, row.id)).toBe("start");

    expect(pc.state.links.song).toMatchObject({ cloudId: row.id, base: 1, pending: false });
    expect(pc.lastPhase()).toBe("synced");
  });

  it("replaces the file on every later upload and cleans up the old one", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    await pc.engine.push();

    pc.save("second");
    await pc.engine.push();
    pc.save("third");
    await pc.engine.push();

    expect(cloud.rows.size).toBe(1);
    const [row] = await cloud.list();
    expect(row.revision).toBe(3);
    expect(await cloudContent(cloud, row.id)).toBe("third");
    // Only the newest file is kept.
    await Promise.resolve();
    expect(cloud.objects.size).toBe(1);
  });

  it("stores compressed files that read back exactly", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    pc.project.content = "x".repeat(50_000);
    await pc.engine.push();

    const [row] = await cloud.list();
    expect(row.size_bytes).toBeLessThan(2_000);
    expect(await cloudContent(cloud, row.id)).toBe("x".repeat(50_000));
  });

  it("does nothing for a project that hasn't been saved anywhere yet", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1", null);

    expect(await pc.engine.push()).toBe("skipped");
    expect(cloud.commits).toBe(0);
    expect(pc.lastPhase()).toBe("unsaved");
  });

  it("does nothing for a project the user switched syncing off for", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    pc.engine.setEnabled(false);

    expect(await pc.engine.push()).toBe("skipped");
    expect(cloud.commits).toBe(0);
    expect(pc.lastPhase()).toBe("excluded");

    pc.engine.setEnabled(true);
    expect(await pc.engine.push()).toBe("pushed");
  });

  it("keeps the change for later while offline", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    await pc.engine.push();

    pc.save("offline edit");
    cloud.offline = true;
    await expect(pc.engine.push()).rejects.toMatchObject({ kind: "offline" });
    expect(pc.state.links.song.pending).toBe(true);

    cloud.offline = false;
    expect(await pc.engine.reconcile(false)).toBe("pushed");
    const [row] = await cloud.list();
    expect(await cloudContent(cloud, row.id)).toBe("offline edit");
  });

  it("notices edits made while the upload was running", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    const upload = cloud.upload.bind(cloud);
    cloud.upload = async (path, data) => {
      await upload(path, data);
      pc.edit("typed during the upload");
    };

    await pc.engine.push();
    expect(pc.state.links.song.pending).toBe(true);
  });

  it("never uploads text that may belong to a different project", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    const original = pc.project;
    const read = vi.fn(async () => {
      // The user opens another project while the text is being read.
      original.key = "other-song";
      return fileText("other project's content", "Other");
    });
    const adapter = {
      key: () => original.key,
      path: () => original.key,
      name: () => "Song",
      text: read,
      revision: () => 0,
      isDirty: () => false,
      busy: () => false,
      apply: async () => undefined
    } satisfies ProjectAdapter;

    const engine = createSyncEngine({
      backend: cloud,
      userId: USER,
      state: emptyState(),
      persist: () => undefined,
      adapter,
      device: "PC 1",
      uuid: nextId
    });

    expect(await engine.push()).toBe("retry");
    expect(cloud.commits).toBe(0);
    expect(cloud.objects.size).toBe(0);
  });

  it("waits while another project is opening", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    pc.project.busy = true;
    expect(await pc.engine.push()).toBe("retry");
    expect(cloud.commits).toBe(0);
  });
});

describe("the same project on two PCs", () => {
  async function twoPcs() {
    const cloud = new FakeCloud();
    const pc1 = device(cloud, "PC 1");
    await pc1.engine.push();

    // PC 2 downloads it, the way "Open from the cloud" does.
    const pc2 = device(cloud, "PC 2");
    const [row] = await cloud.list();
    pc2.project.content = contentOf(await pc2.engine.fetchText(row));
    pc2.engine.setLink("song", { cloudId: row.id, base: row.revision, pending: false });

    return { cloud, pc1, pc2, id: row.id };
  }

  it("brings a newer version across when nothing was changed here", async () => {
    const { cloud, pc1, pc2, id } = await twoPcs();
    pc1.save("PC 1 was here");
    await pc1.engine.push();

    expect(await pc2.engine.reconcile(true)).toBe("applied");
    expect(pc2.project.content).toBe("PC 1 was here");
    expect(pc2.state.links.song).toMatchObject({ cloudId: id, base: 2, pending: false });
    expect(pc2.notices[0]).toContain("Loaded the newest version");
    expect(cloud.commits).toBe(2);
  });

  it("only tells the user when the project is already open and the cloud moved on", async () => {
    const { pc1, pc2 } = await twoPcs();
    pc1.save("PC 1 was here");
    await pc1.engine.push();

    expect(await pc2.engine.reconcile(false)).toBe("behind");
    expect(pc2.project.content).toBe("start");
    expect(last(pc2.statuses)).toMatchObject({ phase: "behind", behind: { revision: 2 } });

    // The user chooses to load it.
    const row = last(pc2.statuses)?.behind as CloudRow;
    expect(await pc2.engine.load(row)).toBe("applied");
    expect(pc2.project.content).toBe("PC 1 was here");
  });

  it("keeps both versions when each PC changed it", async () => {
    const { cloud, pc1, pc2, id } = await twoPcs();

    pc1.save("version from PC 1");
    await pc1.engine.push();
    pc2.save("version from PC 2");

    expect(await pc2.engine.reconcile(true)).toBe("pushed");

    // The original now holds PC 2's version…
    expect(await cloudContent(cloud, id)).toBe("version from PC 2");

    // …and PC 1's version lives on as a project of its own.
    const rows = await cloud.list();
    expect(rows).toHaveLength(2);
    const copy = rows.find((row) => row.id !== id) as CloudRow;
    expect(copy.name).toBe("Song (other version)");
    expect(await cloudContent(cloud, copy.id)).toBe("version from PC 1");
    const copyFile = JSON.parse(await unpack(cloud.objects.get(copy.object_path) as Blob)) as {
      project: { projectName: string };
    };
    expect(copyFile.project.projectName).toBe("Song (other version)");

    expect(last(pc2.notices)).toContain("Song (other version)");
    expect(pc2.state.links.song.pending).toBe(false);

    // PC 1 then simply picks up PC 2's version.
    expect(await pc1.engine.reconcile(true)).toBe("applied");
    expect(pc1.project.content).toBe("version from PC 2");
  });

  it("also keeps both when the second PC had unsaved edits open", async () => {
    const { cloud, pc1, pc2, id } = await twoPcs();
    pc1.save("version from PC 1");
    await pc1.engine.push();
    pc2.edit("typing right now on PC 2");

    expect(await pc2.engine.reconcile(false)).toBe("pushed");
    expect(await cloudContent(cloud, id)).toBe("typing right now on PC 2");
    expect(cloud.rows.size).toBe(2);
  });

  it("never loses the other version if keeping it fails", async () => {
    const { cloud, pc1, pc2, id } = await twoPcs();
    pc1.save("version from PC 1");
    await pc1.engine.push();
    pc2.save("version from PC 2");

    // Room for the existing project but not for a second copy of it.
    const [row] = await cloud.list();
    cloud.quotaBytes = row.size_bytes + 1;

    await expect(pc2.engine.push()).rejects.toMatchObject({ kind: "quota" });
    expect(await cloudContent(cloud, id)).toBe("version from PC 1");
    expect(cloud.rows.size).toBe(1);
  });

  it("puts a project back if it was deleted elsewhere while this PC kept it", async () => {
    const { cloud, pc2, id } = await twoPcs();
    await cloud.deleteRow(id);
    pc2.save("kept on PC 2");

    expect(await pc2.engine.push()).toBe("pushed");
    expect(cloud.rows.size).toBe(1);
    const [row] = await cloud.list();
    expect(await cloudContent(cloud, row.id)).toBe("kept on PC 2");
  });

  it("stops syncing a project that was removed elsewhere and not changed here, and says so", async () => {
    const { cloud, pc2, id } = await twoPcs();
    await cloud.deleteRow(id);

    expect(await pc2.engine.reconcile(true)).toBe("skipped");
    expect(cloud.rows.size).toBe(0);
    expect(pc2.state.links.song).toBeUndefined();
    expect(pc2.state.excluded.song).toBe(true);
    expect(pc2.lastPhase()).toBe("excluded");
    expect(last(pc2.notices)).toContain("removed from your cloud on another PC");

    // Turning syncing back on puts it up again.
    pc2.engine.setEnabled(true);
    expect(await pc2.engine.push()).toBe("pushed");
    expect(cloud.rows.size).toBe(1);
  });

});

describe("limits and housekeeping", () => {
  it("explains a full account and leaves the cloud untouched", async () => {
    const cloud = new FakeCloud();
    cloud.quotaBytes = 10;
    const pc = device(cloud, "PC 1");

    await expect(pc.engine.push()).rejects.toMatchObject({ kind: "quota" });
    expect(cloud.rows.size).toBe(0);
    // The file that was uploaded for it is removed again.
    expect(cloud.objects.size).toBe(0);
  });

  it("removes a project from the cloud and stops syncing it here", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    await pc.engine.push();
    const [row] = await cloud.list();

    await pc.engine.removeFromCloud(row.id);

    expect(cloud.rows.size).toBe(0);
    expect(cloud.objects.size).toBe(0);
    expect(pc.state.links.song).toBeUndefined();
    expect(pc.state.excluded.song).toBe(true);
    // Editing it afterwards doesn't put it back.
    pc.save("more edits");
    expect(await pc.engine.push()).toBe("skipped");
    expect(cloud.rows.size).toBe(0);
  });

  it("knows whether everything is already in the cloud", async () => {
    const cloud = new FakeCloud();
    const pc = device(cloud, "PC 1");
    expect(pc.engine.isCurrentSafe()).toBe(false);

    await pc.engine.push();
    expect(pc.engine.isCurrentSafe()).toBe(true);
    expect(pc.engine.needsPush()).toBe(false);

    pc.save("changed");
    expect(pc.engine.isCurrentSafe()).toBe(false);
    expect(pc.engine.needsPush()).toBe(true);
  });
});

describe("helpers", () => {
  it("renames a project file without touching anything else", () => {
    const renamed = JSON.parse(renameProjectText(fileText("abc", "Old"), "New")) as {
      project: { projectName: string };
      content: string;
    };
    expect(renamed.project.projectName).toBe("New");
    expect(renamed.content).toBe("abc");
    expect(renameProjectText("not json", "New")).toBe("not json");
  });

  it("compresses and restores text, and still reads plain files", async () => {
    const text = JSON.stringify({ notes: [1, 2, 3], audio: "AAAA".repeat(5000) });
    const packed = await pack(text);
    expect(packed.size).toBeLessThan(text.length / 10);
    expect(await unpack(packed)).toBe(text);
    expect(await unpack(new Blob([text]))).toBe(text);
  });

  it("stores each account's links separately and survives damaged storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    };

    const state = emptyState();
    state.links.a = { cloudId: "c1", base: 3, pending: true, path: "C:\\A.pulsegrid" };
    state.excluded.b = true;
    saveSyncState("user-1", state, storage);

    expect(loadSyncState("user-1", storage)).toEqual(state);
    expect(loadSyncState("user-2", storage)).toEqual(emptyState());

    store.set("pulsegrid:sync:user-1", "{ not json");
    expect(loadSyncState("user-1", storage)).toEqual(emptyState());

    store.set(
      "pulsegrid:sync:user-1",
      JSON.stringify({ links: { ok: { cloudId: "c", base: 1, pending: false }, bad: { base: "x" } } })
    );
    expect(Object.keys(loadSyncState("user-1", storage).links)).toEqual(["ok"]);
  });
});
