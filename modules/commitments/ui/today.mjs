/* global document, ResizeObserver, window, requestAnimationFrame */
import { moduleClient } from "./guest-bridge.mjs";
import { bindMenus } from "/module-shared/menu.mjs";
import { commitmentsApi } from "./api.mjs";
import { reviewController } from "./controller.mjs";
import { sectionHtml } from "./view.mjs";

const root = document.getElementById("root");
const client = moduleClient();
let disposeMenus = () => {};
let lastHeight = -1;
let focusHint = null;
function resize() {
  requestAnimationFrame(() => {
    const bottom = Math.max(
      root.getBoundingClientRect().bottom,
      ...[...root.querySelectorAll('[role="menu"]:not([hidden])')].map(
        (menu) => menu.getBoundingClientRect().bottom
      )
    );
    const height = Math.ceil(bottom + window.scrollY);
    if (height !== lastHeight) {
      lastHeight = height;
      void client.resize(height).catch(() => {});
    }
  });
}
const controller = reviewController(commitmentsApi(client), (state) => {
  const focus = document.activeElement;
  const focusedId = focus?.closest?.("[data-candidate]")?.dataset.candidate;
  if (focusedId) focusHint = { id: focusedId, action: focus?.dataset?.act };
  const { id, action } = focusHint ?? {};
  disposeMenus();
  root.innerHTML = sectionHtml(state);
  disposeMenus = bindMenus(root, resize);
  if (state.picker) root.querySelector('input[type="date"]')?.focus();
  else if (id && !state.busy) {
    const row = [...root.querySelectorAll("[data-candidate]")].find(
      (r) => r.dataset.candidate === id
    );
    const selector = ["tomorrow", "week", "pick"].includes(action)
      ? "[data-menu-trigger]"
      : `[data-act="${action}"]`;
    (row?.querySelector(selector) ?? root.querySelector("[data-act]"))?.focus();
  }
  resize();
});
root.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-act]");
  if (!button || button.disabled) return;
  if (button.dataset.act === "retry") {
    void controller.load();
    return;
  }
  const row = button.closest("[data-candidate]");
  if (row) void controller.act(row.dataset.candidate, button.dataset.act);
});
root.addEventListener("submit", (event) => {
  if (!event.target.matches("[data-date-form]")) return;
  event.preventDefault();
  void controller.act(
    event.target.closest("[data-candidate]").dataset.candidate,
    "date",
    event.target.querySelector("input").value
  );
});
const observer = new ResizeObserver(resize);
observer.observe(root);
window.addEventListener(
  "pagehide",
  () => {
    observer.disconnect();
    disposeMenus();
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
void controller.load();
void document.fonts.ready.then(resize);
