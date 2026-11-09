/* global document, location, requestAnimationFrame, cancelAnimationFrame, addEventListener, removeEventListener */
import { moduleClient } from "./guest-bridge.mjs";

// Establish the document port before the first iframe load, including slow Wasm startup.
const client = moduleClient();
const presentation = client.theme();
let interval;
let revealFrame;
function revealToday() {
  cancelAnimationFrame(revealFrame);
  revealFrame = requestAnimationFrame(() => {
    const body = document.querySelector(".cal-body");
    const today = body?.querySelector(".is-today");
    if (!today) return;
    const outer = body.getBoundingClientRect();
    const box = today.getBoundingClientRect();
    body.scrollLeft += box.left - outer.left + box.width / 2 - body.clientWidth / 2;
  });
}
addEventListener("resize", revealToday);
globalThis.calendarBridge = {
  async request(method, path, body) {
    const value = await client.request(method, path, body ? JSON.parse(body) : null);
    return JSON.stringify(value);
  },
  requestedEvent() {
    return presentation.then((value) =>
      typeof value?.calendarEvent === "string" ? value.calendarEvent : null
    );
  },
  settings() {
    return new URL(location.href).pathname.endsWith("/settings.html");
  },
  navigate(path) {
    return client.navigate(path);
  },
  preserve() {
    const active = document.activeElement;
    const body = document.querySelector(".cal-body");
    return { active, key: active?.dataset.calFocus, left: body?.scrollLeft, top: body?.scrollTop };
  },
  restore(saved) {
    requestAnimationFrame(() => {
      const body = document.querySelector(".cal-body");
      if (body && saved.left !== undefined) {
        body.scrollLeft = saved.left;
        body.scrollTop = saved.top;
      }
      if (
        saved.key &&
        (document.activeElement === document.body || !saved.active?.isConnected) &&
        !document.querySelector("dialog[open]")
      ) {
        [...document.querySelectorAll("[data-cal-focus]")]
          .find((el) => el.dataset.calFocus === saved.key)
          ?.focus({ preventScroll: true });
      }
    });
  },
  revealToday,
  watch(callback) {
    clearInterval(interval);
    interval = setInterval(callback, 30000);
  }
};
presentation
  .then((value) => {
    // Theme names are host-owned. No markup or script is accepted from the parent.
    if (typeof value?.theme === "string") document.documentElement.dataset.theme = value.theme;
    if (typeof value?.mode === "string") document.documentElement.dataset.mode = value.mode;
  })
  .catch(() => {});
addEventListener(
  "pagehide",
  () => {
    clearInterval(interval);
    cancelAnimationFrame(revealFrame);
    removeEventListener("resize", revealToday);
    client.dispose();
  },
  { once: true }
);
