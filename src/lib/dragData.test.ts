import { describe, expect, it } from "vitest";

import { DRAG_TYPE, carriesDragItem, decodeDragItem, encodeDragItem } from "./dragData";

describe("dragging from the browser", () => {
  it("carries an instrument or a sample there and back", () => {
    expect(decodeDragItem(encodeDragItem({ kind: "instrument", label: "Grand Piano" }))).toEqual({ kind: "instrument", label: "Grand Piano" });
    expect(decodeDragItem(encodeDragItem({ kind: "sample", id: "sample-fx-impact", name: "Impact" }))).toEqual({
      kind: "sample",
      id: "sample-fx-impact",
      name: "Impact"
    });
  });

  it("ignores anything that isn't one of ours", () => {
    for (const raw of [null, "", "Grand Piano", "{}", '{"kind":"file","path":"C:/x"}', '{"kind":"instrument"}', '{"kind":"sample","id":""}', "[1,2]"]) {
      expect(decodeDragItem(raw), String(raw)).toBeNull();
    }
  });

  it("knows its own drag from a file or text being dragged in", () => {
    expect(carriesDragItem([DRAG_TYPE, "text/plain"])).toBe(true);
    expect(carriesDragItem(["Files"])).toBe(false);
    expect(carriesDragItem(["text/plain"])).toBe(false);
    expect(carriesDragItem(undefined)).toBe(false);
  });
});
