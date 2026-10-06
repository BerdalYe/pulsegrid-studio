import { describe, expect, it } from "vitest";

import { createInitialProjectData, sanitizeProjectData } from "./initialState";
import {
  DEFAULT_TRACK_HEIGHT,
  MAX_BPM,
  MAX_TRACK_HEIGHT,
  MIN_BPM,
  MIN_TRACK_HEIGHT
} from "../lib/utils";

describe("sanitizeProjectData", () => {
  it("falls back to a fresh project for junk input", () => {
    // A fresh project is empty, so the guarantee is a usable shell: one
    // pattern to write into, a full mixer, and no channels invented for you.
    for (const junk of [null, undefined, "not a project", 42, []]) {
      const project = sanitizeProjectData(junk);
      expect(project.patternOrder.length).toBe(1);
      expect(project.patterns[project.patternOrder[0]]).toBeDefined();
      // Three empty drum channels to start on, and nothing written yet.
      expect(project.channels.map((channel) => channel.type)).toEqual(["kick", "snare", "hat"]);
      for (const lane of Object.values(project.patterns[project.patternOrder[0]].channels)) {
        expect(lane.notes).toEqual([]);
        expect(lane.steps.every((cell) => cell === null)).toBe(true);
      }
      expect(project.mixer.tracks.length).toBeGreaterThan(0);
      expect(project.playlist.clips).toEqual([]);
    }
  });

  it("clamps a tempo that would break the scheduler", () => {
    expect(sanitizeProjectData({ bpm: -5 }).bpm).toBe(MIN_BPM);
    expect(sanitizeProjectData({ bpm: 0 }).bpm).toBe(MIN_BPM);
    expect(sanitizeProjectData({ bpm: 99999 }).bpm).toBe(MAX_BPM);
    expect(sanitizeProjectData({ bpm: "fast" }).bpm).toBe(createInitialProjectData().bpm);
  });

  it("keeps zero swing and zero master volume", () => {
    const clean = sanitizeProjectData({ swing: 0, masterVolume: 0 });
    expect(clean.swing).toBe(0);
    expect(clean.masterVolume).toBe(0);
  });

  it("drops clips that point at a track or pattern that doesn't exist", () => {
    const base = createInitialProjectData();
    const patternId = base.patternOrder[0];

    const clean = sanitizeProjectData({
      ...base,
      playlist: {
        tracks: [{ id: "t1", name: "Track 1", mute: false, solo: false }],
        clips: [
          { id: "ok", type: "pattern", patternId, trackIndex: 0, startStep: 0, lengthSteps: 16 },
          { id: "bad-track", type: "pattern", patternId, trackIndex: 99, startStep: 0 },
          { id: "bad-pattern", type: "pattern", patternId: "ghost", trackIndex: 0, startStep: 0 },
          { id: "bad-audio", type: "audio", trackIndex: 0, startStep: 0 }
        ]
      }
    });

    expect(clean.playlist.clips.map((clip) => clip.id)).toEqual(["ok"]);
  });

  it("repairs an out-of-range trim so start always precedes end", () => {
    const base = createInitialProjectData();
    const clean = sanitizeProjectData({
      ...base,
      channels: [{ ...base.channels[0], trimStart: 0.9, trimEnd: 0.2 }]
    });

    const channel = clean.channels[0];
    expect(channel.trimStart).toBeLessThan(channel.trimEnd!);
  });

  it("keeps the pattern order in step with the patterns that exist", () => {
    const base = createInitialProjectData();
    const patternId = base.patternOrder[0];

    const clean = sanitizeProjectData({
      ...base,
      patternOrder: [patternId, "ghost-pattern"]
    });

    expect(clean.patternOrder).toEqual([patternId]);
  });

  it("gives every channel a lane in every pattern", () => {
    const base = createInitialProjectData();
    const patternId = base.patternOrder[0];

    const clean = sanitizeProjectData({
      ...base,
      patterns: {
        [patternId]: { id: patternId, name: "P", length: 8, channels: {} }
      }
    });

    for (const channel of clean.channels) {
      expect(clean.patterns[patternId].channels[channel.id].steps).toHaveLength(8);
    }
  });

  it("discards effects with an unknown type but keeps valid ones", () => {
    const base = createInitialProjectData();
    const clean = sanitizeProjectData({
      ...base,
      mixer: {
        tracks: [
          {
            id: 1,
            name: "Insert 1",
            volume: 1,
            pan: 0,
            mute: false,
            solo: false,
            effects: [
              { id: "e1", type: "reverb", name: "Reverb", enabled: true, params: { decay: 3 } },
              { id: "e2", type: "quantum-flux", name: "???", enabled: true, params: {} }
            ]
          }
        ],
        masterEffects: []
      }
    });

    const effects = clean.mixer.tracks[0].effects;
    expect(effects).toHaveLength(1);
    expect(effects[0].type).toBe("reverb");
    // Missing params are filled in from the defaults.
    expect(effects[0].params.decay).toBe(3);
    expect(effects[0].params.mix).toBeTypeOf("number");
  });
});

describe("playlist lanes and markers", () => {
  it("gives every lane a height and a colour", () => {
    const project = sanitizeProjectData(null);

    for (const track of project.playlist.tracks) {
      expect(track.height).toBe(DEFAULT_TRACK_HEIGHT);
      expect(track.color).toMatch(/^#[0-9a-f]{6}$/i);
    }

    // Neighbouring lanes have to be told apart at a glance.
    const colors = project.playlist.tracks.map((track) => track.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("repairs lane heights and colours that would break the layout", () => {
    const base = createInitialProjectData();
    const project = sanitizeProjectData({
      ...base,
      playlist: {
        ...base.playlist,
        tracks: [
          { id: "a", name: "Tall", mute: false, solo: false, height: 9000, color: "#ff0000" },
          { id: "b", name: "Flat", mute: false, solo: false, height: 0, color: "#00ff00" },
          { id: "c", name: "Odd", mute: false, solo: false, height: "big", color: "rgb(1,2,3)" }
        ]
      }
    });

    const [tall, flat, odd] = project.playlist.tracks;
    expect(tall.height).toBe(MAX_TRACK_HEIGHT);
    expect(flat.height).toBe(MIN_TRACK_HEIGHT);
    expect(odd.height).toBe(DEFAULT_TRACK_HEIGHT);
    // Only real hex survives; anything else falls back to the palette.
    expect(odd.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tall.color).toBe("#ff0000");
  });

  it("puts markers in order, one per step, with names", () => {
    const base = createInitialProjectData();
    const project = sanitizeProjectData({
      ...base,
      playlist: {
        ...base.playlist,
        markers: [
          { id: "m2", name: "Chorus", step: 64 },
          { id: "m1", name: "  Intro  ", step: 0 },
          { id: "dupe", name: "Also bar 1", step: 0 },
          { name: "", step: -12 }
        ]
      }
    });

    const markers = project.playlist.markers;
    expect(markers.map((marker) => marker.step)).toEqual([0, 64]);
    expect(markers[0].name).toBe("Intro");
    expect(markers[1].name).toBe("Chorus");
  });

  it("drops a markers field that isn't a list", () => {
    const base = createInitialProjectData();
    const project = sanitizeProjectData({
      ...base,
      playlist: { ...base.playlist, markers: { verse: 16 } }
    });

    expect(project.playlist.markers).toEqual([]);
  });
});
