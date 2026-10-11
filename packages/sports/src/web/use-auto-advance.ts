import { useEffect, useRef, useState, type FocusEvent } from "react";

/**
 * Auto-advance + pause behaviour shared by the two hero carousels: the top-stories carousel
 * (HeroCarousel) and the gameday score bar (#1386). Only the timer and the pause rules live
 * here — each carousel keeps its own notion of "which slide", because they differ: the story
 * carousel indexes by position, the gameday one tracks the game id so a refetch that reorders
 * or drops a game can't swap what you're reading.
 *
 * Pausing on focus as well as hover is the accessibility half: a keyboard user tabbing into
 * the controls would otherwise have the slide move out from under them mid-interaction.
 *
 * `advance` is held in a ref rather than listed as an effect dependency — a caller that
 * rebuilds the callback each render would otherwise reset the interval every render, and the
 * slide would never advance at all.
 */
export function useAutoAdvance(count: number, advance: () => void, intervalMs: number) {
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const advanceRef = useRef(advance);

  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  useEffect(() => {
    if (count < 2) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(media.matches);
    const changed = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    media.addEventListener?.("change", changed);
    return () => media.removeEventListener?.("change", changed);
  }, [count]);

  useEffect(() => {
    if (paused || hovered || focused || reducedMotion || count < 2) return;
    const timer = window.setInterval(() => advanceRef.current(), intervalMs);
    return () => window.clearInterval(timer);
  }, [paused, hovered, focused, reducedMotion, count, intervalMs]);

  return {
    paused,
    reducedMotion,
    togglePaused: () => setPaused((current) => !current),
    pauseHandlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }
    }
  };
}
