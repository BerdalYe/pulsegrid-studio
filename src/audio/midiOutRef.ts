import type { MidiOutRef } from "../types";

/**
 * Make whatever a project file holds into a MIDI output choice that is safe to
 * use: a short port name and a MIDI channel from 1 to 16. Returns undefined when
 * there is no usable choice.
 */
export function sanitizeMidiOutRef(raw: unknown): MidiOutRef | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;

  const portId = typeof source.portId === "string" ? source.portId.slice(0, 200) : "";
  const portName = typeof source.portName === "string" ? source.portName.slice(0, 120) : "";
  if (!portId && !portName) return undefined;

  const channel = typeof source.channel === "number" && Number.isFinite(source.channel) ? Math.round(source.channel) : 1;

  const ref: MidiOutRef = { portId, portName, channel: Math.min(16, Math.max(1, channel)) };
  if (source.alsoPlay === true) ref.alsoPlay = true;
  if (source.knobsToStudio === true) ref.knobsToStudio = true;
  return ref;
}
