import { useCallback, useState, type ReactNode } from "react";

const KEY = "pulsegrid:browser-sections";

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    return typeof saved[id] === "boolean" ? (saved[id] as boolean) : fallback;
  } catch {
    return fallback;
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    localStorage.setItem(KEY, JSON.stringify({ ...saved, [id]: open }));
  } catch {
    /* the section still opens and closes; it just isn't remembered */
  }
}

interface ToolSectionProps {
  id: string;
  title: string;
  /** Whether it starts open, the first time. After that it stays how you left it. */
  defaultOpen?: boolean;
  /** A few words shown beside the title while it is closed: what is inside. */
  summary?: ReactNode;
  /** Small buttons on the right of the header, always visible. */
  actions?: ReactNode;
  children: ReactNode;
}

/** One collapsible block of the browser panel. */
export function ToolSection({ id, title, defaultOpen = true, summary, actions, children }: ToolSectionProps) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));

  const toggle = useCallback(() => {
    setOpen((current) => {
      writeOpen(id, !current);
      return !current;
    });
  }, [id]);

  return (
    <section className={`tool-section${open ? " open" : ""}`}>
      <header className="tool-section-head">
        <button type="button" className="tool-section-toggle" aria-expanded={open} onClick={toggle}>
          <span className="tool-chevron" aria-hidden="true" />
          <span className="tool-section-title">{title}</span>
          {!open && summary ? <span className="tool-section-summary">{summary}</span> : null}
        </button>
        {actions ? <div className="tool-section-actions">{actions}</div> : null}
      </header>
      {open ? <div className="tool-section-body">{children}</div> : null}
    </section>
  );
}
