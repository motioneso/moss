/* global document, location, addEventListener */
import { openModuleFrame } from "/calendar-bridge.mjs";
const frame = document.querySelector("#calendar");
const error = document.querySelector("#host-error");
const dispose = openModuleFrame(frame, "calendar", frame.dataset.src, {
  async request(method, path, body) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) })
    });
    if (response.status === 401) location.assign("/sign-in");
    if (!response.ok) throw new Error("Calendar request failed");
    return response.json();
  },
  theme: () => ({
    theme: "sage",
    calendarEvent: new URL(location.href).searchParams.get("event")
  }),
  navigate: (path) => {
    if (!["/calendar", "/settings/calendar"].includes(path)) throw new Error("Unavailable page");
    location.assign(path);
  },
  chat: () => {
    throw new Error("Chat is not connected to this Calendar page yet");
  }
});
addEventListener("pagehide", dispose, { once: true });
document.querySelector("#sign-out").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error();
    dispose();
    location.assign("/sign-in");
  } catch {
    error.hidden = false;
    error.textContent = "Could not sign out. Please retry.";
  }
});
