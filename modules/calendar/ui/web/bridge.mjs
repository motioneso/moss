/* global document, location, requestAnimationFrame, addEventListener */
import { moduleClient } from "./guest-bridge.mjs";

// Establish the document port before the first iframe load, including slow Wasm startup.
const client = moduleClient();
let interval;
globalThis.calendarBridge = {
  async request(method, path, body) {
    const value = await client.request(method, path, body ? JSON.parse(body) : null);
    return JSON.stringify(value);
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
  watch(callback) {
    clearInterval(interval);
    interval = setInterval(callback, 30000);
  }
};
client
  .theme()
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
    client.dispose();
  },
  { once: true }
);
