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
