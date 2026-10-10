import { platformText } from "../lib/hotkeys";
import { useEffect, useMemo, useState } from "react";

import { getDesktop, useFileStore, type DesktopProjectEntry } from "../files/desktop";
import { filterByName } from "../lib/search";
import { ListSearch } from "./ListSearch";
import { ToolSection } from "./ToolSection";
import {
  chooseSaveFolder,
  openProjectAt,
  openProjectFromDisk,
  openSaveFolder,
  saveProject,
  toggleAutosave
} from "../files/actions";

export function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(timestamp);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** Re-render every so often so "2 min ago" stays true. */
function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
}

/**
 * The desktop app's project browser: what's open, whether it's saved, and
 * every project in the save folder one click away.
 */
export function ProjectsPanel({ onStatus }: { onStatus: (message: string) => void }) {
  const path = useFileStore((state) => state.path);
  const saveState = useFileStore((state) => state.saveState);
  const lastSavedAt = useFileStore((state) => state.lastSavedAt);
  const settings = useFileStore((state) => state.settings);
  const folderVersion = useFileStore((state) => state.folderVersion);

  const [projects, setProjects] = useState<DesktopProjectEntry[]>([]);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterByName(projects, query, (project) => project.name), [projects, query]);
  useTick(15000);

  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;

    let cancelled = false;
    void desktop
      .listProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [folderVersion, settings?.saveFolder]);

  const run = (action: () => Promise<string>) => {
    void action()
      .then(onStatus)
      .catch((error: unknown) => onStatus(error instanceof Error ? error.message : "That didn't work."));
  };

  const status =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Save failed — check the folder"
        : saveState === "unsaved"
          ? settings?.autosave === false
            ? "Unsaved changes"
            : "Auto-saving…"
          : path && lastSavedAt
            ? `Saved ${timeAgo(lastSavedAt)}`
            : path
              ? "Saved"
              : "Not saved yet";

  return (
    <ToolSection id="projects" title="Projects" summary={path ? path.split(/[\\/]/).pop()?.replace(/\.pulsegrid$/i, "") : status}>
      <div className="projects-panel">
      <div
        className={`save-status save-${!path && saveState === "saved" ? "new" : saveState}`}
        title={path ?? "Saved to the save folder on your first edit"}
      >
        <span className="save-dot" aria-hidden="true" />
        {status}
      </div>

      <div className="projects-actions">
        <button onClick={() => run(saveProject)} title={platformText("Save (Ctrl+S)")}>
          Save
        </button>
        <button onClick={() => run(openProjectFromDisk)} title={platformText("Open a project (Ctrl+O)")}>
          Open…
        </button>
        <button onClick={() => run(() => openSaveFolder("projects"))} title="Show the save folder in File Explorer">
          Folder
        </button>
      </div>

      <ListSearch
        query={query}
        onChange={setQuery}
        total={projects.length}
        shown={visible.length}
        label="Search the projects in the save folder"
      />

      <div className="project-list">
        {projects.length === 0 ? (
          <span className="small-note">No projects in the save folder yet.</span>
        ) : visible.length === 0 ? (
          <span className="small-note">No project matches “{query.trim()}”.</span>
        ) : (
          visible.map((project) => {
            const current = project.path === path;
            return (
              <button
                key={project.path}
                className={`project-item${current ? " current" : ""}`}
                title={project.path}
                onClick={() => {
                  if (!current) run(() => openProjectAt(project.path));
                }}
              >
                <span className="project-item-name">{project.name}</span>
                <em>{current ? "open" : timeAgo(project.modified)}</em>
              </button>
            );
          })
        )}
      </div>

      <label className="autosave-toggle">
        <input
          type="checkbox"
          checked={settings?.autosave !== false}
          onChange={() => run(toggleAutosave)}
        />
        Auto-save
      </label>

      <div className="save-folder" title={settings?.saveFolder}>
        <span className="small-note">{settings?.saveFolder ?? "…"}</span>
        <button onClick={() => run(chooseSaveFolder)}>Change…</button>
      </div>
      </div>
    </ToolSection>
  );
}
