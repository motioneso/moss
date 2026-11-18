import { moduleClient } from "./guest-bridge.mjs";
import { peopleBridge } from "./bridge.mjs";
// Connect during initial document startup, before loading the compiled screen.
const client = moduleClient();
globalThis.mossPeople = peopleBridge(client).api;
void client
  .theme()
  .then((theme) => {
    if (theme && typeof theme === "object") {
      for (const key of ["theme", "colorMode"]) {
        if (typeof theme[key] === "string")
          globalThis.document.documentElement.dataset[key] = theme[key];
      }
    }
  })
  .catch(() => {
    /* Host defaults still use the canonical stylesheet. */
  });
const { default: init } = await import("./people.js");
await init({ module_or_path: new URL("./people_bg.wasm", import.meta.url) });
const observer = new globalThis.ResizeObserver(() => {
  void client.resize(globalThis.document.body.scrollHeight).catch(() => {});
});
observer.observe(globalThis.document.body);
globalThis.addEventListener(
  "pagehide",
  () => {
    observer.disconnect();
    client.dispose();
  },
  { once: true }
);
