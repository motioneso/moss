// Applies the saved theme before first paint so the loading screen matches the user's choice.
// index.html loads it in the head, so it runs before the body paints.
// Keys match SHELL_THEME_STORAGE_KEY, SHELL_COLOR_MODE_STORAGE_KEY and
// SHELL_PAGE_TONE_STORAGE_KEY in src/shell/theme-storage.ts. The app shell re-applies the
// server's answer once signed in.
(function () {
  var root = document.documentElement;
  var theme = "light";
  var mode = null;

  try {
    var storedTheme = (localStorage.getItem("jarvis.theme:v1") || "").trim();
    var storedMode = localStorage.getItem("jarvis.color-mode:v1");
    // Page tone covers custom themes, which always save color mode as light.
    var storedTone = localStorage.getItem("jarvis.page-tone:v1");
    if (storedTheme) theme = storedTheme;
    if (storedTone === "light" || storedTone === "dark") mode = storedTone;
    else if (storedMode === "light" || storedMode === "dark") mode = storedMode;
    else if (storedMode === null && storedTheme === "dark") mode = "dark";
  } catch {
    // Storage can be disabled; fall through to the system preference.
  }

  // Nothing saved yet (first visit, new browser): follow the operating system.
  if (mode === null) {
    try {
      mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      mode = "light";
    }
  }

  root.setAttribute("data-theme", theme === "dark" ? "light" : theme);
  root.setAttribute("data-color-mode", mode);

  // Address bar matches the page background. The production build links the stylesheet after
  // this script, so --bg cannot be read yet; these are --paper in tokens.css (light and dark,
  // no palette changes it). A unit test keeps them in step.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", mode === "dark" ? "#1c1a16" : "#f2eee4");
})();
