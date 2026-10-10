import type { Channel } from "../../types";
import type { Voice } from "../voices";
import { BUILTIN_ID, requestFont, resolveChannelSound, useSoundFontStore } from "./registry";
import { createSoundFontVoice } from "./voice";

/**
 * A channel that plays a SoundFont instrument. If its sounds haven't been read
 * from disk yet, that starts now and this note is silent: the first notes of a
 * session can arrive a moment before the instrument has loaded.
 */
export function createSoundFontChannelVoice(
  context: BaseAudioContext,
  channel: Channel,
  destination: AudioNode,
  options: { time: number; pitch: number; velocity: number; duration: number | null }
): Voice | null {
  const ref = channel.soundfont;
  if (!ref) return null;

  const store = useSoundFontStore.getState();
  const wanted = store.fonts[ref.fontId];

  // Its own SoundFont is still being read (or could be): wait for it rather than play the wrong sound.
  if (!wanted?.font && !wanted?.error) {
    requestFont(ref.fontId);
    return null;
  }
  // Missing or broken: the built-in set stands in, once it is there.
  if (!wanted?.font && !store.fonts[BUILTIN_ID]?.font) {
    requestFont(BUILTIN_ID);
    return null;
  }

  const sound = resolveChannelSound(ref);
  if (!sound) return null;

  return createSoundFontVoice(
    context,
    sound.font,
    sound.preset,
    destination,
    options.time,
    options.pitch,
    options.velocity,
    options.duration,
    { attack: ref.attack, release: ref.release, brightness: ref.brightness, transpose: ref.transpose },
    channel.id
  );
}
