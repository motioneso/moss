/* global document, addEventListener */
import { moduleClient } from "./guest-bridge.mjs";

// Establish the document port before the first iframe load, including slow Wasm startup.
const client = moduleClient();
const presentation = client.theme();
globalThis.emailBridge = {
  async request(method, path, body) {
    const value = await client.request(method, path, body ? JSON.parse(body) : null);
    return JSON.stringify(value);
  }
};
presentation
  .then((value) => {
    // Theme names are host-owned. No markup or script is accepted from the parent.
    if (typeof value?.theme === "string") document.documentElement.dataset.theme = value.theme;
    if (typeof value?.mode === "string") document.documentElement.dataset.mode = value.mode;
  })
  .catch(() => {});
addEventListener("pagehide", () => client.dispose(), { once: true });
