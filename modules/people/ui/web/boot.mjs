import { moduleClient } from "./guest-bridge.mjs";
// Connect during initial document startup, before loading the compiled screen.
const client = moduleClient();
globalThis.mossPeople = {
  async request(method, path, body) {
    const response = await client.request(method, path, JSON.parse(body));
    if (!response || response.status < 200 || response.status >= 300)
      throw new Error("Request failed");
    return JSON.stringify(response.body);
  },
  chat: (text) => client.chat(text)
};
try {
  const theme = await client.theme();
  if (theme && typeof theme === "object") {
    for (const key of ["theme", "colorMode"]) {
      if (typeof theme[key] === "string") document.documentElement.dataset[key] = theme[key];
    }
  }
} catch {
  /* Host defaults still use the canonical stylesheet. */
}
const { default: init } = await import("./people.js");
await init();
const observer = new ResizeObserver(() => {
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
});
observer.observe(document.body);
addEventListener(
  "pagehide",
  () => {
    observer.disconnect();
    client.dispose();
  },
  { once: true }
);
