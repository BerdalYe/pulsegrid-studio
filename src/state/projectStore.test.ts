import { beforeEach, describe, expect, it } from "vitest";

import { useProjectStore } from "./projectStore";
import { getProjectData } from "./serialize";
import { canUndo, clearHistory } from "./history";
import { sanitizeProjectData } from "./initialState";
import {
  DEFAULT_TRACK_HEIGHT,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  trackColorAt
} from "../lib/utils";

const store = () => useProjectStore.getState();
const snapshot = () => JSON.stringify(getProjectData(store()));

const firstPattern = () => store().patternOrder[0];
const firstChannel = () => store().channels[0].id;

beforeEach(() => {
  store().reset();

  // A new project is empty by design, so the fixtures make their own channels.
  store().addChannel("kick", "Kick");
  store().addChannel("synth", "Lead", undefined, "grand-piano");

  clearHistory();
});

describe("undo grouping", () => {
  it("collapses one gesture into a single undo entry", () => {
    const before = snapshot();

    store().beginEdit("Paint steps");
    store().toggleStep(firstPattern(), firstChannel(), 1);
    store().toggleStep(firstPattern(), firstChannel(), 2);
    store().toggleStep(firstPattern(), firstChannel(), 3);
    store().endEdit();

    expect(snapshot()).not.toBe(before);

    store().undo();
    expect(snapshot()).toBe(before);
  });

  it("stops swallowing later edits once the gesture is closed", () => {
    store().beginEdit("Move note");
    store().setBpm(151);
    store().endEdit();

    // These are separate actions and must each be undoable on their own.
    store().setBpm(152);
    store().setBpm(153);

    expect(store().bpm).toBe(153);
    store().undo();
    expect(store().bpm).toBe(152);
    store().undo();
    expect(store().bpm).toBe(151);
  });
});

describe("edit() no-op detection", () => {
  it("records nothing when an action changes nothing", () => {
    store().setBpm(150);
    const depthBefore = canUndo();

    store().setBpm(150);
    store().renamePattern(firstPattern(), store().patterns[firstPattern()].name);

    expect(canUndo()).toBe(depthBefore);

    store().undo();
    // A single undo must land on the value from before setBpm(150), not on 150.
    expect(store().bpm).not.toBe(150);
  });

  it("ignores a step written to a channel that does not exist", () => {
    const before = snapshot();

    store().setStep(firstPattern(), "no-such-channel", 0, 0.8);

    expect(snapshot()).toBe(before);
    expect(store().patterns[firstPattern()].channels["no-such-channel"]).toBeUndefined();
  });
});

describe("referential integrity", () => {
  it("undo restores a deleted channel and its lanes together", () => {
    const before = snapshot();
    const target = firstChannel();

    store().removeChannel(target);
    expect(store().channels.some((channel) => channel.id === target)).toBe(false);

    store().undo();
    expect(snapshot()).toBe(before);
  });

  it("keeps every pattern lane in step with the channel list", () => {
    const added = store().addChannel("synth", "Lead");

    for (const patternId of store().patternOrder) {
      expect(Object.keys(store().patterns[patternId].channels).sort()).toEqual(
        store().channels.map((channel) => channel.id).sort()
      );
    }

    store().removeChannel(added);

    for (const patternId of store().patternOrder) {
      expect(store().patterns[patternId].channels[added]).toBeUndefined();
    }
  });
});

describe("sanitizeProjectData invariants", () => {
  const invariants = (raw: unknown) => {
    const project = sanitizeProjectData(raw);
    const ids = project.channels.map((channel) => channel.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const pattern of Object.values(project.patterns)) {
      expect(Object.keys(pattern.channels).sort()).toEqual([...ids].sort());

      for (const lane of Object.values(pattern.channels)) {
        expect(lane.steps.length).toBe(pattern.length);

        for (const note of lane.notes) {
          expect(note.start).toBeGreaterThanOrEqual(0);
          expect(note.start).toBeLessThan(pattern.length);
          expect(note.start + note.length).toBeLessThanOrEqual(pattern.length);
        }
      }
    }

    for (const channel of project.channels) {
      expect(channel.mixerTrackId).toBeGreaterThanOrEqual(1);
      expect(channel.mixerTrackId).toBeLessThanOrEqual(project.mixer.tracks.length);
    }

    for (const clip of project.playlist.clips) {
      if (clip.type === "pattern") expect(project.patterns[clip.patternId]).toBeDefined();
    }

    return project;
  };

  it("holds for a healthy project", () => {
    invariants(getProjectData(store()));
  });

  it("mints a fresh id when two channels collide", () => {
    const good = JSON.parse(JSON.stringify(getProjectData(store())));
    good.channels = [good.channels[0], { ...good.channels[1], id: good.channels[0].id }];

    const project = invariants(good);
    expect(project.channels).toHaveLength(2);
  });

  it("drops notes that sit past the end of their pattern", () => {
    const good = JSON.parse(JSON.stringify(getProjectData(store())));
    const patternId = good.patternOrder[0];
    const channelId = good.channels[0].id;

    good.patterns[patternId].channels[channelId].notes = [
      { id: "wild", pitch: 60, start: 900, length: 400, velocity: 100 }
    ];

    invariants(good);
  });

  it("builds default lanes from the real channels when patterns are unusable", () => {
    const good = JSON.parse(JSON.stringify(getProjectData(store())));
    good.patterns = {};
    good.patternOrder = [];

    invariants(good);
  });

  it("does not re-key patterns supplied as an array", () => {
    const good = JSON.parse(JSON.stringify(getProjectData(store())));
    good.patterns = [good.patterns[good.patternOrder[0]]];

    const project = invariants(good);
    expect(project.patternOrder.length).toBeGreaterThan(0);
  });

  it("clamps effect parameters to their declared range", () => {
    const good = JSON.parse(JSON.stringify(getProjectData(store())));
    good.mixer.masterEffects = [
      {
        id: "d",
        type: "delay",
        name: "Delay",
        enabled: true,
        params: { time: 99, feedback: 5, mix: -2, cutoff: 1e9 }
      }
    ];

    const project = sanitizeProjectData(good);
    const params = project.mixer.masterEffects[0].params;

    expect(params.feedback).toBeLessThanOrEqual(0.95);
    expect(params.mix).toBeGreaterThanOrEqual(0);
    expect(params.time).toBeLessThanOrEqual(2);
    expect(params.cutoff).toBeLessThanOrEqual(18000);
  });

  it("is idempotent", () => {
    const once = sanitizeProjectData(getProjectData(store()));
    const twice = sanitizeProjectData(once);
    expect(twice).toEqual(once);
  });
});

describe("markers", () => {
  it("keeps one marker per step and stays in timeline order", () => {
    store().addMarker(64, "Chorus");
    store().addMarker(0, "Intro");

    expect(store().playlist.markers.map((marker) => marker.name)).toEqual(["Intro", "Chorus"]);

    // A second marker on an occupied step would hide the first behind it.
    const id = store().addMarker(64, "Drop");
    expect(store().playlist.markers).toHaveLength(2);
    expect(id).toBe(store().playlist.markers[1].id);
    expect(store().playlist.markers[1].name).toBe("Chorus");
  });

  it("moves a marker, refusing a step another one already holds", () => {
    const intro = store().addMarker(0, "Intro");
    store().addMarker(32, "Verse");
    expect(intro).not.toBeNull();

    store().moveMarker(intro as string, 16);
    expect(store().playlist.markers.map((marker) => marker.step)).toEqual([16, 32]);

    store().moveMarker(intro as string, 32);
    expect(store().playlist.markers.map((marker) => marker.step)).toEqual([16, 32]);

    // Moving past a neighbour re-sorts rather than leaving the list scrambled.
    store().moveMarker(intro as string, 64);
    expect(store().playlist.markers.map((marker) => marker.name)).toEqual(["Verse", "Intro"]);
  });

  it("renames and deletes markers", () => {
    const id = store().addMarker(0, "Intro") as string;

    store().renameMarker(id, "  Opening  ");
    expect(store().playlist.markers[0].name).toBe("Opening");

    // An empty rename is a slip, not an instruction.
    store().renameMarker(id, "   ");
    expect(store().playlist.markers[0].name).toBe("Opening");

    store().removeMarker(id);
    expect(store().playlist.markers).toEqual([]);
  });
});

describe("playlist lanes", () => {
  it("clamps a lane height instead of collapsing the row", () => {
    store().setPlaylistTrackHeight(0, 5);
    expect(store().playlist.tracks[0].height).toBe(MIN_TRACK_HEIGHT);

    store().setPlaylistTrackHeight(0, 10000);
    expect(store().playlist.tracks[0].height).toBe(MAX_TRACK_HEIGHT);
  });

  it("gives a new lane its own colour and the default height", () => {
    const before = store().playlist.tracks.length;
    store().addPlaylistTrack("Bass");

    const track = store().playlist.tracks[before];
    expect(track.name).toBe("Bass");
    expect(track.height).toBe(DEFAULT_TRACK_HEIGHT);
    expect(track.color).toBe(trackColorAt(before));
  });

  it("burns no undo entry on a no-op recolour", () => {
    const track = store().playlist.tracks[0];
    clearHistory();

    store().setPlaylistTrackColor(0, track.color);
    expect(canUndo()).toBe(false);

    store().setPlaylistTrackColor(0, trackColorAt(3) === track.color ? trackColorAt(4) : trackColorAt(3));
    expect(canUndo()).toBe(true);
  });
});

describe("mixer routing", () => {
  const insert = (id: number) => store().mixer.tracks.find((track) => track.id === id);

  it("routes an insert to a bus and refuses to loop it back", () => {
    expect(store().setMixerTrackOutput(1, 10)).toBe(true);
    expect(insert(1)?.output).toBe(10);

    // 10 → 1 would feed insert 1 its own output.
    expect(store().setMixerTrackOutput(10, 1)).toBe(false);
    expect(store().addMixerSend(10, 1)).toBe(false);
    expect(insert(10)?.output).toBe(0);
  });

  it("adds, levels and removes a send, one per destination", () => {
    expect(store().addMixerSend(2, 15, 0.3)).toBe(true);
    expect(store().addMixerSend(2, 15)).toBe(false);

    store().setMixerSendLevel(2, 15, 2);
    expect(insert(2)?.sends).toEqual([{ target: 15, level: 1 }]);

    store().removeMixerSend(2, 15);
    expect(insert(2)?.sends).toEqual([]);
  });

  it("drops a send when the insert is routed to that same bus", () => {
    store().addMixerSend(3, 12);
    store().setMixerTrackOutput(3, 12);
    expect(insert(3)?.sends).toEqual([]);
  });
});
describe("a synth channel's own sound", () => {
  const lead = () => store().channels.find((channel) => channel.type === "synth")!;
  const mine = (changes: Record<string, unknown> = {}) => ({
    name: "Mine",
    oscType: "square" as OscillatorType,
    detuneSpread: 0,
    filterType: "lowpass" as BiquadFilterType,
    filterFreq: 2000,
    filterEnvAmount: 0,
    filterQ: 1,
    attackTime: 0.01,
    decayTime: 0.3,
    sustainLevel: 0.7,
    releaseTime: 0.3,
    gain: 0.4,
    ...changes
  });

  it("is kept, and can be undone", () => {
    store().updateChannelSynthPatch(lead().id, mine());
    expect(lead().synthPatch?.name).toBe("Mine");

    store().undo();
    expect(lead().synthPatch).toBeUndefined();
  });

  it("turns one knob drag into one undo step", () => {
    store().updateChannelSynthPatch(lead().id, mine());
    const before = snapshot();

    store().beginEdit("Synth sound");
    for (const cutoff of [2100, 2400, 3000, 5000]) store().updateChannelSynthPatch(lead().id, mine({ filterFreq: cutoff }));
    store().endEdit();

    expect(lead().synthPatch?.filterFreq).toBe(5000);
    store().undo();
    expect(snapshot()).toBe(before);
  });

  it("is never written to a channel that isn't a synth", () => {
    store().updateChannelSynthPatch(firstChannel(), mine());
    expect(store().channels[0].synthPatch).toBeUndefined();
  });

  it("keeps wild numbers out of the project", () => {
    store().updateChannelSynthPatch(lead().id, mine({ filterFreq: 1e12, gain: -5 }));
    expect(lead().synthPatch?.filterFreq).toBe(18000);
    expect(lead().synthPatch?.gain).toBe(0);
  });

  it("survives saving and loading, and a damaged one is repaired", () => {
    store().updateChannelSynthPatch(lead().id, mine({ filterFreq: 1234 }));
    const saved = JSON.parse(JSON.stringify(getProjectData(store())));
    expect(sanitizeProjectData(saved).channels.find((c) => c.type === "synth")?.synthPatch?.filterFreq).toBe(1234);

    saved.channels.find((c: { type: string }) => c.type === "synth").synthPatch = { filterFreq: "loud", oscType: 7 };
    const repaired = sanitizeProjectData(saved).channels.find((c) => c.type === "synth")?.synthPatch;
    expect(repaired?.oscType).toBe("sawtooth");
    expect(repaired?.filterFreq).toBe(4000);
  });

  it("picking a preset by name drops the custom sound", () => {
    store().updateChannelSynthPatch(lead().id, mine());
    store().updateChannelSynthPreset(lead().id, "electric-piano");
    expect(lead().synthPatch).toBeUndefined();
    expect(lead().synthPreset).toBe("electric-piano");
  });
});
