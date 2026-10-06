/**
 * The computer keyboard as a piano, FL "typing keyboard" style: two rows of
 * keys, one semitone each. These keys are spoken for, so no other shortcut may
 * use them on their own (see hotkeys.test.ts).
 */
export const PIANO_KEYS: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17,
  Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24
};

/** [ and ] change the octave, so they are taken too. */
export const OCTAVE_KEYS = ["BracketLeft", "BracketRight"];
