import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { platformText } from "../lib/hotkeys";

/**
 * One entry in a drop-down menu, laid out as in a desktop program: a column for
 * check marks, the name, the shortcut on the right, and a ▸ where a flyout opens.
 */
export interface MenuItem {
  label: string;
  run?: () => void;
  /** Shown on the right, e.g. "Ctrl+S". A label may also carry it after three spaces. */
  shortcut?: string;
  checked?: boolean;
  /** A bullet instead of a tick, for choosing one of several. */
  radio?: boolean;
  disabled?: boolean;
  /** A small caption that groups what follows. */
  heading?: boolean;
  separator?: boolean;
  /** A flyout menu opens beside this entry. */
  items?: MenuItem[];
}

/** Split an old-style "Save   Ctrl+S" label into its name and shortcut, and use the system's key names. */
export function prepareItems(items: MenuItem[]): MenuItem[] {
  return items.map((item) => {
    if (item.separator) return item;
    const [name, ...rest] = item.label.split(/\s{3,}/);
    const shortcut = item.shortcut ?? (rest.length > 0 ? rest.join(" ") : undefined);
    return {
      ...item,
      label: platformText(name.trim()),
      shortcut: shortcut ? platformText(shortcut) : undefined,
      items: item.items ? prepareItems(item.items) : undefined
    };
  });
}

interface ListProps {
  items: MenuItem[];
  onClose: () => void;
  /** Where a flyout list sits (fixed, in the window); the top list uses CSS instead. */
  place?: { left?: number; right?: number; top: number };
  depth: number;
}

function MenuList({ items, onClose, place, depth }: ListProps) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subPlace, setSubPlace] = useState<ListProps["place"]>(undefined);
  const list = useRef<HTMLDivElement | null>(null);

  const openFlyout = (index: number, row: HTMLElement) => {
    const box = row.getBoundingClientRect();
    const room = window.innerWidth - box.right;
    // Opens to the right, or to the left when the window is too narrow.
    setSubPlace(
      room >= 240
        ? { left: box.right - 2, top: Math.max(4, box.top - 4) }
        : { right: window.innerWidth - box.left - 2, top: Math.max(4, box.top - 4) }
    );
    setOpenSub(index);
  };

  // Arrow keys move through the entries, → opens a flyout and ← leaves it.
  useEffect(() => {
    const element = list.current;
    if (!element) return;

    const buttons = () => [...element.querySelectorAll<HTMLButtonElement>(":scope > .menu-row > button:not(:disabled)")];

    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const inside = active && element.contains(active) && active.closest(".menu-list") === element;
      const all = buttons();

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        // Only the list that has focus (or the top one, when nothing has) answers.
        if (!inside && !(depth === 0 && !document.activeElement?.closest(".menu-list"))) return;
        event.preventDefault();
        event.stopPropagation();
        const at = inside ? all.indexOf(active as HTMLButtonElement) : -1;
        const next = event.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
        all[next]?.focus();
        return;
      }

      if (event.key === "Home" || event.key === "End") {
        if (!inside) return;
        event.preventDefault();
        event.stopPropagation();
        (event.key === "Home" ? all[0] : all[all.length - 1])?.focus();
        return;
      }

      if (event.key === "ArrowRight" && inside) {
        const row = (active as HTMLElement).closest<HTMLElement>(".menu-row");
        const index = row ? Number(row.dataset.index) : -1;
        if (index >= 0 && items[index]?.items) {
          event.preventDefault();
          event.stopPropagation();
          openFlyout(index, row!);
          window.setTimeout(() => document.querySelector<HTMLButtonElement>(`.menu-list[data-depth="${depth + 1}"] .menu-row > button:not(:disabled)`)?.focus(), 0);
        }
        return;
      }

      if (event.key === "ArrowLeft" && depth > 0 && inside) {
        event.preventDefault();
        event.stopPropagation();
        // The parent list closes this flyout, and focus goes back to the entry that opened it.
        element.dispatchEvent(new CustomEvent("menu-leave", { bubbles: true }));
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [depth, items]);

  const style = place ? { position: "fixed" as const, left: place.left, right: place.right, top: place.top, maxHeight: `calc(100vh - ${place.top + 8}px)` } : undefined;

  return (
    <div
      ref={list}
      className={`menu-list${depth > 0 ? " menu-flyout" : ""}`}
      data-depth={depth}
      role="menu"
      style={style}
    >
      {items.map((item, index) => {
        if (item.separator) return <div key={`sep-${index}`} className="menu-separator" role="separator" />;
        if (item.heading) {
          return (
            <div key={`heading-${index}-${item.label}`} className="menu-heading">
              {item.label}
            </div>
          );
        }

        const hasSub = Boolean(item.items?.length);
        return (
          <div
            key={`${index}-${item.label}`}
            className={`menu-row${openSub === index ? " open" : ""}`}
            data-index={index}
            onPointerEnter={(event) => {
              if (hasSub && !item.disabled) openFlyout(index, event.currentTarget);
              else setOpenSub(null);
            }}
          >
            <button
              type="button"
              role={item.checked !== undefined ? (item.radio ? "menuitemradio" : "menuitemcheckbox") : "menuitem"}
              aria-checked={item.checked}
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub ? openSub === index : undefined}
              disabled={item.disabled}
              onClick={(event) => {
                if (hasSub) {
                  openFlyout(index, event.currentTarget.parentElement as HTMLElement);
                  return;
                }
                item.run?.();
                onClose();
              }}
            >
              <span className="menu-mark" aria-hidden="true">
                {item.checked ? (item.radio ? "●" : "✓") : ""}
              </span>
              <span className="menu-label">{item.label}</span>
              <span className="menu-shortcut">{item.shortcut ?? ""}</span>
              <span className="menu-arrow" aria-hidden="true">
                {hasSub ? "▸" : ""}
              </span>
            </button>

            {hasSub && openSub === index ? (
              <MenuLeaveCatcher onLeave={() => setOpenSub(null)} focusRow={() => (list.current?.querySelector<HTMLButtonElement>(`.menu-row[data-index="${index}"] > button`))?.focus()}>
                <MenuList items={item.items!} onClose={onClose} place={subPlace} depth={depth + 1} />
              </MenuLeaveCatcher>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Closes a flyout when ← is pressed inside it, and puts focus back on the entry that opened it. */
function MenuLeaveCatcher({ children, onLeave, focusRow }: { children: ReactNode; onLeave: () => void; focusRow: () => void }) {
  const holder = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = holder.current;
    if (!element) return;
    const leave = () => {
      onLeave();
      focusRow();
    };
    element.addEventListener("menu-leave", leave);
    return () => element.removeEventListener("menu-leave", leave);
  });

  return (
    <div ref={holder} className="menu-flyout-holder">
      {children}
    </div>
  );
}

/**
 * A menu dropped from the menu bar. Closes on a click elsewhere, on Escape, and
 * when a command is chosen; ← and → at the top level move to the next menu.
 */
export function MenuPanel({
  items,
  left,
  top,
  onClose,
  onSwitch,
  anchor
}: {
  items: MenuItem[];
  left: number;
  /** Where the menu hangs from; the menu bar's own height by default. */
  top?: number;
  onClose: () => void;
  /** Only for a menu in a bar: ← and → move to the next menu. */
  onSwitch?: (direction: -1 | 1) => void;
  /** The button that opened it, so pressing it again isn't taken as a click elsewhere. */
  anchor?: HTMLElement | null;
}) {
  // A click anywhere else closes it (a menu in the menu bar is closed by the bar itself).
  useEffect(() => {
    if (!anchor) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".menu-panel, .menu-flyout") || anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [anchor, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      // At the top level (no flyout has focus), ← and → move along the menu bar.
      const focused = document.activeElement as HTMLElement | null;
      const inFlyout = focused?.closest(".menu-flyout");
      if (onSwitch && !inFlyout && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        const row = focused?.closest<HTMLElement>(".menu-row");
        const opensFlyout = row && row.querySelector(".menu-arrow")?.textContent === "▸";
        if (event.key === "ArrowRight" && opensFlyout) return;
        event.preventDefault();
        event.stopPropagation();
        onSwitch(event.key === "ArrowLeft" ? -1 : 1);
      }
    };

    // After the list's own handlers, so a flyout gets ← first.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, onSwitch]);

  return (
    <div
      className="menu-panel"
      style={
        top === undefined
          ? { left }
          : { left: Math.max(4, Math.min(left, window.innerWidth - 250)), top, maxHeight: `calc(100vh - ${top + 8}px)` }
      }
    >
      <MenuList items={items} onClose={onClose} depth={0} />
    </div>
  );
}
