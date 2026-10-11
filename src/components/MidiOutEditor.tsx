import { useEffect, useRef, useState } from "react";

import { ensureAudio } from "../audio/engine";
import { midiManager, type MidiDevice } from "../audio/midi";
import { midiOutPanic, midiOutReady, sendTestNote } from "../audio/midiOut";
import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import type { MidiOutRef } from "../types";
import { useSynthEditor } from "./SynthEditor";

/** Virtual MIDI cables are named by whoever made them; these are the ones people use. */
export function looksLikeCable(name: string): boolean {
  return /loopmidi|iac|virtual|rtpmidi|loopbe|midi yoke|bome/i.test(name);
}

/**
 * The panel for a channel that sends its notes to another program. Pick the MIDI
 * port (a virtual cable into the Akai Studio Instrument Collection, or any other
 * instrument) and the MIDI channel, and play the keyboard or write notes as usual.
 */
export function MidiOutEditor() {
  const channelId = useSynthEditor((state) => state.channelId);
  const behind = useSynthEditor((state) => state.behind);
  const close = useSynthEditor((state) => state.close);
  const channel = useProjectStore((state) => state.channels.find((entry) => entry.id === channelId));
  const update = useProjectStore((state) => state.updateChannelMidiOut);
  const selectChannel = useSessionStore((state) => state.selectChannel);

  const [outputs, setOutputs] = useState<MidiDevice[]>(() => midiManager.getOutputs());
  const [connected, setConnected] = useState(midiManager.isConnected);
  const [message, setMessage] = useState("");
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);

  const ref = channel?.midiOut;
  const open = channel !== undefined && channel.type === "synth" && ref !== undefined;

  useEffect(() => {
    if (!open || !channelId) return;
    selectChannel(channelId);
  }, [open, channelId, selectChannel]);

  // The list follows cables being added or unplugged.
  useEffect(() => {
    if (!open) return;
    return midiManager.onDevices(() => {
      setOutputs(midiManager.getOutputs());
      setConnected(midiManager.isConnected);
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);

  if (!open || !channel || !ref) return null;

  const change = (changes: Partial<MidiOutRef>) => update(channel.id, { ...ref, ...changes });
  const ready = midiOutReady(ref);
  const cables = outputs.filter((output) => looksLikeCable(output.name));

  const enable = async () => {
    const ok = await midiManager.init();
    setConnected(ok);
    setOutputs(midiManager.getOutputs());
    setMessage(ok ? "" : "MIDI couldn't be turned on. Check that this app is allowed to use MIDI.");
  };

  const test = () => {
    const context = ensureAudio();
    if (!context) return;
    setMessage(sendTestNote(context, ref) ? "Sent a middle C." : "No port to send to yet. Choose one above.");
  };

  const chosenMissing = ref.portName !== "" && !outputs.some((output) => output.id === ref.portId || output.name === ref.portName);

  return (
    <div
      className={`synth-editor midiout-editor${behind ? " behind" : ""}`}
      role="dialog"
      aria-label={`MIDI out for ${channel.name}`}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <header
        className="synth-editor-bar"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button, select, input")) return;
          dragStart.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = dragStart.current;
          if (!start) return;
          setOffset({ x: start.startX + event.clientX - start.x, y: start.startY + event.clientY - start.y });
        }}
        onPointerUp={() => {
          dragStart.current = null;
        }}
      >
        <strong>
          MIDI Out <span>· {channel.name}</span>
        </strong>
        <span className="menu-spacer" />
        <button type="button" onClick={test} title="Send a short middle C to the port">
          Test note
        </button>
        <button type="button" onClick={midiOutPanic} title="Switch off every note that is still sounding">
          All notes off
        </button>
        <button type="button" className="synth-close" onClick={close} aria-label="Close the MIDI out panel" title="Close">
          ×
        </button>
      </header>

      <div className="midiout-body">
        {!connected ? (
          <div className="midiout-enable">
            <p className="sf-note">MIDI is off. Turn it on to see the ports this computer has.</p>
            <button type="button" onClick={() => void enable()}>
              Turn on MIDI
            </button>
          </div>
        ) : null}

        <label className="sf-field">
          Send notes to
          <select
            value={outputs.some((output) => output.id === ref.portId) ? ref.portId : ref.portName ? `name:${ref.portName}` : ""}
            aria-label="MIDI output port"
            onChange={(event) => {
              const value = event.target.value;
              const picked = outputs.find((output) => output.id === value);
              if (picked) change({ portId: picked.id, portName: picked.name });
            }}
          >
            {ref.portName === "" ? <option value="">Choose a port…</option> : null}
            {chosenMissing ? <option value={`name:${ref.portName}`}>{ref.portName} (not connected)</option> : null}
            {outputs.map((output) => (
              <option key={output.id} value={output.id}>
                {output.name}
                {looksLikeCable(output.name) ? " · virtual cable" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="sf-field">
          MIDI channel
          <select value={ref.channel} aria-label="MIDI channel" onChange={(event) => change({ channel: Number(event.target.value) })}>
            {Array.from({ length: 16 }, (_, index) => index + 1).map((number) => (
              <option key={number} value={number}>
                Channel {number}
              </option>
            ))}
          </select>
        </label>

        <label className="midiout-check">
          <input type="checkbox" checked={ref.alsoPlay === true} onChange={(event) => change({ alsoPlay: event.target.checked })} />
          Also play it with PulseGrid's own sound
        </label>

        <label className="midiout-check">
          <input type="checkbox" checked={ref.knobsToStudio === true} onChange={(event) => change({ knobsToStudio: event.target.checked })} />
          Keep linked knobs for PulseGrid (volume, pan, tempo)
        </label>

        <p className={`sf-note${ready ? "" : " sf-error"}`} role="status">
          {ready
            ? `Ready: notes go to ${ref.portName || "the port"} on channel ${ref.channel}.`
            : connected
              ? outputs.length === 0
                ? "No MIDI ports found. Install a virtual MIDI cable first (see the steps below)."
                : "Choose the port the other program listens to."
              : "Turn on MIDI to start sending."}
          {cables.length > 0 && !ready ? ` Found a virtual cable: ${cables[0].name}.` : ""}
        </p>
        {message ? <p className="sf-note">{message}</p> : null}

        <details className="midiout-help">
          <summary>How to play the Akai Studio Instrument Collection</summary>
          <ol>
            <li>
              Make a virtual MIDI cable. On Windows, install the free <strong>loopMIDI</strong> and add a port (call it
              “PulseGrid”). On a Mac, open Audio MIDI Setup, show the MIDI Studio, and turn on the <strong>IAC Driver</strong>.
            </li>
            <li>
              Open the Akai instruments in a program that can host plugins: the software that came with your keyboard, or any
              VST/AU host. Add an instrument from the Collection to a track.
            </li>
            <li>In that program, set the track's MIDI input to the same cable.</li>
            <li>Back here, choose that cable above. Play your keyboard, or write notes on this channel.</li>
          </ol>
          <p className="sf-note">
            The sound comes from the other program, not from PulseGrid's mixer, and it is not in a PulseGrid export. Record that
            program's output, or bounce it there.
          </p>
        </details>
      </div>

      <footer className="synth-editor-foot">
        Keys, pads, the pitch wheel, the mod wheel, sustain and any knob that isn't linked to something in PulseGrid are passed on.
      </footer>
    </div>
  );
}
