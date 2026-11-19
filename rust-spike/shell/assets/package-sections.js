/* global document, MutationObserver */
// The shell embeds verified package screens; the package owns its section's content and actions.
import { openModuleFrame } from "/module-shared/host-bridge.mjs";

const active = new Map();
async function mount(slot) {
  const moduleId = slot.dataset.moduleSection;
  let dispose = () => {};
  active.set(slot, () => dispose());
  async function load() {
    dispose();
    slot.replaceChildren();
    try {
      const response = await fetch(
        `/api/modules/${encodeURIComponent(moduleId)}/screen?path=${encodeURIComponent(slot.dataset.screenPath)}`
      );
      // Optional packages without this screen occupy no space.
      if (response.status === 404) return;
      if (!response.ok) throw new Error();
      const screen = await response.json();
      if (!slot.isConnected) return;
      const frame = document.createElement("iframe");
      frame.className = "package-section-frame";
      frame.title = screen.title;
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      slot.append(frame);
      dispose = openModuleFrame(frame, moduleId, screen.src, {
        minimumHeight: 0,
        resized: (height) => {
          slot.hidden = height === 0;
        },
        request: async (method, path, body) => {
          const reply = await fetch(path, {
            method,
            headers: body == null ? {} : { "content-type": "application/json" },
            body: body == null ? undefined : JSON.stringify(body)
          });
          if (!reply.ok) throw Object.assign(new Error(), { status: reply.status });
          return reply.status === 204 ? null : reply.json();
        },
        theme: () => ({
          theme: document.documentElement.dataset.theme ?? "park-press",
          colorMode: document.documentElement.dataset.colorMode ?? "light"
        })
      });
    } catch {
      if (!slot.isConnected) return;
      const message = document.createElement("p");
      message.className = "cmd-empty";
      message.setAttribute("role", "status");
      message.dataset.errorCode = "commitments_today_unavailable";
      message.textContent = "This section couldn't load.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "jds-btn jds-btn--quiet";
      retry.textContent = "Try again";
      retry.onclick = load;
      slot.replaceChildren(message, retry);
    }
  }
  await load();
}
function refresh() {
  for (const [slot, dispose] of active) {
    if (!slot.isConnected) {
      dispose();
      active.delete(slot);
    }
  }
  for (const slot of document.querySelectorAll("[data-module-section]")) {
    if (!active.has(slot)) void mount(slot);
  }
}
new MutationObserver(refresh).observe(document.getElementById("root"), {
  childList: true,
  subtree: true
});
refresh();
