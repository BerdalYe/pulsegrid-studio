// For tests only: the studio's stores and engine expect a `window`, and the test
// runner has none. Import this before anything else that needs one.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

export {};
