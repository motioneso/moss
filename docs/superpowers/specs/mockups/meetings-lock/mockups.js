/* global document, window */
// Frozen design snapshots. No authentication, network calls or password comparison.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
function applyTheme(key, value) {
  document.documentElement.dataset[key] = value;
  $$("iframe").forEach((frame) => {
    frame.contentDocument.documentElement.dataset[key] = value;
  });
}
$("[data-theme-toggle]")?.addEventListener("click", (event) => {
  const dark = document.documentElement.dataset.colorMode !== "dark";
  applyTheme("colorMode", dark ? "dark" : "light");
  event.currentTarget.textContent = dark ? "Light" : "Dark";
});
$("[data-park-toggle]")?.addEventListener("click", (event) => {
  const canyon = document.documentElement.dataset.theme !== "canyon";
  applyTheme("theme", canyon ? "canyon" : "forest");
  event.currentTarget.textContent = canyon ? "Canyon" : "Forest";
});
$$("iframe").forEach((frame) => {
  frame.addEventListener("load", () => {
    for (const key of ["theme", "colorMode"]) {
      frame.contentDocument.documentElement.dataset[key] =
        document.documentElement.dataset[key] || (key === "theme" ? "forest" : "light");
    }
  });
});
function clearPassword() {
  const input = $("#app-password");
  if (input) input.value = "";
}
$("[data-password-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  clearPassword();
  // Any nonempty submission opens the error snapshot. Success is a review link only.
  window.location.assign("wrong-password.html");
});
$$("[data-clear-password]").forEach((link) => link.addEventListener("click", clearPassword));
window.addEventListener("pagehide", clearPassword);
const chat = $(".lock-chat");
const opener = $("[data-open-chat]");
const media = window.matchMedia("(max-width: 920px)");
const background = $$(".mock-sidebar, .mock-topbar, .lock-home");
function isDrawer() {
  return media.matches || document.body.classList.contains("lock-phone-preview");
}
function syncDrawer() {
  if (!chat) return;
  const modal = isDrawer() && !chat.hidden;
  chat.setAttribute("role", isDrawer() ? "dialog" : "complementary");
  if (modal) chat.setAttribute("aria-modal", "true");
  else chat.removeAttribute("aria-modal");
  background.forEach((node) => (node.inert = modal));
}
function closeChat() {
  clearPassword();
  chat.hidden = true;
  syncDrawer();
  opener.focus();
}
$("[data-close-chat]")?.addEventListener("click", closeChat);
opener?.addEventListener("click", () => {
  chat.hidden = false;
  syncDrawer();
  ($("#app-password") || $("[data-close-chat]"))?.focus();
});
chat?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeChat();
  }
  if (event.key === "Tab" && isDrawer()) {
    const focusable = [...chat.querySelectorAll("a, button, input, textarea")].filter(
      (node) => !node.disabled && node.getClientRects().length
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
$("[data-send]")?.addEventListener("click", () => {
  const composer = $(".chatd-input textarea");
  if (!composer.value.trim()) return;
  composer.value = "";
  const locked = window.location.pathname.split("/").at(-1) === "locked.html";
  window.location.assign(locked ? "expired.html" : "chooser.html");
});
media.addEventListener("change", syncDrawer);
syncDrawer();
