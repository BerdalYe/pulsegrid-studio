import { describe, expect, it } from "vitest";

import { DRUM_SET_PIECES, GM_DRUM_NAMES, KIT_PADS, KIT_PIECES, drumName, isFullKit, kitPieceColor, stepPitchOf } from "./drumKits";

const kit = (drumNote?: number) => ({
  soundfont: { fontId: "generaluser-gs", fontName: "x", bank: 128, program: 25, name: "808", ...(drumNote === undefined ? {} : { drumNote }) }
});

describe("drum kits", () => {
  it("plays the kick on the steps of a whole kit, and middle C for everything else", () => {
    expect(isFullKit(kit())).toBe(true);
    expect(stepPitchOf(kit())).toBe(36);
    // A single drum plays itself on middle C.
    expect(isFullKit(kit(38))).toBe(false);
    expect(stepPitchOf(kit(38))).toBe(60);
    expect(stepPitchOf({ soundfont: { fontId: "generaluser-gs", fontName: "x", bank: 0, program: 0, name: "Piano" } })).toBe(60);
    expect(stepPitchOf({})).toBe(60);
  });

  it("names the drums of the General MIDI map", () => {
    expect(drumName(36)).toBe("Kick");
    expect(drumName(38)).toBe("Snare");
    expect(drumName(42)).toBe("Closed Hat");
    expect(drumName(100)).toBeNull();
    for (let note = 35; note <= 81; note += 1) expect(GM_DRUM_NAMES[note], String(note)).toBeTruthy();
  });

  it("offers sixteen different pads, each a named drum", () => {
    expect(KIT_PADS).toHaveLength(16);
    expect(new Set(KIT_PADS).size).toBe(16);
    for (const note of KIT_PADS) expect(drumName(note)).toBeTruthy();
    expect(KIT_PADS[0]).toBe(36);
  });

  it("builds a drum set from drums every kit has, each coloured like its kind", () => {
    for (const name of DRUM_SET_PIECES) expect(KIT_PIECES.some((piece) => piece.name === name)).toBe(true);
    for (const piece of KIT_PIECES) {
      expect(drumName(piece.note)).toBe(piece.name);
      expect(kitPieceColor(piece.note)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
