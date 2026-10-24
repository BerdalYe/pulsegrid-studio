import { describe, expect, it } from "vitest";

import { platformText } from "../lib/hotkeys";
import { prepareItems } from "./MenuPanel";

// Shortcuts are shown the Mac way (⌘Z) on a Mac, so the expected labels follow the platform the tests run on.

describe("menu items", () => {
  it("splits a shortcut off the end of a label", () => {
    const [item] = prepareItems([{ label: "Save as…   Ctrl+Shift+S" }]);
    expect(item.label).toBe("Save as…");
    expect(item.shortcut).toBe(platformText("Ctrl+Shift+S"));
  });

  it("leaves a plain label and an explicit shortcut alone", () => {
    const items = prepareItems([{ label: "Open the save folder" }, { label: "Undo", shortcut: "Ctrl+Z" }]);
    expect(items[0]).toMatchObject({ label: "Open the save folder", shortcut: undefined });
    expect(items[1]).toMatchObject({ label: "Undo", shortcut: platformText("Ctrl+Z") });
  });

  it("does not mistake a double space inside a label for a shortcut", () => {
    const [item] = prepareItems([{ label: "Scroll  wheel zooms" }]);
    expect(item.label).toBe("Scroll  wheel zooms");
    expect(item.shortcut).toBeUndefined();
  });

  it("prepares the entries of a flyout too, and keeps separators", () => {
    const [parent, separator] = prepareItems([
      { label: "Family", items: [{ label: "Kick   Ctrl+K" }] },
      { label: "", separator: true }
    ]);
    expect(parent.items?.[0]).toMatchObject({ label: "Kick", shortcut: platformText("Ctrl+K") });
    expect(separator.separator).toBe(true);
  });
});
