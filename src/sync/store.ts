import { create } from "zustand";

import type { Phase, StatusPatch } from "./engine";
import type { CloudRow } from "./types";

/** What the interface shows about syncing. The engine and manager write it; panels only read. */
interface CloudState {
  phase: Phase;
  message: string;
  lastSyncedAt: number | null;
  /** A newer version of the open project is waiting in the cloud. */
  behind: CloudRow | null;
  projects: CloudRow[];
  projectsLoaded: boolean;
  /** The cloud project the open project is linked to, if any. */
  currentId: string | null;
  /** One-off news ("kept the other version…"), shown once in the status bar. */
  notice: string;

  patch(patch: StatusPatch): void;
  setProjects(projects: CloudRow[]): void;
  setCurrentId(id: string | null): void;
  setNotice(notice: string): void;
  reset(): void;
}

const initial = {
  phase: "idle" as Phase,
  message: "",
  lastSyncedAt: null as number | null,
  behind: null as CloudRow | null,
  projects: [] as CloudRow[],
  projectsLoaded: false,
  currentId: null as string | null,
  notice: ""
};

export const useCloudStore = create<CloudState>()((set) => ({
  ...initial,
  patch: (patch) => set((state) => ({ ...state, ...patch })),
  setProjects: (projects) => set({ projects, projectsLoaded: true }),
  setCurrentId: (currentId) => set({ currentId }),
  setNotice: (notice) => set({ notice }),
  reset: () => set({ ...initial })
}));
