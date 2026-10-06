import type { Channel, ChannelType } from "../types";

/** General MIDI percussion notes → drum channel type, and a pitch for toms. */
export const GM_DRUM_MAP: Record<number, { type: ChannelType; pitch?: number; open?: boolean }> = {
  35: { type: "kick" },
  36: { type: "kick" },
  37: { type: "rim" },
  38: { type: "snare" },
  40: { type: "snare" },
  39: { type: "clap" },
  42: { type: "hat" },
  44: { type: "hat" },
  46: { type: "hat", open: true },
  41: { type: "tom", pitch: 53 },
  43: { type: "tom", pitch: 55 },
  45: { type: "tom", pitch: 58 },
  47: { type: "tom", pitch: 60 },
  48: { type: "tom", pitch: 63 },
  50: { type: "tom", pitch: 66 },
  49: { type: "cymbal" },
  51: { type: "cymbal" },
  52: { type: "cymbal" },
  55: { type: "cymbal" },
  57: { type: "cymbal" },
  59: { type: "cymbal" },
  56: { type: "cowbell" },
  54: { type: "shaker" },
  69: { type: "shaker" },
  70: { type: "shaker" },
  82: { type: "shaker" }
};

/** The channel a drum pad plays, and at what pitch. */
export function padTarget(
  note: number,
  channels: Channel[]
): { channelId: string; pitch: number; open: boolean } | null {
  const mapped = GM_DRUM_MAP[note];
  if (mapped) {
    const channel = channels.find((entry) => entry.type === mapped.type);
    if (channel) return { channelId: channel.id, pitch: mapped.pitch ?? 60, open: mapped.open ?? false };
  }

  // No drum of that kind in the project: pads 1–16 play the rack in order.
  const index = (((note - 36) % 16) + 16) % 16;
  const channel = channels[index];
  return channel ? { channelId: channel.id, pitch: 60, open: false } : null;
}
