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
  theme: async () => {
    const base = { theme: "sage", colorMode: "light" };
    try {
      const response = await fetch("/api/shell");
      if (!response.ok) return base;
      const shell = await response.json();
      return {
        ...base,
        displayName: shell?.account?.display_name,
        assistantName: shell?.assistant_name
      };
    } catch {
      return base;
    }
  },
  navigate: (path) => {
    window.location.href = path;
  },
  chat: () => {
    document.getElementById("chat-status").textContent =
      "Chat is not connected in this package check.";
  }
});
