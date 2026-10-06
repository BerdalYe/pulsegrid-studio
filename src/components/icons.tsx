import type { ReactNode } from "react";

/**
 * The studio's icons. One style throughout: outlines on a 24-pixel grid with
 * rounded ends, a little solid colour where it helps tell them apart, and they
 * take their colour from the text around them so they follow the theme and the
 * on / off state of whatever button they sit in.
 */
interface IconProps {
  /** Size in pixels. The button usually decides, through CSS. */
  size?: number;
}

function Icon({ size, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The wavetable synth: a pulse of bars rising to a peak. */
export function IconSynth(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 10.5v3M8 8v8M12 4.5v15M16 8v8M20 10.5v3" strokeWidth="2.2" />
    </Icon>
  );
}

/* ───────────────────────────── the windows ───────────────────────────── */

/** The browser panel: a window with its side panel picked out. */
export function IconBrowser(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
      <path d="M5.5 8h2.5M5.5 11h2.5M5.5 14h2.5" strokeWidth="1.5" />
    </Icon>
  );
}

/** The playlist: clips laid out along lanes, with the playhead. */
export function IconPlaylist(props: IconProps) {
  return (
    <Icon {...props}>
      <rect className="tint" x="3" y="5" width="9" height="3.8" rx="1.2" />
      <rect className="tint" x="9" y="10.1" width="12" height="3.8" rx="1.2" />
      <rect className="tint" x="5" y="15.2" width="8" height="3.8" rx="1.2" />
      <path d="M16.5 3v3" />
    </Icon>
  );
}

/** The channel rack: rows of steps, some switched on. */
export function IconRack(props: IconProps) {
  const lit = [
    [0, 2],
    [1, 3],
    [0, 1, 3]
  ];
  return (
    <Icon {...props}>
      {[0, 1, 2].map((row) =>
        [0, 1, 2, 3].map((column) => (
          <rect
            key={`${row}:${column}`}
            className={lit[row].includes(column) ? "solid" : "ghost"}
            x={3 + column * 4.9}
            y={4.6 + row * 5.6}
            width="3.6"
            height="3.6"
            rx="0.9"
          />
        ))
      )}
    </Icon>
  );
}

/** The piano roll: keys down the left, notes in the grid. */
export function IconPiano(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="5.5" height="16" rx="1.4" />
      <path d="M3 9.3h3.2M3 14.7h3.2" />
      <rect className="solid" x="10.5" y="6" width="6" height="3" rx="1" />
      <rect className="solid" x="14.5" y="11" width="6.5" height="3" rx="1" />
      <rect className="solid" x="11" y="16" width="5" height="3" rx="1" />
    </Icon>
  );
}

/** The mixer: three faders at different levels. */
export function IconMixer(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4v16M12 4v16M18 4v16" />
      <rect className="solid knob" x="3.2" y="13.2" width="5.6" height="3.4" rx="1" />
      <rect className="solid knob" x="9.2" y="6.8" width="5.6" height="3.4" rx="1" />
      <rect className="solid knob" x="15.2" y="10.2" width="5.6" height="3.4" rx="1" />
    </Icon>
  );
}

/* ───────────────────────── window title-bar buttons ───────────────────────── */

export function IconMinimise(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 17.5h13" strokeWidth="2" />
    </Icon>
  );
}

export function IconMaximise(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.6" strokeWidth="2" />
    </Icon>
  );
}

/** Two windows, one behind the other: put it back to its size. */
export function IconRestore(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="8.5" width="11" height="11" rx="1.6" strokeWidth="2" />
      <path d="M8.5 5.5h8a2 2 0 0 1 2 2v8" strokeWidth="2" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" strokeWidth="2" />
    </Icon>
  );
}

/* ───────────────────────────── small actions ───────────────────────────── */

export function IconChevronUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 15l6-6 6 6" strokeWidth="2.2" />
    </Icon>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 9l6 6 6-6" strokeWidth="2.2" />
    </Icon>
  );
}

/** Clear everything on a lane. */
export function IconBroom(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 3.5l6 6-9.4 9.4a2 2 0 0 1-2.8 0L5 15.6a2 2 0 0 1 0-2.8z" />
      <path d="M8 10.5l5.5 5.5M4.5 20.5h8" />
    </Icon>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 7h15M9.5 7V4.5h5V7" />
      <path d="M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10 11v5M14 11v5" />
    </Icon>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </Icon>
  );
}

/* ───────────────────────────── piano roll tools ───────────────────────────── */

export function IconPencil(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20l1.1-4.4L16.4 4.3a1.8 1.8 0 0 1 2.5 0l.8.8a1.8 1.8 0 0 1 0 2.5L8.4 18.9z" />
      <path d="M14.3 6.4l3.3 3.3M4 20l4.4-1.1" />
    </Icon>
  );
}

export function IconBrush(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="3.5" width="14" height="6" rx="1.8" />
      <path d="M18 6.5h1.5a1.5 1.5 0 0 1 1.5 1.5v2.5a1.5 1.5 0 0 1-1.5 1.5H12v3" />
      <rect className="solid" x="10" y="15" width="4" height="5.5" rx="1.2" />
    </Icon>
  );
}

export function IconEraser(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.2 4.6l6.2 6.2a1.8 1.8 0 0 1 0 2.5L12.2 20.5H8.4l-4-4a1.8 1.8 0 0 1 0-2.5l7-7.4a1.8 1.8 0 0 1 1.8-1z" />
      <path d="M8 10.3l6.7 6.7M12.2 20.5H21" />
    </Icon>
  );
}

export function IconSelect(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2.2" strokeDasharray="3.2 3.2" strokeWidth="2" />
    </Icon>
  );
}

/** Put an effect back to its defaults. */
export function IconReset(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5" />
      <path d="M4.5 4.5v4.8h4.8" />
    </Icon>
  );
}
