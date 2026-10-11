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
 * The instruments to offer, arranged the same way everywhere (the Add menu and the browser): the plugins on
 * top, then Instruments and Drums, then every synthesized sound tucked into one folder of families.
 */
export function instrumentLibrary(available: InstrumentMenuEntry[]): InstrumentLibrary {
  const group = (name: string): InstrumentFolder[] => {
    const entries = available.filter((entry) => entry.group === name);
    return entries.length === 0 ? [] : [{ label: name, entries }];
  };

  const synths = INSTRUMENT_GROUPS.filter((name) => !["Plugins", "Instruments", "Drums"].includes(name)).flatMap(group);

  return {
    plugins: available.filter((entry) => entry.group === "Plugins"),
    folders: [...group("Instruments"), ...group("Drums"), ...(synths.length > 0 ? [{ label: "Synth sounds", folders: synths }] : [])]
  };
}
