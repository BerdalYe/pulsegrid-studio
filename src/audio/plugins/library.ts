import { useMemo } from "react";

import type { InstrumentMenuEntry } from "../../presets/presets";
import { usePluginStore, type FoundPlugin } from "./host";

/** The VST3 instruments found on this computer, as entries of the instrument list (browser, Add menu). */
export function vst3Entries(plugins: FoundPlugin[]): InstrumentMenuEntry[] {
  return plugins
    .filter((plugin) => plugin.instrument)
    .map((plugin) => ({
      label: plugin.name,
      type: "synth",
      group: "Plugins",
      plugin: true,
      vst3: { path: plugin.path, uid: plugin.uid, name: plugin.name, vendor: plugin.vendor }
    }));
}

export function useVst3Entries(): InstrumentMenuEntry[] {
  const plugins = usePluginStore((state) => state.plugins);
  return useMemo(() => vst3Entries(plugins), [plugins]);
}

/** The same, read once, for menus built outside React's rendering. */
export function currentVst3Entries(): InstrumentMenuEntry[] {
  return vst3Entries(usePluginStore.getState().plugins);
}
