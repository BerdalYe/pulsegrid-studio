import { useEffect, useState } from "react";

import { useMidiStore } from "../audio/midiMap";

/** A small light that flickers whenever MIDI arrives — proof the keyboard is talking. */
export function MidiActivity() {
  const lastActivity = useMidiStore((state) => state.lastActivity);
  const [lit, setLit] = useState(false);

  useEffect(() => {
    if (!lastActivity) return;
    setLit(true);
    const timer = window.setTimeout(() => setLit(false), 120);
    return () => window.clearTimeout(timer);
  }, [lastActivity]);

  return <span className={`midi-activity${lit ? " on" : ""}`} title="MIDI activity" aria-hidden="true" />;
}
