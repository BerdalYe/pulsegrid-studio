import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, sanitizeSettings } from "./appSettings";

describe("settings", () => {
  it("gives the defaults when nothing is stored, or what is stored is not settings", () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("loud")).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps good values", () => {
    const stored = {
      uiScale: 1.25,
      showHints: false,
      audition: false,
      metronomeVolume: 0.3,
      keyboardVelocity: 0.5,
      latency: "playback",
      outputDeviceId: "speakers-1"
    };
    expect(sanitizeSettings(stored)).toEqual(stored);
  });

  it("brings numbers into range, and ignores the wrong kind of value", () => {
    const s = sanitizeSettings({ uiScale: 9, metronomeVolume: -4, keyboardVelocity: 0, showHints: "yes", audition: 1, latency: "instant", outputDeviceId: 5 });
    expect(s.uiScale).toBe(1.5);
    expect(s.metronomeVolume).toBe(0);
    expect(s.keyboardVelocity).toBe(0.1);
    expect(s.showHints).toBe(true);
    expect(s.audition).toBe(true);
    expect(s.latency).toBe("interactive");
    expect(s.outputDeviceId).toBe("");
    expect(sanitizeSettings({ uiScale: Number.NaN }).uiScale).toBe(1);
  });

  it("rounds the interface size to its step", () => {
    expect(sanitizeSettings({ uiScale: 1.2300001 }).uiScale).toBe(1.25);
    expect(sanitizeSettings({ uiScale: 0.1 }).uiScale).toBe(0.8);
  });

  it("cuts an absurdly long device id", () => {
    expect(sanitizeSettings({ outputDeviceId: "x".repeat(5000) }).outputDeviceId).toHaveLength(300);
  });
});
