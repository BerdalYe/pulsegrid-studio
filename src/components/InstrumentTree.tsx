import { useMemo, useState } from "react";

import { useSoundFontStore } from "../audio/soundfont/registry";
import { addInstrument } from "../lib/addInstrument";
import { instrumentLibrary, type InstrumentFolder } from "../lib/instrumentLibrary";
import { availableInstruments, type InstrumentMenuEntry } from "../presets/presets";
import { IconFolder, IconKeys, IconSynth } from "./icons";

interface InstrumentTreeProps {
  onStatus: (message: string) => void;
}

/** How many instruments a folder holds, counting the folders inside it. */
function countOf(folder: InstrumentFolder): number {
  return (folder.entries?.length ?? 0) + (folder.folders ?? []).reduce((sum, inner) => sum + countOf(inner), 0);
}

/** Every instrument in a folder and the folders inside it, with the folder names it sits under. */
function flatten(folder: InstrumentFolder, trail: string[] = []): Array<{ entry: InstrumentMenuEntry; where: string }> {
  const here = [...trail, folder.label];
  return [
    ...(folder.entries ?? []).map((entry) => ({ entry, where: here.join(" › ") })),
    ...(folder.folders ?? []).flatMap((inner) => flatten(inner, here))
  ];
}

/**
 * The instrument library as a tree, like a plugin database: the plugins on top, then folders of instruments.
 * One click adds an instrument as a new channel. A search box looks through all of them.
 */
export function InstrumentTree({ onStatus }: InstrumentTreeProps) {
  const builtinSounds = useSoundFontStore((state) => state.builtinAvailable);
  const library = useMemo(() => instrumentLibrary(availableInstruments(builtinSounds)), [builtinSounds]);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const add = (entry: InstrumentMenuEntry) => {
    addInstrument(entry);
    onStatus(`Added ${entry.label}.`);
  };

  const leaf = (entry: InstrumentMenuEntry, depth: number, where?: string, parent = "") => (
    <button
      key={`${parent}|${where ?? ""}/${entry.label}`}
      type="button"
      className="tree-row tree-leaf"
      style={{ paddingLeft: 8 + depth * 14 }}
      title={`Add ${entry.label} as a new channel`}
      onClick={() => add(entry)}
    >
      <span className="tree-icon" aria-hidden="true">
        {entry.plugin ? <IconSynth /> : <IconKeys />}
      </span>
      <span className="tree-label">{entry.label}</span>
      {where ? <span className="tree-where">{where}</span> : null}
    </button>
  );

  const folder = (item: InstrumentFolder, depth: number, parent: string) => {
    const path = `${parent}/${item.label}`;
    const expanded = open.has(path);
    return (
      <div key={path} className="tree-folder">
        <button
          type="button"
          className="tree-row"
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-expanded={expanded}
          onClick={() => toggle(path)}
        >
          <span className={`tree-caret${expanded ? " open" : ""}`} aria-hidden="true" />
          <span className="tree-icon" aria-hidden="true">
            <IconFolder />
          </span>
          <span className="tree-label">{item.label}</span>
          <span className="tree-count">{countOf(item)}</span>
        </button>
        {expanded ? (
          <div role="group">
            {(item.entries ?? []).map((entry) => leaf(entry, depth + 1, undefined, path))}
            {(item.folders ?? []).map((inner) => folder(inner, depth + 1, path))}
          </div>
        ) : null}
      </div>
    );
  };

  const needle = query.trim().toLowerCase();
  const everything = useMemo(
    () => [...library.plugins.map((entry) => ({ entry, where: "Plugins" })), ...library.folders.flatMap((item) => flatten(item))],
    [library]
  );
  const matches = needle ? everything.filter(({ entry, where }) => `${entry.label} ${where}`.toLowerCase().includes(needle)) : [];

  return (
    <div className="tree">
      <div className="list-search">
        <input
          type="search"
          value={query}
          placeholder={`Search ${everything.length} instruments…`}
          aria-label="Search the instruments"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        {query !== "" ? (
          <button className="list-search-clear" aria-label="Clear the search" title="Clear the search" onClick={() => setQuery("")}>
            ×
          </button>
        ) : null}
      </div>

      {needle ? (
        matches.length === 0 ? (
          <p className="small-note">Nothing matches “{query.trim()}”.</p>
        ) : (
          <div className="tree-list" role="list">
            {matches.map(({ entry, where }) => leaf(entry, 0, where))}
          </div>
        )
      ) : (
        <div className="tree-list" role="tree">
          {library.plugins.map((entry) => leaf(entry, 0))}
          {library.folders.map((item) => folder(item, 0, ""))}
        </div>
      )}
    </div>
  );
}
