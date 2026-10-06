import { SCHEMA_VERSION, type ProjectData, type ProjectFile, type SessionData } from "../types";
import { sanitizeProjectData, sanitizeSession } from "../state/initialState";

export interface LoadedProject {
  project: ProjectData;
  session: SessionData;
  assets: ProjectFile["assets"];
}

/**
 * Bring any older save into the current shape.
 *
 * v1 → v2  legacy playlist clips gain a `type`, channels gain mixer routing.
 * v2 → v3  step lanes move from `boolean[]` to velocity cells, and view state
 *          (theme, mode, selection) moves out of the project into the session.
 *
 * Everything then goes through `sanitizeProjectData`, which is the single
 * place that decides what a valid project looks like.
 */
export function migrateProject(raw: unknown): LoadedProject {
  if (!raw || typeof raw !== "object") {
    throw new Error("That file doesn't look like a PulseGrid project.");
  }

  const source = raw as Record<string, unknown>;

  // v3 project file: { schemaVersion, project, session, assets }
  const isWrapped = source.project !== undefined && typeof source.project === "object";

  const rawProject = (isWrapped ? source.project : source) as Record<string, unknown>;
  const rawSession = (isWrapped ? source.session : source) as Record<string, unknown>;

  const upgraded = { ...rawProject };

  // Copy the playlist before rewriting it. `{ ...rawProject }` is shallow, so
  // writing to `upgraded.playlist.clips` would write straight through to the
  // caller's object — and throw outright on a frozen one, which is what every
  // project object produced by immer is.
  if (upgraded.playlist && typeof upgraded.playlist === "object") {
    const source = upgraded.playlist as Record<string, unknown>;
    upgraded.playlist = {
      ...source,
      clips: Array.isArray(source.clips) ? [...source.clips] : source.clips
    };
  }

  // v1 → v2: playlist clips used to be bare pattern references.
  const playlist = upgraded.playlist as Record<string, unknown> | undefined;
  if (playlist && Array.isArray(playlist.clips)) {
    playlist.clips = playlist.clips.map((entry) => {
      const clip = (entry ?? {}) as Record<string, unknown>;
      if (clip.type) return clip;
      return { ...clip, type: "pattern" };
    });
  }

  // v2 → v3: pattern clips need an explicit length so they no longer depend on
  // the pattern's current length at playback time.
  if (playlist && Array.isArray(playlist.clips)) {
    const patterns = (upgraded.patterns ?? {}) as Record<string, { length?: number }>;

    playlist.clips = playlist.clips.map((entry) => {
      const clip = (entry ?? {}) as Record<string, unknown>;
      if (clip.type !== "pattern" || clip.lengthSteps !== undefined) return clip;

      const patternId = typeof clip.patternId === "string" ? clip.patternId : "";
      return { ...clip, lengthSteps: patterns[patternId]?.length ?? 16 };
    });
  }

  upgraded.schemaVersion = SCHEMA_VERSION;

  const project = sanitizeProjectData(upgraded);
  const session = sanitizeSession(rawSession, project);

  const assets = Array.isArray(source.assets)
    ? (source.assets as ProjectFile["assets"])
    : undefined;

  return { project, session, assets };
}
