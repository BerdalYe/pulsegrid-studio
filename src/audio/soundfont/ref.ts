import type { SoundFontRef } from "../../types";

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

/**
 * Make whatever a project file holds into a SoundFont choice that is safe to
 * use: numbers in range, names short, nothing that could reach the audio
 * engine out of bounds. Returns undefined when there is no usable choice.
 */
export function sanitizeSoundFontRef(raw: unknown): SoundFontRef | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;

  // Ids come from this studio (a name or a short hash); anything else is not one of ours.
  const fontId = typeof source.fontId === "string" && /^[a-z0-9-]{3,64}$/.test(source.fontId) ? source.fontId : null;
  if (!fontId) return undefined;

  const ref: SoundFontRef = {
    fontId,
    fontName: text(source.fontName, fontId, 80),
    bank: Math.round(number(source.bank, 0, 0, 16383)),
    program: Math.round(number(source.program, 0, 0, 127)),
    name: text(source.name, "Instrument", 60)
  };

  if (source.attack !== undefined) ref.attack = number(source.attack, 1, 0.02, 8);
  if (source.release !== undefined) ref.release = number(source.release, 1, 0.05, 8);
  if (source.brightness !== undefined) ref.brightness = number(source.brightness, 1, 0, 1);
  if (source.transpose !== undefined) ref.transpose = Math.round(number(source.transpose, 0, -24, 24));
  if (source.drumNote !== undefined) ref.drumNote = Math.round(number(source.drumNote, 36, 0, 127));
  return ref;
}
