/* global document, window, ResizeObserver */
import { moduleClient } from "./guest-bridge.mjs";
import { goalsHtml } from "./view.mjs";

const client = moduleClient();
const root = document.getElementById("root");
function resize() {
  void client.resize(Math.ceil(root.getBoundingClientRect().height)).catch(() => {});
}
new ResizeObserver(resize).observe(root);
window.addEventListener("pagehide", () => client.dispose(), { once: true });
client
  .theme()
  .then((theme) => {
    if (typeof theme?.theme === "string") document.documentElement.dataset.theme = theme.theme;
    if (typeof theme?.colorMode === "string")
      document.documentElement.dataset.colorMode = theme.colorMode;
  })
  .catch(() => {});

async function load() {
  root.innerHTML = '<p class="goals-status" role="status" aria-busy="true">Loading your goals…</p>';
  try {
    const goals = await client.request("GET", "/goals/today");
    if (!Array.isArray(goals)) throw new Error();
    root.innerHTML = goalsHtml(goals);
  } catch {
    root.innerHTML =
      '<div class="goals-status"><p role="status">Your goals could not be loaded.</p><button type="button" class="jds-btn jds-btn--link">Retry</button></div>';
    root.querySelector("button").addEventListener("click", () => void load());
  }
  resize();
}
void load();
