import type { MixerTrack } from "../types";

/** The master bus, as a routing destination. */
export const MASTER_OUTPUT = 0;

type RoutedTrack = Pick<MixerTrack, "id" | "output" | "sends" | "mute" | "solo">;

/** Every insert this one feeds directly: its main output plus its sends. */
export function routeTargets(track: Pick<MixerTrack, "output" | "sends">): number[] {
  const targets = track.sends.map((send) => send.target);
  if (track.output !== MASTER_OUTPUT) targets.push(track.output);
  return targets;
}

function downstream(tracks: RoutedTrack[], from: number): Set<number> {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const seen = new Set<number>();
  const stack = [from];

  while (stack.length > 0) {
    const id = stack.pop() as number;
    const track = byId.get(id);
    if (!track) continue;

    for (const target of routeTargets(track)) {
      if (seen.has(target)) continue;
      seen.add(target);
      stack.push(target);
    }
  }

  return seen;
}

/**
 * Would routing `from` into `to` close a loop?
 *
 * Web Audio doesn't reject a cycle without a delay in it — it silences the
 * whole loop instead, so one bad send would mute every insert involved.
 * Every routing change has to be checked here first.
 */
export function wouldCreateCycle(tracks: RoutedTrack[], from: number, to: number): boolean {
  if (to === MASTER_OUTPUT) return false;
  if (to === from) return true;
  return downstream(tracks, to).has(from);
}

/**
 * Which inserts can be heard, given mute and solo.
 *
 * Soloing an insert has to keep the buses it feeds audible — solo a vocal
 * that sends to a reverb bus and you still expect the reverb — and whatever
 * feeds a soloed bus, so soloing a drum bus plays the drums.
 */
export function audibleInserts(tracks: RoutedTrack[]): Set<number> {
  const soloed = tracks.filter((track) => track.solo).map((track) => track.id);

  let candidates: Set<number>;

  if (soloed.length === 0) {
    candidates = new Set(tracks.map((track) => track.id));
  } else {
    candidates = new Set(soloed);
    for (const id of soloed) {
      for (const target of downstream(tracks, id)) candidates.add(target);
    }
    for (const track of tracks) {
      const feeds = downstream(tracks, track.id);
      if (soloed.some((id) => feeds.has(id))) candidates.add(track.id);
    }
  }

  for (const track of tracks) {
    if (track.mute) candidates.delete(track.id);
  }

  return candidates;
}

/**
 * Drop any routing that points nowhere or closes a loop, keeping the first
 * of each. Used when loading a file, which may have been edited by hand.
 */
export function repairRouting<T extends RoutedTrack>(tracks: T[]): T[] {
  const ids = new Set(tracks.map((track) => track.id));
  const repaired: T[] = tracks.map((track) => ({ ...track, output: MASTER_OUTPUT, sends: [] }));

  const find = (id: number) => repaired.find((track) => track.id === id) as T;

  for (const original of tracks) {
    const track = find(original.id);

    if (
      original.output !== MASTER_OUTPUT &&
      ids.has(original.output) &&
      !wouldCreateCycle(repaired, track.id, original.output)
    ) {
      track.output = original.output;
    }

    for (const send of original.sends) {
      if (!ids.has(send.target)) continue;
      if (send.target === track.output) continue;
      if (track.sends.some((existing) => existing.target === send.target)) continue;
      if (wouldCreateCycle(repaired, track.id, send.target)) continue;
      track.sends = [...track.sends, send];
    }
  }

  return repaired;
}
