import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";

interface ConfirmRequest {
  id: number;
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (confirmed: boolean) => void;
}

export interface ConfirmOptions {
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (title: string, message: string, options?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

let nextId = 1;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const confirmButton = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback<ConfirmFn>((title, message, options) => {
    return new Promise<boolean>((resolve) => {
      setQueue((current) => [
        ...current,
        {
          id: nextId++,
          title,
          message,
          confirmLabel: options?.confirmLabel ?? "Confirm",
          danger: options?.danger ?? true,
          resolve
        }
      ]);
    });
  }, []);

  const active = queue[0];

  const finish = useCallback(
    (confirmed: boolean) => {
      setQueue((current) => {
        const [first, ...rest] = current;
        // Resolve after the state update is queued so a caller that opens
        // another dialog immediately still lands behind this one.
        if (first) queueMicrotask(() => first.resolve(confirmed));
        return rest;
      });
    },
    []
  );

  useEffect(() => {
    if (!active) return;

    confirmButton.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Enter") return;

      event.preventDefault();
      // Shield the app's own global shortcuts while a modal is up. Without
      // this, dismissing the dialog with Escape also reaches App's handler and
      // stops playback and kills every voice.
      event.stopPropagation();

      finish(event.key === "Enter");
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, finish]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}

      {active ? (
        <div className="confirm-backdrop" role="presentation" onPointerDown={() => finish(false)}>
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`confirm-title-${active.id}`}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className={`confirm-dialog-icon${active.danger ? " danger" : ""}`}>!</div>
            <div className="confirm-dialog-content">
              <div id={`confirm-title-${active.id}`} className="confirm-dialog-title">
                {active.title}
              </div>
              <p>{active.message}</p>
              <div className="confirm-dialog-actions">
                <button onClick={() => finish(false)}>Cancel</button>
                <button
                  ref={confirmButton}
                  className={active.danger ? "danger-button" : "active"}
                  onClick={() => finish(true)}
                >
                  {active.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
