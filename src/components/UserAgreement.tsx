import { useEffect, useRef, useState } from "react";

import {
  AGREEMENT_VERSION,
  agreementCopy,
  defaultAgreementLanguage,
  saveAcceptance,
  type AgreementAcceptance,
  type AgreementLanguage
} from "../agreement";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface UserAgreementProps {
  /** Null until the user has accepted; the dialog then blocks the studio. */
  accepted: AgreementAcceptance | null;
  onAccept?: (acceptance: AgreementAcceptance) => void;
  /** Review mode only (opened from Help once already accepted). */
  onClose?: () => void;
}

export function UserAgreement({ accepted, onAccept, onClose }: UserAgreementProps) {
  const [language, setLanguage] = useState<AgreementLanguage>(
    () => accepted?.language ?? defaultAgreementLanguage(navigator.languages ?? [navigator.language])
  );
  const [agreed, setAgreed] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFocus = useRef<HTMLElement | null>(null);

  const copy = agreementCopy[language];
  const reviewing = accepted !== null;

  useEffect(() => {
    firstFocus.current?.focus();
  }, []);

  // Nothing typed while the agreement is up may reach the studio behind it:
  // Space would start playback and the letter keys play notes. Capture-phase
  // stopPropagation keeps the keys' default actions (ticking the box, pressing
  // a button, moving focus) while hiding them from every studio shortcut.
  useEffect(() => {
    const shield = (event: KeyboardEvent) => {
      event.stopPropagation();

      if (event.type !== "keydown") return;

      if (event.key === "Escape" && reviewing) {
        event.preventDefault();
        onClose?.();
        return;
      }

      // Keep Tab inside the dialog rather than wandering into the studio.
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (focusable.length === 0) return;

        const index = focusable.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? index <= 0 ? focusable.length - 1 : index - 1
          : index === focusable.length - 1 ? 0 : index + 1;

        event.preventDefault();
        focusable[next].focus();
      }
    };

    window.addEventListener("keydown", shield, true);
    window.addEventListener("keyup", shield, true);
    return () => {
      window.removeEventListener("keydown", shield, true);
      window.removeEventListener("keyup", shield, true);
    };
  }, [onClose, reviewing]);

  const acceptedOn = accepted
    ? new Date(accepted.acceptedAt).toLocaleDateString(language === "no" ? "nb-NO" : "en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric"
      })
    : "";

  return (
    <div className={`agreement-backdrop${reviewing ? "" : " required"}`} role="presentation">
      <div
        ref={dialogRef}
        className="agreement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agreement-title"
      >
        <div className="agreement-head">
          <div>
            <div id="agreement-title" className="agreement-title">
              {copy.title}
            </div>
            <div className="agreement-parties">
              {copy.parties} · {copy.version(AGREEMENT_VERSION)}
            </div>
          </div>

          <div className="agreement-lang" role="group" aria-label="Language / Språk">
            {(["en", "no"] as const).map((code) => (
              <button
                key={code}
                className={language === code ? "active" : ""}
                aria-pressed={language === code}
                onClick={() => setLanguage(code)}
              >
                {agreementCopy[code].languageName}
              </button>
            ))}
          </div>
        </div>

        <p className="agreement-intro">{copy.intro}</p>

        <div className="agreement-body" lang={language === "no" ? "nb" : "en"}>
          <ol className="agreement-sections">
            {copy.sections.map((section) => (
              <li key={section.heading}>
                <h3>{section.heading}</h3>
                <p>{section.text}</p>
              </li>
            ))}
          </ol>
        </div>

        {reviewing ? (
          <div className="agreement-footer">
            <span className="agreement-accepted">{copy.acceptedOn(acceptedOn)}</span>
            <button
              ref={(element) => {
                firstFocus.current = element;
              }}
              onClick={onClose}
            >
              {copy.close}
            </button>
          </div>
        ) : (
          <div className="agreement-footer">
            <label className="agreement-check">
              <input
                ref={(element) => {
                  firstFocus.current = element;
                }}
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              {copy.checkbox}
            </label>

            <button
              className="active"
              disabled={!agreed}
              onClick={() => onAccept?.(saveAcceptance(language))}
            >
              {copy.accept}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
