import { connectModuleFrame } from "/host-bridge.mjs";
const frame = document.querySelector("#calendar");
connectModuleFrame(frame, "calendar", {
  async request(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new Error();
    return response.json();
  },
  theme: () => ({ theme: "sage" }),
  navigate: (path) => {
    location.href = path === "/calendar" ? "/" : "/settings";
  },
  chat: () => {
    throw new Error("Chat is not composed in this frame check");
  }
});
frame.src = frame.dataset.src;
