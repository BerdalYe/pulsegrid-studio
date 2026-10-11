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
import { DRUM_KITS, KIT_PADS, KIT_PIECES, drumName, kitPieceColor } from "../lib/drumKits";
import { INSTRUMENT_GROUPS, INSTRUMENT_MENU } from "../presets/presets";
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

/** The pitch to try an instrument at: middle C, the kick for a whole drum kit, or a single drum as it is. */
const demoPitch = (ref: Pick<SoundFontRef, "bank" | "drumNote">) => (ref.bank === 128 && ref.drumNote === undefined ? 36 : 60);

/**
 * The built-in instruments worth offering, by family: the same ones the browser lists, so this panel never shows
 * the General MIDI set's sound effects (gunshots, helicopters, seashore) or its imitations of what's already here.
 */
const CURATED: Array<[string, Array<{ label: string; bank: number; program: number }>]> = INSTRUMENT_GROUPS.flatMap((group) => {
  const items = INSTRUMENT_MENU.filter(
    (entry) => entry.group === group && entry.soundfont && !entry.plugin && !entry.drumSet && entry.soundfont.bank !== 128
  ).map((entry) => ({ label: entry.label, bank: entry.soundfont!.bank, program: entry.soundfont!.program }));
  return items.length > 0 ? [[group, items] as [string, typeof items]] : [];
});

/** The kits a drum channel can switch between. */
const KITS: Array<{ name: string; program: number; mapped: boolean }> = [
  ...DRUM_KITS.map((kit) => ({ name: kit.name, program: kit.program, mapped: true })),
  { name: "Orchestral Percussion", program: 48, mapped: false }
];

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
  const renameChannel = useProjectStore((state) => state.updateChannelName);
  const setColor = useProjectStore((state) => state.setChannelColor);
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
  const play = (pitch = demoPitch(ref)) => previewChannel(channel.id, pitch, 0.85, 1.2);
  const builtin = ref.fontId === BUILTIN_ID;
  const isKit = ref.bank === 128;
  const single = isKit && ref.drumNote !== undefined;

  // A channel still called what it plays is renamed along with the sound; one the person named keeps its name.
  const renameTo = (name: string) => {
    if (channel.name === ref.name) renameChannel(channel.id, name);
  };

  const choose = (bank: number, program: number, name: string) => {
    // Another kit for a single drum keeps the drum; anything else is a whole instrument.
    const keepDrum = bank === 128 && ref.bank === 128 && ref.drumNote !== undefined;
    const kit = DRUM_KITS.find((candidate) => candidate.program === program);
    const piece = KIT_PIECES.find((candidate) => candidate.note === ref.drumNote);
    const label = keepDrum ? `${kit?.short ?? name} ${piece?.name ?? drumName(ref.drumNote!) ?? "Drum"}` : name;
    const next: SoundFontRef = { ...ref, bank, program, name: label };
    if (!keepDrum) delete next.drumNote;
    renameTo(label);
    update(channel.id, next);
    // Heard straight away: a kick for a drum kit, middle C for the rest.
    window.setTimeout(() => previewChannel(channel.id, demoPitch(next), 0.85, 1.2), 0);
  };

  // A pad plays its drum; on a channel of one drum it also makes that the drum the channel plays.
  const hitPad = (note: number) => {
    if (!single) {
      previewChannel(channel.id, note, 0.9, 0.6);
      return;
    }
    if (note !== ref.drumNote) {
      const kit = DRUM_KITS.find((candidate) => candidate.program === ref.program);
      const label = `${kit?.short ?? "Kit"} ${drumName(note) ?? "Drum"}`;
      renameTo(label);
      // The colour follows the drum too, unless the person picked one of their own.
      if (channel.color === kitPieceColor(ref.drumNote!)) {
        const color = kitPieceColor(note);
        if (color) setColor(channel.id, color);
      }
      update(channel.id, { ...ref, drumNote: note, name: label });
    }
    window.setTimeout(() => previewChannel(channel.id, 60, 0.9, 0.6), 0);
  };

  const needle = query.trim().toLowerCase();
  const curated = needle
    ? CURATED.map(([group, items]) => [group, items.filter((item) => item.label.toLowerCase().includes(needle))] as const).filter(([, items]) => items.length > 0)
    : CURATED;

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
    if (!(await confirm("Remove this sound file?", `${name} will be removed from this computer. Projects that use it play the built-in instruments instead, until you add it again.`, { confirmLabel: "Remove" }))) return;
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
          {channel.name} <span>· {single ? "Drum" : isKit ? "Drum kit" : "Instrument"}</span>
        </strong>
        <span className="menu-spacer" />
        <button type="button" onClick={() => play()} title={single ? "Play the drum" : "Play one note"}>
          {single ? "Play" : "Play note"}
        </button>
        {single ? null : (
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
        )}
        <button type="button" className="synth-close" onClick={close} aria-label="Close the instrument panel" title="Close">
          ×
        </button>
      </header>

      <div className="sf-body">
        <div className="sf-sidebar">
          <label className="sf-field">
            Sounds
            <select
              value={ref.fontId}
              aria-label="SoundFont"
              onChange={(event) => {
                const id = event.target.value;
                change({ fontId: id, fontName: id === BUILTIN_ID ? BUILTIN_NAME : (fonts[id]?.name ?? id) });
              }}
            >
              {builtinVisible ? <option value={BUILTIN_ID}>{BUILTIN_NAME}</option> : null}
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
          {isKit ? (
            <div className="sf-pads-wrap">
              <span className="sf-caption">{single ? "Click a pad to change the drum this channel plays" : "Click the pads to hear the kit"}</span>
              <div className="sf-pads" role="group" aria-label="Drum pads">
                {/* Top row first on screen, the kick bottom-left, as on a pad controller. */}
                {[12, 8, 4, 0].flatMap((row) =>
                  KIT_PADS.slice(row, row + 4).map((note) => (
                    <button
                      key={note}
                      type="button"
                      className={`sf-pad${single && note === ref.drumNote ? " active" : ""}`}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        hitPad(note);
                      }}
                      title={single ? `Play ${drumName(note)} on this channel` : `${drumName(note)} (key ${note})`}
                    >
                      {drumName(note)}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <input
              type="search"
              className="sf-search"
              value={query}
              placeholder="Search instruments…"
              aria-label="Search instruments"
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <div className="sf-list" role="listbox" aria-label={isKit ? "Kits" : "Instruments"}>
            {builtin && isKit ? (
              <div className="sf-group">
                <h4>Kits</h4>
                {KITS.filter((kit) => !single || kit.mapped).map((kit) => {
                  const chosen = kit.program === ref.program;
                  return (
                    <button
                      key={kit.program}
                      type="button"
                      role="option"
                      aria-selected={chosen}
                      className={chosen ? "active" : ""}
                      onClick={() => choose(128, kit.program, kit.name)}
                    >
                      {kit.name}
                    </button>
                  );
                })}
              </div>
            ) : builtin ? (
              <>
                {curated.length === 0 ? <p className="sf-note">{font ? "Nothing matches." : "The instruments appear here once they are loaded."}</p> : null}
                {curated.map(([group, items]) => (
                  <div key={group} className="sf-group">
                    <h4>{group}</h4>
                    {items.map((item) => {
                      const chosen = item.bank === ref.bank && item.program === ref.program;
                      return (
                        <button
                          key={`${item.bank}:${item.program}:${item.label}`}
                          type="button"
                          role="option"
                          aria-selected={chosen}
                          className={chosen ? "active" : ""}
                          onClick={() => choose(item.bank, item.program, item.label)}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
      </div>

      <footer className="synth-editor-foot">
        {single
          ? "One drum on its own channel: click its steps in the channel rack. In the piano roll, C4 (middle C) plays it as recorded and other notes tune it."
          : isKit
            ? "The whole kit on one channel: every key is a different drum, named in the piano roll. On the computer keyboard Z is the kick."
            : "Pick an instrument to hear it, then play the keyboard. Notes you write in the piano roll use it too."}
      </footer>
    </div>
  );
}
