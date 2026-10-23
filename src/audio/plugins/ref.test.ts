import { describe, expect, it } from "vitest";

import { samePlugin, sanitizePluginRef } from "./ref";

const good = {
  format: "vst3",
  path: "C:\\Program Files\\Common Files\\VST3\\Studio Instrument Collection.vst3",
  uid: "abcdef019182faeb53564b5853564b58",
  name: "Studio Instrument Collection",
  vendor: "Akai Professional",
  state: { component: "AAECAw==", controller: "" }
};

describe("plugin choices from a project file", () => {
  it("keeps a good one, with the class id in capitals and empty settings dropped", () => {
    const ref = sanitizePluginRef(good);
    expect(ref).toEqual({
      format: "vst3",
      path: good.path,
      uid: "ABCDEF019182FAEB53564B5853564B58",
      name: "Studio Instrument Collection",
      vendor: "Akai Professional",
      state: { component: "AAECAw==" }
    });
  });

  it("refuses anything that isn't a VST3 file and a proper class id", () => {
    expect(sanitizePluginRef(null)).toBeUndefined();
    expect(sanitizePluginRef({ ...good, format: "vst2" })).toBeUndefined();
    expect(sanitizePluginRef({ ...good, path: "C:\\Windows\\System32\\evil.dll" })).toBeUndefined();
    expect(sanitizePluginRef({ ...good, uid: "not-a-uid" })).toBeUndefined();
    expect(sanitizePluginRef({ ...good, path: "" })).toBeUndefined();
  });

  it("leaves out settings that aren't base64, keeping the plugin", () => {
    const ref = sanitizePluginRef({ ...good, state: { component: "<script>", controller: 42 } });
    expect(ref?.uid).toBe("ABCDEF019182FAEB53564B5853564B58");
    expect(ref?.state).toBeUndefined();
  });

  it("names the plugin when the file doesn't", () => {
    expect(sanitizePluginRef({ ...good, name: "" })?.name).toBe("Plugin");
  });

  it("tells the same plugin from another, ignoring settings and the case of the path", () => {
    const a = sanitizePluginRef(good)!;
    const b = sanitizePluginRef({ ...good, path: good.path.toLowerCase(), state: undefined })!;
    expect(samePlugin(a, b)).toBe(true);
    expect(samePlugin(a, { ...b, uid: "00000000000000000000000000000000" })).toBe(false);
    expect(samePlugin(undefined, undefined)).toBe(true);
    expect(samePlugin(a, undefined)).toBe(false);
  });
});
