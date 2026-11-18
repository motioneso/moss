/* global document, window */
import { openModuleFrame } from "/host-bridge.mjs";
const frame = document.getElementById("module");
document.documentElement.dataset.theme = "sage";
document.documentElement.dataset.colorMode = window.matchMedia("(prefers-color-scheme: dark)")
  .matches
  ? "dark"
  : "light";
openModuleFrame(frame, "notes", frame.dataset.src, {
  request: async (method, path, body) => {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  },
  theme: () => ({
    theme: document.documentElement.dataset.theme,
    colorMode: document.documentElement.dataset.colorMode
  }),
  navigate: (path) => {
    window.location.href = path;
  },
  chat: () => {
    document.getElementById("chat-status").textContent =
      "Chat is not connected in this package check.";
  }
});
