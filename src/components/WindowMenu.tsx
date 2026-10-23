import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { addInstrument } from "../lib/addInstrument";
import { currentVst3Entries } from "../audio/plugins/library";
import { instrumentLibrary, type InstrumentFolder } from "../lib/instrumentLibrary";
import { availableInstruments, type InstrumentMenuEntry } from "../presets/presets";
import { useSoundFontStore } from "../audio/soundfont/registry";
import { useProjectStore } from "../state/projectStore";
import { useSessionStore, type WindowId } from "../state/sessionStore";
import { IconCaret } from "./icons";
import { MenuPanel, prepareItems, type MenuItem } from "./MenuPanel";

/** The grid sizes the playlist and the piano roll snap to, in steps. */
const SNAPS: Array<{ label: string; steps: number }> = [
  { label: "Step", steps: 1 },
  { label: "1/2 beat", steps: 2 },
  { label: "Beat", steps: 4 },
  { label: "1/2 bar", steps: 8 },
  { label: "Bar", steps: 16 }
];

const PATTERN_LENGTHS = [16, 32, 48, 64];

function folderItem(folder: InstrumentFolder, add: (entry: InstrumentMenuEntry) => void): MenuItem {
  return {
    label: folder.label,
    items: [
      ...(folder.entries ?? []).map((entry) => ({ label: entry.label, run: () => add(entry) })),
      ...(folder.folders ?? []).map((inner) => folderItem(inner, add))
    ]
  };
}

/**
 * The menu behind the ▾ on a window's title bar: the things you set for that window (snap, pattern length, adding
 * instruments), then the usual ones (maximise, reset the layout, close). Built when it opens, from how things are now.
 */
export function windowMenuItems(id: WindowId, builtinSounds: boolean | null, onStatus: (message: string) => void): MenuItem[] {
  const session = useSessionStore.getState();
  const own: MenuItem[] = [];

  if (id === "playlist") {
    own.push(
      {
        label: "Snap",
        items: SNAPS.map((snap) => ({
          label: snap.label,
          checked: session.snapSteps === snap.steps,
          radio: true,
          run: () => useSessionStore.getState().setSnapSteps(snap.steps)
        }))
      },
      {
        label: "Plays",
        items: [
          { label: "Selected pattern", checked: session.mode === "pattern", radio: true, run: () => useSessionStore.getState().setMode("pattern") },
          { label: "The whole song", checked: session.mode === "song", radio: true, run: () => useSessionStore.getState().setMode("song") }
        ]
      }
    );
  }

  if (id === "rack") {
    const library = instrumentLibrary(availableInstruments(builtinSounds), currentVst3Entries());
    const add = (entry: InstrumentMenuEntry) => {
      addInstrument(entry);
      onStatus(`Added ${entry.label}.`);
    };
    const pattern = useProjectStore.getState().patterns[session.selectedPatternId];
    own.push(
      {
        label: "Add instrument",
        items: [
          ...library.plugins.map((entry) => ({ label: entry.label, run: () => add(entry) })),
          { label: "", separator: true },
          ...library.folders.map((folder) => folderItem(folder, add))
        ]
      },
      {
        label: "Pattern length",
        items: PATTERN_LENGTHS.map((length) => ({
          label: `${length} steps`,
          checked: pattern?.length === length,
          radio: true,
          run: () => useProjectStore.getState().setPatternLength(session.selectedPatternId, length)
        }))
      }
    );
  }

  if (id === "piano") {
    own.push(
      {
        label: "Snap",
        items: SNAPS.map((snap) => ({
          label: snap.label,
          checked: session.pianoSnapSteps === snap.steps,
          radio: true,
          run: () => useSessionStore.getState().setPianoSnapSteps(snap.steps)
        }))
      },
      { label: "Ghost notes", checked: session.ghostNotes, run: () => useSessionStore.getState().toggleGhostNotes() }
    );
  }

  const layout = session.windows[id];
  return [
    ...own,
    ...(own.length > 0 ? [{ label: "", separator: true } as MenuItem] : []),
    {
      label: layout.maximized ? "Restore" : "Maximise",
      run: () => {
        useSessionStore.getState().setWindowFlag(id, "maximized", !layout.maximized);
        useSessionStore.getState().setWindowFlag(id, "minimized", false);
      }
    },
    { label: "Reset window layout", run: () => useSessionStore.getState().resetLayout() },
    { label: "Close", run: () => useSessionStore.getState().closeWindow(id) }
  ];
}

/** The ▾ beside a window's title: opens that window's menu. */
export function WindowMenuButton({ id, title, onStatus }: { id: WindowId; title: string; onStatus: (message: string) => void }) {
  const button = useRef<HTMLButtonElement | null>(null);
  const builtinSounds = useSoundFontStore((state) => state.builtinAvailable);
  const [menu, setMenu] = useState<{ left: number; top: number; items: MenuItem[] } | null>(null);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`window-button window-menu-button${menu ? " active" : ""}`}
        title={`${title} options`}
        aria-label={`${title} options`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => {
          if (menu) {
            setMenu(null);
            return;
          }
          const box = button.current!.getBoundingClientRect();
          setMenu({ left: box.left, top: box.bottom + 2, items: prepareItems(windowMenuItems(id, builtinSounds, onStatus)) });
        }}
      >
        <IconCaret />
      </button>

      {menu
        ? createPortal(
            <MenuPanel items={menu.items} left={menu.left} top={menu.top} anchor={button.current} onClose={() => setMenu(null)} />,
            document.body
          )
        : null}
    </>
  );
}
