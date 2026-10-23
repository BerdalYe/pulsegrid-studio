/**
 * The plugin bridge: runs in a utility process of its own (started by main.cjs) and sits between the studio and the
 * plugin host program.
 *
 *  - The studio page sends it requests (load a plugin, open its window, scan for plugins) and the notes to play,
 *    over the "studio" port.
 *  - The page's audio thread (the plugin hub worklet, src/audio/plugins/hubWorklet.ts) tells it where playback is,
 *    over the "audio" port, a few hundred times a second. The bridge keeps the plugins' sound made a little ahead of
 *    that point and sends it straight back to the audio thread, so the page's own thread is never in the way.
 *
 * Everything is in frames of the page's AudioContext, so a note lands on the exact sample it was scheduled for.
 */
const fs = require("node:fs");
const path = require("node:path");
const { PluginHostClient, scanFile } = require("./pluginHostClient.cjs");

/** Frames made per request to the host. */
const CHUNK = 256;
/** How far ahead of the audio thread the sound is made: room for the trip there and back, about 32 ms at 48 kHz. */
const LEAD = 1536;
/** Frames per request when rendering a whole song for export. */
const OFFLINE_CHUNK = 4096;

let config = { exePath: "", cacheFile: "", extraFolders: [] };
let studio = null;
let audio = null;

let host = null;
let hostSetup = null;
let sampleRate = 48000;
let studioWindow = "";

/** slot → { path, uid, state, loaded, editorOpen, lastState } */
const slots = new Map();
/** slot → [{ frame, kind, a, b }] waiting to be played */
const queues = new Map();

let latestTick = 0;
let renderedUpTo = 0;
let rendering = false;
let paused = false;
let transport = { tempo: 120, playing: false, frame: 0, ppq: 0 };

/* ─────────────────────────────── the host program ─────────────────────────────── */

function ensureHost() {
  if (host && host.alive) return hostSetup;
  host = new PluginHostClient(config.exePath, { onEvent: onHostEvent, onExit: onHostExit });
  hostSetup = host.call({ cmd: "setup", sampleRate, maxBlock: 512, studioWindow });
  return hostSetup;
}

function onHostExit(code) {
  host = null;
  hostSetup = null;
  const wereLoaded = [...slots.entries()].filter(([, slot]) => slot.loaded).map(([id]) => id);
  for (const slot of slots.values()) {
    slot.loaded = false;
    slot.editorOpen = false;
  }
  // The studio puts them back, with their last saved settings, and says what happened.
  if (wereLoaded.length) tell({ type: "crashed", slots: wereLoaded, code });
}

const editedTimers = new Map();

function onHostEvent(event) {
  const id = event.instance;
  if (event.event === "edited" && slots.has(id)) {
    clearTimeout(editedTimers.get(id));
    editedTimers.set(id, setTimeout(() => void sendState(id), 600));
  } else if (event.event === "editorClosed" && slots.has(id)) {
    slots.get(id).editorOpen = false;
    tell({ type: "editorClosed", slot: id });
    void sendState(id);
  }
}

/** Fetch a plugin's settings and hand them to the studio, which keeps them in the project, if they changed. */
async function sendState(id) {
  const slot = slots.get(id);
  if (!slot?.loaded || !host) return;
  try {
    const { reply } = await host.call({ cmd: "getState", instance: id });
    const state = reply.state || {};
    const key = `${state.component || ""}|${state.controller || ""}`;
    if (key === slot.lastState) return;
    slot.lastState = key;
    slot.state = state;
    tell({ type: "state", slot: id, state });
  } catch {
    /* the host has gone; onHostExit deals with it */
  }
}

// Some plugins change their settings without saying so (a preset picked in their own browser): while a window is
// open, look every couple of seconds.
setInterval(() => {
  for (const [id, slot] of slots) if (slot.editorOpen) void sendState(id);
}, 2500).unref?.();

/* ─────────────────────────────── making the sound ─────────────────────────────── */

function loadedSlots() {
  return [...slots.entries()].filter(([, slot]) => slot.loaded).map(([id]) => id);
}

function takeEvents(ids, start, frames) {
  const events = [];
  const end = start + frames;
  for (const id of ids) {
    const queue = queues.get(id);
    if (!queue?.length) continue;
    const keep = [];
    for (const event of queue) {
      if (event.frame < end) events.push({ instance: id, offset: Math.max(0, Math.min(frames - 1, event.frame - start)), kind: event.kind, a: event.a, b: event.b });
      else keep.push(event);
    }
    queues.set(id, keep);
  }
  return events;
}

function ppqAt(frame) {
  return transport.ppq + ((frame - transport.frame) / sampleRate) * (transport.tempo / 60);
}

async function pump() {
  if (rendering || paused || !audio) return;
  const ids = loadedSlots();
  if (!ids.length || !host) {
    renderedUpTo = latestTick + LEAD;
    return;
  }
  rendering = true;
  try {
    while (!paused && renderedUpTo < latestTick + LEAD) {
      // Fallen behind (the computer stalled): skip to now rather than play late.
      if (renderedUpTo < latestTick) renderedUpTo = latestTick;
      const start = renderedUpTo;
      const events = takeEvents(ids, start, CHUNK);
      const { message, binary } = await host.request({
        cmd: "render",
        instances: ids,
        frames: CHUNK,
        start,
        tempo: transport.tempo,
        playing: transport.playing,
        ppq: ppqAt(start),
        events
      });
      if (!message.ok) break;
      const data = new Float32Array(binary.length / 4);
      new Uint8Array(data.buffer).set(binary);
      audio.postMessage({ type: "chunk", start, frames: CHUNK, slots: ids, data });
      renderedUpTo = start + CHUNK;
    }
  } catch {
    /* the host stopped; it is started again on the next load */
  } finally {
    rendering = false;
  }
}

/** A whole song's worth of each plugin's part, for exporting: made as fast as the plugins can go. */
async function renderOffline({ ids, frames, events, tempo, offlineRate }) {
  paused = true;
  while (rendering) await new Promise((resolve) => setTimeout(resolve, 5));
  await ensureHost();
  const loaded = ids.filter((id) => slots.get(id)?.loaded);
  const out = new Map(loaded.map((id) => [id, { left: new Float32Array(frames), right: new Float32Array(frames) }]));
  const pending = [...events].sort((a, b) => a.frame - b.frame);
  let next = 0;
  try {
    // A clean start: whatever was sounding live is let go first.
    await host.request({ cmd: "render", instances: loaded, frames: 64, start: 0, tempo, playing: false, ppq: 0, events: loaded.map((id) => ({ instance: id, offset: 0, kind: "allOff" })) });
    for (let start = 0; start < frames; start += OFFLINE_CHUNK) {
      const count = Math.min(OFFLINE_CHUNK, frames - start);
      const chunkEvents = [];
      while (next < pending.length && pending[next].frame < start + count) {
        const event = pending[next++];
        if (out.has(event.slot)) chunkEvents.push({ instance: event.slot, offset: Math.max(0, event.frame - start), kind: event.kind, a: event.a, b: event.b });
      }
      const { message, binary } = await host.request({
        cmd: "render",
        instances: loaded,
        frames: count,
        start,
        tempo,
        playing: true,
        ppq: (start / offlineRate) * (tempo / 60),
        events: chunkEvents
      });
      if (!message.ok) throw new Error(message.error || "The plugin stopped.");
      const floats = new Float32Array(binary.buffer, binary.byteOffset, binary.length / 4);
      loaded.forEach((id, index) => {
        const base = index * count * 2;
        out.get(id).left.set(floats.subarray(base, base + count), start);
        out.get(id).right.set(floats.subarray(base + count, base + count * 2), start);
      });
      if ((start / OFFLINE_CHUNK) % 16 === 0) tell({ type: "offlineProgress", done: start / frames });
    }
    await host.request({ cmd: "render", instances: loaded, frames: 64, start: 0, tempo, playing: false, ppq: 0, events: loaded.map((id) => ({ instance: id, offset: 0, kind: "allOff" })) });
  } finally {
    paused = false;
    renderedUpTo = latestTick + LEAD;
  }
  return Object.fromEntries([...out.entries()].map(([id, sound]) => [id, sound]));
}

/* ─────────────────────────────── finding plugins ─────────────────────────────── */

function defaultFolders() {
  const folders = [path.join(process.env.CommonProgramFiles || "C:\\Program Files\\Common Files", "VST3")];
  if (process.env.LOCALAPPDATA) folders.push(path.join(process.env.LOCALAPPDATA, "Programs", "Common", "VST3"));
  return folders;
}

function readCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(config.cacheFile, "utf8"));
    return { plugins: Array.isArray(cache.plugins) ? cache.plugins : [], failed: Array.isArray(cache.failed) ? cache.failed : [], folders: Array.isArray(cache.folders) ? cache.folders : [], scannedAt: cache.scannedAt || null };
  } catch {
    return { plugins: [], failed: [], folders: [], scannedAt: null };
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(config.cacheFile), { recursive: true });
    fs.writeFileSync(config.cacheFile, JSON.stringify(cache, null, 2));
  } catch {
    /* a list that isn't remembered is scanned again next time */
  }
}

function allFolders(cache) {
  const seen = new Set();
  return [...defaultFolders(), ...config.extraFolders, ...cache.folders].filter((folder) => {
    const key = folder.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findPluginFiles(folder, depth = 0, found = []) {
  if (depth > 6) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    // A plugin is either a .vst3 file or a .vst3 bundle folder; nothing inside a bundle needs looking at.
    if (/\.vst3$/i.test(entry.name)) found.push(full);
    else if (entry.isDirectory()) findPluginFiles(full, depth + 1, found);
  }
  return found;
}

async function scan() {
  const cache = readCache();
  const folders = allFolders(cache);
  const files = folders.flatMap((folder) => findPluginFiles(folder));
  const plugins = [];
  const failed = [];
  for (let i = 0; i < files.length; i += 1) {
    tell({ type: "scanProgress", done: i, total: files.length, file: path.basename(files[i]) });
    const result = await scanFile(config.exePath, files[i]);
    if (result.error && !result.plugins?.length) failed.push({ path: files[i], error: result.error });
    for (const plugin of result.plugins || []) plugins.push({ ...plugin, path: files[i] });
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  const next = { ...cache, plugins, failed, scannedAt: new Date().toISOString() };
  writeCache(next);
  return { ...next, folders: allFolders(next), userFolders: next.folders };
}

/* ─────────────────────────────── requests from the studio ─────────────────────────────── */

function tell(message) {
  studio?.postMessage(message);
}

async function handle(request) {
  switch (request.cmd) {
    case "status":
      return { available: fs.existsSync(config.exePath) };
    case "list": {
      const cache = readCache();
      return { ...cache, folders: allFolders(cache), userFolders: cache.folders };
    }
    case "scan":
      return scan();
    case "setFolders": {
      const cache = readCache();
      cache.folders = (request.folders || []).filter((folder) => typeof folder === "string" && folder.length < 1024);
      writeCache(cache);
      return { folders: allFolders(cache), userFolders: cache.folders };
    }
    case "setup": {
      const rate = Number(request.sampleRate) || 48000;
      if (rate !== sampleRate) {
        sampleRate = rate;
        if (host) {
          await host.call({ cmd: "setup", sampleRate, maxBlock: 512, studioWindow });
          // The plugins were set up for the old rate: load them again with their settings.
          for (const [id, slot] of slots) if (slot.loaded) await load(id, slot);
        }
      }
      return {};
    }
    case "load":
      return load(request.slot, request);
    case "unload": {
      const slot = slots.get(request.slot);
      slots.delete(request.slot);
      queues.delete(request.slot);
      if (slot?.loaded && host) await host.call({ cmd: "unload", instance: request.slot });
      return {};
    }
    case "show": {
      const slot = slots.get(request.slot);
      if (!slot?.loaded) throw new Error("The plugin isn't loaded.");
      await host.call({ cmd: "showEditor", instance: request.slot, title: request.title || "Plugin" });
      slot.editorOpen = true;
      return {};
    }
    case "close": {
      const slot = slots.get(request.slot);
      if (slot?.loaded && host) await host.call({ cmd: "closeEditor", instance: request.slot });
      if (slot) slot.editorOpen = false;
      return {};
    }
    case "getState": {
      if (!slots.get(request.slot)?.loaded) throw new Error("The plugin isn't loaded.");
      const { reply } = await host.call({ cmd: "getState", instance: request.slot });
      return { state: reply.state };
    }
    case "renderOffline": {
      const parts = await renderOffline(request);
      return { parts };
    }
    default:
      throw new Error(`Unknown request: ${request.cmd}`);
  }
}

async function load(id, request) {
  await ensureHost();
  const slot = { path: request.path, uid: request.uid, state: request.state, loaded: false, editorOpen: false, lastState: "" };
  slots.set(id, slot);
  queues.set(id, []);
  const { reply } = await host.call({ cmd: "load", instance: id, path: request.path, uid: request.uid, state: request.state });
  // Unloaded or replaced while it was loading: let it go.
  if (slots.get(id) !== slot) {
    if (slots.get(id) === undefined && host) await host.call({ cmd: "unload", instance: id }).catch(() => undefined);
    return reply;
  }
  slot.loaded = true;
  const state = request.state || {};
  slot.lastState = `${state.component || ""}|${state.controller || ""}`;
  renderedUpTo = Math.max(renderedUpTo, latestTick);
  return { name: reply.name, vendor: reply.vendor, uid: reply.uid, hasEditor: reply.hasEditor };
}

function onStudioMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "events") {
    for (const event of message.list || []) {
      if (!slots.has(event.slot)) continue;
      queues.get(event.slot).push({ frame: Number(event.frame) || 0, kind: event.kind, a: event.a | 0, b: Number(event.b) || 0 });
    }
    return;
  }
  if (message.type === "transport") {
    transport = { tempo: Number(message.tempo) || 120, playing: !!message.playing, frame: Number(message.frame) || 0, ppq: Number(message.ppq) || 0 };
    return;
  }
  if (message.type === "request") {
    handle(message)
      .then((result) => tell({ type: "reply", id: message.id, ok: true, ...result }))
      .catch((error) => tell({ type: "reply", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}

function onAudioMessage(message) {
  if (message?.type === "tick") {
    latestTick = Number(message.frame) || 0;
    void pump();
  }
}

/* ─────────────────────────────── wiring ─────────────────────────────── */

process.parentPort.on("message", (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    config = { exePath: message.exePath, cacheFile: message.cacheFile, extraFolders: message.extraFolders || [] };
    return;
  }
  if (message.type === "ports") {
    studioWindow = message.studioWindow || studioWindow;
    // A new page (the studio was reloaded): it starts with no plugins, so the old ones go.
    studio?.close();
    audio?.close();
    for (const id of loadedSlots()) host?.call({ cmd: "unload", instance: id }).catch(() => undefined);
    slots.clear();
    queues.clear();
    [studio, audio] = event.ports;
    studio.on("message", (incoming) => onStudioMessage(incoming.data));
    audio.on("message", (incoming) => onAudioMessage(incoming.data));
    studio.start();
    audio.start();
  }
});
