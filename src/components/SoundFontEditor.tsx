import { useEffect, useMemo, useRef, useState } from "react";

import { previewChannel } from "../audio/engine";
import {
  BUILTIN_ID,
  BUILTIN_NAME,
  importSoundFont,
  listPresets,
  loadFont,
  removeSoundFont,
  useSoundFontStore
} from "../audio/soundfont/registry";
import { useGesture } from "../hooks/useStudio";
import type { SoundFontRef } from "../types";
import { useProjectStore } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { Knob } from "./controls";
import { useConfirm } from "./ConfirmDialog";
import { useSynthEditor } from "./SynthEditor";

/** What a bank number means, for the list's headings. */
function bankTitle(bank: number): string {
  if (bank === 0) return "Instruments";
  if (bank === 128) return "Drum kits";
  if (bank === 120) return "Sound effects";
  return `Variations (bank ${bank})`;
}

/** The pitch to try an instrument at: middle C, or the kick for a drum kit. */
const demoPitch = (bank: number) => (bank === 128 ? 36 : 60);

/**
 * The panel for a channel that plays a recorded instrument: pick any instrument
 * of the SoundFont (or add a SoundFont of your own), shape its attack and
 * release, and hear it as you go. It opens and closes like the synth editor.
 */
export function SoundFontEditor() {
  const channelId = useSynthEditor((state) => state.channelId);
  const close = useSynthEditor((state) => state.close);
  const channel = useProjectStore((state) => state.channels.find((entry) => entry.id === channelId));
  const update = useProjectStore((state) => state.updateChannelSoundFont);
  const selectChannel = useSessionStore((state) => state.selectChannel);
  const fonts = useSoundFontStore((state) => state.fonts);
  const builtinAvailable = useSoundFontStore((state) => state.builtinAvailable);
  const gesture = useGesture("Instrument");
  const confirm = useConfirm();

  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);

  const ref = channel?.soundfont;
  const open = channel !== undefined && channel.type === "synth" && ref !== undefined && !channel.midiOut;
  const fontId = ref?.fontId;

  // The channel being edited is the one the keyboard plays; and its SoundFont is read now.
  useEffect(() => {
    if (!open || !channelId) return;
    selectChannel(channelId);
  }, [open, channelId, selectChannel]);

  useEffect(() => {
    if (open && fontId) void loadFont(fontId);
  }, [open, fontId]);

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

  const entry = fontId ? fonts[fontId] : undefined;
  const font = entry?.font ?? null;
  const presets = useMemo(() => (font ? listPresets(font) : []), [font]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle ? presets.filter((preset) => preset.name.toLowerCase().includes(needle) || String(preset.program + 1) === needle) : presets;
    const groups = new Map<number, typeof presets>();
    for (const preset of matching) groups.set(preset.bank, [...(groups.get(preset.bank) ?? []), preset]);
    return [...groups.entries()].sort(([a], [b]) => (a === 0 ? -1 : b === 0 ? 1 : a === 128 ? 1 : b === 128 ? -1 : a - b));
  }, [presets, query]);

  if (!open || !channel || !ref) return null;

  const change = (changes: Partial<SoundFontRef>) => update(channel.id, { ...ref, ...changes });
  const play = (pitch = demoPitch(ref.bank)) => previewChannel(channel.id, pitch, 0.85, 1.2);

  const choose = (bank: number, program: number, name: string) => {
    update(channel.id, { ...ref, bank, program, name });
    // Heard straight away: a kick for a drum kit, middle C for the rest.
    window.setTimeout(() => previewChannel(channel.id, demoPitch(bank), 0.85, 1.2), 0);
  };

  const addFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      const added = await importSoundFont(file);
      const first = listPresets(added.font!)[0];
      update(channel.id, { ...ref, fontId: added.id, fontName: added.name, bank: first?.bank ?? 0, program: first?.program ?? 0, name: first?.name ?? added.name });
      setMessage(`Added ${added.name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That SoundFont couldn't be added.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const removeCurrent = async () => {
    if (ref.fontId === BUILTIN_ID) return;
    const name = entry?.name ?? ref.fontName;
    if (!(await confirm("Remove this SoundFont?", `${name} will be removed from this computer. Projects that use it play the built-in instruments instead, until you add it again.`, { confirmLabel: "Remove" }))) return;
    await removeSoundFont(ref.fontId);
    update(channel.id, { ...ref, fontId: BUILTIN_ID, fontName: BUILTIN_NAME });
  };

  const choices = Object.values(fonts).filter((item) => item.id !== BUILTIN_ID);
  const builtinVisible = builtinAvailable !== false || ref.fontId === BUILTIN_ID;

  const knob = (label: string, value: number, min: number, max: number, display: string, onChange: (next: number) => void, reset: number, log = false) => {
    const position = log ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
    const fromPosition = (p: number) => (log ? min * Math.pow(max / min, Math.min(1, Math.max(0, p))) : min + (max - min) * Math.min(1, Math.max(0, p)));
    return (
      <Knob
        label={label}
        value={position}
        min={0}
        max={1}
        step={0.002}
        size={38}
        display={display}
        defaultValue={log ? Math.log(reset / min) / Math.log(max / min) : (reset - min) / (max - min)}
        onChange={(next) => onChange(fromPosition(next))}
        onCommitStart={gesture.begin}
        onCommitEnd={gesture.end}
      />
    );
  };

  const attack = ref.attack ?? 1;
  const release = ref.release ?? 1;
  const brightness = ref.brightness ?? 1;
  const transpose = ref.transpose ?? 0;

  return (
    <div
      className="synth-editor sf-editor"
      role="dialog"
      aria-label={`Instrument for ${channel.name}`}
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
          SoundFont Instrument <span>· {channel.name}</span>
        </strong>
        <span className="menu-spacer" />
        <button type="button" onClick={() => play()} title="Play one note">
          Play note
        </button>
        <button
          type="button"
          onClick={() => {
            if (ref.bank === 128) {
              for (const [index, pitch] of [36, 42, 38, 42].entries()) window.setTimeout(() => previewChannel(channel.id, pitch, 0.85, 0.3), index * 220);
            } else {
              for (const pitch of [60, 64, 67]) previewChannel(channel.id, pitch, 0.8, 1.4);
            }
          }}
          title={ref.bank === 128 ? "Play a short beat" : "Play a C major chord"}
        >
          {ref.bank === 128 ? "Play beat" : "Play chord"}
        </button>
        <button type="button" className="synth-close" onClick={close} aria-label="Close the instrument panel" title="Close">
          ×
        </button>
      </header>

      <div className="sf-body">
        <div className="sf-sidebar">
          <label className="sf-field">
            SoundFont
            <select
              value={ref.fontId}
              aria-label="SoundFont"
              onChange={(event) => {
                const id = event.target.value;
                change({ fontId: id, fontName: id === BUILTIN_ID ? BUILTIN_NAME : (fonts[id]?.name ?? id) });
              }}
            >
              {builtinVisible ? <option value={BUILTIN_ID}>{BUILTIN_NAME} (built in)</option> : null}
              {choices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
              {!builtinVisible && choices.length === 0 ? <option value={ref.fontId}>No SoundFont yet</option> : null}
            </select>
          </label>

          <div className="sf-actions">
            <button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? "Adding…" : "Add a SoundFont…"}
            </button>
            {ref.fontId !== BUILTIN_ID ? (
              <button type="button" onClick={() => void removeCurrent()}>
                Remove
              </button>
            ) : null}
            <input
              ref={fileInput}
              type="file"
              accept=".sf2"
              hidden
              onChange={(event) => void addFile(event.target.files?.[0])}
            />
          </div>

          {entry?.loading ? <p className="sf-note">Loading the instruments…</p> : null}
          {entry?.error ? <p className="sf-note sf-error">{entry.error}</p> : null}
          {builtinAvailable === false ? (
            <p className="sf-note">
              The built-in instruments come with the Windows and Mac apps. In the browser, add a SoundFont (.sf2) file of your own.
            </p>
          ) : null}
          {message ? <p className="sf-note">{message}</p> : null}

          <div className="synth-knobs sf-tweaks">
            {knob("Attack", attack, 0.1, 4, `×${attack.toFixed(2)}`, (value) => change({ attack: value }), 1, true)}
            {knob("Release", release, 0.1, 4, `×${release.toFixed(2)}`, (value) => change({ release: value }), 1, true)}
            {knob("Brightness", brightness, 0, 1, `${Math.round(brightness * 100)}%`, (value) => change({ brightness: value }), 1)}
            {knob("Transpose", transpose, -12, 12, `${transpose > 0 ? "+" : ""}${Math.round(transpose)} st`, (value) => change({ transpose: Math.round(value) }), 0)}
          </div>
          <p className="sf-note">Attack and release stretch the instrument's own. Double-click a knob to reset it.</p>
        </div>

        <div className="sf-list-wrap">
          <input
            type="search"
            className="sf-search"
            value={query}
            placeholder={`Search ${presets.length || ""} instruments…`}
            aria-label="Search instruments"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="sf-list" role="listbox" aria-label="Instruments">
            {shown.length === 0 ? <p className="sf-note">{font ? "Nothing matches." : "The instruments appear here once they are loaded."}</p> : null}
            {shown.map(([bank, items]) => (
              <div key={bank} className="sf-group">
                <h4>{bankTitle(bank)}</h4>
                {items.map((preset) => {
                  const chosen = preset.bank === ref.bank && preset.program === ref.program;
                  return (
                    <button
                      key={`${preset.bank}:${preset.program}`}
                      type="button"
                      role="option"
                      aria-selected={chosen}
                      className={chosen ? "active" : ""}
                      onClick={() => choose(preset.bank, preset.program, preset.name)}
                    >
                      <span className="sf-number">{preset.bank === 0 || preset.bank === 128 ? preset.program + 1 : ""}</span>
                      {preset.name}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <footer className="synth-editor-foot">Pick an instrument to hear it, then play the keyboard. Notes you write in the piano roll use it too.</footer>
    </div>
  );
}
