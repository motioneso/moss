/* global HTMLElement, customElements, document, matchMedia */
import { openModuleFrame } from "/module-shared/host-bridge.mjs";

// Only the shell owns the signed-in requests. The package owns the Goals markup.
class GoalsToday extends HTMLElement {
  connectedCallback() {
    this.controller = new AbortController();
    void this.open(this.controller.signal);
  }
  disconnectedCallback() {
    this.controller?.abort();
    this.dispose?.();
    this.replaceChildren();
  }
  async open(signal) {
    try {
      const response = await fetch("/api/modules/goals/screen?path=%2Fgoals%2Ftoday", { signal });
      if (response.status === 404) return; // Package not installed.
      if (!response.ok) throw new Error();
      const screen = await response.json();
      if (signal.aborted) return;
      const frame = document.createElement("iframe");
      frame.title = "Long-term goals";
      frame.className = "goals-today-frame";
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      this.replaceChildren(frame);
      this.dispose = openModuleFrame(frame, "goals", screen.src, {
        minimumHeight: 0,
        request: async (method, path, body) => {
          const reply = await fetch(path, {
            method,
            signal,
            credentials: "same-origin",
            headers: body === null ? {} : { "content-type": "application/json" },
            body: body === null ? undefined : JSON.stringify(body)
          });
          if (!reply.ok) throw Object.assign(new Error(), { status: reply.status });
          return reply.json();
        },
        theme: () => ({
          theme: document.documentElement.dataset.theme ?? "park-press",
          colorMode:
            document.documentElement.dataset.colorMode ??
            (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        }),
        navigate: async () => {
          throw new Error();
        },
        chat: async () => {
          throw new Error();
        },
        open: async () => {
          throw new Error();
        },
        save: async () => {
          throw new Error();
        }
      });
    } catch {
      if (signal.aborted) return;
      const text = document.createElement("p");
      text.className = "cmd-empty";
      text.setAttribute("role", "status");
      text.textContent = "Your goals could not be loaded. Reload Today to try again.";
      this.replaceChildren(text);
    }
  }
}
customElements.define("moss-goals-today", GoalsToday);
