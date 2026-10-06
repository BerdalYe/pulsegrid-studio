import { describe, expect, it } from "vitest";

import { migrateProject } from "./migrations";
import { SCHEMA_VERSION } from "../types";
import { isStepActive } from "../lib/utils";

/** A project saved by the original v1 build. */
const legacyV1 = {
  schemaVersion: 1,
  projectName: "Old Song",
  theme: "cyberpunk-neon",
  bpm: 128,
  swing: 0,
  masterVolume: 0,
  mode: "pattern",
  view: "rack",
  selectedPatternId: "p1",
  selectedChannelId: "kick",
  songBars: 4,
  channels: [
    { id: "kick", name: "Kick", type: "kick", color: "#f00", mute: false, solo: false, volume: 0.9, pan: 0 }
  ],
  patterns: {
    p1: {
      id: "p1",
      name: "Pattern 1",
      length: 16,
      channels: {
        kick: {
          steps: [true, false, false, false, true, false, false, false,
                  true, false, false, false, true, false, false, false],
          notes: []
        }
      }
    }
  },
  patternOrder: ["p1"],
  playlist: {
    tracks: [{ id: "t1", name: "Track 1", mute: false, solo: false }],
    // v1 clips had no `type` and no explicit length.
    clips: [{ id: "c1", patternId: "p1", trackIndex: 0, startStep: 0 }]
  }
};

describe("migrateProject", () => {
  it("upgrades a v1 project to the current schema", () => {
    const { project } = migrateProject(legacyV1);

    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(project.projectName).toBe("Old Song");
    expect(project.bpm).toBe(128);
    expect(project.channels).toHaveLength(1);
  });

  it("converts boolean step lanes into velocity cells", () => {
    const { project } = migrateProject(legacyV1);
    const steps = project.patterns.p1.channels.kick.steps;

    expect(steps).toHaveLength(16);
    expect(isStepActive(steps[0])).toBe(true);
    expect(steps[1]).toBeNull();
    expect(typeof steps[0]).toBe("number");
  });

  it("gives legacy clips a type and an explicit length", () => {
    const { project } = migrateProject(legacyV1);
    const clip = project.playlist.clips[0];

    expect(clip.type).toBe("pattern");
    expect(clip.type === "pattern" && clip.lengthSteps).toBe(16);
  });

  it("moves view state out of the project and into the session", () => {
    const { project, session } = migrateProject(legacyV1);

    expect(session.theme).toBe("cyberpunk-neon");
    expect(session.mode).toBe("pattern");
    expect(session.view).toBe("rack");
    expect("theme" in project).toBe(false);
    expect("view" in project).toBe(false);
  });

  it("preserves a deliberate zero for swing and master volume", () => {
    const { project } = migrateProject(legacyV1);

    expect(project.swing).toBe(0);
    expect(project.masterVolume).toBe(0);
  });

  it("adds a mixer when the old project had none", () => {
    const { project } = migrateProject(legacyV1);

    expect(project.mixer.tracks.length).toBeGreaterThan(0);
    expect(project.mixer.masterEffects).toEqual([]);
  });

  it("reads the current wrapped file format", () => {
    const { project } = migrateProject(legacyV1);
    const wrapped = { schemaVersion: SCHEMA_VERSION, project, session: { theme: "charcoal-studio" } };

    const reloaded = migrateProject(wrapped);
    expect(reloaded.project.projectName).toBe("Old Song");
    expect(reloaded.session.theme).toBe("charcoal-studio");
  });

  it("rejects things that aren't projects", () => {
    expect(() => migrateProject(null)).toThrow();
    expect(() => migrateProject("nope")).toThrow();
  });
});
