/* global window */
import { button, h } from "./dom.mjs";

/**
 * Auto-advance for a carousel. Pauses while hovered or focused (unless the viewer pressed Resume),
 * and stays off when the viewer prefers reduced motion. `advance` is read at tick time, so a caller
 * may swap it freely without resetting the timer.
 */
export function autoAdvance({ root, count, advance, intervalMs, onChange }) {
  const state = { paused: false, hovered: false, focused: false, resumed: false, timer: null };
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => media.matches;

  function sync() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
    const running = !state.paused && (state.resumed || !(state.hovered || state.focused)) && !reduced() && count() >= 2;
    if (running) state.timer = window.setInterval(() => advance(), intervalMs);
    onChange?.();
  }

  root.addEventListener("mouseenter", () => {
    state.hovered = true;
    state.resumed = false;
    sync();
  });
  root.addEventListener("mouseleave", () => {
    state.hovered = false;
    sync();
  });
  root.addEventListener("focusin", (event) => {
    state.focused = true;
    if (!root.contains(event.relatedTarget)) state.resumed = false;
    sync();
  });
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) {
      state.focused = false;
      sync();
    }
  });
  media.addEventListener?.("change", sync);
  sync();

  return {
    get paused() {
      return state.paused;
    },
    get reducedMotion() {
      return reduced();
    },
    toggle() {
      state.resumed = state.paused;
      state.paused = !state.paused;
      sync();
    },
    refresh: sync,
    stop() {
      if (state.timer) window.clearInterval(state.timer);
      state.timer = null;
    }
  };
}

/** The pause/resume button, with a note when reduced motion has turned rotation off. */
export function rotationControl(rotation) {
  const reduced = rotation.reducedMotion;
  return [
    button(rotation.paused ? "Resume rotation" : "Pause rotation", {
      variant: "quiet",
      size: "sm",
      "aria-pressed": rotation.paused ? "true" : "false",
      disabled: reduced,
      onClick: () => rotation.toggle()
    }),
    reduced ? h("span", { role: "status" }, "Rotation is off for reduced motion.") : null
  ];
}
