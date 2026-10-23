import type { PluginRef, PluginState } from "../../types";

/** A plugin's saved settings are kept in the project; past this size they are left out rather than bloat it. */
export const MAX_PLUGIN_STATE_CHARS = 32 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stateText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PLUGIN_STATE_CHARS) return undefined;
  // Checked in one go: a regular expression over megabytes is fast, and anything else is not ours.
  return BASE64.test(value) ? value : undefined;
}

function sanitizeState(raw: unknown): PluginState | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const state: PluginState = {};
  const component = stateText(source.component);
  const controller = stateText(source.controller);
  if (component) state.component = component;
  if (controller) state.controller = controller;
  return component || controller ? state : undefined;
}

/**
 * Make whatever a project file holds into a plugin choice that is safe to hand to the plugin host: a path, a class id
 * of 32 hex digits, short names, and settings that are plain base64. Returns undefined when there is nothing usable.
 */
export function sanitizePluginRef(raw: unknown): PluginRef | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (source.format !== "vst3") return undefined;

  const path = text(source.path, 1024);
  const uid = text(source.uid, 64).toUpperCase();
  if (!path || !/\.vst3$/i.test(path) || !/^[0-9A-F]{32}$/.test(uid)) return undefined;

  const ref: PluginRef = {
    format: "vst3",
    path,
    uid,
    name: text(source.name, 120) || "Plugin",
    vendor: text(source.vendor, 120)
  };
  const state = sanitizeState(source.state);
  if (state) ref.state = state;
  return ref;
}

/** Two choices are the same plugin when they name the same file and class: then its settings are all that differ. */
export function samePlugin(a: PluginRef | undefined, b: PluginRef | undefined): boolean {
  if (!a || !b) return a === b;
  return a.path.toLowerCase() === b.path.toLowerCase() && a.uid === b.uid;
}
