/* global document */
// Frozen design snapshots. Theme toggles only; no pairing, network or credentials.
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
