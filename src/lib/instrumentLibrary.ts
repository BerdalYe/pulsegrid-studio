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
      return entries.length === 0 ? [] : [{ label: name, entries }];
    })
  };
}
