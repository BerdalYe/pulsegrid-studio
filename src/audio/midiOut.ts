import type { MidiOutRef } from "../types";
import { clamp } from "../lib/utils";
import { midiManager } from "./midi";
import type { Voice } from "./voices";

/**
 * Playing outside PulseGrid. A channel set to "MIDI out" sends its notes to a MIDI
 * port, where another program (the Akai Studio Instrument Collection in its own
 * host, a hardware synth) turns them into sound. The notes are timed against the
 * audio clock, so they land on the beat just as the built-in instruments do.
 */

/* ─────────────────────────────── the bytes ─────────────────────────────── */

const status = (kind: number, channel: number) => kind | ((clamp(Math.round(channel), 1, 16) - 1) & 0x0f);
const data = (value: number) => clamp(Math.round(value), 0, 127);

export const noteOnBytes = (channel: number, note: number, velocity: number) => [status(0x90, channel), data(note), Math.max(1, data(velocity))];
export const noteOffBytes = (channel: number, note: number) => [status(0x80, channel), data(note), 0];
export const controlBytes = (channel: number, controller: number, value: number) => [status(0xb0, channel), data(controller), data(value)];
export const programBytes = (channel: number, program: number) => [status(0xc0, channel), data(program)];
export const pressureBytes = (channel: number, value: number) => [status(0xd0, channel), data(value)];

/** Pitch bend, −1..1 with 0 in the middle, as the two 7-bit halves of a 14-bit number. */
export function pitchBendBytes(channel: number, amount: number): number[] {
  const raw = clamp(Math.round(8192 + clamp(amount, -1, 1) * 8191), 0, 16383);
  return [status(0xe0, channel), raw & 0x7f, raw >> 7];
}

/* ─────────────────────────────── the clock ─────────────────────────────── */

/**
 * Web MIDI stamps messages on the performance.now() clock; notes are scheduled on
 * the audio clock. This is the time on the first that the second reaches the
 * speakers. An offline render has no output and never calls here.
 */
export function performanceTimeOf(context: BaseAudioContext, audioTime: number): number {
  const live = context as AudioContext;
  if (typeof live.getOutputTimestamp === "function") {
    const stamp = live.getOutputTimestamp();
    if (stamp.performanceTime !== undefined && stamp.contextTime !== undefined && stamp.performanceTime > 0) {
      return stamp.performanceTime + (audioTime - stamp.contextTime) * 1000;
    }
  }
  return performance.now() + (audioTime - context.currentTime) * 1000;
}

const isOffline = (context: BaseAudioContext) => typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext;

/* ─────────────────────────────── what is sounding out there ─────────────────────────────── */

interface Sounding {
  ref: MidiOutRef;
  note: number;
}

/** Every note switched on and not yet off, so a stop or panic can switch each one off. */
const sounding = new Set<Sounding>();
/** The ports and channels used, so "all notes off" also reaches notes sent by something else. */
const used = new Map<string, MidiOutRef>();

const keyOf = (ref: MidiOutRef) => `${ref.portId}|${ref.portName}|${ref.channel}`;

const send = (ref: MidiOutRef, bytes: number[], timestamp?: number) => midiManager.send(ref.portId, ref.portName, bytes, timestamp);

/** Is there a port to send to right now? (False when MIDI isn't enabled or the cable is gone.) */
export function midiOutReady(ref: MidiOutRef): boolean {
  return midiManager.findOutput(ref.portId, ref.portName) !== null;
}

/* ─────────────────────────────── a note ─────────────────────────────── */

export interface MidiOutNote {
  time: number;
  pitch: number;
  /** 0..1 */
  velocity: number;
  /** Seconds, or null to hold until released. */
  duration: number | null;
}

/** Start a note on the external port. Null for an offline render (it has no MIDI) or when nothing is listening. */
export function createMidiOutVoice(context: BaseAudioContext, ref: MidiOutRef, note: MidiOutNote): Voice | null {
  if (isOffline(context)) return null;
  if (!midiOutReady(ref)) return null;

  const pitch = clamp(Math.round(note.pitch), 0, 127);
  const velocity = Math.round(clamp(note.velocity, 0, 1) * 127);
  const startsAt = performanceTimeOf(context, note.time);

  used.set(keyOf(ref), ref);
  send(ref, noteOnBytes(ref.channel, pitch, velocity), startsAt);

  const entry: Sounding = { ref, note: pitch };
  sounding.add(entry);

  let ended = false;
  const end = (audioTime: number, notBefore = startsAt + 1) => {
    if (ended) return;
    ended = true;
    sounding.delete(entry);
    // Never before its own note-on, or the note would start after it was stopped.
    send(ref, noteOffBytes(ref.channel, pitch), Math.max(performanceTimeOf(context, audioTime), notBefore));
  };

  if (note.duration !== null) end(note.time + Math.max(0.02, note.duration));

  return {
    release: (time) => end(time),
    kill: (time) => end(time),
    bend: (cents) => {
      send(ref, pitchBendBytes(ref.channel, cents / 200));
    },
    modulate: (amount) => {
      send(ref, controlBytes(ref.channel, 1, amount * 127));
    }
  };
}

/** Both voices as one, for a channel that sends out and plays here too. */
export function joinVoices(first: Voice, second: Voice): Voice {
  return {
    release: (time) => {
      first.release(time);
      second.release(time);
    },
    kill: (time) => {
      first.kill(time);
      second.kill(time);
    },
    bend: (cents, time) => {
      first.bend?.(cents, time);
      second.bend?.(cents, time);
    },
    modulate: (amount, time) => {
      first.modulate?.(amount, time);
      second.modulate?.(amount, time);
    }
  };
}

/* ─────────────────────────────── everything off ─────────────────────────────── */

/** Switch off every note still sounding out there, and tell each port and channel used to let go of the rest. */
export function midiOutPanic(): void {
  for (const entry of sounding) send(entry.ref, noteOffBytes(entry.ref.channel, entry.note));
  sounding.clear();

  for (const ref of used.values()) {
    send(ref, controlBytes(ref.channel, 123, 0));
    send(ref, controlBytes(ref.channel, 120, 0));
    send(ref, pitchBendBytes(ref.channel, 0));
  }
}

/** A short note, to check the connection: the keyboard-played middle C. */
export function sendTestNote(context: BaseAudioContext, ref: MidiOutRef, pitch = 60): boolean {
  if (!midiOutReady(ref)) return false;
  createMidiOutVoice(context, ref, { time: context.currentTime, pitch, velocity: 0.8, duration: 0.6 });
  return true;
}

/* ─────────────────────────────── a keyboard's other controls ─────────────────────────────── */

/** Knob turns, pressure and preset changes from a keyboard, passed through to the instrument it is playing. */
export function forwardControl(
  ref: MidiOutRef,
  message: { type: "cc"; controller: number; value: number } | { type: "pressure"; value: number } | { type: "program"; program: number }
): void {
  used.set(keyOf(ref), ref);
  if (message.type === "cc") send(ref, controlBytes(ref.channel, message.controller, message.value * 127));
  else if (message.type === "pressure") send(ref, pressureBytes(ref.channel, message.value * 127));
  else send(ref, programBytes(ref.channel, message.program));
}
