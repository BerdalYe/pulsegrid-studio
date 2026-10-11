import { INSTRUMENT_GROUPS, type InstrumentMenuEntry } from "../presets/presets";

/** A folder of the instrument library: instruments of its own, and folders inside it. */
export interface InstrumentFolder {
  label: string;
  entries?: InstrumentMenuEntry[];
  folders?: InstrumentFolder[];
}

export interface InstrumentLibrary {
  /** The plugins, listed first, outside any folder. */
  plugins: InstrumentMenuEntry[];
  folders: InstrumentFolder[];
}

/**
 * The instruments to offer, arranged the same way everywhere (the Add menu, the browser, the channel rack's menu):
 * the plugins on top, then one folder per family (Drums, Keys, Mallets & Bells, … FX).
 */
export function instrumentLibrary(available: InstrumentMenuEntry[]): InstrumentLibrary {
  return {
    plugins: available.filter((entry) => entry.group === "Plugins"),
    folders: INSTRUMENT_GROUPS.filter((name) => name !== "Plugins").flatMap((name) => {
      const entries = available.filter((entry) => entry.group === name);
      if (entries.length === 0) return [];

      // Entries that name a folder (each drum kit, the drum machine) are gathered into it, in the order they come.
      const inner = new Map<string, InstrumentMenuEntry[]>();
      for (const entry of entries) if (entry.folder) inner.set(entry.folder, [...(inner.get(entry.folder) ?? []), entry]);
      const loose = entries.filter((entry) => !entry.folder);
      const folders = [...inner].map(([label, items]) => ({ label, entries: items }));

      return [{ label: name, ...(loose.length > 0 ? { entries: loose } : {}), ...(folders.length > 0 ? { folders } : {}) }];
    })
  };
}
