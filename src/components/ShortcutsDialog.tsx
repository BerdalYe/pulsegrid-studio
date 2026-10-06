import { useEffect, useRef } from "react";

import { platformKey, shortcutGroups } from "../lib/hotkeys";

/** "Ctrl+Shift+S" becomes Ctrl, Shift, S; a lone "+" is the plus key. */
function keysOf(display: string): string[] {
  return display === "+" ? ["+"] : display.split("+");
}

/**
 * Every keyboard shortcut, from the same table that drives them, so what this
 * says is what the keys do. Opens with F1 or from the Help menu.
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButton.current?.focus();

    // Keys belong to this window while it's open: Esc closes it rather than
    // stopping the music, and F1 again puts it away.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "F1") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="export-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <header className="shortcuts-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button ref={closeButton} onClick={onClose}>
            Close
          </button>
        </header>

        <div className="shortcuts-body">
          {shortcutGroups().map(({ group, items }) => (
            <section key={group} className="shortcuts-group">
              <h3>{group}</h3>
              <dl>
                {items.map((item) => (
                  <div key={`${group}:${item.label}`} className="shortcuts-row">
                    <dt>{item.label}</dt>
                    <dd>
                      {item.display.map((way, index) => (
                        <span key={way} className="shortcuts-way">
                          {index > 0 ? <span className="shortcuts-or">or</span> : null}
                          {keysOf(way).map((key, position) => (
                            <span key={`${key}:${position}`}>
                              {position > 0 ? <span className="shortcuts-plus">+</span> : null}
                              <kbd>{platformKey(key)}</kbd>
                            </span>
                          ))}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="small-note shortcuts-foot">
          The keys that play notes (Z to M and Q to I) are kept free, so shortcuts on those letters need Ctrl or Alt.
        </p>
      </div>
    </div>
  );
}
