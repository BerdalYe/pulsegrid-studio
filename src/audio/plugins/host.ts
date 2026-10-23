/**
 * VST3 plugins, from the studio's side (Windows desktop app). The plugins themselves run in the plugin host program,
 * reached through the plugin bridge (electron/pluginBridge.cjs); here:
 *  - the connection to the bridge and its requests;
 *  - which channel plays which plugin, in which of the hub's slots, kept in step with the project;
 *  - the hub worklet's outputs, wired to each plugin channel's strip;
 *  - the notes, sent as frames of the AudioContext so they land on the exact sample;
 *  - exporting: the plugins' parts made first, then mixed into the offline render.
 */
import { create } from "zustand";

import { getDesktop } from "../../files/desktop";
import type { Channel, PluginRef, PluginState, ProjectData } from "../../types";
import { useProjectStore } from "../../state/projectStore";
import type { RenderGraph } from "../graph";
import type { Voice } from "../voices";
import { samePlugin } from "./ref";
import hubUrl from "./hubWorklet.ts?worker&url";

export const PLUGIN_SLOTS = 16;

/** A plugin found on this computer by a scan. */
export interface FoundPlugin {
  path: string;
  uid: string;
  name: string;
  vendor: string;
  version: string;
  subCategories: string;
  instrument: boolean;
}

export type ChannelPluginStatus = { kind: "loading" } | { kind: "ready"; hasEditor: boolean } | { kind: "error"; message: string };

interface PluginStore {
  /** null until asked; false on the web, on a Mac, or without the host program. */
  available: boolean | null;
  plugins: FoundPlugin[];
  failed: Array<{ path: string; error: string }>;
  folders: string[];
  userFolders: string[];
  scannedAt: string | null;
  scanning: { done: number; total: number; file: string } | null;
  status: Record<string, ChannelPluginStatus>;
  /** Said once when the host program stopped and the plugins were started again. */
  notice: string;
}

export const usePluginStore = create<PluginStore>()(() => ({
  available: null,
  plugins: [],
  failed: [],
  folders: [],
  userFolders: [],
  scannedAt: null,
  scanning: null,
  status: {},
  notice: ""
}));

/* ─────────────────────────────── the connection ─────────────────────────────── */

let studioPort: MessagePort | null = null;
let audioPort: MessagePort | null = null;
let connecting: Promise<boolean> | null = null;
let nextRequest = 1;
const waiting = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
const offlineListeners = new Set<(done: number) => void>();

function connect(): Promise<boolean> {
  if (studioPort) return Promise.resolve(true);
  if (connecting) return connecting;
  connecting = (async () => {
    const desktop = getDesktop();
    if (!desktop?.pluginsAvailable || !desktop.connectPlugins) return false;
    if (!(await desktop.pluginsAvailable().catch(() => false))) return false;

    const ports = await new Promise<readonly MessagePort[] | null>((resolve) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 8000);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data !== "pulsegrid:plugin-ports" || event.ports.length < 2) return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(event.ports);
      };
      window.addEventListener("message", onMessage);
      desktop.connectPlugins!();
    });
    if (!ports) return false;
    [studioPort, audioPort] = ports;
    studioPort.onmessage = (event) => onBridgeMessage(event.data as Record<string, unknown>);
    return true;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Is plugin support here at all (Windows desktop app with the host program)? Asked once. */
export async function pluginsAvailable(): Promise<boolean> {
  const known = usePluginStore.getState().available;
  if (known !== null) return known;
  const desktop = getDesktop();
  const available = Boolean(desktop?.pluginsAvailable && (await desktop.pluginsAvailable().catch(() => false)));
  usePluginStore.setState({ available });
  return available;
}

function request<T = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return connect().then((ok) => {
    if (!ok || !studioPort) throw new Error("Plugins aren't available here.");
    const id = nextRequest++;
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (value: Record<string, unknown>) => void, reject });
      studioPort!.postMessage({ type: "request", id, cmd, ...args });
    });
  });
}

function onBridgeMessage(message: Record<string, unknown>): void {
  switch (message.type) {
    case "reply": {
      const entry = waiting.get(message.id as number);
      if (!entry) return;
      waiting.delete(message.id as number);
      if (message.ok) entry.resolve(message);
      else entry.reject(new Error(String(message.error ?? "The plugin couldn't do that.")));
      return;
    }
    case "state": {
      const channelId = channelOfSlot(message.slot as number);
      if (channelId) useProjectStore.getState().setChannelPluginState(channelId, message.state as PluginState);
      return;
    }
    case "scanProgress":
      usePluginStore.setState({ scanning: { done: message.done as number, total: message.total as number, file: String(message.file ?? "") } });
      return;
    case "offlineProgress":
      for (const listener of offlineListeners) listener(message.done as number);
      return;
    case "crashed":
      // Start them again from their last saved settings.
      usePluginStore.setState({ notice: "A plugin stopped working, so the plugins were started again." });
      for (const [channelId, entry] of slotsByChannel) {
        if (!(message.slots as number[]).includes(entry.slot)) continue;
        entry.loadedFor = null;
        entry.loading = false;
        entry.failed = false;
        setStatus(channelId, { kind: "loading" });
      }
      requestSync();
      return;
    default:
      return;
  }
}

/* ─────────────────────────────── the plugin list ─────────────────────────────── */

function applyList(list: Record<string, unknown>): void {
  usePluginStore.setState({
    plugins: (list.plugins as FoundPlugin[]) ?? [],
    failed: (list.failed as PluginStore["failed"]) ?? [],
    folders: (list.folders as string[]) ?? [],
    userFolders: (list.userFolders as string[]) ?? [],
    scannedAt: (list.scannedAt as string | null) ?? null
  });
}

/** The plugins found last time; scans first if there never was a scan. */
export async function loadPluginList(): Promise<void> {
  if (!(await pluginsAvailable())) return;
  const list = await request("list");
  applyList(list);
  if (!list.scannedAt) await scanForPlugins();
}

export async function scanForPlugins(): Promise<void> {
  if (!(await pluginsAvailable())) return;
  usePluginStore.setState({ scanning: { done: 0, total: 0, file: "" } });
  try {
    applyList(await request("scan"));
  } finally {
    usePluginStore.setState({ scanning: null });
  }
}

export async function setPluginFolders(folders: string[]): Promise<void> {
  const result = await request("setFolders", { folders });
  usePluginStore.setState({ folders: (result.folders as string[]) ?? [], userFolders: (result.userFolders as string[]) ?? [] });
}

/* ─────────────────────────────── slots ─────────────────────────────── */

interface SlotEntry {
  slot: number;
  ref: PluginRef;
  /** The plugin the host has loaded in this slot, or null while loading (or after the host stopped). */
  loadedFor: PluginRef | null;
  loading: boolean;
  /** It wouldn't load: not tried again until the channel's plugin changes. */
  failed: boolean;
  /** The channel input the hub's output is wired to. */
  wiredTo: AudioNode | null;
}

const slotsByChannel = new Map<string, SlotEntry>();

function channelOfSlot(slot: number): string | undefined {
  for (const [channelId, entry] of slotsByChannel) if (entry.slot === slot) return channelId;
  return undefined;
}

function freeSlot(): number | null {
  const used = new Set([...slotsByChannel.values()].map((entry) => entry.slot));
  for (let slot = 0; slot < PLUGIN_SLOTS; slot += 1) if (!used.has(slot)) return slot;
  return null;
}

function setStatus(channelId: string, status: ChannelPluginStatus | null): void {
  usePluginStore.setState((store) => {
    const next = { ...store.status };
    if (status) next[channelId] = status;
    else delete next[channelId];
    return { status: next };
  });
}

/* ─────────────────────────────── the hub ─────────────────────────────── */

let hubContext: AudioContext | null = null;
let hub: AudioWorkletNode | null = null;
let hubLoading: Promise<AudioWorkletNode | null> | null = null;
let lastGraph: RenderGraph | null = null;
let lastProject: ProjectData | null = null;

async function ensureHub(context: AudioContext): Promise<AudioWorkletNode | null> {
  if (hub && hubContext === context) return hub;
  if (hubLoading) return hubLoading;
  hubLoading = (async () => {
    if (!(await connect()) || !audioPort) return null;
    await context.audioWorklet.addModule(hubUrl);
    const node = new AudioWorkletNode(context, "pulsegrid-plugin-hub", {
      numberOfInputs: 0,
      numberOfOutputs: PLUGIN_SLOTS,
      outputChannelCount: Array(PLUGIN_SLOTS).fill(2)
    });
    node.port.postMessage({ type: "port", port: audioPort }, [audioPort]);
    await request("setup", { sampleRate: context.sampleRate });
    hub = node;
    hubContext = context;
    return node;
  })().finally(() => {
    hubLoading = null;
  });
  return hubLoading;
}

let syncQueued = false;

function requestSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    if (lastGraph && lastProject) void syncPlugins(lastGraph, lastProject);
  });
}

/**
 * Keep the host's plugins in step with the project: load a plugin for each channel that has one (with its saved
 * settings), let go of the ones no channel uses, and wire each slot to its channel's strip. Called on every project
 * change; cheap when nothing changed.
 */
export async function syncPlugins(graph: RenderGraph, project: ProjectData): Promise<void> {
  lastGraph = graph;
  lastProject = project;
  const wanted = project.channels.filter((channel): channel is Channel & { plugin: PluginRef } => channel.type === "synth" && Boolean(channel.plugin));

  // Gone: channels removed, or no longer playing a plugin.
  for (const [channelId, entry] of [...slotsByChannel]) {
    const channel = wanted.find((candidate) => candidate.id === channelId);
    if (channel && samePlugin(channel.plugin, entry.ref)) continue;
    slotsByChannel.delete(channelId);
    if (hub) hub.disconnect(entry.slot);
    setStatus(channelId, null);
    void request("unload", { slot: entry.slot }).catch(() => undefined);
  }
  if (!wanted.length) return;
  if (!(await pluginsAvailable())) {
    for (const channel of wanted) setStatus(channel.id, { kind: "error", message: "VST3 plugins play in the Windows app." });
    return;
  }

  const context = graph.context as AudioContext;
  const node = await ensureHub(context);
  if (!node) return;

  for (const channel of wanted) {
    let entry = slotsByChannel.get(channel.id);
    if (!entry) {
      const slot = freeSlot();
      if (slot === null) {
        setStatus(channel.id, { kind: "error", message: `Up to ${PLUGIN_SLOTS} plugins can play at once.` });
        continue;
      }
      entry = { slot, ref: channel.plugin, loadedFor: null, loading: false, failed: false, wiredTo: null };
      slotsByChannel.set(channel.id, entry);
    }

    if (!entry.loadedFor && !entry.loading && !entry.failed) {
      const loading = entry;
      loading.loading = true;
      setStatus(channel.id, { kind: "loading" });
      request<{ hasEditor?: boolean }>("load", { slot: entry.slot, path: channel.plugin.path, uid: channel.plugin.uid, state: channel.plugin.state })
        .then((reply) => {
          loading.loading = false;
          if (slotsByChannel.get(channel.id) !== loading) return;
          loading.loadedFor = loading.ref;
          setStatus(channel.id, { kind: "ready", hasEditor: reply.hasEditor !== false });
        })
        .catch((error: Error) => {
          loading.loading = false;
          loading.failed = true;
          if (slotsByChannel.get(channel.id) !== loading) return;
          setStatus(channel.id, { kind: "error", message: friendlyLoadError(error.message, channel.plugin) });
        });
    }

    // Wire the slot to the channel's strip, again whenever the strip was rebuilt.
    const input = graph.getChannelInput(channel.id) ?? null;
    if (input !== entry.wiredTo) {
      try {
        node.disconnect(entry.slot);
      } catch {
        /* nothing was connected yet */
      }
      if (input) node.connect(input, entry.slot, 0);
      entry.wiredTo = input;
    }
  }
}

function friendlyLoadError(message: string, ref: PluginRef): string {
  if (/Couldn't open the plugin file/i.test(message)) return `${ref.name} isn't installed on this computer.`;
  return message;
}

/** The studio's audio was shut down: the hub goes with it, and is made again next time. */
export function disposePlugins(): void {
  hub = null;
  hubContext = null;
  lastGraph = null;
  for (const entry of slotsByChannel.values()) entry.wiredTo = null;
}

/* ─────────────────────────────── playing ─────────────────────────────── */

interface NoteEventOut {
  slot: number;
  frame: number;
  kind: "on" | "off" | "cc" | "bend" | "allOff";
  a?: number;
  b?: number;
}

let outbox: NoteEventOut[] = [];
let flushQueued = false;

function send(event: NoteEventOut): void {
  outbox.push(event);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const list = outbox;
    outbox = [];
    studioPort?.postMessage({ type: "events", list });
  });
}

const isOffline = (context: BaseAudioContext) => typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext;

/** Notes collected while an export schedules the song, per offline render. */
const offlineNotes = new WeakMap<BaseAudioContext, Array<{ channelId: string; time: number; kind: "on" | "off"; pitch: number; velocity: number }>>();

/**
 * A note on a plugin channel. Live: sent to the host for the frame it falls on. While exporting: written down, to be
 * played by the plugin before the offline render (see renderPluginParts).
 */
export function createPluginVoice(
  context: BaseAudioContext,
  channel: Channel,
  options: { time: number; pitch: number; velocity: number; duration: number | null }
): Voice | null {
  const pitch = Math.max(0, Math.min(127, Math.round(options.pitch)));
  const velocity = Math.max(0, Math.min(1, options.velocity));
  if (velocity <= 0) return null;

  if (isOffline(context)) {
    const notes = offlineNotes.get(context) ?? [];
    offlineNotes.set(context, notes);
    notes.push({ channelId: channel.id, time: options.time, kind: "on", pitch, velocity });
    let ended = false;
    const end = (time: number) => {
      if (ended) return;
      ended = true;
      notes.push({ channelId: channel.id, time: Math.max(options.time + 0.001, time), kind: "off", pitch, velocity: 0 });
    };
    if (options.duration !== null) end(options.time + Math.max(0.01, options.duration));
    return { release: end, kill: end };
  }

  const entry = slotsByChannel.get(channel.id);
  if (!entry) return null;
  const rate = context.sampleRate;
  const onFrame = Math.round(options.time * rate);
  send({ slot: entry.slot, frame: onFrame, kind: "on", a: pitch, b: velocity });

  let ended = false;
  const end = (time: number) => {
    if (ended) return;
    ended = true;
    send({ slot: entry.slot, frame: Math.max(onFrame + 1, Math.round(time * rate)), kind: "off", a: pitch });
  };
  if (options.duration !== null) end(options.time + Math.max(0.01, options.duration));

  return {
    release: end,
    kill: end,
    // The wheel's usual range is two semitones either way.
    bend: (cents, time) => send({ slot: entry.slot, frame: Math.round(time * rate), kind: "bend", b: Math.max(-1, Math.min(1, cents / 200)) }),
    modulate: (amount, time) => send({ slot: entry.slot, frame: Math.round(time * rate), kind: "cc", a: 1, b: amount })
  };
}

/** Everything sounding on every plugin stops: the transport stopped, or the panic button. */
export function pluginsAllNotesOff(context: BaseAudioContext | null): void {
  if (!context) return;
  const frame = Math.round(context.currentTime * context.sampleRate);
  for (const entry of slotsByChannel.values()) send({ slot: entry.slot, frame, kind: "allOff" });
}

/** Tempo and position, for plugins that follow the song (arpeggiators, synced delays). */
export function pluginsTransport(context: BaseAudioContext | null, tempo: number, playing: boolean, step: number): void {
  if (!context || !studioPort) return;
  studioPort.postMessage({ type: "transport", tempo, playing, frame: Math.round(context.currentTime * context.sampleRate), ppq: step / 4 });
}

/* ─────────────────────────────── windows ─────────────────────────────── */

export async function showPluginWindow(channelId: string): Promise<void> {
  const entry = slotsByChannel.get(channelId);
  const channel = useProjectStore.getState().channels.find((candidate) => candidate.id === channelId);
  if (!entry || !channel?.plugin) throw new Error("This channel has no plugin.");
  if (!entry.loadedFor) throw new Error(`${channel.plugin.name} is still loading.`);
  await request("show", { slot: entry.slot, title: `${channel.plugin.name} · ${channel.name}` });
}

/* ─────────────────────────────── exporting ─────────────────────────────── */

/**
 * Before an offline render starts: have each plugin play its part of the song (written down by createPluginVoice
 * while the song was scheduled), and put those recordings into the render, into each plugin channel's strip.
 */
export async function renderPluginParts(offline: OfflineAudioContext, graph: RenderGraph, duration: number, tempo: number, onProgress?: (done: number) => void): Promise<void> {
  const notes = offlineNotes.get(offline);
  if (!notes?.length) return;
  offlineNotes.delete(offline);

  const live = hubContext;
  const rate = live?.sampleRate ?? 48000;
  const ids = new Map<number, string>();
  const events = notes.flatMap((note) => {
    const entry = slotsByChannel.get(note.channelId);
    if (!entry?.loadedFor) return [];
    ids.set(entry.slot, note.channelId);
    return [{ slot: entry.slot, frame: Math.round(note.time * rate), kind: note.kind, a: note.pitch, b: note.velocity }];
  });
  if (!ids.size) return;

  const listener = (done: number) => onProgress?.(done);
  offlineListeners.add(listener);
  try {
    const frames = Math.ceil(duration * rate);
    const result = await request<{ parts: Record<string, { left: Float32Array; right: Float32Array }> }>("renderOffline", {
      ids: [...ids.keys()],
      frames,
      events,
      tempo,
      offlineRate: rate
    });
    for (const [slot, part] of Object.entries(result.parts)) {
      const input = graph.getChannelInput(ids.get(Number(slot)) ?? "");
      if (!input) continue;
      // Recorded at the live rate; the render resamples it if the export's rate differs.
      const buffer = offline.createBuffer(2, part.left.length, rate);
      buffer.copyToChannel(new Float32Array(part.left), 0);
      buffer.copyToChannel(new Float32Array(part.right), 1);
      const source = offline.createBufferSource();
      source.buffer = buffer;
      source.connect(input);
      source.start(0);
    }
  } finally {
    offlineListeners.delete(listener);
  }
}
