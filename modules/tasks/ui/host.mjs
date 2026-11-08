/* global document, window */
import { connectModuleFrame } from "/host-bridge.mjs";
const frame = document.getElementById("module");
connectModuleFrame(frame, "tasks", {
  screenUrl: frame.dataset.src,
  request: async (method, path, body) => {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new Error("Tasks request failed");
    return response.json();
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
