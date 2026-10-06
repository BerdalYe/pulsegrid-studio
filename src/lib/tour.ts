/**
 * The first-run tour: a handful of pop-ups, each pointing at one part of the
 * studio. Shown once, after the user agreement is accepted, and again from
 * Help → Take the tour.
 */
export interface TourStep {
  /**
   * What to point at: one selector, or several whose combined area is lit up.
   * Without one, the card sits in the middle of the screen.
   */
  target?: string | string[];
  /** Slowly scroll the (first) target to its end while the step shows, to reveal what's further down. */
  scroll?: boolean;
  /** Skip the step when its target isn't on screen (e.g. the browser is hidden). */
  optional?: boolean;
  title: string;
  text: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: "Welcome to PulseGrid Studio",
    text: "Here's a one-minute look at where everything is. You can see it again any time from Help → Take the tour."
  },
  {
    target: ".studio-window-rack",
    title: "Channel rack",
    text: "Each row is an instrument. Click the squares to switch steps on and build a beat. Right-drag a step to change how hard it hits."
  },
  {
    target: [".fl-panel-mode", ".fl-panel-transport"],
    title: "Play it",
    text: "Press Play or the Space bar. PAT loops the pattern you're editing; SONG plays the whole arrangement."
  },
  {
    target: ".fl-panel-pattern",
    title: "Patterns",
    text: "A pattern is one loop, like a drum beat or a bassline. Pick one here, rename it with the pencil, or start a new one with +."
  },
  {
    target: ".studio-window-playlist",
    title: "Playlist",
    text: "This is your song. Click a lane to place the selected pattern, drag clips to move them, and drag a clip's right edge to make it longer."
  },
  {
    target: ".playlist-scroll",
    title: "Zoom and scroll",
    text: "Turn the mouse wheel to zoom the playlist and piano roll around your pointer. Shift + wheel scrolls sideways, Alt + wheel up and down."
  },
  {
    target: ".fl-panel-windows",
    title: "Windows",
    text: "Lit buttons are open. Open the piano roll (F7) to write melodies and the mixer (F9) for levels and effects. The first button shows the browser."
  },
  {
    target: ".studio-tools",
    optional: true,
    scroll: true,
    title: "Browser",
    text: "Projects, samples and MIDI live here. Further down: demo songs to learn from, and colour themes."
  },
  {
    target: ".cloud-panel",
    optional: true,
    title: "Cloud sync",
    text: "Sign in here to keep your projects on every PC. It's free and optional, and nothing leaves your device until you do."
  },
  {
    target: ".fl-export-button",
    title: "Export",
    text: "When your track is done, export it as a WAV or MP3 file."
  },
  {
    target: ".fl-menus button:last-child",
    title: "Keyboard shortcuts",
    text: "Press F1 any time for every shortcut. Space plays, Enter plays from the start, L loops and K is the metronome."
  },
  {
    target: ".status-bar",
    title: "Hints",
    text: "Point at anything and it explains itself down here. That's the tour — have fun!"
  }
];

const STORAGE_KEY = "pulsegrid:tour";

/** Browser storage can throw outright when site data is blocked; then the tour just shows again. */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "seen";
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "seen");
  } catch {
    /* nothing to remember it in */
  }
}

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Where the card goes: below the target if it fits, else above, right, left,
 * and for targets too big to sit beside (the playlist), inside their top-right
 * corner. Always kept on screen.
 */
export function placeCard(
  target: Box | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 12,
  margin = 8
): { top: number; left: number } {
  const clampLeft = (left: number) => Math.max(margin, Math.min(left, viewport.width - card.width - margin));
  const clampTop = (top: number) => Math.max(margin, Math.min(top, viewport.height - card.height - margin));

  if (!target) {
    return {
      top: clampTop((viewport.height - card.height) / 2),
      left: clampLeft((viewport.width - card.width) / 2)
    };
  }

  const centredLeft = clampLeft(target.left + target.width / 2 - card.width / 2);
  const bottom = target.top + target.height;
  const right = target.left + target.width;

  if (bottom + gap + card.height <= viewport.height - margin) {
    return { top: bottom + gap, left: centredLeft };
  }
  if (target.top - gap - card.height >= margin) {
    return { top: target.top - gap - card.height, left: centredLeft };
  }
  if (right + gap + card.width <= viewport.width - margin) {
    return { top: clampTop(target.top), left: right + gap };
  }
  if (target.left - gap - card.width >= margin) {
    return { top: clampTop(target.top), left: target.left - gap - card.width };
  }
  return { top: clampTop(target.top + gap * 2), left: clampLeft(right - card.width - gap * 2) };
}
