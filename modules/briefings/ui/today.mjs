/* global document, ResizeObserver, window, navigator, CSS */
import { moduleClient } from "./guest-bridge.mjs";
import { briefingsApi } from "./api.mjs";
import { sectionHtml } from "./today-view.mjs";
import { replyPrompt } from "./view.mjs";

const root = document.getElementById("root");
const client = moduleClient();
const api = briefingsApi(client);
const locale = navigator.language || undefined;
const state = { phase: "loading", data: null, busy: "", error: "" };
let lastHeight = -1;

// Measured at once rather than on the next frame, because the browser does not run frames for a
// frame that sits below the fold, which would leave its rows clipped until scrolled into view.
function resize() {
  const height = Math.ceil(root.getBoundingClientRect().bottom + window.scrollY);
  if (height !== lastHeight) {
    lastHeight = height;
    void client.resize(height).catch(() => {});
  }
}

function draw() {
  const focused = document.activeElement?.closest?.("[data-task]")?.dataset.task;
  root.innerHTML = sectionHtml(state, locale);
  if (focused && !state.busy)
    root.querySelector(`[data-task="${CSS.escape(focused)}"] [data-act]`)?.focus();
  resize();
}

async function load() {
  try {
    state.data = await api.today();
    state.phase = "ready";
  } catch {
    state.phase = "error";
  }
  draw();
}

async function act(taskId, action) {
  if (state.busy) return;
  state.busy = taskId;
  state.error = "";
  draw();
  try {
    await api.triage(taskId, action);
  } catch {
    state.error = "Could not save that. Try again.";
  }
  state.busy = "";
  // The saved state decides what shows, so a refused or lost change reads true after the reload.
  await load();
}

root.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-act], [data-reply]");
  if (!button || button.disabled) return;
  if (button.dataset.reply) {
    void client.chat(replyPrompt(button.dataset.reply)).catch(() => {});
  } else if (button.dataset.act === "retry") {
    state.phase = "loading";
    draw();
    void load();
  } else {
    void act(button.closest("[data-task]").dataset.task, button.dataset.act);
  }
});
const observer = new ResizeObserver(resize);
observer.observe(root);
window.addEventListener(
  "pagehide",
  () => {
    observer.disconnect();
    client.dispose();
  },
  { once: true }
);
void client
  .theme()
  .then((theme) => {
    document.documentElement.dataset.theme = theme.theme;
    document.documentElement.dataset.colorMode = theme.colorMode;
  })
  .catch(() => {});
draw();
void load();
void document.fonts.ready.then(resize);
