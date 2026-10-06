/**
 * Every keyboard shortcut in the studio, in one table. The same list drives
 * the key handling and the "Keyboard shortcuts" window, so the two can't drift
 * apart, and a test checks that no two shortcuts share a key and none of them
 * takes a key the typing-keyboard piano needs.
 *
 * Letters are matched by their physical key (`code`), so shortcuts stay put on
 * any keyboard layout; + and − are matched by what they type, because they
 * sit in different places on different layouts.
 */

export type ShortcutGroup =
  | "File"
  | "Edit"
  | "Playback"
  | "Windows"
  | "Patterns and channels"
  | "Piano roll and playlist"
  | "Piano roll"
  | "Playlist"
  | "Play from the keyboard";

export type ShortcutId =
  | "save"
  | "saveAs"
  | "open"
  | "newProject"
  | "exportAudio"
  | "undo"
  | "redo"
  | "play"
  | "playFromStart"
  | "toStart"
  | "stopAll"
  | "toggleLoop"
  | "toggleMetronome"
  | "toggleCountIn"
  | "toggleSongMode"
  | "windowPlaylist"
  | "windowRack"
  | "windowPiano"
  | "windowMixer"
  | "windowSynth"
  | "toggleBrowser"
  | "showShortcuts"
  | "nextPattern"
  | "previousPattern"
  | "newPattern"
  | "nextChannel"
  | "previousChannel"
  | "muteChannel"
  | "soloChannel"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "tool1"
  | "tool2"
  | "tool3"
  | "tool4"
  | "quantise"
  | "toggleGhost"
  | "toggleVelocity";

interface KeySpec {
  /** Physical key, e.g. "KeyK". */
  code?: string;
  /** What the key types, e.g. "+". Any of these. */
  keys?: string[];
  /** Ctrl, or Cmd on a Mac. */
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Shift doesn't matter (+ needs it on some layouts and not on others). */
  anyShift?: boolean;
}

export interface Shortcut {
  /** Absent for shortcuts that are handled where they happen (copy and paste, say) and only listed here. */
  id?: ShortcutId;
  group: ShortcutGroup;
  label: string;
  /** How it is shown, one entry per alternative: ["Ctrl+Y", "Ctrl+Shift+Z"]. */
  display: string[];
  spec?: KeySpec;
}

const s = (
  id: ShortcutId,
  group: ShortcutGroup,
  label: string,
  display: string[],
  spec: KeySpec
): Shortcut => ({ id, group, label, display, spec });

const listed = (group: ShortcutGroup, label: string, display: string[]): Shortcut => ({
  group,
  label,
  display
});

export const SHORTCUTS: Shortcut[] = [
  // ── file ──
  s("save", "File", "Save", ["Ctrl+S"], { code: "KeyS", ctrl: true }),
  s("saveAs", "File", "Save as…", ["Ctrl+Shift+S"], { code: "KeyS", ctrl: true, shift: true }),
  s("open", "File", "Open a project", ["Ctrl+O"], { code: "KeyO", ctrl: true }),
  s("newProject", "File", "New project", ["Ctrl+N"], { code: "KeyN", ctrl: true }),
  s("exportAudio", "File", "Export audio…", ["Ctrl+E"], { code: "KeyE", ctrl: true }),

  // ── edit ──
  s("undo", "Edit", "Undo", ["Ctrl+Z"], { code: "KeyZ", ctrl: true }),
  s("redo", "Edit", "Redo", ["Ctrl+Y", "Ctrl+Shift+Z"], { code: "KeyY", ctrl: true }),

  // ── playback ──
  s("play", "Playback", "Play / pause", ["Space"], { code: "Space" }),
  s("playFromStart", "Playback", "Play from the beginning", ["Enter"], { code: "Enter" }),
  s("toStart", "Playback", "Stop and go back to the start", ["Home"], { code: "Home" }),
  s("stopAll", "Playback", "Stop all sound", ["Esc"], { code: "Escape" }),
  s("toggleLoop", "Playback", "Loop on / off", ["L"], { code: "KeyL" }),
  s("toggleMetronome", "Playback", "Metronome on / off", ["K"], { code: "KeyK" }),
  s("toggleCountIn", "Playback", "Count-in on / off", ["Shift+K"], { code: "KeyK", shift: true }),
  s("toggleSongMode", "Playback", "Switch between pattern and song mode", ["P"], { code: "KeyP" }),

  // ── windows ──
  s("windowPlaylist", "Windows", "Playlist", ["F5"], { code: "F5" }),
  s("windowRack", "Windows", "Channel rack", ["F6"], { code: "F6" }),
  s("windowPiano", "Windows", "Piano roll", ["F7"], { code: "F7" }),
  s("windowMixer", "Windows", "Mixer", ["F9"], { code: "F9" }),
  s("windowSynth", "Windows", "Synth sound editor (selected channel)", ["F8"], { code: "F8" }),
  s("toggleBrowser", "Windows", "Show or hide the browser panel", ["Ctrl+B"], { code: "KeyB", ctrl: true }),
  s("showShortcuts", "Windows", "Keyboard shortcuts", ["F1"], { code: "F1" }),

  // ── patterns and channels ──
  s("nextPattern", "Patterns and channels", "Next pattern", ["Alt+Page Down"], { code: "PageDown", alt: true }),
  s("previousPattern", "Patterns and channels", "Previous pattern", ["Alt+Page Up"], { code: "PageUp", alt: true }),
  s("newPattern", "Patterns and channels", "New pattern", ["Ctrl+Shift+N"], { code: "KeyN", ctrl: true, shift: true }),
  s("nextChannel", "Patterns and channels", "Next channel", ["Alt+↓"], { code: "ArrowDown", alt: true }),
  s("previousChannel", "Patterns and channels", "Previous channel", ["Alt+↑"], { code: "ArrowUp", alt: true }),
  s("muteChannel", "Patterns and channels", "Mute the selected channel", ["Alt+M"], { code: "KeyM", alt: true }),
  s("soloChannel", "Patterns and channels", "Solo the selected channel", ["Alt+S"], { code: "KeyS", alt: true }),

  // ── both editors ──
  s("zoomIn", "Piano roll and playlist", "Zoom in", ["+", "Ctrl+scroll up"], {
    keys: ["+", "="],
    anyShift: true
  }),
  s("zoomOut", "Piano roll and playlist", "Zoom out", ["−", "Ctrl+scroll down"], {
    keys: ["-", "_"],
    anyShift: true
  }),
  s("zoomReset", "Piano roll and playlist", "Reset the zoom", ["0"], { code: "Digit0" }),
  listed("Piano roll and playlist", "Zoom with the mouse wheel", ["Scroll"]),
  listed("Piano roll and playlist", "Scroll sideways", ["Shift+scroll"]),
  listed("Piano roll and playlist", "Scroll up and down", ["Alt+scroll"]),
  listed("Piano roll and playlist", "Copy, cut, paste", ["Ctrl+C", "Ctrl+X", "Ctrl+V"]),
  listed("Piano roll and playlist", "Duplicate the selection", ["Ctrl+D"]),
  listed("Piano roll and playlist", "Delete the selection", ["Delete"]),

  // ── piano roll ──
  s("tool1", "Piano roll", "Draw tool", ["Alt+1"], { code: "Digit1", alt: true }),
  s("tool2", "Piano roll", "Paint tool", ["Alt+2"], { code: "Digit2", alt: true }),
  s("tool3", "Piano roll", "Erase tool", ["Alt+3"], { code: "Digit3", alt: true }),
  s("tool4", "Piano roll", "Select tool", ["Alt+4"], { code: "Digit4", alt: true }),
  s("quantise", "Piano roll", "Quantise the selected notes", ["Ctrl+Q"], { code: "KeyQ", ctrl: true }),
  s("toggleGhost", "Piano roll", "Ghost notes on / off", ["Alt+G"], { code: "KeyG", alt: true }),
  s("toggleVelocity", "Piano roll", "Velocity lane on / off", ["Alt+V"], { code: "KeyV", alt: true }),
  listed("Piano roll", "Select all", ["Ctrl+A"]),
  listed("Piano roll", "Move the selected notes", ["← → ↑ ↓"]),
  listed("Piano roll", "Move the selected notes an octave", ["Shift+↑ ↓"]),

  // ── playlist (the tools share Alt+1–3 with the piano roll: whichever window is in front) ──
  listed("Playlist", "Pattern, audio and automation tools", ["Alt+1", "Alt+2", "Alt+3"]),
  listed("Playlist", "Drop a marker at the playhead", ["M"]),

  // ── playing ──
  listed("Play from the keyboard", "Play notes on the selected channel", ["Z–M row", "Q–I row"]),
  listed("Play from the keyboard", "Octave down / up", ["[", "]"])
];

/** Does this key press match the shortcut's keys? */
function matches(
  spec: KeySpec,
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">
): boolean {
  if (Boolean(spec.ctrl) !== (event.ctrlKey || event.metaKey)) return false;
  if (Boolean(spec.alt) !== event.altKey) return false;
  if (!spec.anyShift && Boolean(spec.shift) !== event.shiftKey) return false;
  if (spec.code !== undefined && spec.code !== event.code) return false;
  if (spec.keys !== undefined && !spec.keys.includes(event.key)) return false;
  return spec.code !== undefined || spec.keys !== undefined;
}

/**
 * Which shortcut does this key press trigger, if any? Redo is the one with two
 * ways in, Ctrl+Y and Ctrl+Shift+Z.
 */
export function matchShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">
): ShortcutId | null {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyZ" && !event.altKey) {
    return "redo";
  }

  for (const shortcut of SHORTCUTS) {
    if (shortcut.id && shortcut.spec && matches(shortcut.spec, event)) return shortcut.id;
  }
  return null;
}

/** The shortcuts of each group, in the order they're listed, for the shortcuts window. */
export function shortcutGroups(): Array<{ group: ShortcutGroup; items: Shortcut[] }> {
  const groups = new Map<ShortcutGroup, Shortcut[]>();
  for (const shortcut of SHORTCUTS) {
    const items = groups.get(shortcut.group) ?? [];
    items.push(shortcut);
    groups.set(shortcut.group, items);
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

/** Is this a Mac (or an iPad), where Ctrl is ⌘ and Alt is ⌥? */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

/** One key's name on this system: "Ctrl" is "⌘" on a Mac, "Alt" is "⌥", "Shift" is "⇧". */
export function platformKey(key: string, mac = IS_MAC): string {
  if (!mac) return key;
  return key === "Ctrl" ? "⌘" : key === "Alt" ? "⌥" : key === "Shift" ? "⇧" : key;
}

/** A line of text that mentions shortcuts, in this system's words: "Ctrl+Shift+S" is "⌘⇧S" on a Mac. */
export function platformText(text: string, mac = IS_MAC): string {
  if (!mac) return text;
  return text
    .replace(/\bCtrl\s*\+\s*/g, "⌘")
    .replace(/\bAlt\s*\+\s*/g, "⌥")
    .replace(/\bShift\s*\+\s*/g, "⇧")
    .replace(/\bCtrl\b/g, "⌘")
    .replace(/\bAlt\b/g, "⌥");
}

/** The first way of pressing a shortcut, for menus and tooltips ("Ctrl+S", or "⌘S" on a Mac). */
export function shortcutLabel(id: ShortcutId): string {
  return platformText(SHORTCUTS.find((shortcut) => shortcut.id === id)?.display[0] ?? "");
}
