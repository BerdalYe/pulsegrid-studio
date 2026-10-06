import { IconChevronDown, IconChevronUp, IconClose, IconReset } from "./icons";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { useProjectStore, type EffectTarget } from "../state/projectStore";
import { useSessionStore } from "../state/sessionStore";
import { getMasterLevel, getMixerLevel } from "../audio/engine";
import { effectTypeDefs, formatParamValue, getEffectDef } from "../audio/effectDefs";
import { effectPresets } from "../presets/presets";
import { useConfirm } from "./ConfirmDialog";
import { Fader, Knob, LevelMeter } from "./controls";
import { gainToDb } from "../lib/utils";
import { MASTER_OUTPUT, wouldCreateCycle } from "../audio/routing";

import type { EffectInstance, EffectType, MixerTrack } from "../types";

/** Shared so unrouted strips get a stable prop and `memo` still bails. */
const NO_CHANNELS: string[] = [];

const FADER_HEIGHT = 118;

export function Mixer() {
  const tracks = useProjectStore((state) => state.mixer.tracks);
  const channels = useProjectStore((state) => state.channels);
  const masterVolume = useProjectStore((state) => state.masterVolume);
  const masterEffects = useProjectStore((state) => state.mixer.masterEffects);
  const setMasterVolume = useProjectStore((state) => state.setMasterVolume);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const selectedMixerTrackId = useSessionStore((state) => state.selectedMixerTrackId);
  const selectMixerTrack = useSessionStore((state) => state.selectMixerTrack);

  // Stable identity so `memo` on MixerStrip can actually bail out — a fresh
  // arrow per render would defeat it on every parent render.
  const handleSelect = useCallback(
    (trackId: number) => selectMixerTrack(trackId),
    [selectMixerTrack]
  );

  const channelsByTrack = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const channel of channels) {
      const list = map.get(channel.mixerTrackId) ?? [];
      list.push(channel.name);
      map.set(channel.mixerTrackId, list);
    }
    return map;
  }, [channels]);

  const trackNames = useMemo(
    () => new Map(tracks.map((track) => [track.id, track.name])),
    [tracks]
  );

  const selectedTrack = tracks.find((track) => track.id === selectedMixerTrackId);
  const isMasterSelected = selectedMixerTrackId === 0;

  return (
    <section className="mixer">
      <div className="mixer-strips">
        <div
          className={`strip master-strip${isMasterSelected ? " selected" : ""}`}
          onPointerDown={() => selectMixerTrack(0)}
        >
          <div className="strip-name">Master</div>

          <div className="strip-meters">
            <LevelMeter read={getMasterLevel} height={FADER_HEIGHT} />
            <Fader
              label="Master volume"
              value={masterVolume}
              height={FADER_HEIGHT}
              defaultValue={0.9}
              display={`${gainToDb(masterVolume).toFixed(1)} dB`}
              learnId="master:volume"
              onChange={setMasterVolume}
              onCommitStart={() => beginEdit("Master volume")}
              onCommitEnd={endEdit}
            />
          </div>

          <div className="strip-readout">{gainToDb(masterVolume).toFixed(1)} dB</div>
          <div className="strip-fx-count">
            {masterEffects.length > 0 ? `${masterEffects.length} FX` : "—"}
          </div>
        </div>

        {tracks.map((track) => (
          <MixerStrip
            key={track.id}
            track={track}
            selected={track.id === selectedMixerTrackId}
            routedChannels={channelsByTrack.get(track.id) ?? NO_CHANNELS}
            outputName={
              track.output === MASTER_OUTPUT ? "Master" : trackNames.get(track.output) ?? "Master"
            }
            sendCount={track.sends.length}
            onSelect={handleSelect}
          />
        ))}
      </div>

      <EffectRack
        target={isMasterSelected ? "master" : selectedTrack?.id ?? 1}
        title={isMasterSelected ? "Master" : selectedTrack?.name ?? "Insert"}
        effects={isMasterSelected ? masterEffects : selectedTrack?.effects ?? []}
        routing={
          !isMasterSelected && selectedTrack ? (
            <RoutingPanel track={selectedTrack} tracks={tracks} />
          ) : null
        }
      />
    </section>
  );
}

const MixerStrip = memo(function MixerStrip({
  track,
  selected,
  routedChannels,
  outputName,
  sendCount,
  onSelect
}: {
  track: MixerTrack;
  selected: boolean;
  routedChannels: string[];
  outputName: string;
  sendCount: number;
  onSelect: (trackId: number) => void;
}) {
  const readLevel = useCallback(() => getMixerLevel(track.id), [track.id]);

  const setMixerTrackVolume = useProjectStore((state) => state.setMixerTrackVolume);
  const setMixerTrackPan = useProjectStore((state) => state.setMixerTrackPan);
  const toggleMixerTrackMute = useProjectStore((state) => state.toggleMixerTrackMute);
  const toggleMixerTrackSolo = useProjectStore((state) => state.toggleMixerTrackSolo);
  const renameMixerTrack = useProjectStore((state) => state.renameMixerTrack);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const [draft, setDraft] = useState(track.name);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => setDraft(track.name), [track.name]);

  const enabledCount = track.effects.filter((effect) => effect.enabled).length;

  return (
    <div
      className={`strip${selected ? " selected" : ""}${track.mute ? " muted" : ""}`}
      onPointerDown={() => onSelect(track.id)}
    >
      {renaming ? (
        <input
          className="strip-name-input"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            renameMixerTrack(track.id, draft);
            setRenaming(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(track.name);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <div className="strip-name" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
          {track.name}
        </div>
      )}

      <div className="strip-routing" title={routedChannels.join(", ") || "Nothing routed here"}>
        {routedChannels.length > 0 ? routedChannels.join(", ") : "—"}
      </div>

      <Knob
        label="Pan"
        size={30}
        value={track.pan}
        min={-1}
        max={1}
        step={0.01}
        defaultValue={0}
        display={
          Math.abs(track.pan) < 0.005
            ? "C"
            : `${track.pan < 0 ? "L" : "R"}${Math.round(Math.abs(track.pan) * 100)}`
        }
        learnId={`insert:${track.id}:pan`}
        onChange={(value) => setMixerTrackPan(track.id, value)}
        onCommitStart={() => beginEdit("Insert pan")}
        onCommitEnd={endEdit}
      />

      <div className="strip-meters">
        <LevelMeter read={readLevel} height={FADER_HEIGHT} />
        <Fader
          label={`${track.name} volume`}
          value={track.volume}
          max={1.5}
          height={FADER_HEIGHT}
          defaultValue={1}
          display={`${gainToDb(track.volume).toFixed(1)} dB`}
          learnId={`insert:${track.id}:volume`}
          onChange={(value) => setMixerTrackVolume(track.id, value)}
          onCommitStart={() => beginEdit("Insert volume")}
          onCommitEnd={endEdit}
        />
      </div>

      <div className="strip-readout">{gainToDb(track.volume).toFixed(1)} dB</div>

      <div className="strip-row">
        <button
          className={track.mute ? "active" : ""}
          aria-pressed={track.mute}
          onClick={() => toggleMixerTrackMute(track.id)}
          title="Mute insert"
        >
          M
        </button>
        <button
          className={track.solo ? "active" : ""}
          aria-pressed={track.solo}
          onClick={() => toggleMixerTrackSolo(track.id)}
          title="Solo insert"
        >
          S
        </button>
      </div>

      <div className="strip-fx-count">{enabledCount > 0 ? `${enabledCount} FX` : "—"}</div>

      <div
        className={`strip-output${track.output === MASTER_OUTPUT ? "" : " bus"}`}
        title={`Output: ${outputName}${sendCount > 0 ? `, plus ${sendCount} send${sendCount === 1 ? "" : "s"}` : ""}`}
      >
        → {outputName}
        {sendCount > 0 ? <span className="strip-sends">+{sendCount}</span> : null}
      </div>
    </div>
  );
});

/* ──────────────────────────────── routing ──────────────────────────────── */

/**
 * Where the selected insert goes: its main output (master, or another insert
 * used as a bus) and any number of post-fader sends — a shared reverb, a
 * parallel-compression bus. Destinations that would close a loop are left out
 * of the lists rather than refused after the fact.
 */
function RoutingPanel({ track, tracks }: { track: MixerTrack; tracks: MixerTrack[] }) {
  const setMixerTrackOutput = useProjectStore((state) => state.setMixerTrackOutput);
  const addMixerSend = useProjectStore((state) => state.addMixerSend);
  const setMixerSendLevel = useProjectStore((state) => state.setMixerSendLevel);
  const removeMixerSend = useProjectStore((state) => state.removeMixerSend);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const others = tracks.filter((entry) => entry.id !== track.id);

  const outputChoices = others.filter(
    (entry) => entry.id === track.output || !wouldCreateCycle(tracks, track.id, entry.id)
  );

  const sendChoices = others.filter(
    (entry) =>
      entry.id !== track.output &&
      !track.sends.some((send) => send.target === entry.id) &&
      !wouldCreateCycle(tracks, track.id, entry.id)
  );

  const nameOf = (id: number) => tracks.find((entry) => entry.id === id)?.name ?? `Insert ${id}`;

  return (
    <div className="routing-panel">
      <label className="routing-output">
        Output
        <select
          value={track.output}
          onChange={(event) => setMixerTrackOutput(track.id, Number(event.target.value))}
        >
          <option value={MASTER_OUTPUT}>Master</option>
          {outputChoices.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      <div className="routing-sends">
        <span className="routing-label">Sends</span>

        {track.sends.length === 0 ? <span className="small-note">none</span> : null}

        {track.sends.map((send) => (
          <div key={send.target} className="routing-send">
            <Knob
              label={nameOf(send.target)}
              size={26}
              value={send.level}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.5}
              display={`${gainToDb(send.level).toFixed(1)} dB`}
              learnId={`send:${track.id}:${send.target}`}
              onChange={(value) => setMixerSendLevel(track.id, send.target, value)}
              onCommitStart={() => beginEdit("Send level")}
              onCommitEnd={endEdit}
            />
            <button
              className="routing-remove"
              title={`Remove send to ${nameOf(send.target)}`}
              onClick={() => removeMixerSend(track.id, send.target)}
            >
              ×
            </button>
          </div>
        ))}

        {sendChoices.length > 0 ? (
          <select
            className="routing-add"
            value=""
            aria-label="Add a send"
            onChange={(event) => {
              const target = Number(event.target.value);
              if (target) addMixerSend(track.id, target);
            }}
          >
            <option value="">+ Send to…</option>
            {sendChoices.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

/* ──────────────────────────────── FX rack ──────────────────────────────── */

function EffectRack({
  target,
  title,
  effects,
  routing
}: {
  target: EffectTarget;
  title: string;
  effects: EffectInstance[];
  routing?: React.ReactNode;
}) {
  const addEffect = useProjectStore((state) => state.addEffect);
  const addEffectPreset = useProjectStore((state) => state.addEffectPreset);
  const [type, setType] = useState<EffectType>("eq");
  const [presetId, setPresetId] = useState(effectPresets[0]?.id ?? "");

  return (
    <div className="effect-rack">
      <div className="rack-head">
        <strong>{title}</strong>
        <span className="small-note">Insert effects run top to bottom</span>
        <span className="menu-spacer" />

        <label>
          Add
          <select value={type} onChange={(event) => setType(event.target.value as EffectType)}>
            {effectTypeDefs.map((def) => (
              <option key={def.type} value={def.type}>
                {def.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => addEffect(target, type)}>+</button>

        <label>
          Preset
          <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
            {effectPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => addEffectPreset(target, presetId)}>+</button>
      </div>

      {routing}

      <div className="rack-slots">
        {effects.length === 0 ? (
          <div className="empty-note">No effects on this insert yet.</div>
        ) : (
          effects.map((effect, index) => (
            <EffectSlot
              key={effect.id}
              effect={effect}
              target={target}
              isFirst={index === 0}
              isLast={index === effects.length - 1}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EffectSlot({
  effect,
  target,
  isFirst,
  isLast
}: {
  effect: EffectInstance;
  target: EffectTarget;
  isFirst: boolean;
  isLast: boolean;
}) {
  const confirm = useConfirm();
  const toggleEffect = useProjectStore((state) => state.toggleEffect);
  const removeEffect = useProjectStore((state) => state.removeEffect);
  const moveEffect = useProjectStore((state) => state.moveEffect);
  const resetEffect = useProjectStore((state) => state.resetEffect);
  const updateEffectParam = useProjectStore((state) => state.updateEffectParam);
  const beginEdit = useProjectStore((state) => state.beginEdit);
  const endEdit = useProjectStore((state) => state.endEdit);

  const def = getEffectDef(effect.type);

  return (
    <div className={`effect-slot${effect.enabled ? "" : " bypassed"}`}>
      <div className="effect-heading">
        <button
          className={effect.enabled ? "led on" : "led"}
          onClick={() => toggleEffect(target, effect.id)}
          title={effect.enabled ? "Bypass" : "Enable"}
        />
        <strong>{effect.name}</strong>
        <span className="menu-spacer" />
        <button onClick={() => moveEffect(target, effect.id, -1)} disabled={isFirst} title="Move up" aria-label="Move up">
          <IconChevronUp />
        </button>
        <button onClick={() => moveEffect(target, effect.id, 1)} disabled={isLast} title="Move down" aria-label="Move down">
          <IconChevronDown />
        </button>
        <button onClick={() => resetEffect(target, effect.id)} title="Reset to defaults" aria-label="Reset to defaults">
          <IconReset />
        </button>
        <button
          title="Remove"
          aria-label="Remove"
          onClick={() =>
            void confirm(`Remove ${effect.name}?`, "Its settings will be lost.", {
              confirmLabel: "Remove"
            }).then((confirmed) => {
              if (confirmed) removeEffect(target, effect.id);
            })
          }
        >
          <IconClose />
        </button>
      </div>

      <div className="effect-params">
        {def?.params.map((param) => {
          const value = effect.params[param.key] ?? param.min;

          if (param.options) {
            return (
              <label key={param.key} className="effect-select">
                {param.label}
                <select
                  value={Math.round(value)}
                  onChange={(event) =>
                    updateEffectParam(target, effect.id, param.key, Number(event.target.value))
                  }
                >
                  {param.options.map((option, index) => (
                    <option key={option} value={index}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            );
          }

          return (
            <Knob
              key={param.key}
              label={param.label}
              value={value}
              min={param.min}
              max={param.max}
              step={param.step}
              display={formatParamValue(param, value)}
              learnId={`fx:${effect.id}:${param.key}`}
              onChange={(next) => updateEffectParam(target, effect.id, param.key, next)}
              onCommitStart={() => beginEdit(`${effect.name} ${param.label}`)}
              onCommitEnd={endEdit}
            />
          );
        })}
      </div>
    </div>
  );
}
