import { describe, expect, it } from "vitest";

import { SHORTCUTS, matchShortcut, platformKey, platformText, shortcutGroups, shortcutLabel } from "./hotkeys";
import { OCTAVE_KEYS, PIANO_KEYS } from "./pianoKeys";

type Press = Parameters<typeof matchShortcut>[0];

const press = (init: Partial<Press>): Press => ({
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init
});

/** The key press a shortcut asks for. */
function pressFor(shortcut: (typeof SHORTCUTS)[number]): Press {
  const spec = shortcut.spec;
  if (!spec) throw new Error("not a key shortcut");
  return press({
    code: spec.code ?? "",
    key: spec.keys?.[0] ?? "",
    ctrlKey: Boolean(spec.ctrl),
    altKey: Boolean(spec.alt),
    shiftKey: Boolean(spec.shift)
  });
}

const keyShortcuts = SHORTCUTS.filter((shortcut) => shortcut.id && shortcut.spec);

describe("shortcut table", () => {
  it("lets every shortcut trigger itself", () => {
    for (const shortcut of keyShortcuts) {
      expect(matchShortcut(pressFor(shortcut)), shortcut.label).toBe(shortcut.id);
    }
  });

  it("never lets two shortcuts share a key", () => {
    const seen = new Map<string, string>();
    for (const shortcut of keyShortcuts) {
      const spec = shortcut.spec!;
      const signature = JSON.stringify([
        spec.code ?? spec.keys,
        Boolean(spec.ctrl),
        Boolean(spec.alt),
        spec.anyShift ? "any" : Boolean(spec.shift)
      ]);
      expect(seen.get(signature), `${shortcut.label} clashes with ${seen.get(signature)}`).toBeUndefined();
      seen.set(signature, shortcut.label);
    }
  });

  it("leaves the typing-keyboard piano alone", () => {
    const pianoCodes = new Set([...Object.keys(PIANO_KEYS), ...OCTAVE_KEYS]);

    for (const shortcut of keyShortcuts) {
      const spec = shortcut.spec!;
      // With Ctrl or Alt held the piano ignores the key, so any key will do.
      if (spec.ctrl || spec.alt) continue;
      expect(pianoCodes.has(spec.code ?? ""), `${shortcut.label} (${spec.code}) is a piano key`).toBe(false);
    }
  });

  it("only lets Ctrl or Alt combinations through for keys the piano uses", () => {
    expect(matchShortcut(press({ code: "KeyM" }))).toBeNull();
    expect(matchShortcut(press({ code: "KeyM", altKey: true }))).toBe("muteChannel");
    expect(matchShortcut(press({ code: "KeyS" }))).toBeNull();
    expect(matchShortcut(press({ code: "KeyS", ctrlKey: true }))).toBe("save");
  });

  it("accepts Cmd on a Mac as Ctrl", () => {
    expect(matchShortcut(press({ code: "KeyS", metaKey: true }))).toBe("save");
  });

  it("has two ways to redo", () => {
    expect(matchShortcut(press({ code: "KeyY", ctrlKey: true }))).toBe("redo");
    expect(matchShortcut(press({ code: "KeyZ", ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(matchShortcut(press({ code: "KeyZ", ctrlKey: true }))).toBe("undo");
  });

  it("finds + and − wherever the keyboard puts them", () => {
    // US layout: + is Shift and the = key.
    expect(matchShortcut(press({ key: "+", code: "Equal", shiftKey: true }))).toBe("zoomIn");
    expect(matchShortcut(press({ key: "=", code: "Equal" }))).toBe("zoomIn");
    expect(matchShortcut(press({ key: "-", code: "Minus" }))).toBe("zoomOut");
    // Nordic layout: + sits on the key US keyboards call Minus, and − on Slash.
    expect(matchShortcut(press({ key: "+", code: "Minus" }))).toBe("zoomIn");
    expect(matchShortcut(press({ key: "-", code: "Slash" }))).toBe("zoomOut");
    // The number pad.
    expect(matchShortcut(press({ key: "+", code: "NumpadAdd" }))).toBe("zoomIn");
    expect(matchShortcut(press({ key: "-", code: "NumpadSubtract" }))).toBe("zoomOut");
  });

  it("does not mistake AltGr for Alt", () => {
    // European keyboards report AltGr as Ctrl and Alt together; it types characters like @ and {.
    expect(matchShortcut(press({ code: "Digit2", key: "@", ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchShortcut(press({ code: "KeyM", key: "µ", ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchShortcut(press({ code: "Digit4", key: "$", ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("ignores keys that aren't shortcuts", () => {
    expect(matchShortcut(press({ code: "KeyA" }))).toBeNull();
    expect(matchShortcut(press({ code: "Tab", key: "Tab" }))).toBeNull();
    expect(matchShortcut(press({ code: "KeyK", shiftKey: true }))).toBe("toggleCountIn");
    expect(matchShortcut(press({ code: "KeyK", shiftKey: true, ctrlKey: true }))).toBeNull();
  });

  it("labels shortcuts for menus", () => {
    // "Ctrl+S", or "⌘S" when the tests happen to run on a Mac.
    expect(shortcutLabel("save")).toBe(platformText("Ctrl+S"));
    expect(shortcutLabel("showShortcuts")).toBe("F1");
  });

  it("groups everything for the shortcuts window, with nothing empty", () => {
    const groups = shortcutGroups();
    expect(groups.length).toBeGreaterThan(5);
    for (const { items } of groups) {
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.label.trim()).not.toBe("");
        expect(item.display.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("shortcut wording for a Mac", () => {
  it("says ⌘, ⌥ and ⇧ instead of Ctrl, Alt and Shift", () => {
    expect(platformText("Save (Ctrl+S)", true)).toBe("Save (⌘S)");
    expect(platformText("Ctrl+Shift+S", true)).toBe("⌘⇧S");
    expect(platformText("Alt+Page Down", true)).toBe("⌥Page Down");
    expect(platformText("Ctrl + scroll zooms", true)).toBe("⌘scroll zooms");
    expect(platformKey("Ctrl", true)).toBe("⌘");
    expect(platformKey("Alt", true)).toBe("⌥");
    expect(platformKey("Shift", true)).toBe("⇧");
    expect(platformKey("S", true)).toBe("S");
  });

  it("leaves other words alone", () => {
    expect(platformText("Controls and Alternatives", true)).toBe("Controls and Alternatives");
  });

  it("changes nothing on Windows", () => {
    expect(platformText("Save (Ctrl+S)", false)).toBe("Save (Ctrl+S)");
    expect(platformKey("Ctrl", false)).toBe("Ctrl");
  });

  it("treats ⌘ as the main modifier for every shortcut", () => {
    const event = { key: "s", code: "KeyS", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false };
    expect(matchShortcut(event)).toBe("save");
  });
});
