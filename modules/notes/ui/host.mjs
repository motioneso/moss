/* global document, window */
import { connectModuleFrame } from "/host-bridge.mjs";
const frame = document.getElementById("module");
connectModuleFrame(frame, "notes", {
  request: async (method, path, body) => {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  },
  theme: () => ({ theme: "sage", colorMode: "light" }),
  navigate: (path) => {
    window.location.href = path;
  },
  chat: () => {
    document.getElementById("chat-status").textContent =
      "Chat is not connected in this package check.";
  }
});
frame.src = frame.dataset.src;
