import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { TOUR_STEPS, placeCard, type Box } from "../lib/tour";

interface GuidedTourProps {
  onClose: () => void;
}

/** Room left around the highlighted element. */
const SPOTLIGHT_PAD = 5;

/** The area covered by every element the step names, or null if none is showing. */
function findTarget(target: string | string[] | undefined): Box | null {
  if (!target) return null;

  const rects = (Array.isArray(target) ? target : [target])
    .map((selector) => document.querySelector(selector)?.getBoundingClientRect())
    .filter((rect): rect is DOMRect => rect !== undefined && rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return null;

  const top = Math.min(...rects.map((rect) => rect.top));
  const left = Math.min(...rects.map((rect) => rect.left));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const right = Math.max(...rects.map((rect) => rect.right));
  return { top, left, width: right - left, height: bottom - top };
}

/** Scroll speed for steps that reveal what's further down, in pixels per second. */
const REVEAL_SPEED = 70;

/**
 * The first-run tour. Dims the studio, lights up one part at a time and
 * explains it in a small card. The studio underneath can't be clicked while
 * it runs; Esc or "Skip tour" leaves at any point.
 */
export function GuidedTour({ onClose }: GuidedTourProps) {
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<Box | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;

  /** Move by one step, passing over optional steps whose target isn't showing. */
  const go = useCallback(
    (direction: 1 | -1) => {
      let next = index + direction;
      while (next > 0 && next < TOUR_STEPS.length - 1 && TOUR_STEPS[next].optional && !findTarget(TOUR_STEPS[next].target)) {
        next += direction;
      }
      if (next >= TOUR_STEPS.length) onClose();
      else if (next >= 0) setIndex(next);
    },
    [index, onClose]
  );

  // Find the target, then place the card once its real size is known.
  useLayoutEffect(() => {
    const measure = () => {
      const box = findTarget(step.target);
      setTarget(box);
      const card = cardRef.current;
      if (!card) return;
      setPosition(
        placeCard(
          box && {
            top: box.top - SPOTLIGHT_PAD,
            left: box.left - SPOTLIGHT_PAD,
            width: box.width + SPOTLIGHT_PAD * 2,
            height: box.height + SPOTLIGHT_PAD * 2
          },
          { width: card.offsetWidth, height: card.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight }
        )
      );
    };

    measure();
    // Windows may still be settling on the first step; look again shortly.
    const timer = window.setTimeout(measure, 150);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", measure);
    };
  }, [step]);

  // Some steps show off what's below the fold: after a moment, glide the
  // target down to its end, and put it back where it was when the step ends.
  useEffect(() => {
    if (!step.scroll || !step.target) return;
    const selector = Array.isArray(step.target) ? step.target[0] : step.target;
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return;

    const from = element.scrollTop;
    const to = element.scrollHeight - element.clientHeight;
    if (to - from < 4) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = Math.min(7000, Math.max(2500, ((to - from) / REVEAL_SPEED) * 1000));
    let frame = 0;
    let startedAt = 0;

    const tick = (now: number) => {
      if (!startedAt) startedAt = now;
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      element.scrollTop = from + (to - from) * eased;
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    const delay = window.setTimeout(() => {
      if (reduceMotion) element.scrollTop = to;
      else frame = requestAnimationFrame(tick);
    }, 700);

    return () => {
      window.clearTimeout(delay);
      cancelAnimationFrame(frame);
      element.scrollTo({ top: from, behavior: reduceMotion ? "auto" : "smooth" });
    };
  }, [step]);

  // Focus the main button once the card is placed; a hidden button can't take focus.
  const placed = position !== null;
  useEffect(() => {
    if (placed) nextRef.current?.focus();
  }, [index, placed]);

  // Keys drive the tour, not the studio: Space shouldn't start playback
  // behind it, and Esc should close it rather than stop all sound.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const handled = ["Escape", "Enter", " ", "ArrowRight", "ArrowLeft"];
      if (!handled.includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") go(-1);
      else go(1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [go, onClose]);

  return (
    <div className="tour-layer">
      {/* Catches clicks so the studio stays as it is during the tour. */}
      <div className={`tour-catcher${target ? "" : " tour-dim"}`} />

      {target ? (
        <div
          className="tour-spotlight"
          style={{
            top: target.top - SPOTLIGHT_PAD,
            left: target.left - SPOTLIGHT_PAD,
            width: target.width + SPOTLIGHT_PAD * 2,
            height: target.height + SPOTLIGHT_PAD * 2
          }}
        />
      ) : null}

      <div
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-text"
        style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
      >
        <span className="tour-count">
          {index + 1} of {TOUR_STEPS.length}
        </span>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-text">{step.text}</p>

        <div className="tour-actions">
          {last ? null : (
            <button className="tour-skip" onClick={onClose}>
              Skip tour
            </button>
          )}
          <span className="tour-spacer" />
          {index > 0 ? <button onClick={() => go(-1)}>Back</button> : null}
          <button ref={nextRef} className="tour-next" onClick={() => go(1)}>
            {index === 0 ? "Show me around" : last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
